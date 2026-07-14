/**
 * Documentation drift-guard: keep `docs/architecture.md` honest against what the
 * server actually does — the API-reference table vs. the real routes, and the
 * "SSE events" line vs. the real `broadcast()` call sites.
 *
 * Why this exists: 4 of the last 5 fixes (#103/#106/#107/#109) were doc drift —
 * docs asserting state the code had moved past. The architecture.md API table
 * silently lagged the code (missing `POST /api/squawks` and `DELETE /api/squawks/:id`)
 * for weeks after #96. This test makes that class of drift fail the required
 * `test` check instead of riding along invisibly.
 *
 * The *code* side is always derived, never read from a second doc:
 *   - Routes: probe the exported `routeRequest` in-process (no port). An UNROUTED
 *     path returns the generic `404 {error:"not found"}`; a routed one returns
 *     anything else (2xx / 400 / a *specific* 404 like "list not found" / 405).
 *     So a (method, path) is "registered" iff the response is neither the
 *     generic-404 nor a 405 "method not allowed".
 *   - SSE events: scan `broadcast({ type: "…" })` call sites under `src/server/`.
 *
 * Fragility note: the "route literal" scan (test 3) is coupled to the current
 * imperative router (`segments[N] === "x"` in api.ts, `url.pathname === "x"` in
 * index.ts). If the router is ever rewritten table-style the scan finds nothing
 * and that one check passes vacuously — the behavioral checks (tests 1 & 2)
 * remain the real guarantee.
 */

import { afterAll, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

// Point the data layer at an in-memory database BEFORE importing anything that
// imports db.ts, so this file gets its own throwaway connection.
process.env.SQUAWK_DB = ":memory:";
const { routeRequest } = await import("../src/server/index.ts");
const { shutdown } = await import("../src/server/sse.ts");

// Close SSE streams + heartbeat opened by the /api/stream probe below.
afterAll(() => shutdown());

// --- sources under test ------------------------------------------------------

const archMd = readFileSync(
  new URL("../docs/architecture.md", import.meta.url).pathname,
  "utf8",
);
const apiSrc = readFileSync(
  new URL("../src/server/api.ts", import.meta.url).pathname,
  "utf8",
);
const indexSrc = readFileSync(
  new URL("../src/server/index.ts", import.meta.url).pathname,
  "utf8",
);
const serverDir = new URL("../src/server/", import.meta.url).pathname;
const serverSrc = readdirSync(serverDir)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => readFileSync(serverDir + f, "utf8"))
  .join("\n");

// --- HTTP helpers ------------------------------------------------------------

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type Method = (typeof HTTP_METHODS)[number];

function isHttpMethod(m: string): m is Method {
  return (HTTP_METHODS as readonly string[]).includes(m);
}

/** Build a bodyless JSON request — probes stay side-effect-free (no valid body). */
function req(method: string, path: string): Request {
  return new Request(`http://x${path}`, { method });
}

interface DocRoute {
  method: Method;
  /** Path template with the query string stripped, e.g. `/api/lists/:id`. */
  path: string;
}

// --- architecture.md parsing (guards itself against a moved/renamed section) -

/** The body of the `## API reference` section, up to the next `## ` heading. */
function apiSection(md: string): string {
  const marker = "## API reference";
  const start = md.indexOf(marker);
  expect(start, "architecture.md is missing its `## API reference` section").toBeGreaterThanOrEqual(0);
  const rest = md.slice(start + marker.length);
  const next = rest.indexOf("\n## ");
  return next >= 0 ? rest.slice(0, next) : rest;
}

