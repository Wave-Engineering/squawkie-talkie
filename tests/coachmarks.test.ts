/**
 * Unit tests for the coach-mark engine (#70).
 *
 * These exercise the engine against a happy-dom document: real elements, real
 * `localStorage`, real focus and keydown dispatch. happy-dom is registered for
 * this file only so the server suite keeps Bun's native globals.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import {
  type CoachStep,
  hasSeen,
  markSeen,
  replayTour,
  runTour,
} from "../src/client/coachmarks.ts";

beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(() => {
  GlobalRegistrator.unregister();
});

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
});

afterEach(() => {
  // Belt-and-suspenders: press Escape in case a test left a tour open, then
  // scrub any surviving overlay so tours never leak across tests.
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  document.querySelectorAll(".coach-overlay").forEach((n) => n.remove());
});

/** Dispatch a document-level keydown for `key`. */
function press(key: string): void {
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
  );
}

/** Append a focusable target with `id` and return it. */
function addTarget(id: string): HTMLButtonElement {
  const el = document.createElement("button");
  el.id = id;
  el.textContent = id;
  document.body.append(el);
  return el;
}

// --- localStorage bookkeeping ------------------------------------------------

test("hasSeen/markSeen round-trip", () => {
  expect(hasSeen("lists")).toBe(false);
  markSeen("lists");
  expect(hasSeen("lists")).toBe(true);
  // Keyed per surface: marking one does not mark another.
  expect(hasSeen("detail")).toBe(false);
  // Namespaced storage key, not a bare surfaceKey.
  expect(localStorage.getItem("st.coach.lists")).not.toBeNull();
});

// --- auto-show suppression ---------------------------------------------------

test("runTour suppressed when seen", () => {
  addTarget("t1");
  markSeen("lists");

  runTour("lists", [{ target: "#t1", body: "hello" }]);

  // A set flag prevents the overlay from ever mounting.
  expect(document.querySelector(".coach-overlay")).toBeNull();
});

test("runTour shows the overlay + callout on a fresh surface", () => {
  addTarget("t1");

  runTour("lists", [{ target: "#t1", title: "Step one", body: "hello" }]);

  const overlay = document.querySelector(".coach-overlay");
  expect(overlay).not.toBeNull();
  expect(document.querySelector(".coach-spotlight")).not.toBeNull();
  expect(document.querySelector(".coach-callout__title")?.textContent).toBe(
    "Step one",
  );
  expect(document.querySelector(".coach-callout__counter")?.textContent).toBe(
    "1 / 1",
  );
});

// --- missing target resilience ----------------------------------------------

test("missing target skipped not thrown", () => {
  const steps: CoachStep[] = [{ target: () => null, body: "orphan" }];

  // The single step has no live target: the tour must end cleanly, not throw.
  expect(() => runTour("lists", steps)).not.toThrow();
  expect(document.querySelector(".coach-overlay")).toBeNull();
  // Ending (even via all-skipped) still marks the surface seen.
  expect(hasSeen("lists")).toBe(true);
});

test("a missing step in the middle is skipped, live steps still shown", () => {
  addTarget("a");
  addTarget("c");
  const steps: CoachStep[] = [
    { target: "#a", body: "first" },
    { target: "#missing", body: "gone" },
    { target: "#c", body: "third" },
  ];

  runTour("lists", steps);
  // First live step shown.
  expect(document.querySelector(".coach-callout__body")?.textContent).toBe(
    "first",
  );
  // Advance: the absent middle step is skipped straight to the third.
  press("Enter");
  expect(document.querySelector(".coach-callout__body")?.textContent).toBe(
    "third",
  );
});

// --- keyboard drive + end-states --------------------------------------------

test("Enter advances through steps; Done ends and marks seen", () => {
  addTarget("a");
  addTarget("b");
  runTour("lists", [
    { target: "#a", body: "first" },
    { target: "#b", body: "second" },
  ]);

  expect(document.querySelector(".coach-callout__counter")?.textContent).toBe(
    "1 / 2",
  );
  press("Enter");
  expect(document.querySelector(".coach-callout__counter")?.textContent).toBe(
    "2 / 2",
  );
  // Enter on the last step finishes the tour.
  press("Enter");
  expect(document.querySelector(".coach-overlay")).toBeNull();
  expect(hasSeen("lists")).toBe(true);
});

test("Esc ends the tour and marks seen", () => {
  addTarget("a");
  runTour("lists", [
    { target: "#a", body: "first" },
    { target: "#a", body: "second" },
  ]);
  expect(document.querySelector(".coach-overlay")).not.toBeNull();

  press("Escape");
  expect(document.querySelector(".coach-overlay")).toBeNull();
  expect(hasSeen("lists")).toBe(true);
});

test("focus is restored to the pre-tour element on end", () => {
  const before = addTarget("origin");
  addTarget("a");
  before.focus();
  expect(document.activeElement).toBe(before);

  runTour("lists", [{ target: "#a", body: "first" }]);
  press("Escape");

  expect(document.activeElement).toBe(before);
});

// --- replay ------------------------------------------------------------------

test("replayTour runs regardless of the seen-flag", () => {
  addTarget("a");
  markSeen("lists");

  // runTour would suppress; replayTour must still show.
  runTour("lists", [{ target: "#a", body: "x" }]);
  expect(document.querySelector(".coach-overlay")).toBeNull();

  replayTour("lists", [{ target: "#a", body: "x" }]);
  expect(document.querySelector(".coach-overlay")).not.toBeNull();
});

// --- guard: no double-start --------------------------------------------------

test("a second start while a tour is live is a no-op", () => {
  addTarget("a");
  runTour("lists", [{ target: "#a", body: "first" }]);
  replayTour("detail", [{ target: "#a", body: "other" }]);

  // Only one overlay is ever on screen.
  expect(document.querySelectorAll(".coach-overlay")).toHaveLength(1);
});
