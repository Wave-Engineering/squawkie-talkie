import { expect, test } from "bun:test";
import type { Squawk } from "../src/server/types.ts";
import {
  CLAMP_LINES,
  countByState,
  cycleState,
  debounce,
  fitWithin,
  onEnter,
  overflowsClamp,
  stateClass,
} from "../src/client/detail.ts";
import { changedSquawkIds } from "../src/client/counts.ts";

// --- changedSquawkIds (#145) ---------------------------------------------------

test("changedSquawkIds: rows created or updated after last seen", () => {
  const t = (d: number) => `2026-01-0${d}T00:00:00.000Z`;
  const squawks = [
    { id: 1, created_at: t(1), updated_at: t(1) }, // before
    { id: 2, created_at: t(1), updated_at: t(3) }, // updated after
    { id: 3, created_at: t(3), updated_at: t(3) }, // created after
    { id: 4, created_at: t(2), updated_at: t(2) }, // exactly at last seen
  ];
  expect(changedSquawkIds(squawks, t(2))).toEqual([2, 3]);
});

test("changedSquawkIds: nothing marked when never opened or storage is out", () => {
  const squawks = [{ id: 1, created_at: "2026-01-05T00:00:00.000Z", updated_at: "2026-01-05T00:00:00.000Z" }];
  expect(changedSquawkIds(squawks, undefined)).toEqual([]);
  expect(changedSquawkIds(squawks, null)).toEqual([]);
});

// --- stateClass --------------------------------------------------------------

test("stateClass maps state -> css class", () => {
  expect(stateClass("open")).toBe("state-open");
  expect(stateClass("confirmed")).toBe("state-confirmed");
  expect(stateClass("rejected")).toBe("state-rejected");
  expect(stateClass("retired")).toBe("state-retired");
  expect(stateClass("recorded")).toBe("state-recorded");
});

// --- countByState ------------------------------------------------------------

test("countByState tallies every state", () => {
  const sq = (id: number, state: Squawk["state"]): Squawk => ({
    id,
    list_id: 1,
    seq: id,
    text: "",
    state,
    initials: "BJ",
    created_at: "t",
    updated_at: "t",
    has_image: false,
    image_ids: [],
  });
  expect(countByState([])).toEqual({
    open: 0,
    confirmed: 0,
    rejected: 0,
    retired: 0,
    recorded: 0,
  });
  expect(
    countByState([
      sq(1, "open"),
      sq(2, "open"),
      sq(3, "retired"),
      sq(4, "recorded"),
      sq(5, "confirmed"),
      sq(6, "rejected"),
      sq(7, "rejected"),
    ]),
  ).toEqual({ open: 2, confirmed: 1, rejected: 2, retired: 1, recorded: 1 });
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

// --- cycleState ---------------------------------------------------------------

test("cycleState forward visits all five states and wraps", () => {
  expect(cycleState("open", "forward")).toBe("confirmed");
  expect(cycleState("confirmed", "forward")).toBe("rejected");
  expect(cycleState("rejected", "forward")).toBe("retired");
  expect(cycleState("retired", "forward")).toBe("recorded");
  expect(cycleState("recorded", "forward")).toBe("open");
});

test("cycleState backward visits all five states and wraps", () => {
  expect(cycleState("open", "backward")).toBe("recorded");
  expect(cycleState("recorded", "backward")).toBe("retired");
  expect(cycleState("retired", "backward")).toBe("rejected");
  expect(cycleState("rejected", "backward")).toBe("confirmed");
  expect(cycleState("confirmed", "backward")).toBe("open");
});

// --- fitWithin ---------------------------------------------------------------

test("fitWithin leaves an image already within the box unchanged", () => {
  expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 });
  expect(fitWithin(1600, 1600, 1600)).toEqual({ width: 1600, height: 1600 });
});

test("fitWithin scales the longest edge to maxEdge, preserving aspect", () => {
  expect(fitWithin(3200, 2400, 1600)).toEqual({ width: 1600, height: 1200 });
  expect(fitWithin(2400, 3200, 1600)).toEqual({ width: 1200, height: 1600 });
});

test("fitWithin never upscales a small image", () => {
  expect(fitWithin(100, 50, 1600)).toEqual({ width: 100, height: 50 });
});

// --- overflowsClamp (#146) -----------------------------------------------------

test("overflowsClamp: text within the clamp shows no cue", () => {
  // 3 lines of 20px.
  expect(overflowsClamp(60, 20)).toBe(false);
  expect(overflowsClamp(20, 20)).toBe(false); // one line
});

test("overflowsClamp: a fourth line is hidden text", () => {
  expect(overflowsClamp(80, 20)).toBe(true);
});

test("overflowsClamp: a sub-pixel overshoot of an exact fit is not overflow", () => {
  expect(overflowsClamp(60.6, 20)).toBe(false);
});

test("overflowsClamp: an unreadable line height never shows the cue", () => {
  expect(overflowsClamp(500, Number.NaN)).toBe(false);
  expect(overflowsClamp(500, 0)).toBe(false);
});

test("overflowsClamp defaults to CLAMP_LINES", () => {
  expect(CLAMP_LINES).toBe(3);
  expect(overflowsClamp(20 * 4, 20, 4)).toBe(false);
  expect(overflowsClamp(20 * 4, 20)).toBe(true);
});
