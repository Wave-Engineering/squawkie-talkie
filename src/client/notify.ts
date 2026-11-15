/**
 * Per-list alerts (#177) — a browser notification and a soft chime when a squawk
 * is added to a list the viewer has switched an alert on for, while the viewer is
 * not looking at the page.
 *
 * The page already hears every `squawk.created` on the SSE stream, so this is
 * client-only. There are no default lists: every list starts with its alert off,
 * and each browser turns on the lists it wants (`localStorage`, per browser).
 *
 * The decisions are pure and unit-tested ({@link shouldAlert}, {@link Burst},
 * {@link readAlerts}); the browser seams (Notification, Web Audio, the document
 * title) are thin and sit below them.
 */

// ---------------------------------------------------------------------------
// Settings: which lists alert, per browser
// ---------------------------------------------------------------------------

/** The `localStorage` key holding `{ [listId]: listName }` for every alert-on list. */
export const ALERTS_KEY = "st.alerts";

/** Alert-on lists, by id. The name is what the notification title says. */
export type AlertMap = Record<string, string>;

/** Every alert-on list in this browser. Empty when none, or when storage is unavailable. */
export function readAlerts(): AlertMap {
  try {
    const raw = window.localStorage.getItem(ALERTS_KEY);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out: AlertMap = {};
    for (const [id, name] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof name === "string") out[id] = name;
    }
    return out;
  } catch {
    return {};
  }
}

function writeAlerts(map: AlertMap): void {
  try {
    window.localStorage.setItem(ALERTS_KEY, JSON.stringify(map));
  } catch {
    // No storage means no alerts that survive a reload, not an error.
  }
}

/** Whether this browser alerts for `listId`. */
export function isAlertOn(listId: number): boolean {
  return String(listId) in readAlerts();
}

/** Switch the alert for `listId` on or off, and repaint every toggle. */
export function setAlertOn(listId: number, name: string, on: boolean): void {
  const map = readAlerts();
  if (on) map[String(listId)] = name;
  else delete map[String(listId)];
  writeAlerts(map);
  repaintToggles();
}

/** Keep the stored name current: a renamed list should not alert under its old name. */
export function noteListName(listId: number, name: string): void {
  const map = readAlerts();
  const key = String(listId);
  if (key in map && map[key] !== name) {
    map[key] = name;
    writeAlerts(map);
  }
}

/** Forget a list that no longer exists. */
export function forgetList(listId: number): void {
  const map = readAlerts();
  if (String(listId) in map) {
    delete map[String(listId)];
    writeAlerts(map);
    repaintToggles();
  }
}

// ---------------------------------------------------------------------------
// The decision: does this event alert?
// ---------------------------------------------------------------------------

/** What the decision needs from a realtime event (structural, so no import cycle). */
export interface AlertableEvent {
  type: string;
  squawk?: { list_id?: unknown; text?: unknown } | null;
  [k: string]: unknown;
}

/** An alert to raise. */
export interface AlertDue {
  listId: number;
  name: string;
  text: string;
}

/** The viewer is looking only when the tab is visible and its window has focus. */
export function viewerIsLooking(doc: { hidden: boolean; hasFocus(): boolean }): boolean {
  return !doc.hidden && doc.hasFocus();
}

/**
 * The alert due for `event`, or null. Only a live `squawk.created` on an alert-on
 * list, while the viewer is not looking. An update, a delete, or an add to a list
 * with its alert off raises nothing.
 */
export function shouldAlert(input: {
  event: AlertableEvent;
  alerts: AlertMap;
  looking: boolean;
}): AlertDue | null {
  const { event, alerts, looking } = input;
  if (looking || event.type !== "squawk.created") return null;
  const sq = event.squawk;
  if (!sq || typeof sq.list_id !== "number") return null;
  const name = alerts[String(sq.list_id)];
  if (name === undefined) return null;
  return {
    listId: sq.list_id,
    name,
    text: typeof sq.text === "string" ? sq.text : "",
  };
}

// ---------------------------------------------------------------------------
// Bursts: one chime and one notification per run of adds
// ---------------------------------------------------------------------------

/** Adds closer together than this belong to one burst. */
export const BURST_MS = 3_000;

/**
 * Groups adds into bursts per list. `hit` returns how many adds the current burst
 * holds and whether this one opened it. A burst runs on while adds keep arriving
 * within {@link BURST_MS} of the previous one.
 */
export class Burst {
  private last = new Map<number, { at: number; count: number }>();

  hit(listId: number, now: number): { count: number; first: boolean } {
    const prev = this.last.get(listId);
    const count = prev !== undefined && now - prev.at <= BURST_MS ? prev.count + 1 : 1;
    this.last.set(listId, { at: now, count });
    return { count, first: count === 1 };
  }
}

/** The notification's title and body for a burst of `count` adds. Pure. */
export function notificationCopy(
  due: AlertDue,
  count: number,
): { title: string; body: string } {
  const title =
    count > 1 ? `${due.name}: ${count} new squawks` : `${due.name}: new squawk`;
  const text = due.text.replace(/\s+/g, " ").trim();
  const body = text.length > 120 ? `${text.slice(0, 119)}…` : text;
  return { title, body };
}

/** The tab title with the unseen count in front of it. Pure. */
export function titleWithCount(base: string, unseen: number): string {
  return unseen > 0 ? `(${unseen}) ${base}` : base;
}

// ---------------------------------------------------------------------------
// The chime: two soft notes, synthesised, no audio file
// ---------------------------------------------------------------------------

/** The chime's shape. Tune it here. Gain is deliberately low: subtle, not a klaxon. */
export const CHIME = { notesHz: [880, 1175], noteSec: 0.14, gain: 0.05 } as const;

