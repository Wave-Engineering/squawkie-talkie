/**
 * Integration test for the `sqtk` client CLI (#95, #141).
 *
 * Spawns the real server on an ephemeral in-memory DB + a dedicated test port,
 * then drives the CLI as a subprocess against it (SQUAWK_URL) and asserts the
 * round-trip: add → lists/show reflect it → set <list> <seq> --state persists,
 * plus the two error paths (unknown list, bad seq) exit non-zero with a message.
 *
 * The CLI runs from a throwaway git checkout, never this repo: `add` prefixes the
 * text from ./.claude/agent-identity.json + the git toplevel and writes
 * .claude/sqtk-mine.json there, so the fixture keeps both deterministic and out of
 * the working tree. Git runs hermetic (no global/system config or excludes), so the
 * info/exclude assertions see only what sqtk wrote.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 7794;
const BASE = `http://localhost:${PORT}`;
const MOCK_PORT = 7795; // a stand-in "older" server, for attach's unsupported path
const ROOT = new URL("..", import.meta.url).pathname; // repo root (trailing slash)
const CLI = `${ROOT}sqtk`;

const TMP = mkdtempSync(join(tmpdir(), "sqtk-cli-"));
const FIX = join(TMP, "sqtk-fixture"); // a git checkout with an agent identity
const SUB = join(FIX, "sub", "dir"); // inside FIX, with no identity of its own
const PLAIN = join(TMP, "plain-dir"); // not a git repo
const IMG = join(TMP, "images");
const P = "[tester·sqtk-fixture] "; // the prefix `add` applies when run from FIX
const EXCLUDE_LINE = "**/.claude/sqtk-*.json";

const childEnv: Record<string, string | undefined> = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  XDG_CONFIG_HOME: join(TMP, "xdg"), // no ~/.config/git/ignore either
};
delete childEnv.GIT_DIR;
delete childEnv.GIT_WORK_TREE;

let server: ReturnType<typeof Bun.spawn> | undefined;

interface WireSquawk {
  id: number;
  seq: number;
  text: string;
  state: string;
  created_at: string;
  image_ids: number[];
}

interface MineEntry {
  list: string;
  seq: number;
  id: number;
  created_at: string;
}

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

type RunOpts = { cwd?: string; env?: Record<string, string> };

function run(args: string[], opts: RunOpts = {}): { code: number | null; out: string; err: string } {
  const r = Bun.spawnSync([CLI, ...args], {
    cwd: opts.cwd ?? FIX,
    env: { ...childEnv, SQUAWK_URL: BASE, SQUAWK_INITIALS: "bot", ...opts.env },
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function sqtk(...args: string[]) {
  return run(args);
}

function git(cwd: string, ...args: string[]) {
  return Bun.spawnSync(["git", ...args], { cwd, env: childEnv });
}

function gitInit(dir: string): void {
  mkdirSync(dir, { recursive: true });
  expect(git(dir, "init", "-q").exitCode).toBe(0);
}

const img = (name: string) => join(IMG, name);
const sqtkLines = (stderr: string) => stderr.split("\n").filter((l) => l.startsWith("sqtk:"));
const mineOf = (dir = FIX): MineEntry[] =>
  JSON.parse(readFileSync(join(dir, ".claude", "sqtk-mine.json"), "utf8")) as MineEntry[];
const excludeLines = (dir: string) =>
  readFileSync(join(dir, ".git", "info", "exclude"), "utf8")
    .split("\n")
    .filter((l) => l === EXCLUDE_LINE);

async function listByName(name: string): Promise<{ id: number; squawks: WireSquawk[] }> {
  const res = await fetch(`${BASE}/api/lists/by-name?name=${encodeURIComponent(name)}`);
  expect(res.ok).toBe(true);
  return (await res.json()) as { id: number; squawks: WireSquawk[] };
}

async function squawk(list: string, seq: number): Promise<WireSquawk> {
  const s = (await listByName(list)).squawks.find((q) => q.seq === seq);
  expect(s).toBeDefined();
  return s!;
}

// A 1×1 PNG, and an SVG (which the server refuses, so the CLI must too).
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';

beforeAll(async () => {
  gitInit(FIX);
  mkdirSync(join(FIX, ".claude"));
  writeFileSync(join(FIX, ".claude", "agent-identity.json"), JSON.stringify({ dev_name: "tester" }));
  mkdirSync(SUB, { recursive: true });
  mkdirSync(PLAIN);

  mkdirSync(IMG);
  writeFileSync(img("tiny.png"), PNG_1PX);
  writeFileSync(img("drawing.svg"), SVG);
  writeFileSync(img("svg-in-disguise.png"), SVG);
  // Real JPEG / WebP magic under names that say nothing about the type.
  writeFileSync(img("photo.bin"), Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]));
  writeFileSync(
    img("picture.dat"),
    Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(32)]),
  );
  // PNG magic, one byte over the 2 MB cap.
  writeFileSync(img("huge.png"), Buffer.concat([PNG_1PX.subarray(0, 8), Buffer.alloc(2 * 1024 * 1024 + 1 - 8)]));

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
  rmSync(TMP, { recursive: true, force: true });
});

