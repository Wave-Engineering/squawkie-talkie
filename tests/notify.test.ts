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
  ALERTED_KEY,
  ALERTS_KEY,
  BURST_MS,
  Burst,
  CHIMED_KEY,
  LOOKING_KEY,
  LOOKING_TTL_MS,
  NOTICE_FILL_MS,
  anotherTabLooking,
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
  unlockAudio,
  viewerIsLooking,
} from "../src/client/notify.ts";
import { dispatch, setActiveView } from "../src/client/realtime.ts";

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
let audio: FakeAudioContext | null = null;
class FakeAudioContext {
  state: AudioContextState = "running";
  constructor() {
    audio = this;
  }
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
  if (audio !== null) audio.state = "running";
  // The unseen count is module state; clear it the way a viewer does, by coming back.
  hidden = false;
  focused = true;
  window.dispatchEvent(new window.Event("focus"));
  hidden = true;
  focused = false;
  document.title = "Squawkie-Talkie";
});

// Each add is its own squawk: tabs claim an alert by squawk id.
let nextSquawkId = 1;
const created = (listId: number, text = "a new squawk") => ({
  type: "squawk.created",
  squawk: { id: nextSquawkId++, list_id: listId, text },
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
  expect(b.hit(1, 1_000)).toEqual({ count: 1, first: true, chime: true });
  expect(b.hit(1, 1_000 + BURST_MS)).toEqual({ count: 2, first: false, chime: false });
  // Rolling: measured from the previous add, not from the first.
  expect(b.hit(1, 1_000 + 2 * BURST_MS)).toEqual({ count: 3, first: false, chime: false });
});

test("Burst: a gap longer than the window starts a new burst", () => {
  const b = new Burst();
  b.hit(1, 0);
  expect(b.hit(1, BURST_MS + 1)).toEqual({ count: 1, first: true, chime: true });
});

test("Burst: lists count independently, but one chime covers a burst across lists", () => {
  const b = new Burst();
  b.hit(1, 0);
  expect(b.hit(2, 10)).toEqual({ count: 1, first: true, chime: false });
  expect(b.hit(2, BURST_MS * 3)).toEqual({ count: 1, first: true, chime: true });
});