type AudioCtor = typeof AudioContext;
let audioCtx: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (audioCtx !== null) return audioCtx;
  const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (Ctor === undefined) return null;
  try {
    audioCtx = new Ctor();
  } catch {
    audioCtx = null;
  }
  return audioCtx;
}

/**
 * Create and resume the audio context. Browsers refuse to start sound until the
 * page has had a user gesture, so this runs from the toggle click and, after a
 * reload, from the first click or key press.
 */
export function unlockAudio(): void {
  const ctx = audioContext();
  if (ctx !== null && ctx.state === "suspended") void ctx.resume().catch(() => {});
}

function playChime(): void {
  const ctx = audioContext();
  // Still locked (no gesture since load): skip rather than queue a sound for later.
  if (ctx === null || ctx.state !== "running") return;
  const start = ctx.currentTime;
  CHIME.notesHz.forEach((hz, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const t0 = start + i * CHIME.noteSec;
    osc.type = "sine";
    osc.frequency.value = hz;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(CHIME.gain, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + CHIME.noteSec * 1.8);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + CHIME.noteSec * 2);
  });
}

// ---------------------------------------------------------------------------
// Raising the alert
// ---------------------------------------------------------------------------

const burst = new Burst();
let unseen = 0;
let baseTitle = "";

function paintTitle(): void {
  document.title = titleWithCount(baseTitle, unseen);
}

function raiseNotification(due: AlertDue, count: number): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") {
    return;
  }
  const { title, body } = notificationCopy(due, count);
  try {
    // One tag per list: a later add replaces the earlier popup instead of stacking.
    const n = new Notification(title, {
      body,
      tag: `st-list-${due.listId}`,
      icon: "/logo.png",
    });
    n.onclick = () => {
      window.focus();
      window.location.hash = `#/list/${due.listId}`;
      n.close();
    };
  } catch {
    // Some browsers throw on `new Notification` (older mobile). The chime and the title still work.
  }
}

/**
 * Hand a realtime event to the alerts. Called for every event before it is applied
 * to the view. A reconnect re-fetch is not an event, so it can never alert.
 */
export function handleRealtimeEvent(event: AlertableEvent, now = Date.now()): void {
  if (event.type === "list.deleted" && typeof event.id === "number") {
    forgetList(event.id);
    return;
  }
  const due = shouldAlert({
    event,
    alerts: readAlerts(),
    looking: viewerIsLooking(document),
  });
  if (due === null) return;
  unseen += 1;
  paintTitle();
  const { count, first } = burst.hit(due.listId, now);
  if (first) playChime();
  raiseNotification(due, count);
}

/** Start the title count and the audio unlock. Call once at bootstrap. */
export function initNotify(): void {
  baseTitle = document.title;
  const clear = (): void => {
    if (viewerIsLooking(document) && unseen > 0) {
      unseen = 0;
      paintTitle();
    }
  };
  document.addEventListener("visibilitychange", clear);
  window.addEventListener("focus", clear);
  // Another tab of this browser changed the toggles: follow it.
  window.addEventListener("storage", (e) => {
    if (e.key === ALERTS_KEY) repaintToggles();
  });
  // After a reload with alerts already on there has been no gesture yet, so the
  // first click or key press unlocks the chime.
  const unlock = (): void => {
    unlockAudio();
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
}

// ---------------------------------------------------------------------------
// The toggle
// ---------------------------------------------------------------------------

/** The toggle's state copy. Pure. */
export function toggleCopy(on: boolean, blocked: string | null): { label: string; title: string } {
  if (on) {
    return {
      label: "Alert: on",
      title: "You get a notification and a chime when a squawk is added while you're away from this page. Click to turn off.",
    };
  }
  return {
    label: "Alert: off",
    title:
      blocked ??
      "Click to get a notification and a chime when a squawk is added while you're away from this page.",
  };
}

/** Why a turn-on cannot proceed, or null when it can (permission is asked on the click). */
export function blockedReason(
  permission: NotificationPermission | "unsupported",
): string | null {
  if (permission === "unsupported") {
    return "This browser does not support notifications.";
  }
  if (permission === "denied") {
    return "Notifications are blocked for this site. Allow them in the browser's site settings, then try again.";
  }
  return null;
}

function currentPermission(): NotificationPermission | "unsupported" {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

const toggles = new Set<{ el: HTMLButtonElement; listId: number; paint: () => void }>();

function repaintToggles(): void {
  for (const t of toggles) {
    if (!t.el.isConnected) toggles.delete(t);
    else t.paint();
  }
}

/**
 * Build the alert toggle for one list. `getName` gives the list's current name (the
 * notification title) at the moment of the click. Off by default.
 */
export function buildAlertToggle(listId: number, getName: () => string): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "alert-toggle";
  let blocked: string | null = null;

  const paint = (): void => {
    const on = isAlertOn(listId);
    const c = toggleCopy(on, blocked);
    el.textContent = c.label;
    el.title = c.title;
    el.setAttribute("aria-pressed", on ? "true" : "false");
    el.setAttribute("aria-label", `${c.label} for ${getName()}`);
    el.classList.toggle("alert-toggle--on", on);
  };

  el.addEventListener("click", () => {
    void (async () => {
      if (isAlertOn(listId)) {
        setAlertOn(listId, getName(), false);
        return;
      }
      // The click is the user gesture the browser needs for the permission prompt and the chime.
      unlockAudio();
      let permission = currentPermission();
      if (permission === "default") {
        try {
          permission = await Notification.requestPermission();
        } catch {
          permission = "default";
        }
      }
      blocked = blockedReason(permission);
      if (permission === "granted") {
        setAlertOn(listId, getName(), true);
      } else {
        paint();
      }
    })();
  });

  const entry = { el, listId, paint };
  toggles.add(entry);
  paint();
  return el;
}