test("add quick-adds a squawk (creating the list) and normalizes initials", () => {
  const r = sqtk("add", "regression", "first concern");
  expect(r.code).toBe(0);
  expect(r.out).toContain(`#1 ○ [open] ${P}first concern  (BOT)`);
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
  expect(r.out).toContain(`#1 ○ [open] ${P}first concern`);
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
  expect(r.out).toContain(`#3 ✓ [confirmed] ${P}third`);
  expect(r.out).toContain(`#4 ✗ [rejected] ${P}fourth`);
  expect(r.out).toContain(`#5 ◌ [retired] ${P}fifth`);
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
  expect(sqtkLines(err)).toHaveLength(1); // one error, not a cascade
  // The old footgun default must not reappear.
  expect(err).not.toContain("localhost:3000");
});

test("a failure inside a nested helper reports once, not as a cascade of false follow-ons", () => {
  // set/attach resolve the list through nested command substitutions; without
  // inherit_errexit a die() there only ended its own subshell and the caller carried on,
  // adding e.g. a false "no squawk #1" after the real error.
  const unknown = sqtk("set", "does-not-exist", "1", "--state", "open");
  expect(unknown.code).not.toBe(0);
  expect(sqtkLines(unknown.err)).toEqual([expect.stringContaining("list not found")]);
  const down = run(["set", "regression", "1", "--state", "open"], { env: { SQUAWK_URL: "http://localhost:7796" } });
  expect(down.code).not.toBe(0);
  expect(sqtkLines(down.err)).toEqual([expect.stringContaining("cannot reach")]);
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

test("sqtk help covers every #141 addition", () => {
  const usage = sqtk("help").err;
  for (const s of ["sqtk attach <list> <seq> <file>", "sqtk mine", "sqtk walk", "--no-prefix", "--force", "→"]) {
    expect(usage).toContain(s);
  }
});

// --- #141: auto-prefix -------------------------------------------------------

test("add prefixes [<dev-name>·<repo>] from the agent identity and the git toplevel", () => {
  const r = sqtk("add", "pfx", "hello");
  expect(r.code).toBe(0);
  expect(r.out).toContain(`[open] ${P}hello  (BOT)`);
});

test("add never doubles a prefix this dev-name already wrote, and --no-prefix skips it", () => {
  const same = sqtk("add", "pfx", "[tester·elsewhere] tagged already");
  expect(same.code).toBe(0);
  expect(same.out).toContain("[open] [tester·elsewhere] tagged already  (BOT)");
  const raw = sqtk("add", "pfx", "bare words", "--no-prefix");
  expect(raw.code).toBe(0);
  expect(raw.out).toContain("[open] bare words  (BOT)");
});

test("from a subdirectory the identity and repo are the toplevel's; outside git, SQUAWK_INITIALS + cwd", () => {
  // A subdirectory has no ./.claude/agent-identity.json: the toplevel's identifies the agent.
  const sub = run(["add", "pfx", "from a subdir"], { cwd: SUB });
  expect(sub.code).toBe(0);
  expect(sub.out).toContain(`[open] ${P}from a subdir`);
  // ...and so does the initials column, which reads the same identity (SQUAWK_INITIALS unset).
  const ini = run(["add", "pfx", "initials too"], { cwd: SUB, env: { SQUAWK_INITIALS: "" } });
  expect(ini.out).toContain(`[open] ${P}initials too  (TES)`);
  // No identity anywhere and no git repo: SQUAWK_INITIALS, and the cwd's basename.
  const plain = run(["add", "pfx", "from nowhere"], { cwd: PLAIN });
  expect(plain.code).toBe(0);
  expect(plain.out).toContain("[open] [bot·plain-dir] from nowhere");
});

// --- #141: the record of mine ------------------------------------------------

test("each add appends {list, seq, id, created_at} to .claude/sqtk-mine.json at the git toplevel", async () => {
  const before = mineOf().length;
  expect(sqtk("add", "minefile", "one").code).toBe(0);
  expect(run(["add", "minefile", "two"], { cwd: SUB }).code).toBe(0); // a subdir writes the toplevel's file
  const after = mineOf();
  expect(after.length).toBe(before + 2);
  const { squawks } = await listByName("minefile");
  for (const [i, e] of after.slice(-2).entries()) {
    const sq = squawks.find((s) => s.id === e.id)!;
    expect(e).toEqual({ list: "minefile", seq: i + 1, id: sq.id, created_at: sq.created_at });
  }
  // Written by temp file + mv: no temp file is left behind, and nothing lands under the subdir.
  expect(readdirSync(join(FIX, ".claude")).sort()).toEqual(["agent-identity.json", "sqtk-mine.json"]);
  expect(existsSync(join(SUB, ".claude"))).toBe(false);
});

test("the script header documents the sqtk-mine.json shape add actually writes (the contract)", async () => {
  const src = await Bun.file(CLI).text();
  const line = src.split("\n").find((l) => l.startsWith("#") && l.includes('[{"list"'));
  expect(line).toBeDefined();
  const documented = [...line!.matchAll(/"(\w+)":/g)].map((m) => m[1]).sort();
  expect(documented).toEqual(Object.keys(mineOf().at(-1)!).sort());
});

test("add makes sqtk-mine.json uncommittable via info/exclude, writing the entry once", () => {
  const dir = join(TMP, "ignore-fixture");
  gitInit(dir);
  // An existing exclude whose last line is unterminated: the entry must not glue onto it.
  writeFileSync(join(dir, ".git", "info", "exclude"), "# mine");
  expect(git(dir, "check-ignore", "-q", ".claude/sqtk-mine.json").exitCode).toBe(1); // not ignored yet
  expect(run(["add", "ignored", "first"], { cwd: dir }).code).toBe(0);
  expect(git(dir, "check-ignore", "-q", ".claude/sqtk-mine.json").exitCode).toBe(0);
  expect(git(dir, "status", "--porcelain").stdout.toString()).toBe("");
  expect(run(["add", "ignored", "second"], { cwd: dir }).code).toBe(0);
  expect(excludeLines(dir)).toHaveLength(1);
  expect(readFileSync(join(dir, ".git", "info", "exclude"), "utf8")).toBe(`# mine\n${EXCLUDE_LINE}\n`);
});

test("in a linked worktree (how fleet agents run) the entry goes to the shared info/exclude", () => {
  const main = join(TMP, "wt-main");
  const wt = join(TMP, "wt-linked");
  gitInit(main);
  expect(git(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x").exitCode).toBe(0);
  expect(git(main, "worktree", "add", "-q", wt).exitCode).toBe(0);
  const r = run(["add", "worktree", "from a worktree"], { cwd: wt });
  expect(r.code).toBe(0);
  // The prefix names the repo (the main checkout's folder), not the worktree's folder.
  expect(r.out).toContain("[open] [bot·wt-main] from a worktree");
  expect(existsSync(join(wt, ".claude", "sqtk-mine.json"))).toBe(true);
  expect(git(wt, "check-ignore", "-q", ".claude/sqtk-mine.json").exitCode).toBe(0);
  expect(excludeLines(main)).toHaveLength(1); // --git-path answers absolute here: the common dir's
});

// --- #147: reserved list names -------------------------------------------------

test("triage resolves to <repo>:triage for every list command, and add says so", async () => {
  const add = sqtk("add", "triage", "a triage item");
  expect(add.code).toBe(0);
  expect(sqtkLines(add.err)).toEqual(['sqtk: "triage" resolved to "sqtk-fixture:triage"']);
  expect((await listByName("sqtk-fixture:triage")).squawks.map((s) => s.text)).toContain(`${P}a triage item`);
  expect(mineOf().at(-1)?.list).toBe("sqtk-fixture:triage");

  const show = sqtk("show", "triage");
  expect(show.code).toBe(0);
  expect(show.out).toContain("sqtk-fixture:triage");
  expect(sqtkLines(show.err)).toEqual([]); // only add reports a resolution inside git
  expect(sqtk("walk", "triage").out).toContain(`${P}a triage item`);
  const seq = String((await listByName("sqtk-fixture:triage")).squawks.at(-1)?.seq);
  expect(sqtk("set", "triage", seq, "--state", "retired").code).toBe(0);
  expect((await squawk("sqtk-fixture:triage", Number(seq))).state).toBe("retired");
  expect(sqtk("attach", "triage", seq, img("tiny.png")).code).toBe(0);
});

test("needs resolves to bj:needs", async () => {
  const add = sqtk("add", "needs", "a need →");
  expect(add.code).toBe(0);
  expect(sqtkLines(add.err)).toEqual(['sqtk: "needs" resolved to "bj:needs"']);
  expect((await listByName("bj:needs")).squawks.map((s) => s.text)).toContain(`${P}a need →`);
  expect(sqtk("walk", "needs").out).toContain(`${P}a need →`);
});

test("from a linked worktree, triage names the main checkout's repo", async () => {
  const main = join(TMP, "widget");
  const wt = join(TMP, "widget-wt-7");
  gitInit(main);
  expect(git(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x").exitCode).toBe(0);
  expect(git(main, "worktree", "add", "-q", wt).exitCode).toBe(0);
  const r = run(["add", "triage", "from the worktree"], { cwd: wt });
  expect(r.code).toBe(0);
  expect(sqtkLines(r.err)).toEqual(['sqtk: "triage" resolved to "widget:triage"']);
  expect((await listByName("widget:triage")).squawks).toHaveLength(1);
});

test("outside a git checkout, triage falls back to the cwd's name and every command says so", () => {
  // Its own non-git dir: PLAIN's record of mine is asserted exactly elsewhere.
  const dir = join(TMP, "loose-dir");
  mkdirSync(dir);
  const add = run(["add", "triage", "from nowhere"], { cwd: dir });
  expect(add.code).toBe(0);
  const note = 'sqtk: "triage" resolved to "loose-dir:triage" (not in a git checkout)';
  expect(sqtkLines(add.err)).toEqual([note]);
  const walk = run(["walk", "triage"], { cwd: dir });
  expect(walk.code).toBe(0);
  expect(sqtkLines(walk.err)).toEqual([note]);
});

test("other names pass through unchanged; new and rmlist take reserved names literally", async () => {
  const other = sqtk("add", "other:triage", "qualified");
  expect(other.code).toBe(0);
  expect(sqtkLines(other.err)).toEqual([]);
  expect((await listByName("other:triage")).squawks).toHaveLength(1);
  expect(sqtk("add", "triage-ish", "near miss").code).toBe(0);
  expect((await listByName("triage-ish")).squawks).toHaveLength(1);

  // rmlist needs must never reach bj:needs: with no list literally named "needs", it fails.
  const before = (await listByName("bj:needs")).squawks.length;
  expect(sqtk("rmlist", "needs", "--yes").code).not.toBe(0);
  expect((await listByName("bj:needs")).squawks).toHaveLength(before);
  const made = sqtk("new", "triage");
  expect(made.code).toBe(0);
  expect(made.out).toContain("created list #");
  expect((await listByName("triage")).squawks).toHaveLength(0);
});

test("help documents the reserved names", () => {
  const usage = sqtk("help").err;
  expect(usage).toContain('"triage"');
  expect(usage).toContain('"bj:needs"');
});

test("parallel adds in one checkout (an agent's parallel tool calls) lose no record", async () => {
  const dir = join(TMP, "parallel-fixture");
  gitInit(dir);
  expect(sqtk("new", "parallel").code).toBe(0); // so the adds race only on the record, not the list
  const N = 8;
  const procs = Array.from({ length: N }, (_, i) =>
    Bun.spawn([CLI, "add", "parallel", `item ${i}`], {
      cwd: dir,
      env: { ...childEnv, SQUAWK_URL: BASE, SQUAWK_INITIALS: "bot" },
      stdout: "ignore",
      stderr: "pipe",
    }),
  );
  expect(await Promise.all(procs.map((p) => p.exited))).toEqual(Array(N).fill(0));
  // Every add really took the lock: none fell back to the unlocked write with a warning.
  const errs = await Promise.all(procs.map((p) => new Response(p.stderr).text()));
  expect(errs).toEqual(Array(N).fill(""));
  const ids = mineOf(dir).map((e) => e.id);
  expect(ids).toHaveLength(N);
  expect(new Set(ids).size).toBe(N);
  expect(excludeLines(dir)).toHaveLength(1);
});

test("a flock that cannot lock at all (e.g. NFS) warns and still records, never failing the add", () => {
  // A stub flock that fails the way a non-conflict error does: with a message (a real
  // conflict under -n is silent).
  const bin = join(TMP, "stub-bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "flock"), "#!/bin/sh\necho 'flock: 3: Bad file descriptor' >&2\nexit 1\n", { mode: 0o755 });
  const dir = join(TMP, "nolock-fixture");
  gitInit(dir);
  const r = run(["add", "nolock", "still recorded"], { cwd: dir, env: { PATH: `${bin}:${process.env.PATH}` } });
  expect(r.code).toBe(0);
  expect(r.err).toContain("warning: cannot lock");
  expect(r.err).toContain("Bad file descriptor");
  expect(mineOf(dir)).toHaveLength(1);
});

test("a record of mine that isn't a JSON array is left untouched, and the add says so", () => {
  const dir = join(TMP, "corrupt-dir");
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, ".claude", "sqtk-mine.json"), "not json");
  const r = run(["add", "corrupt", "lost?"], { cwd: dir });
  expect(r.code).not.toBe(0);
  expect(r.err).toContain('squawk #1 was added to "corrupt"');
  expect(r.err).toContain("not a JSON array");
  expect(readFileSync(join(dir, ".claude", "sqtk-mine.json"), "utf8")).toBe("not json");
});

// --- #141: dedup -------------------------------------------------------------

test("add refuses an open duplicate with exit 3 naming its #seq; --force adds it anyway", () => {
  expect(sqtk("add", "dedup", "same thing").code).toBe(0); // #1
  const recorded = mineOf().length;
  const dup = sqtk("add", "dedup", "same thing");
  expect(dup.code).toBe(3);
  expect(dup.err).toContain("open squawk #1");
  expect(dup.err).toContain("--force");
  // Identical *after prefixing*: the pre-prefixed spelling is the same squawk.
  expect(sqtk("add", "dedup", `${P}same thing`).code).toBe(3);
  expect(mineOf().length).toBe(recorded); // a refusal records nothing
  const forced = sqtk("add", "dedup", "same thing", "--force");
  expect(forced.code).toBe(0);
  expect(forced.out).toContain("squawked #2");
});

test("dedup only counts open squawks", () => {
  for (const seq of ["1", "2"]) {
    expect(sqtk("set", "dedup", seq, "--state", "retired").code).toBe(0);
  }
  const r = sqtk("add", "dedup", "same thing");
  expect(r.code).toBe(0);
  expect(r.out).toContain("squawked #3");
});

// --- #141: attach ------------------------------------------------------------

test("attach uploads a small PNG", async () => {
  expect(sqtk("add", "pics", "needs a picture").code).toBe(0);
  const r = sqtk("attach", "pics", "1", img("tiny.png"));
  expect(r.code).toBe(0);
  expect(r.out).toContain("(1/5 images)");
  expect((await squawk("pics", 1)).image_ids).toHaveLength(1);
});

test("attach types files by magic bytes, not extension: SVG is refused, even named .png", async () => {
  for (const f of ["drawing.svg", "svg-in-disguise.png"]) {
    const r = sqtk("attach", "pics", "1", img(f));
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("not a jpeg, png or webp image");
  }
  // Real JPEG and WebP content is accepted under any name and stored as its real type.
  expect(sqtk("attach", "pics", "1", img("photo.bin"), img("picture.dat")).code).toBe(0);
  const sq = await squawk("pics", 1);
  const types = await Promise.all(
    sq.image_ids.map(async (i) => (await fetch(`${BASE}/api/squawks/${sq.id}/images/${i}`)).headers.get("content-type")),
  );
  expect(types).toEqual(["image/png", "image/jpeg", "image/webp"]);
});

test("attach refuses a file over 2 MB, with a downscale hint", async () => {
  const r = sqtk("attach", "pics", "1", img("huge.png"));
  expect(r.code).not.toBe(0);
  expect(r.err).toContain("over the 2 MB limit per image");
  expect(r.err).toContain("magick in.png -resize 1600x1600\\> out.webp");
  expect((await squawk("pics", 1)).image_ids).toHaveLength(3);
});

test("attach counts the images already attached: past 5 is refused before any upload", async () => {
  const tiny = img("tiny.png");
  const over = sqtk("attach", "pics", "1", tiny, tiny, tiny); // 3 held + 3 > 5
  expect(over.code).not.toBe(0);
  expect(over.err).toContain("limit of 5 per squawk");
  expect((await squawk("pics", 1)).image_ids).toHaveLength(3); // all or nothing
  expect(sqtk("attach", "pics", "1", tiny, tiny).code).toBe(0); // → 5
  const sixth = sqtk("attach", "pics", "1", tiny);
  expect(sixth.code).not.toBe(0);
  expect(sixth.err).toContain("already has 5 image(s)");
  expect((await squawk("pics", 1)).image_ids).toHaveLength(5);
});

test("attach against a server without image support says so plainly and uploads nothing", async () => {
  const posts: string[] = [];
  // An older server: its squawks carry no image_ids.
  const mock = Bun.serve({
    port: MOCK_PORT,
    fetch(req) {
      if (req.method !== "GET") {
        posts.push(new URL(req.url).pathname);
        return Response.json({ error: "not found" }, { status: 404 });
      }
      const at = "2026-01-01 00:00:00";
      return Response.json({
        id: 1,
        name: "old",
        created_at: at,
        squawks: [{ id: 1, list_id: 1, seq: 1, text: "x", state: "open", initials: "AI", created_at: at, updated_at: at }],
      });
    },
  });
  try {
    // Async spawn: a sync one would block the event loop this mock answers on.
    const p = Bun.spawn([CLI, "attach", "old", "1", img("tiny.png")], {
      cwd: FIX,
      env: { ...childEnv, SQUAWK_URL: `http://localhost:${MOCK_PORT}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await p.exited).not.toBe(0);
    expect(await new Response(p.stderr).text()).toContain("not supported by this server");
    expect(posts).toEqual([]);
  } finally {
    mock.stop(true);
  }
});

// --- #141: mine --------------------------------------------------------------

test("mine shows this checkout's squawks with their current state, following a set", () => {
  expect(sqtk("add", "minewatch", "watch me").code).toBe(0);
  expect(sqtk("mine").out).toContain(`minewatch #1 ○ [open] ${P}watch me`);
  expect(sqtk("set", "minewatch", "1", "--state", "confirmed", "--text", `${P}watch me → done`).code).toBe(0);
  const r = sqtk("mine");
  expect(r.code).toBe(0);
  expect(r.out).toContain(`minewatch #1 ✓ [confirmed] ${P}watch me → done`);
  const json = JSON.parse(sqtk("mine", "--json").out) as (MineEntry & { state: string; text: string })[];
  expect(json.find((e) => e.list === "minewatch")).toMatchObject({ seq: 1, state: "confirmed" });
});

test("mine marks a squawk whose list is gone, and reads only this checkout's record", () => {
  expect(sqtk("add", "doomed", "short-lived").code).toBe(0);
  expect(sqtk("rmlist", "doomed", "--yes").code).toBe(0);
  expect(sqtk("mine").out).toContain("doomed #1 (gone from the server)");
  // PLAIN keeps its own record: only the one squawk added from there.
  expect(run(["mine"], { cwd: PLAIN }).out).toMatch(/^pfx #\d+ ○ \[open\] \[bot·plain-dir\] from nowhere\n$/);
});

test("mine with nothing recorded says so", () => {
  const dir = join(TMP, "fresh-dir");
  mkdirSync(dir);
  const r = run(["mine"], { cwd: dir });
  expect(r.code).toBe(0);
  expect(r.out).toBe("(no squawks recorded in this checkout yet)\n");
});

// --- #141: walk --------------------------------------------------------------

test("walk prints the list's open squawks oldest first, one '#seq  <text>' per line", () => {
  for (const t of ["alpha", "bravo", "charlie", "delta"]) {
    expect(sqtk("add", "walkies", t).code).toBe(0);
  }
  expect(sqtk("set", "walkies", "2", "--state", "retired").code).toBe(0);
  expect(sqtk("set", "walkies", "4", "--state", "confirmed").code).toBe(0);
  const r = sqtk("walk", "walkies");
  expect(r.code).toBe(0);
  expect(r.out).toBe(`#1  ${P}alpha\n#3  ${P}charlie\n`);
});

test("walk on a list with nothing open says so", () => {
  expect(sqtk("new", "quiet").code).toBe(0);
  expect(sqtk("walk", "quiet").out).toBe("(no open squawks)\n");
});

// --- #141: the set --text guard ----------------------------------------------

test("set --text refuses to drop the trailing → answer; keeping it, or --force, passes", async () => {
  expect(sqtk("add", "answers", "ship it?").code).toBe(0);
  // No answer yet, so any text goes.
  expect(sqtk("set", "answers", "1", "--text", `${P}ship it? → yes, Friday`).code).toBe(0);

  const drop = sqtk("set", "answers", "1", "--text", `${P}ship it now?`);
  expect(drop.code).not.toBe(0);
  expect(drop.err).toContain('answer "→ yes, Friday"');
  expect(drop.err).toContain("--force");
  expect((await squawk("answers", 1)).text).toBe(`${P}ship it? → yes, Friday`); // untouched

  // Rewording the question, or answering further, keeps the answer.
  expect(sqtk("set", "answers", "1", "--text", `${P}ship it now? → yes, Friday`).code).toBe(0);
  expect(sqtk("set", "answers", "1", "--text", `${P}ship it now? → yes, Friday → shipped`).code).toBe(0);

  const forced = sqtk("set", "answers", "1", "--text", "start over", "--force");
  expect(forced.code).toBe(0);
  expect(forced.out).toContain("start over");
});
