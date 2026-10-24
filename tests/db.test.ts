import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

// Point the data layer at an in-memory database BEFORE importing it, so this
// test file gets its own throwaway connection and never touches squawk.db.
process.env.SQUAWK_DB = ":memory:";
const {
  getDb,
  createList,
  listLists,
  getList,
  getListByName,
  deleteList,
  createSquawk,
  updateSquawk,
  listSquawks,
  migrateSquawkImages,
  migrateSquawkStates,
  listListsWithStats,
  getListWithStats,
} = await import("../src/server/db.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("createList and getList round-trip", () => {
  const list = createList("Preflight");
  expect(list.id).toBeGreaterThan(0);
  expect(list.name).toBe("Preflight");
  expect(list.next_seq).toBe(1);
  expect(getList(list.id)).toEqual(list);
  expect(getList(999999)).toBeNull();
  expect(listLists().some((l) => l.id === list.id)).toBe(true);
});

test("getListByName returns the oldest exact match, or null", () => {
  const first = createList("Dupe Name");
  createList("Dupe Name"); // a later list with the same name
  expect(getListByName("Dupe Name")?.id).toBe(first.id); // oldest wins
  expect(getListByName("no such list")).toBeNull();
  expect(getListByName("dupe name")).toBeNull(); // exact match (case-sensitive)
});

test("seq is monotonic and never reused", () => {
  const list = createList("Climb");
  const s1 = createSquawk(list.id, "first", "AA");
  const s2 = createSquawk(list.id, "second", "BB");
  expect(s1.seq).toBe(1);
  expect(s2.seq).toBe(2);

  // Delete the most recent squawk directly; seq allocation must not roll back.
  getDb().query("DELETE FROM squawks WHERE id = ?").run(s2.id);

  const s3 = createSquawk(list.id, "third", "CC");
  expect(s3.seq).toBe(3); // not 2 — seq keeps climbing
});

test("deleteList cascades squawks", () => {
  const list = createList("Expunge");
  createSquawk(list.id, "x", "AA");
  createSquawk(list.id, "y", "BB");
  expect(listSquawks(list.id)).toHaveLength(2);

  expect(deleteList(list.id)).toBe(true);
  expect(getList(list.id)).toBeNull();
  expect(listSquawks(list.id)).toHaveLength(0);

  // Deleting a non-existent list reports no change.
  expect(deleteList(list.id)).toBe(false);
});

test("listSquawks newest first", () => {
  const list = createList("Order");
  createSquawk(list.id, "a", "AA");
  createSquawk(list.id, "b", "BB");
  createSquawk(list.id, "c", "CC");

  const rows = listSquawks(list.id);
  expect(rows.map((r) => r.seq)).toEqual([3, 2, 1]);
  expect(rows.map((r) => r.text)).toEqual(["c", "b", "a"]);
});

test("updateSquawk sets state and updated_at", async () => {
  const list = createList("Update");
  const s = createSquawk(list.id, "hello", "AA");
  expect(s.state).toBe("open");

  await sleep(5); // ensure a strictly later ISO timestamp

  const updated = updateSquawk(s.id, { state: "retired", text: "changed" }, "ZZ");
  expect(updated.state).toBe("retired");
  expect(updated.text).toBe("changed");
  expect(updated.initials).toBe("ZZ");
  expect(updated.updated_at > s.updated_at).toBe(true);
  // created_at is untouched by an update.
  expect(updated.created_at).toBe(s.created_at);
});

// --- squawk_images 1:1 → 1:N migration (#127) --------------------------------
// These build their own throwaway connections (not getDb()'s memoized one) so
// they can seed the *legacy* table shape and run the migration against it.

