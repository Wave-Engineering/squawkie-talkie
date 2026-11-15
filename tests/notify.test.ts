/**
 * Per-list alerts (#177): the decision, the settings store, the burst grouping,
 * the copy, and the realtime hand-off, against a happy-dom document with a stubbed
 * Notification and Web Audio. The browser behaviour (a real permission prompt, a
 * real chime) is covered by e2e/26-list-alerts.spec.ts, which stubs Notification
 * in a real browser.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import {
  ALERTS_KEY,
  BURST_MS,
  Burst,
  blockedReason,
  buildAlertToggle,
  forgetList,
  handleRealtimeEvent,
  initNotify,
  isAlertOn,
  noteListName,
  notificationCopy,
  readAlerts,
  setAlertOn,
  shouldAlert,
  titleWithCount,
  toggleCopy,
  viewerIsLooking,
} from "../src/client/notify.ts";

// --- stubs -----------------------------------------------------------------

class FakeNotification {
  static permission: NotificationPermission = "granted";
  static instances: FakeNotification[] = [];
  static async requestPermission(): Promise<NotificationPermission> {
    return FakeNotification.permission;
  }
  onclick: (() => void) | null = null;
  closed = false;
  constructor(
    public title: string,
    public options: { body?: string; tag?: string; icon?: string } = {},
  ) {
    FakeNotification.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
}

let oscillatorsStarted = 0;
class FakeAudioContext {
  state: AudioContextState = "running";
  currentTime = 0;
  destination = {};
  createOscillator() {
    return {
      type: "sine",
      frequency: { value: 0 },
      connect: (n: unknown) => n,
      start: () => {
        oscillatorsStarted += 1;
      },
      stop: () => {},
    };
  }
  createGain() {
    return {
      gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
      connect: (n: unknown) => n,
    };
  }
  async resume(): Promise<void> {
    this.state = "running";
  }
}

let hidden = false;
let focused = true;

beforeAll(() => {
  GlobalRegistrator.register();
  (globalThis as { Notification?: unknown }).Notification = FakeNotification;
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.hasFocus = () => focused;
  document.title = "Squawkie-Talkie";
  initNotify();
});
afterAll(() => {
  GlobalRegistrator.unregister();
});
beforeEach(() => {
  window.localStorage.clear();
  FakeNotification.instances = [];
  FakeNotification.permission = "granted";
  oscillatorsStarted = 0;
  // The unseen count is module state; clear it the way a viewer does, by coming back.
  hidden = false;
  focused = true;
  window.dispatchEvent(new window.Event("focus"));
  hidden = true;
  focused = false;
  document.title = "Squawkie-Talkie";
});

const created = (listId: number, text = "a new squawk") => ({
  type: "squawk.created",
  squawk: { id: 1, list_id: listId, text },
});

// --- the decision ------------------------------------------------------------

test("shouldAlert: an add to an alert-on list while away alerts, with the stored name", () => {
  const due = shouldAlert({
    event: created(7, "deploy is red"),
    alerts: { "7": "bj:needs" },
    looking: false,
  });
  expect(due).toEqual({ listId: 7, name: "bj:needs", text: "deploy is red" });
});

test("shouldAlert: nothing while the viewer is looking", () => {
  expect(shouldAlert({ event: created(7), alerts: { "7": "x" }, looking: true })).toBeNull();
});

test("shouldAlert: a list with its alert off raises nothing (there are no default lists)", () => {
  expect(shouldAlert({ event: created(7), alerts: {}, looking: false })).toBeNull();
  expect(shouldAlert({ event: created(7), alerts: { "8": "other" }, looking: false })).toBeNull();
});

test("shouldAlert: only an add alerts, not an update, a delete or an unknown event", () => {
  const alerts = { "7": "x" };
  for (const type of ["squawk.updated", "squawk.deleted", "list.created", "list.deleted", "mystery"]) {
    expect(
      shouldAlert({
        event: { type, squawk: { list_id: 7, text: "t" } },
        alerts,
        looking: false,
      }),
    ).toBeNull();
  }
});

test("shouldAlert: a malformed add is ignored, not thrown on", () => {
  const alerts = { "7": "x" };
  expect(shouldAlert({ event: { type: "squawk.created" }, alerts, looking: false })).toBeNull();
  expect(
    shouldAlert({ event: { type: "squawk.created", squawk: { list_id: "7" } }, alerts, looking: false }),
  ).toBeNull();
  // A missing text is an empty body, not a crash.
  expect(
    shouldAlert({ event: { type: "squawk.created", squawk: { list_id: 7 } }, alerts, looking: false })?.text,
  ).toBe("");
});

test("viewerIsLooking: only a visible tab in a focused window", () => {
  expect(viewerIsLooking({ hidden: false, hasFocus: () => true })).toBe(true);
  expect(viewerIsLooking({ hidden: true, hasFocus: () => true })).toBe(false);
  expect(viewerIsLooking({ hidden: false, hasFocus: () => false })).toBe(false);
  expect(viewerIsLooking({ hidden: true, hasFocus: () => false })).toBe(false);
});

// --- bursts -------------------------------------------------------------------

test("Burst: adds within the window join one burst; only the first is first", () => {
  const b = new Burst();
  expect(b.hit(1, 1_000)).toEqual({ count: 1, first: true });
  expect(b.hit(1, 1_000 + BURST_MS)).toEqual({ count: 2, first: false });
  // Rolling: measured from the previous add, not from the first.
  expect(b.hit(1, 1_000 + 2 * BURST_MS)).toEqual({ count: 3, first: false });
});

test("Burst: a gap longer than the window starts a new burst", () => {
  const b = new Burst();
  b.hit(1, 0);
  expect(b.hit(1, BURST_MS + 1)).toEqual({ count: 1, first: true });
});

test("Burst: lists burst independently", () => {
  const b = new Burst();
  b.hit(1, 0);
  expect(b.hit(2, 10)).toEqual({ count: 1, first: true });
});

// --- copy ---------------------------------------------------------------------

test("notificationCopy: singular and plural titles; body is the text", () => {
  const due = { listId: 1, name: "triage", text: "the gate ignores the lock list" };
  expect(notificationCopy(due, 1)).toEqual({
    title: "triage: new squawk",
    body: "the gate ignores the lock list",
  });
  expect(notificationCopy(due, 4).title).toBe("triage: 4 new squawks");
});

test("notificationCopy: collapses whitespace and cuts a long body at 120 with an ellipsis", () => {
  const due = { listId: 1, name: "x", text: `${"word ".repeat(60)}\n\nend` };
  const { body } = notificationCopy(due, 1);
  expect(body.length).toBe(120);
  expect(body.endsWith("…")).toBe(true);
  expect(body.includes("\n")).toBe(false);
  expect(notificationCopy({ ...due, text: "short\n  text" }, 1).body).toBe("short text");
});

test("titleWithCount: a count in front, or the bare title", () => {
  expect(titleWithCount("Squawkie-Talkie", 0)).toBe("Squawkie-Talkie");
  expect(titleWithCount("Squawkie-Talkie", 3)).toBe("(3) Squawkie-Talkie");
});

test("blockedReason / toggleCopy: say why a turn-on cannot proceed", () => {
  expect(blockedReason("granted")).toBeNull();
  expect(blockedReason("default")).toBeNull();
  expect(blockedReason("denied")).toContain("blocked");
  expect(blockedReason("unsupported")).toContain("does not support");
  expect(toggleCopy(true, null).label).toBe("Alert: on");
  expect(toggleCopy(false, null).label).toBe("Alert: off");
  expect(toggleCopy(false, "Notifications are blocked.").title).toBe("Notifications are blocked.");
});

// --- the settings store -------------------------------------------------------

test("readAlerts: nothing is on in a fresh browser", () => {
  expect(readAlerts()).toEqual({});
  expect(isAlertOn(1)).toBe(false);
});

test("readAlerts: corrupt, wrong-shaped and non-string values read as off", () => {
  window.localStorage.setItem(ALERTS_KEY, "{not json");
  expect(readAlerts()).toEqual({});
  window.localStorage.setItem(ALERTS_KEY, "[1,2]");
  expect(readAlerts()).toEqual({});
  window.localStorage.setItem(ALERTS_KEY, JSON.stringify({ "1": "ok", "2": 5, "3": null }));
  expect(readAlerts()).toEqual({ "1": "ok" });
});

test("setAlertOn / forgetList / noteListName keep the store honest", () => {
  setAlertOn(4, "triage", true);
  expect(isAlertOn(4)).toBe(true);
  expect(readAlerts()).toEqual({ "4": "triage" });
  // A rename follows, but only for a list that is on.
  noteListName(4, "triage-2");
  noteListName(9, "never-on");
  expect(readAlerts()).toEqual({ "4": "triage-2" });
  setAlertOn(4, "triage-2", false);
  expect(isAlertOn(4)).toBe(false);
  setAlertOn(5, "x", true);
  forgetList(5);
  expect(readAlerts()).toEqual({});
});

// --- the hand-off from realtime -----------------------------------------------

test("handleRealtimeEvent: an add to an alert-on list while away notifies, chimes and counts", () => {
  setAlertOn(11, "bj:needs", true);
  handleRealtimeEvent(created(11, "ship it?"), 100_000);
  expect(FakeNotification.instances.length).toBe(1);
  const n = FakeNotification.instances[0]!;
  expect(n.title).toBe("bj:needs: new squawk");
  expect(n.options.body).toBe("ship it?");
  expect(n.options.tag).toBe("st-list-11");
  expect(oscillatorsStarted).toBe(2); // the two notes of the chime
  expect(document.title).toBe("(1) Squawkie-Talkie");
});

test("handleRealtimeEvent: a second add in the burst replaces the popup and stays quiet", () => {
  setAlertOn(12, "triage", true);
  handleRealtimeEvent(created(12, "one"), 200_000);
  handleRealtimeEvent(created(12, "two"), 200_000 + 1_000);
  expect(FakeNotification.instances.length).toBe(2);
  expect(FakeNotification.instances[1]!.title).toBe("triage: 2 new squawks");
  // Same tag, so the browser replaces the first popup rather than stacking.
  expect(FakeNotification.instances[1]!.options.tag).toBe(FakeNotification.instances[0]!.options.tag);
  expect(oscillatorsStarted).toBe(2); // one chime for the burst, not two
  expect(document.title).toBe("(2) Squawkie-Talkie");
});

test("handleRealtimeEvent: nothing for an alert-off list, or while the viewer is looking", () => {
  handleRealtimeEvent(created(13), 300_000);
  expect(FakeNotification.instances.length).toBe(0);
  expect(oscillatorsStarted).toBe(0);
  expect(document.title).toBe("Squawkie-Talkie");

  setAlertOn(14, "x", true);
  hidden = false;
  focused = true;
  handleRealtimeEvent(created(14), 400_000);
  expect(FakeNotification.instances.length).toBe(0);
});

test("handleRealtimeEvent: no popup without permission, but the chime and the count still work", () => {
  setAlertOn(15, "x", true);
  FakeNotification.permission = "denied";
  handleRealtimeEvent(created(15), 500_000);
  expect(FakeNotification.instances.length).toBe(0);
  expect(oscillatorsStarted).toBe(2);
  expect(document.title).toBe("(1) Squawkie-Talkie");
});

test("handleRealtimeEvent: a deleted list forgets its alert", () => {
  setAlertOn(16, "gone", true);
  handleRealtimeEvent({ type: "list.deleted", id: 16 });
  expect(isAlertOn(16)).toBe(false);
});

test("returning to the page clears the unseen count", () => {
  setAlertOn(17, "x", true);
  handleRealtimeEvent(created(17), 600_000);
  expect(document.title).toBe("(1) Squawkie-Talkie");
  hidden = false;
  focused = true;
  window.dispatchEvent(new window.Event("focus"));
  expect(document.title).toBe("Squawkie-Talkie");
});

// --- the toggle ---------------------------------------------------------------

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

test("buildAlertToggle: off by default, with a name the screen reader can use", () => {
  const el = buildAlertToggle(21, () => "triage");
  expect(el.textContent).toBe("Alert: off");
  expect(el.getAttribute("aria-pressed")).toBe("false");
  expect(el.getAttribute("aria-label")).toBe("Alert: off for triage");
  expect(isAlertOn(21)).toBe(false);
});

test("buildAlertToggle: a click with permission granted turns it on, a second turns it off", async () => {
  const el = buildAlertToggle(22, () => "triage");
  document.body.append(el);
  el.click();
  await settle();
  expect(isAlertOn(22)).toBe(true);
  expect(el.textContent).toBe("Alert: on");
  expect(el.getAttribute("aria-pressed")).toBe("true");
  el.click();
  await settle();
  expect(isAlertOn(22)).toBe(false);
  expect(el.textContent).toBe("Alert: off");
});

test("buildAlertToggle: asks for permission on the first click; granting turns it on", async () => {
  FakeNotification.permission = "default";
  const asked: string[] = [];
  FakeNotification.requestPermission = async () => {
    asked.push("asked");
    FakeNotification.permission = "granted";
    return "granted";
  };
  const el = buildAlertToggle(23, () => "x");
  document.body.append(el);
  el.click();
  await settle();
  expect(asked).toEqual(["asked"]);
  expect(isAlertOn(23)).toBe(true);
  FakeNotification.requestPermission = async () => FakeNotification.permission;
});

test("buildAlertToggle: a blocked browser leaves it off and says why", async () => {
  FakeNotification.permission = "denied";
  const el = buildAlertToggle(24, () => "x");
  document.body.append(el);
  el.click();
  await settle();
  expect(isAlertOn(24)).toBe(false);
  expect(el.textContent).toBe("Alert: off");
  expect(el.title).toContain("blocked");
});

test("toggles for the same list stay in step, and a detached one is dropped", async () => {
  const a = buildAlertToggle(25, () => "x");
  const b = buildAlertToggle(25, () => "x");
  document.body.append(a, b);
  a.click();
  await settle();
  expect(b.textContent).toBe("Alert: on");
  b.remove();
  setAlertOn(25, "x", false);
  expect(a.textContent).toBe("Alert: off");
});