/** Parse `| Method | Path | … |` rows into (method, path-template) pairs. */
function parseDocRoutes(section: string): DocRoute[] {
  const routes: DocRoute[] = [];
  for (const line of section.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    const method = cells[1] ?? "";
    if (!isHttpMethod(method)) continue; // skips the header + `---` separator rows
    const backticked = (cells[2] ?? "").match(/`([^`]+)`/);
    if (!backticked) continue;
    const path = (backticked[1] ?? "").split("?")[0]!.trim(); // drop query string
    routes.push({ method, path });
  }
  return routes;
}

const docRoutes = parseDocRoutes(apiSection(archMd));
const apiRestRoutes = docRoutes.filter(
  (r) => r.path.startsWith("/api/") && r.path !== "/api/stream",
);

// --- behavioral probing ------------------------------------------------------

// Seed one real list so the `/api/lists/:id/squawks` existence gate is satisfied
// and method dispatch is actually reached (that branch checks the list exists
// BEFORE the method, so a bogus id would make every method look "registered").
const seed = await (
  await routeRequest(
    new Request("http://x/api/lists", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "drift-guard-seed" }),
    }),
  )
).json();
const SEED_ID: number = seed.id;

/** Concrete path to probe for a template — real id where existence is required. */
function probePath(template: string): string {
  if (template === "/api/lists/:id/squawks") {
    return `/api/lists/${SEED_ID}/squawks`;
  }
  // Bogus but well-formed id: method dispatch on these branches is independent
  // of whether the row exists, and it never collides with the seed above.
  return template.replace(/:id/g, "999999");
}

interface Probe {
  status: number;
  error?: string;
}

async function probe(method: string, template: string): Promise<Probe> {
  const res = await routeRequest(req(method, probePath(template)));
  let error: string | undefined;
  try {
    error = ((await res.json()) as { error?: string })?.error;
  } catch {
    // Non-JSON body (e.g. a static/SPA fallthrough) — leave `error` undefined.
  }
  return { status: res.status, error };
}

/** Registered ⇔ not the generic unrouted-404 and not a 405 method-not-allowed. */
function isRegistered(p: Probe): boolean {
  if (p.status === 404 && p.error === "not found") return false;
  if (p.status === 405) return false;
  return true;
}

// --- tests -------------------------------------------------------------------

test("every documented API route is a registered route in the server", async () => {
  expect(docRoutes.length, "API-reference table parsed too few rows").toBeGreaterThan(6);

  const notRegistered: string[] = [];
  for (const r of docRoutes) {
    // `/healthz` and `/api/stream` are handled in index.ts (not the JSON API),
    // so they don't use the `{error}` envelope — check them positively.
    if (r.path === "/healthz") {
      const res = await routeRequest(req(r.method, "/healthz"));
      if (res.status !== 200) notRegistered.push(`${r.method} ${r.path} (status ${res.status})`);
      continue;
    }
    if (r.path === "/api/stream") {
      const res = await routeRequest(req(r.method, "/api/stream"));
      const ok =
        res.status === 200 &&
        (res.headers.get("content-type") ?? "").includes("text/event-stream");
      await res.body?.cancel(); // deregister the subscriber we just opened
      if (!ok) notRegistered.push(`${r.method} ${r.path} (status ${res.status})`);
      continue;
    }
    const p = await probe(r.method, r.path);
    if (!isRegistered(p)) {
      notRegistered.push(`${r.method} ${r.path} (status ${p.status}${p.error ? ` "${p.error}"` : ""})`);
    }
  }

  expect(notRegistered).toEqual([]);
});

test("no undocumented HTTP methods on documented /api paths", async () => {
  const docByPath = new Map<string, Set<string>>();
  for (const r of apiRestRoutes) {
    let methods = docByPath.get(r.path);
    if (!methods) {
      methods = new Set();
      docByPath.set(r.path, methods);
    }
    methods.add(r.method);
  }

  const mismatches: string[] = [];
  for (const [path, docMethods] of docByPath) {
    const allowed = new Set<string>();
    for (const m of HTTP_METHODS) {
      if (isRegistered(await probe(m, path))) allowed.add(m);
    }
    const extra = [...allowed].filter((m) => !docMethods.has(m));
    const missing = [...docMethods].filter((m) => !allowed.has(m));
    if (extra.length || missing.length) {
      mismatches.push(
        `${path}: code allows {${[...allowed].sort().join(",")}}, docs list {${[...docMethods].sort().join(",")}}`,
      );
    }
  }

  expect(mismatches).toEqual([]);
});

test("every route the router registers is documented", () => {
  const docPaths = new Set(docRoutes.map((r) => r.path));

  // Reconstruct api.ts route templates from its branch guards: each route is an
  // `if (segments.length === N && segments[i] === "literal" …)`. segments[0] is
  // always "api" (handleApi only runs for /api/ paths); a constrained position
  // is that literal, an unconstrained numeric position is `:id`. This is coupled
  // to the imperative router — a table-style rewrite makes it reconstruct nothing
  // and the guard-below trips, so the coupling can't rot silently.
  const codeTemplates = new Set<string>();
  for (const cond of apiSrc.matchAll(/if\s*\(([^)]*segments\.length[^)]*)\)/g)) {
    const condText = cond[1]!;
    const lenMatch = condText.match(/segments\.length\s*===\s*(\d+)/);
    if (!lenMatch) continue;
    const len = Number(lenMatch[1]);
    const literals = new Map<number, string>();
    for (const lit of condText.matchAll(/segments\[(\d+)\]\s*===\s*"([^"]+)"/g)) {
      literals.set(Number(lit[1]), lit[2]!);
    }
    const parts = ["api"];
    for (let i = 1; i < len; i++) parts.push(literals.get(i) ?? ":id");
    codeTemplates.add(`/${parts.join("/")}`);
  }
  expect(codeTemplates.size, "reconstructed no route templates from api.ts").toBeGreaterThan(0);

  // index.ts registers its two routes as full-pathname literals: `url.pathname === "/x"`.
  const indexPaths = new Set(
    [...indexSrc.matchAll(/url\.pathname\s*===\s*"([^"]+)"/g)].map((m) => m[1]!),
  );

  const undocumented = [...codeTemplates, ...indexPaths].filter((p) => !docPaths.has(p));
  expect(undocumented).toEqual([]);
});

test("SSE event types in code match the architecture.md SSE-events line", () => {
  // Code side: every `broadcast({ type: "…" })` call site under src/server/.
  const codeTypes = new Set(
    [...serverSrc.matchAll(/broadcast\(\s*\{\s*type:\s*"([^"]+)"/g)].map((m) => m[1]!),
  );
  expect(codeTypes.size, "no broadcast({type}) call sites found under src/server/").toBeGreaterThan(0);

  // Doc side: the `**SSE events:**` paragraph, up to the next blank line.
  const idx = archMd.indexOf("**SSE events:**");
  expect(idx, "architecture.md is missing its `**SSE events:**` line").toBeGreaterThanOrEqual(0);
  const block = archMd.slice(idx).split("\n\n")[0]!;
  const docTypes = new Set(
    [...block.matchAll(/\{\s*type:\s*"([^"]+)"/g)].map((m) => m[1]!),
  );
  expect(docTypes.size, "no `{type:\"…\"}` entries parsed from the SSE-events line").toBeGreaterThan(0);

  expect([...codeTypes].sort()).toEqual([...docTypes].sort());
});
