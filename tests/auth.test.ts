import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the data layer at an in-memory database BEFORE importing anything that
// imports db.ts, so this test file gets its own throwaway connection.
process.env.SQUAWK_DB = ":memory:";
const { routeRequest } = await import("../src/server/index.ts");
const { resolveApiToken } = await import("../src/server/auth.ts");

const TOKEN = "s3cr3t-machine-token";

/** Build a request, optionally with an Authorization header. */
function req(method: string, path: string, auth?: string): Request {
  const headers: Record<string, string> = {};
  if (auth !== undefined) headers.Authorization = auth;
  return new Request(`http://x${path}`, { method, headers });
}

/** Reset the auth-related env after every test so cases don't bleed together. */
afterEach(() => {
  delete process.env.SQUAWK_API_TOKEN;
  delete process.env.SQUAWK_API_TOKEN_FILE;
});

// --- resolveApiToken (pure) --------------------------------------------------

test("resolveApiToken: unset ⇒ null (feature off)", () => {
  expect(resolveApiToken({})).toBeNull();
});

test("resolveApiToken: whitespace-only env ⇒ null", () => {
  expect(resolveApiToken({ SQUAWK_API_TOKEN: "   \n" })).toBeNull();
});

test("resolveApiToken: env value is trimmed", () => {
  expect(resolveApiToken({ SQUAWK_API_TOKEN: "  tok\n" })).toBe("tok");
});

test("resolveApiToken: _FILE wins over env and is trimmed", () => {
  const dir = mkdtempSync(join(tmpdir(), "sqtk-auth-"));
  const path = join(dir, "token");
  try {
    writeFileSync(path, "filetoken\n");
    expect(
      resolveApiToken({
        SQUAWK_API_TOKEN: "envtoken",
        SQUAWK_API_TOKEN_FILE: path,
      }),
    ).toBe("filetoken");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveApiToken: unreadable _FILE ⇒ null (no crash)", () => {
  expect(
    resolveApiToken({ SQUAWK_API_TOKEN_FILE: "/no/such/secret/file" }),
  ).toBeNull();
});

// --- feature OFF: full backward compatibility --------------------------------

test("token unset: /api/lists with no header ⇒ 200", async () => {
  const res = await routeRequest(req("GET", "/api/lists"));
  expect(res.status).toBe(200);
});

// --- feature ON: additive validate-if-present --------------------------------

test("token set + valid Bearer ⇒ 200", async () => {
  process.env.SQUAWK_API_TOKEN = TOKEN;
  const res = await routeRequest(req("GET", "/api/lists", `Bearer ${TOKEN}`));
  expect(res.status).toBe(200);
});

test("token set + case-insensitive scheme ⇒ 200", async () => {
  process.env.SQUAWK_API_TOKEN = TOKEN;
  const res = await routeRequest(req("GET", "/api/lists", `bearer ${TOKEN}`));
  expect(res.status).toBe(200);
});

test("token set + wrong token ⇒ 401 { error: unauthorized }", async () => {
  process.env.SQUAWK_API_TOKEN = TOKEN;
  const res = await routeRequest(req("GET", "/api/lists", "Bearer nope"));
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "unauthorized" });
});

test("token set + non-Bearer header ⇒ 401", async () => {
  process.env.SQUAWK_API_TOKEN = TOKEN;
  const res = await routeRequest(req("GET", "/api/lists", "Basic aGk6aGk="));
  expect(res.status).toBe(401);
});

test("token set + bare 'Bearer' (malformed) ⇒ 401", async () => {
  process.env.SQUAWK_API_TOKEN = TOKEN;
  const res = await routeRequest(req("GET", "/api/lists", "Bearer"));
  expect(res.status).toBe(401);
});

test("token set + NO header ⇒ 200 (proxy/browser path)", async () => {
  process.env.SQUAWK_API_TOKEN = TOKEN;
  const res = await routeRequest(req("GET", "/api/lists"));
  expect(res.status).toBe(200);
});

// --- scope: healthz and static/SPA are never gated ---------------------------

test("token set: /healthz with no header ⇒ 200", async () => {
  process.env.SQUAWK_API_TOKEN = TOKEN;
  const res = await routeRequest(req("GET", "/healthz"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

test("token set: non-/api path is not gated (never 401)", async () => {
  process.env.SQUAWK_API_TOKEN = TOKEN;
  const res = await routeRequest(req("GET", "/styles.css"));
  expect(res.status).not.toBe(401);
});

// --- SSE stream gated identically to REST ------------------------------------

test("token set: /api/stream + wrong header ⇒ 401 (no stream opened)", async () => {
  process.env.SQUAWK_API_TOKEN = TOKEN;
  const res = await routeRequest(req("GET", "/api/stream", "Bearer nope"));
  expect(res.status).toBe(401);
});

test("token set: /api/stream + valid header ⇒ 200 event-stream", async () => {
  process.env.SQUAWK_API_TOKEN = TOKEN;
  const res = await routeRequest(req("GET", "/api/stream", `Bearer ${TOKEN}`));
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toBe("text/event-stream");
  await res.body?.cancel();
});

test("token set: /api/stream + NO header ⇒ 200 (EventSource path)", async () => {
  process.env.SQUAWK_API_TOKEN = TOKEN;
  const res = await routeRequest(req("GET", "/api/stream"));
  expect(res.status).toBe(200);
  await res.body?.cancel();
});

// --- _FILE end-to-end through the gate ---------------------------------------

test("_FILE token authorizes; the shadowed env token does not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sqtk-auth-"));
  const path = join(dir, "token");
  try {
    writeFileSync(path, "filetoken\n");
    process.env.SQUAWK_API_TOKEN = "envtoken";
    process.env.SQUAWK_API_TOKEN_FILE = path;

    const ok = await routeRequest(req("GET", "/api/lists", "Bearer filetoken"));
    expect(ok.status).toBe(200);

    const bad = await routeRequest(req("GET", "/api/lists", "Bearer envtoken"));
    expect(bad.status).toBe(401);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
