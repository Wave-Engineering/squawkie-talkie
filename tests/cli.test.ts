/**
 * Integration test for the `sqtk` client CLI (#95).
 *
 * Spawns the real server on an ephemeral in-memory DB + a dedicated test port,
 * then drives the CLI as a subprocess against it (SQUAWK_URL) and asserts the
 * round-trip: add → lists/show reflect it → set <list> <seq> --state persists,
 * plus the two error paths (unknown list, bad seq) exit non-zero with a message.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";

const PORT = 7794;
const BASE = `http://localhost:${PORT}`;
const ROOT = new URL("..", import.meta.url).pathname; // repo root (trailing slash)
const CLI = `${ROOT}sqtk`;

let server: ReturnType<typeof Bun.spawn> | undefined;

async function waitReady(tries = 100): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${BASE}/api/lists`);
      if (res.ok) return;
    } catch {
      // server not up yet
    }
    await Bun.sleep(50);
  }
  throw new Error("server did not become ready in time");
}

function sqtk(...args: string[]): { code: number | null; out: string; err: string } {
  const r = Bun.spawnSync([CLI, ...args], {
    env: { ...process.env, SQUAWK_URL: BASE, SQUAWK_INITIALS: "bot" },
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "src/server/index.ts"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), SQUAWK_DB: ":memory:" },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitReady();
});

afterAll(async () => {
  server?.kill();
  await server?.exited;
});

test("add quick-adds a squawk (creating the list) and normalizes initials", () => {
  const r = sqtk("add", "regression", "first concern");
  expect(r.code).toBe(0);
  expect(r.out).toContain("#1 ○ [open] first concern  (BOT)");
});

test("lists shows the created list", () => {
  const r = sqtk("lists");
  expect(r.code).toBe(0);
  expect(r.out).toContain("regression");
});

test("show reflects squawks and glyph counts, zeros omitted", () => {
  expect(sqtk("add", "regression", "second concern").code).toBe(0);
  const r = sqtk("show", "regression");
  expect(r.code).toBe(0);
  expect(r.out.split("\n")[1]).toBe("  ○2");
  expect(r.out).toContain("#1 ○ [open] first concern");
});

test("set <list> <seq> --state resolves seq→id and persists", () => {
  const s = sqtk("set", "regression", "1", "--state", "recorded");
  expect(s.code).toBe(0);
  expect(s.out).toContain("updated #1 ↗ [recorded]");
  const r = sqtk("show", "regression");
  expect(r.out.split("\n")[1]).toBe("  ○1 ↗1");
  expect(r.out).toContain("#1 ↗ [recorded]");
});

test("set --state confirmed / rejected succeed, and show prints every glyph in state order (#137)", () => {
  for (const t of ["third", "fourth", "fifth"]) {
    expect(sqtk("add", "regression", t).code).toBe(0);
  }
  // #1 recorded (above), #2 open, #3 confirmed, #4 rejected, #5 retired
  const c = sqtk("set", "regression", "3", "--state", "confirmed");
  expect(c.code).toBe(0);
  expect(c.out).toContain("updated #3 ✓ [confirmed]");
  const x = sqtk("set", "regression", "4", "--state", "rejected");
  expect(x.code).toBe(0);
  expect(x.out).toContain("updated #4 ✗ [rejected]");
  expect(sqtk("set", "regression", "5", "--state", "retired").code).toBe(0);

  const r = sqtk("show", "regression");
  expect(r.out.split("\n")[1]).toBe("  ○1 ✓1 ✗1 ◌1 ↗1");
  expect(r.out).toContain("#3 ✓ [confirmed] third");
  expect(r.out).toContain("#4 ✗ [rejected] fourth");
  expect(r.out).toContain("#5 ◌ [retired] fifth");
});

test("an unknown --state is refused by the server with a clear message", () => {
  const r = sqtk("set", "regression", "2", "--state", "maybe");
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("invalid state");
});

test("sqtk's glyph map matches STATE_GLYPHS in the server types (no drift)", async () => {
  const { SQUAWK_STATES, STATE_GLYPHS } = await import("../src/server/types.ts");
  const src = await Bun.file(CLI).text();
  const states = src.match(/def states: (\[[^\]]*\]);/)?.[1];
  const glyphs = src.match(/def glyph: (\{[^}]*\})/)?.[1];
  expect(states).toBeDefined();
  expect(glyphs).toBeDefined();
  expect(JSON.parse(states!)).toEqual([...SQUAWK_STATES]);
  // The jq object literal uses bare keys; quote them to read it as JSON.
  expect(JSON.parse(glyphs!.replace(/(\w+):/g, '"$1":'))).toEqual(STATE_GLYPHS);
});

test("unknown list exits non-zero with a clear message", () => {
  const r = sqtk("show", "does-not-exist");
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("list not found");
});

test("a seq that isn't in the list is a clear error", () => {
  const r = sqtk("set", "regression", "99", "--state", "open");
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("no squawk #99");
});

test("an API command with unset SQUAWK_URL fails loud, never silently hits localhost:3000", () => {
  // Strip SQUAWK_URL from the child env (it is pinned in the operator's shell).
  const env = { ...process.env };
  delete env.SQUAWK_URL;
  const r = Bun.spawnSync([CLI, "lists"], { env });
  expect(r.exitCode).not.toBe(0);
  const err = r.stderr.toString();
  expect(err).toContain("SQUAWK_URL is not set");
  // The old footgun default must not reappear.
  expect(err).not.toContain("localhost:3000");
});

test("sqtk help works without SQUAWK_URL — reading usage needs no config", () => {
  const env = { ...process.env };
  delete env.SQUAWK_URL;
  const r = Bun.spawnSync([CLI, "help"], { env });
  expect(r.exitCode).toBe(0);
  // usage() prints the command list to stderr; it must not demand SQUAWK_URL.
  expect(r.stderr.toString()).toContain("sqtk — client CLI");
  expect(r.stderr.toString()).not.toContain("SQUAWK_URL is not set");
});
