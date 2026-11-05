import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A database file written before #168 (no options_json, choice or note), opened
// through getDb() the way a real start-up opens it, then driven through the routes.
// That runs in a child process (tests/helpers/migrate-drive.ts): db.ts keeps one
// connection per process, and the runner's other files share theirs.

type Row = {
  id: number;
  text: string;
  state: string;
  options: string[];
  choice: string | null;
  note: string;
};

test("a pre-#168 database file opens through the routes: rows intact, then notes, options and choices round-trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "squawk-migrate-"));
  try {
    const dbFile = join(dir, "legacy.db");
    const legacy = new Database(dbFile);
    legacy.exec(`
      CREATE TABLE lists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        next_seq INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE TABLE squawks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        text TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','confirmed','rejected','retired','recorded')),
        initials TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO lists (id, name, next_seq, created_at) VALUES (1, 'Old list', 3, 't');
      INSERT INTO squawks (id, list_id, seq, text, state, initials, created_at, updated_at) VALUES
        (1, 1, 1, 'kept one', 'open', 'AA', 't1', 'u1'),
        (2, 1, 2, 'kept two', 'confirmed', 'BB', 't2', 'u2');
    `);
    legacy.close();

    const run = Bun.spawnSync(["bun", "run", join(import.meta.dir, "helpers", "migrate-drive.ts")], {
      env: { ...process.env, SQUAWK_DB: dbFile },
    });
    expect(run.stderr.toString()).toBe("");
    expect(run.exitCode).toBe(0);
    const seen = JSON.parse(run.stdout.toString()) as {
      before: Row[];
      statuses: number[];
      newId: number;
      after: Row[];
    };

    // The old rows survive, open first (#167), with the new fields defaulted.
    expect(seen.before.map((r) => [r.id, r.text, r.state])).toEqual([
      [1, "kept one", "open"],
      [2, "kept two", "confirmed"],
    ]);
    for (const r of seen.before) {
      expect(r.options).toEqual([]);
      expect(r.choice).toBeNull();
      expect(r.note).toBe("");
    }

    // The migrated table takes a note, options at create, and an answer.
    expect(seen.statuses).toEqual([200, 201, 200]);
    expect(seen.after.find((r) => r.id === 1)?.note).toBe("from the old row");
    const answered = seen.after.find((r) => r.id === seen.newId)!;
    expect([answered.state, answered.choice, answered.options]).toEqual([
      "confirmed",
      "Right",
      ["Left", "Right"],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