test("migrateSquawkImages rebuilds the legacy 1:1 table onto position 0 (idempotent)", () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(
    "CREATE TABLE squawks (id INTEGER PRIMARY KEY AUTOINCREMENT); INSERT INTO squawks (id) VALUES (1);",
  );
  // The legacy 1:1 shape: squawk_id as PK, one image.
  db.exec(`
    CREATE TABLE squawk_images (
      squawk_id INTEGER PRIMARY KEY REFERENCES squawks(id) ON DELETE CASCADE,
      mime TEXT NOT NULL,
      bytes BLOB NOT NULL,
      byte_size INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const bytes = new Uint8Array([1, 2, 3, 4]);
  db.query(
    "INSERT INTO squawk_images (squawk_id, mime, bytes, byte_size, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(1, "image/png", bytes, bytes.byteLength, "t");

  migrateSquawkImages(db);

  // New shape: own id PK + position; the legacy image is mapped to position 0
  // with its bytes/mime intact.
  const cols = (
    db.query("PRAGMA table_info(squawk_images)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  expect(cols).toContain("id");
  expect(cols).toContain("position");

  const row = db
    .query(
      "SELECT squawk_id, position, mime, bytes, byte_size FROM squawk_images",
    )
    .get() as {
    squawk_id: number;
    position: number;
    mime: string;
    bytes: Uint8Array;
    byte_size: number;
  };
  expect(row.squawk_id).toBe(1);
  expect(row.position).toBe(0);
  expect(row.mime).toBe("image/png");
  expect(new Uint8Array(row.bytes)).toEqual(bytes);
  expect(row.byte_size).toBe(4);

  // Idempotent: a second run is a no-op, and the table now accepts a 2nd image.
  migrateSquawkImages(db);
  db.query(
    "INSERT INTO squawk_images (squawk_id, position, mime, bytes, byte_size, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(1, 1, "image/png", bytes, bytes.byteLength, "t");
  const count = (
    db
      .query("SELECT COUNT(*) AS n FROM squawk_images WHERE squawk_id = 1")
      .get() as { n: number }
  ).n;
  expect(count).toBe(2);
});

test("migrateSquawkImages creates the 1:N table fresh on an empty DB", () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("CREATE TABLE squawks (id INTEGER PRIMARY KEY AUTOINCREMENT)");
  migrateSquawkImages(db);
  const cols = (
    db.query("PRAGMA table_info(squawk_images)").all() as Array<{ name: string }>
  ).map((c) => c.name);
  for (const c of ["id", "squawk_id", "position", "mime", "bytes", "byte_size"]) {
    expect(cols).toContain(c);
  }
});

// --- squawks.state CHECK widening (#137) ----------------------------------------

test("the live schema accepts every state and rejects an unknown one", () => {
  const list = createList("States");
  const s = createSquawk(list.id, "verdict", "AA");
  for (const state of ["confirmed", "rejected", "retired", "recorded", "open"] as const) {
    expect(updateSquawk(s.id, { state }, "AA").state).toBe(state);
  }
  expect(() =>
    getDb().query("UPDATE squawks SET state = 'maybe' WHERE id = ?").run(s.id),
  ).toThrow(/CHECK constraint failed/);
});

/** The `squawks` table exactly as every DB before #137 was created. */
const LEGACY_SQUAWKS_SQL = `
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
    state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','retired','recorded')),
    initials TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

test("migrateSquawkStates widens a legacy CHECK without losing rows, images or the id high-water mark", () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(LEGACY_SQUAWKS_SQL);
  migrateSquawkImages(db); // the current squawk_images, FK'd ON DELETE CASCADE to squawks
  db.exec(`
    INSERT INTO lists (id, name, next_seq, created_at) VALUES (1, 'L', 5, 't');
    INSERT INTO squawks (id, list_id, seq, text, state, initials, created_at, updated_at) VALUES
      (1, 1, 1, 'one', 'open', 'AA', 't1', 'u1'),
      (2, 1, 2, 'two', 'retired', 'BB', 't2', 'u2'),
      (3, 1, 3, 'three', 'recorded', 'CC', 't3', 'u3'),
      (4, 1, 4, 'four', 'open', 'DD', 't4', 'u4');
    DELETE FROM squawks WHERE id = 4; -- the newest is gone, so the high-water (4) > max(id) (3)
  `);
  const bytes = new Uint8Array([9, 8, 7]);
  db.query(
    "INSERT INTO squawk_images (squawk_id, position, mime, bytes, byte_size, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(2, 0, "image/png", bytes, bytes.byteLength, "t");
  const before = db.query("SELECT * FROM squawks ORDER BY id").all();
  expect(() =>
    db.query("UPDATE squawks SET state = 'confirmed' WHERE id = 1").run(),
  ).toThrow(/CHECK constraint failed/);

  migrateSquawkStates(db);

  // Every row survives byte-for-byte, ids included, and the image was NOT
  // cascade-deleted by the DROP TABLE inside the rebuild.
  expect(db.query("SELECT * FROM squawks ORDER BY id").all()).toEqual(before);
  const img = db
    .query("SELECT squawk_id, bytes FROM squawk_images")
    .all() as Array<{ squawk_id: number; bytes: Uint8Array }>;
  expect(img).toHaveLength(1);
  expect(img[0]!.squawk_id).toBe(2);
  expect(new Uint8Array(img[0]!.bytes)).toEqual(bytes);

  // The new states insert; an unknown one is still rejected.
  db.query("UPDATE squawks SET state = 'confirmed' WHERE id = 1").run();
  db.query("UPDATE squawks SET state = 'rejected' WHERE id = 3").run();
  expect(() =>
    db.query("UPDATE squawks SET state = 'maybe' WHERE id = 1").run(),
  ).toThrow(/CHECK constraint failed/);

  // A deleted id is never reused: the next insert gets 5, not 4.
  const next = db
    .query(
      "INSERT INTO squawks (list_id, seq, text, initials, created_at, updated_at) VALUES (1, 5, 'five', 'EE', 't', 't') RETURNING id",
    )
    .get() as { id: number };
  expect(next.id).toBe(5);

  // Foreign keys are back on, and still cascade.
  expect(
    (db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys,
  ).toBe(1);
  db.query("DELETE FROM squawks WHERE id = 2").run();
  expect(db.query("SELECT COUNT(*) AS n FROM squawk_images").get()).toEqual({ n: 0 });
});

test("migrateSquawkStates is a no-op on a current or empty DB", () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(LEGACY_SQUAWKS_SQL);
  migrateSquawkStates(db);
  const sql = () =>
    (
      db.query("SELECT sql FROM sqlite_master WHERE name = 'squawks'").get() as {
        sql: string;
      }
    ).sql;
  const migrated = sql();
  expect(migrated).toContain("'confirmed'");
  migrateSquawkStates(db); // second run: nothing to do
  expect(sql()).toBe(migrated);

  // No squawks table yet (a fresh DB before its CREATE): nothing happens.
  const fresh = new Database(":memory:");
  migrateSquawkStates(fresh);
  expect(
    fresh.query("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'squawks'").get(),
  ).toEqual({ n: 0 });
});

// --- list stats (#145) ---------------------------------------------------------

test("list stats count every state, zero-filled, for mixed and empty lists", () => {
  const mixed = createList("Stats mixed");
  const a = createSquawk(mixed.id, "a", "BJ");
  const b = createSquawk(mixed.id, "b", "BJ");
  createSquawk(mixed.id, "c", "BJ");
  updateSquawk(a.id, { state: "retired" });
  updateSquawk(b.id, { state: "confirmed" });
  const empty = createList("Stats empty");

  const byId = new Map(listListsWithStats().map((l) => [l.id, l]));
  expect(byId.get(mixed.id)?.counts).toEqual({
    open: 1,
    confirmed: 1,
    rejected: 0,
    retired: 1,
    recorded: 0,
  });
  expect(byId.get(empty.id)?.counts).toEqual({
    open: 0,
    confirmed: 0,
    rejected: 0,
    retired: 0,
    recorded: 0,
  });
  expect(byId.get(empty.id)?.last_activity).toBe(empty.created_at);
  // Every list is there once, oldest first, with its own fields intact.
  const ids = listListsWithStats().map((l) => l.id);
  expect(ids).toEqual(listLists().map((l) => l.id));
  expect(byId.get(mixed.id)?.name).toBe("Stats mixed");
});

test("list stats for every list come from a single query", () => {
  createList("Stats q1");
  createList("Stats q2");
  const db = getDb();
  const original = db.query.bind(db);
  let calls = 0;
  db.query = ((sql: string) => {
    calls += 1;
    return original(sql);
  }) as typeof db.query;
  try {
    expect(listListsWithStats().length).toBeGreaterThanOrEqual(2);
  } finally {
    db.query = original;
  }
  expect(calls).toBe(1);
});

test("last_activity moves on a create and on an update", async () => {
  const list = createList("Stats activity");
  expect(getListWithStats(list.id)?.last_activity).toBe(list.created_at);

  await sleep(5);
  const sq = createSquawk(list.id, "first", "BJ");
  expect(getListWithStats(list.id)?.last_activity).toBe(sq.created_at);

  await sleep(5);
  const updated = updateSquawk(sq.id, { text: "edited" });
  expect(getListWithStats(list.id)?.last_activity).toBe(updated.updated_at);
  expect(updated.updated_at > sq.created_at).toBe(true);

  expect(getListWithStats(999999)).toBeNull();
});