test("Burst: reset forgets the run, so the next add opens a fresh burst", () => {
  const b = new Burst();
  b.hit(1, 0);
  b.hit(1, 100);
  b.reset();
  expect(b.hit(1, 200)).toEqual({ count: 1, first: true, chime: true });
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

test("blockedReason: a prompt that was shown and left unanswered says so; an unasked one does not", () => {
  expect(blockedReason("default", true)).toContain("not given");
  expect(blockedReason("default", false)).toBeNull();
  expect(blockedReason("granted", true)).toBeNull();
});

test("toggleCopy: on with the popups blocked says chime only", () => {
  const c = toggleCopy(true, null, true);
  expect(c.label).toBe("Alert: chime only");
  expect(c.title).toContain("not showing notifications");
  expect(toggleCopy(true, null, false).label).toBe("Alert: on");
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
  // A constant name: aria-pressed carries the state.
  expect(el.getAttribute("aria-label")).toBe("Alert for triage");
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

test("buildAlertToggle: a dismissed prompt leaves it off and says why, on screen", async () => {
  FakeNotification.permission = "default";
  const original = FakeNotification.requestPermission;
  FakeNotification.requestPermission = async () => "default"; // dismissed, not denied
  const el = buildAlertToggle(28, () => "x");
  document.body.append(el);
  el.click();
  await settle();
  FakeNotification.requestPermission = original;
  expect(isAlertOn(28)).toBe(false);
  expect(el.title).toContain("not given");
  // The reason is on screen and announced, not only in a tooltip. The region is in
  // the page already, empty, and is filled a beat later so a screen reader hears it.
  const notice = document.getElementById("alert-notice");
  expect(notice).not.toBeNull();
  expect(notice?.getAttribute("role")).toBe("status");
  expect(notice?.hasAttribute("hidden")).toBe(false);
  expect(notice?.textContent).toBe("");
  await new Promise((r) => setTimeout(r, NOTICE_FILL_MS + 30));
  expect(notice?.textContent).toContain("not given");
});

test("buildAlertToggle: permission revoked after turn-on reads chime only, and recovers", () => {
  setAlertOn(29, "x", true);
  const el = buildAlertToggle(29, () => "x");
  document.body.append(el);
  expect(el.textContent).toBe("Alert: on");
  FakeNotification.permission = "denied";
  window.dispatchEvent(new window.Event("focus")); // the toggles repaint on return
  expect(el.textContent).toBe("Alert: chime only");
  expect(el.classList.contains("alert-toggle--degraded")).toBe(true);
  FakeNotification.permission = "granted";
  window.dispatchEvent(new window.Event("focus"));
  expect(el.textContent).toBe("Alert: on");
});

// --- looking vs focus: both must be true to stay quiet --------------------------

test("handleRealtimeEvent: a visible tab whose window is unfocused still alerts", () => {
  setAlertOn(31, "x", true);
  hidden = false;
  focused = false;
  handleRealtimeEvent(created(31), 700_000);
  expect(FakeNotification.instances.length).toBe(1);
});

test("handleRealtimeEvent: a hidden tab in a focused window still alerts", () => {
  setAlertOn(32, "x", true);
  hidden = true;
  focused = true;
  handleRealtimeEvent(created(32), 710_000);
  expect(FakeNotification.instances.length).toBe(1);
});

// --- the chime: locked audio, and one chime per burst across lists -----------------

test("handleRealtimeEvent: a locked audio context skips the chime, and a gesture unlocks it", () => {
  unlockAudio(); // make sure the context exists
  setAlertOn(33, "x", true);
  audio!.state = "suspended";
  handleRealtimeEvent(created(33), 720_000);
  expect(oscillatorsStarted).toBe(0); // skipped, not queued
  expect(FakeNotification.instances.length).toBe(1); // the popup does not need audio
  unlockAudio();
  expect(audio!.state as string).toBe("running");
  handleRealtimeEvent(created(33), 720_000 + 10 * BURST_MS);
  expect(oscillatorsStarted).toBe(2);
});

test("handleRealtimeEvent: two alert-on lists in one burst chime once", () => {
  setAlertOn(34, "a", true);
  setAlertOn(35, "b", true);
  handleRealtimeEvent(created(34), 730_000);
  handleRealtimeEvent(created(35), 730_000 + 1_000);
  expect(FakeNotification.instances.length).toBe(2); // one popup per list
  expect(oscillatorsStarted).toBe(2); // one chime
});

test("returning to the page ends the burst: the next add chimes and counts from one", () => {
  setAlertOn(36, "x", true);
  handleRealtimeEvent(created(36), 740_000);
  hidden = false;
  focused = true;
  window.dispatchEvent(new window.Event("focus"));
  hidden = true;
  focused = false;
  oscillatorsStarted = 0;
  FakeNotification.instances = [];
  handleRealtimeEvent(created(36), 740_000 + 1_000); // within 3 s of the last add
  expect(oscillatorsStarted).toBe(2);
  expect(FakeNotification.instances[0]!.title).toBe("x: new squawk");
  expect(document.title).toBe("(1) Squawkie-Talkie");
});

// --- several tabs: one alerts, none while another is looked at -------------------

test("anotherTabLooking: a fresh mark from another tab, and nothing else", () => {
  const mark = (tab: string, at: number) => JSON.stringify({ tab, at });
  expect(anotherTabLooking(mark("b", 1_000), "a", 1_000 + LOOKING_TTL_MS)).toBe(true);
  expect(anotherTabLooking(mark("b", 1_000), "a", 1_000 + LOOKING_TTL_MS + 1)).toBe(false); // stale
  expect(anotherTabLooking(mark("a", 1_000), "a", 1_000)).toBe(false); // our own
  expect(anotherTabLooking(null, "a", 0)).toBe(false);
  expect(anotherTabLooking("{nope", "a", 0)).toBe(false);
  expect(anotherTabLooking(JSON.stringify({ tab: 1, at: "x" }), "a", 0)).toBe(false);
  expect(anotherTabLooking("null", "a", 0)).toBe(false);
});

test("handleRealtimeEvent: stays quiet while another tab of the app is being looked at", () => {
  setAlertOn(41, "x", true);
  window.localStorage.setItem(LOOKING_KEY, JSON.stringify({ tab: "someone-else", at: 800_000 }));
  handleRealtimeEvent(created(41), 800_000 + 1_000);
  expect(FakeNotification.instances.length).toBe(0);
  expect(oscillatorsStarted).toBe(0);
  expect(document.title).toBe("Squawkie-Talkie");
  // Their mark goes stale (they left): this tab alerts again.
  handleRealtimeEvent(created(41), 800_000 + LOOKING_TTL_MS + 1_000);
  expect(FakeNotification.instances.length).toBe(1);
});

test("handleRealtimeEvent: a second hidden tab does not chime for a squawk another tab took", () => {
  setAlertOn(42, "x", true);
  const squawk = created(42);
  handleRealtimeEvent(squawk, 810_000); // this tab takes it
  expect(oscillatorsStarted).toBe(2);
  expect(window.localStorage.getItem(ALERTED_KEY)).toBe(String(squawk.squawk.id));
  // The same squawk arrives on another hidden tab: simulated by the same claim, replayed.
  oscillatorsStarted = 0;
  FakeNotification.instances = [];
  handleRealtimeEvent(squawk, 810_000 + 500);
  expect(oscillatorsStarted).toBe(0);
  expect(FakeNotification.instances.length).toBe(0);
});

test("handleRealtimeEvent: with Web Locks, only the tab that wins the lock raises the alert", async () => {
  setAlertOn(43, "x", true);
  const taken = new Set<string>();
  const requested: string[] = [];
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      // The browser's contract, reduced: ifAvailable gives null when someone holds it.
      request: async (name: string, _o: unknown, cb: (l: unknown) => Promise<void>) => {
        requested.push(name);
        if (taken.has(name)) return cb(null);
        taken.add(name);
        return cb({ name });
      },
    },
  });
  try {
    const sq = created(43);
    handleRealtimeEvent(sq, 820_000); // this tab wins the lock
    await settle();
    // The popup and the chime are claimed apart, each under its own lock.
    expect(requested).toEqual([`st-alert-${sq.squawk.id}`, `st-chime-${sq.squawk.id}`]);
    expect(FakeNotification.instances.length).toBe(1);
    expect(oscillatorsStarted).toBe(2);
    // Another tab hears the same squawk and loses the lock: it counts, but stays silent.
    FakeNotification.instances = [];
    oscillatorsStarted = 0;
    handleRealtimeEvent(sq, 820_000 + 100);
    await settle();
    expect(FakeNotification.instances.length).toBe(0);
    expect(oscillatorsStarted).toBe(0);
    expect(document.title).toBe("(2) Squawkie-Talkie"); // the loser still counts what it missed
  } finally {
    Object.defineProperty(navigator, "locks", { configurable: true, value: null });
  }
});

test("handleRealtimeEvent: a refused lock request falls back to the stored claim, so the alert is not lost", async () => {
  setAlertOn(44, "x", true);
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      // A browser with site data blocked: the request rejects before the callback runs.
      request: async () => {
        throw new Error("SecurityError");
      },
    },
  });
  try {
    const sq = created(44);
    handleRealtimeEvent(sq, 830_000);
    await settle();
    expect(FakeNotification.instances.length).toBe(1);
    expect(oscillatorsStarted).toBe(2);
    expect(window.localStorage.getItem(ALERTED_KEY)).toBe(String(sq.squawk.id));
    expect(window.localStorage.getItem(CHIMED_KEY)).toBe(String(sq.squawk.id));
  } finally {
    Object.defineProperty(navigator, "locks", { configurable: true, value: null });
  }
});

