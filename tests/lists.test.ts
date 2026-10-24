import { afterEach, expect, test } from "bun:test";

import { getLists } from "../src/client/api.ts";
import { describeCounts, isChanged, isSettled } from "../src/client/counts.ts";
import { deleteReducer, exportFilename } from "../src/client/lists.ts";

// --- isSettled / isChanged (#145) ---------------------------------------------

const zero = { open: 0, confirmed: 0, rejected: 0, retired: 0, recorded: 0 };

test("isSettled: struck once nothing is open, never when empty", () => {
  expect(isSettled({ ...zero, retired: 2, confirmed: 1 })).toBe(true);
  expect(isSettled({ ...zero, open: 1, retired: 2 })).toBe(false);
  expect(isSettled(zero)).toBe(false);
});

test("describeCounts: non-zero states in state order, in words; empty says so", () => {
  expect(describeCounts({ ...zero, recorded: 1, open: 2, retired: 3 })).toBe(
    "2 open, 3 retired, 1 recorded",
  );
  expect(describeCounts(zero)).toBe("empty");
});

test("isChanged: newer than last seen badges; seen-or-older doesn't", () => {
  const list = { created_at: "2026-01-01T00:00:00.000Z", last_activity: "2026-01-02T00:00:00.000Z" };
  expect(isChanged(list, "2026-01-01T12:00:00.000Z")).toBe(true);
  expect(isChanged(list, "2026-01-02T00:00:00.000Z")).toBe(false);
  expect(isChanged(list, "2026-01-03T00:00:00.000Z")).toBe(false);
});

test("isChanged: a never-opened list badges only if it has activity since creation", () => {
  const filled = { created_at: "2026-01-01T00:00:00.000Z", last_activity: "2026-01-02T00:00:00.000Z" };
  const fresh = { created_at: "2026-01-01T00:00:00.000Z", last_activity: "2026-01-01T00:00:00.000Z" };
  expect(isChanged(filled, undefined)).toBe(true);
  expect(isChanged(fresh, undefined)).toBe(false);
});

test("isChanged: storage unavailable means no badge", () => {
  const list = { created_at: "2026-01-01T00:00:00.000Z", last_activity: "2026-01-02T00:00:00.000Z" };
  expect(isChanged(list, null)).toBe(false);
});

// --- exportFilename ----------------------------------------------------------

test("exportFilename slugifies the name and appends the id", () => {
  expect(exportFilename("Sprint 7 Regression", 3)).toBe(
    "squawk-sprint-7-regression-3.json",
  );
  expect(exportFilename("  Weird/Name!! ", 12)).toBe("squawk-weird-name-12.json");
  expect(exportFilename("", 5)).toBe("squawk-list-5.json"); // empty -> "list"
});

// --- api wrapper: error path -------------------------------------------------
// The wrappers throw on any non-2xx so callers can `try/catch` instead of
// inspecting `res.ok`. Stub `fetch` to assert both the reject and the success
// parse without a server.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("api wrapper throws on non-2xx", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "boom" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

  await expect(getLists()).rejects.toThrow();
});

test("api wrapper resolves parsed JSON on 2xx", async () => {
  const payload = [{ id: 1, name: "Preflight", next_seq: 1, created_at: "t" }];
  globalThis.fetch = (async () =>
    Response.json(payload)) as unknown as typeof fetch;

  const lists = await getLists();
  expect(lists).toHaveLength(1);
  expect(lists[0]?.name).toBe("Preflight");
});

// --- confirm-state reducer ---------------------------------------------------

test("confirm-state reducer", () => {
  // The happy path: first click -> confirming; cancel -> idle; confirm -> deleting.
  expect(deleteReducer("idle", "request")).toBe("confirming");
  expect(deleteReducer("confirming", "cancel")).toBe("idle");
  expect(deleteReducer("confirming", "confirm")).toBe("deleting");
});

test("confirm-state reducer ignores actions from illegal source states", () => {
  // Guards: stray actions are no-ops, not glitches.
  expect(deleteReducer("idle", "cancel")).toBe("idle");
  expect(deleteReducer("idle", "confirm")).toBe("idle");
  expect(deleteReducer("confirming", "request")).toBe("confirming");
  expect(deleteReducer("deleting", "request")).toBe("deleting");
  expect(deleteReducer("deleting", "cancel")).toBe("deleting");
  expect(deleteReducer("deleting", "confirm")).toBe("deleting");
});
