import { afterEach, expect, test } from "bun:test";

import { getLists } from "../src/client/api.ts";
import { deleteReducer, exportFilename } from "../src/client/lists.ts";

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
