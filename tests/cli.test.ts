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
  expect(r.out).toContain("#1 [open] first concern  (BOT)");
});

test("lists shows the created list", () => {
  const r = sqtk("lists");
  expect(r.code).toBe(0);
  expect(r.out).toContain("regression");
});

test("show reflects squawks and (O│R│E) counts", () => {
  expect(sqtk("add", "regression", "second concern").code).toBe(0);
  const r = sqtk("show", "regression");
  expect(r.code).toBe(0);
  expect(r.out).toContain("(O2│R0│E0)");
  expect(r.out).toContain("#1 [open] first concern");
});

test("set <list> <seq> --state resolves seq→id and persists", () => {
  const s = sqtk("set", "regression", "1", "--state", "recorded");
  expect(s.code).toBe(0);
  expect(s.out).toContain("updated #1 [recorded]");
  const r = sqtk("show", "regression");
  expect(r.out).toContain("(O1│R0│E1)");
  expect(r.out).toContain("#1 [recorded]");
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
