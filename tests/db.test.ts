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
