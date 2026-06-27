import { expect, test } from "bun:test";
import type { Squawk } from "../src/server/types.ts";
import {
  countByState,
  debounce,
  onEnter,
  stateClass,
} from "../src/client/detail.ts";

// --- stateClass --------------------------------------------------------------

test("stateClass maps state -> css class", () => {
  expect(stateClass("open")).toBe("state-open");
  expect(stateClass("retired")).toBe("state-retired");
  expect(stateClass("recorded")).toBe("state-recorded");
});

// --- countByState ------------------------------------------------------------

test("countByState tallies open / retired / recorded", () => {
  const sq = (id: number, state: Squawk["state"]): Squawk => ({
    id,
    list_id: 1,
    seq: id,
    text: "",
    state,
    initials: "BJ",
    created_at: "t",
    updated_at: "t",
  });
  expect(countByState([])).toEqual({ open: 0, retired: 0, recorded: 0 });
  expect(
    countByState([
      sq(1, "open"),
      sq(2, "open"),
      sq(3, "retired"),
      sq(4, "recorded"),
    ]),
  ).toEqual({ open: 2, retired: 1, recorded: 1 });
});

// --- debounce ----------------------------------------------------------------

test("debounce fires once after idle", async () => {
  let calls = 0;
  const d = debounce(() => {
    calls += 1;
  }, 10);

  // Rapid calls coalesce — nothing fires until the idle window elapses.
  d();
  d();
  d();
  expect(calls).toBe(0);

  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(calls).toBe(1);
});

test("debounce flush fires the pending call immediately", async () => {
  let calls = 0;
  const d = debounce(() => {
    calls += 1;
  }, 1000);

  d();
  d.flush();
  expect(calls).toBe(1);

  // The original timer must not fire a second time after flushing.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(calls).toBe(1);
});

test("debounce flush is a no-op when nothing is pending", () => {
  let calls = 0;
  const d = debounce(() => {
    calls += 1;
  }, 10);

  d.flush();
  expect(calls).toBe(0);
});

test("debounce cancel drops the pending call", async () => {
  let calls = 0;
  const d = debounce(() => {
    calls += 1;
  }, 10);

  d();
  d.cancel();
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(calls).toBe(0);
});

// --- onEnter -----------------------------------------------------------------

test("enter handler commits + targets new box", () => {
  // Enter inside an existing row commits the edit and moves focus to row 0.
  expect(onEnter({ key: "Enter", isNewRow: false, value: "gear up" })).toEqual({
    action: "commit",
    focusNewBox: true,
  });
});

test("enter handler creates from the new box and keeps focus there", () => {
  expect(onEnter({ key: "Enter", isNewRow: true, value: "gear up" })).toEqual({
    action: "create",
    focusNewBox: true,
  });
});

test("enter handler ignores an empty new box", () => {
  expect(onEnter({ key: "Enter", isNewRow: true, value: "   " })).toEqual({
    action: "ignore",
    focusNewBox: false,
  });
});

test("enter handler ignores non-Enter keys", () => {
  expect(onEnter({ key: "a", isNewRow: false, value: "hi" }).action).toBe(
    "ignore",
  );
});