test("handleRealtimeEvent: a tab whose audio is locked takes the popup but leaves the chime to another", async () => {
  unlockAudio();
  setAlertOn(45, "x", true);
  audio!.state = "suspended";
  const requested: string[] = [];
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (name: string, _o: unknown, cb: (l: unknown) => Promise<void>) => {
        requested.push(name);
        return cb({ name });
      },
    },
  });
  try {
    const sq = created(45);
    handleRealtimeEvent(sq, 840_000);
    await settle();
    expect(requested).toEqual([`st-alert-${sq.squawk.id}`]); // no chime lock taken
    expect(FakeNotification.instances.length).toBe(1);
    expect(oscillatorsStarted).toBe(0);
  } finally {
    Object.defineProperty(navigator, "locks", { configurable: true, value: null });
  }
});

// --- the looking-mark follows the page out ------------------------------------------

test("pagehide releases this tab's looking-mark, and leaves another tab's alone", () => {
  // beforeEach returned focus to this page, so its own mark is stored.
  expect(window.localStorage.getItem(LOOKING_KEY)).not.toBeNull();
  window.dispatchEvent(new window.Event("pagehide"));
  expect(window.localStorage.getItem(LOOKING_KEY)).toBeNull();

  const theirs = JSON.stringify({ tab: "someone-else", at: Date.now() });
  window.localStorage.setItem(LOOKING_KEY, theirs);
  window.dispatchEvent(new window.Event("pagehide"));
  expect(window.localStorage.getItem(LOOKING_KEY)).toBe(theirs);
});

// --- the seam: a failing alert must not cost the live row update ----------------------

test("dispatch: an alert that throws still lets the event reach the mounted view", () => {
  setAlertOn(51, "x", true);
  let applied = 0;
  setActiveView({
    kind: "lists",
    upsertList: () => {},
    removeList: () => {},
    squawkChanged: () => {
      applied += 1;
    },
  });
  const real = Object.getOwnPropertyDescriptor(document, "title");
  Object.defineProperty(document, "title", {
    configurable: true,
    get: () => "Squawkie-Talkie",
    set: () => {
      throw new Error("title is read-only here");
    },
  });
  const errors: unknown[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => errors.push(a);
  try {
    // paintTitle throws inside the alert; the throw must not escape dispatch, and the
    // lists view must still hear that a squawk changed.
    expect(() => dispatch(created(51) as never)).not.toThrow();
  } finally {
    console.error = realError;
    if (real) Object.defineProperty(document, "title", real);
    setActiveView(null);
  }
  expect(errors.length).toBe(1);
  expect(applied).toBe(1);
});
