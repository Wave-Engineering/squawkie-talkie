import { expect, test } from "bun:test";

// Point the data layer at an in-memory database BEFORE importing it, so this
// test file gets its own throwaway connection and never touches squawk.db.
process.env.SQUAWK_DB = ":memory:";
const {
  getDb,
  createList,
  listLists,
  getList,
  deleteList,
  createSquawk,
  updateSquawk,
  listSquawks,
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
