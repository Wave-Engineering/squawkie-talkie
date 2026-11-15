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
 * Groups adds into bursts. `hit` returns how many adds the list's current burst
 * holds, whether this one opened it, and whether it opens a burst across all lists
 * (`chime`: one chime per burst, however many alert-on lists it spans). A burst runs
 * on while adds keep arriving within {@link BURST_MS} of the previous one.
 */
export class Burst {
  private last = new Map<number, { at: number; count: number }>();
  private lastAny: number | null = null;

  hit(listId: number, now: number): { count: number; first: boolean; chime: boolean } {
    const prev = this.last.get(listId);
    const count = prev !== undefined && now - prev.at <= BURST_MS ? prev.count + 1 : 1;
    this.last.set(listId, { at: now, count });
    const chime = this.lastAny === null || now - this.lastAny > BURST_MS;
    this.lastAny = now;
    return { count, first: count === 1, chime };
  }

  /** Forget every burst: the viewer has come back, so what follows starts afresh. */
  reset(): void {
    this.last.clear();
    this.lastAny = null;
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

/** Whether this tab could play the chime right now (the context exists and is running). */
function audioReady(): boolean {
  return audioContext()?.state === "running";
}

function playChime(): void {
  const ctx = audioContext();
  // Still locked (no gesture since load): skip rather than queue a sound for later.
  if (ctx === null || ctx.state !== "running") return;
  try {
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
  } catch {
    // A closed context or an odd browser: the popup and the title still work.
  }
}

// ---------------------------------------------------------------------------
// One alerting tab: several tabs of the app must not alert twice, or alert while
// the viewer is looking at another of them
// ---------------------------------------------------------------------------

/** Written by a tab the viewer is looking at: `{ tab, at }`. */
export const LOOKING_KEY = "st.looking";
/** The id of the last squawk a tab raised a popup for, so a second tab stays quiet (fallback claim). */
export const ALERTED_KEY = "st.alerted";
/** The same, for the chime. */
export const CHIMED_KEY = "st.chimed";
/** A looking tab refreshes its mark this often; a mark older than the TTL is stale. */
export const LOOKING_BEAT_MS = 4_000;
export const LOOKING_TTL_MS = 10_000;

const TAB_ID = Math.random().toString(36).slice(2);

/**
 * Whether the stored looking-mark names a tab other than `tab`, and is fresh. A
 * missing, corrupt or stale mark is no one looking. Pure.
 */
export function anotherTabLooking(raw: string | null, tab: string, now: number): boolean {
  if (raw === null) return false;
  try {
    const m = JSON.parse(raw) as { tab?: unknown; at?: unknown } | null;
    return (
      m !== null &&
      typeof m === "object" &&
      typeof m.tab === "string" &&
      typeof m.at === "number" &&
      m.tab !== tab &&
      now - m.at <= LOOKING_TTL_MS
    );
  } catch {
    return false;
  }
}

function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // No storage: tabs cannot coordinate, and each alerts for itself.
  }
}

/** Remove the looking-mark if it is this tab's own; another tab's mark is left alone. */
function releaseLooking(): void {
  const raw = storageGet(LOOKING_KEY);
  if (raw === null) return;
  try {
    const m = JSON.parse(raw) as { tab?: unknown } | null;
    if (m !== null && typeof m === "object" && m.tab === TAB_ID) {
      window.localStorage.removeItem(LOOKING_KEY);
    }
  } catch {
    // A corrupt mark names no tab, and goes stale on its own.
  }
}

/** Mark this tab as the one being looked at, or release the mark when it is not. */
function syncLooking(now = Date.now()): void {
  if (viewerIsLooking(document)) {
    storageSet(LOOKING_KEY, JSON.stringify({ tab: TAB_ID, at: now }));
  } else {
    releaseLooking();
  }
}

/** How long a tab holds the claim on a squawk, so every other tab has time to lose it. */
export const CLAIM_HOLD_MS = 5_000;

type LockManagerLike = {
  request(
    name: string,
    options: { ifAvailable: boolean },
    callback: (lock: unknown) => Promise<void>,
  ): Promise<void>;
};

/** The two things claimed per squawk: the popup, and the chime (only a tab that can play it). */
type Claim = "alert" | "chime";
const CLAIM_KEY: Record<Claim, string> = { alert: ALERTED_KEY, chime: CHIMED_KEY };

/** The best-effort claim: first to write the squawk's id wins. Not atomic across tabs. */
function claimInStorage(kind: Claim, squawkId: number, raise: () => void): void {
  const mark = String(squawkId);
  if (storageGet(CLAIM_KEY[kind]) === mark) return;
  storageSet(CLAIM_KEY[kind], mark);
  raise();
}

/**
 * Run `raise` in exactly one tab of this browser for a squawk. Web Locks are atomic
 * across tabs, so two hidden tabs that hear the same event at the same instant
 * cannot both win (a `localStorage` read-then-write cannot promise that). Without
 * Web Locks, or when the lock request itself is refused (blocked site data, an
 * opaque origin), a stored claim narrows the window but cannot close it: an alert
 * twice is better than none. A squawk with no id always alerts.
 */
function claimOnce(kind: Claim, squawkId: unknown, raise: () => void): void {
  if (typeof squawkId !== "number") {
    raise();
    return;
  }
  const locks = (navigator as unknown as { locks?: LockManagerLike | null }).locks;
  if (locks == null || typeof locks.request !== "function") {
    claimInStorage(kind, squawkId, raise);
    return;
  }
  let ran = false;
  const fallBack = (err: unknown): void => {
    if (ran) {
      console.error("alerts: raising an alert failed", err);
    } else {
      claimInStorage(kind, squawkId, raise); // the lock never ran: do not lose the alert
    }
  };
  try {
    locks
      .request(`st-${kind}-${squawkId}`, { ifAvailable: true }, async (lock) => {
        if (lock === null) return; // another tab has it
        ran = true;
        raise();
        await new Promise<void>((r) => setTimeout(r, CLAIM_HOLD_MS));
      })
      .catch(fallBack);
  } catch (err) {
    fallBack(err);
  }
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
  // The viewer is looking at another tab of the app: stay quiet.
  if (anotherTabLooking(storageGet(LOOKING_KEY), TAB_ID, now)) return;
  // Every hidden tab counts what it missed; one of them raises the popup and chime.
  unseen += 1;
  paintTitle();
  const { count, chime } = burst.hit(due.listId, now);
  const squawkId = (event.squawk as { id?: unknown } | null | undefined)?.id;
  // The popup and the chime are claimed apart: a tab whose audio is still locked
  // takes the popup but leaves the chime to a tab that can play it.
  claimOnce("alert", squawkId, () => raiseNotification(due, count));
  if (chime && audioReady()) claimOnce("chime", squawkId, playChime);
}

/** Start the title count and the audio unlock. Call once at bootstrap. */
export function initNotify(): void {
  baseTitle = document.title;
  const sync = (): void => {
    syncLooking();
    // Coming back ends the bursts and clears the unseen count.
    if (viewerIsLooking(document)) {
      burst.reset();
      if (unseen > 0) {
        unseen = 0;
        paintTitle();
      }
    }
    // The permission may have changed in the browser's settings while away.
    repaintToggles();
  };
  document.addEventListener("visibilitychange", sync);
  window.addEventListener("focus", sync);
  window.addEventListener("blur", () => syncLooking());
  // A closed or reloaded tab must not leave its mark behind for 10 s, or the
  // other tabs would stay quiet for a viewer who is no longer looking.
  window.addEventListener("pagehide", releaseLooking);
  noticeRegion(); // in the page from the start, so a later message is announced
  window.setInterval(() => syncLooking(), LOOKING_BEAT_MS);
  syncLooking();
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

/**
 * The toggle's state copy. Pure. `popupsBlocked` is true when the alert is on but the
 * browser will not show notifications (permission revoked after turn-on): the chime
 * and the title count still work, so the toggle says so rather than reading plain "on".
 */
export function toggleCopy(
  on: boolean,
  blocked: string | null,
  popupsBlocked = false,
): { label: string; title: string } {
  if (on && popupsBlocked) {
    return {
      label: "Alert: chime only",
      title:
        "The browser is not showing notifications for this site, so you get the chime and the tab count but no popup. Allow notifications in the browser's site settings. Click to turn off.",
    };
  }
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

/**
 * Why a turn-on cannot proceed, or null when it can (permission is asked on the
 * click). `asked` is true once the prompt has been shown: a prompt that is still
 * "default" afterwards was dismissed.
 */
export function blockedReason(
  permission: NotificationPermission | "unsupported",
  asked = false,
): string | null {
  if (permission === "unsupported") {
    return "This browser does not support notifications.";
  }
  if (permission === "denied") {
    return "Notifications are blocked for this site. Allow them in the browser's site settings, then try again.";
  }
  if (permission === "default" && asked) {
    return "Notification permission was not given. Click the alert again to be asked.";
  }
  return null;
}

function currentPermission(): NotificationPermission | "unsupported" {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

const toggles = new Set<{ el: HTMLButtonElement; listId: number; paint: () => void }>();

/** Drop toggles whose button has left the page (a re-rendered view builds new ones). */
function pruneToggles(): void {
  for (const t of toggles) if (!t.el.isConnected) toggles.delete(t);
}

function repaintToggles(): void {
  pruneToggles();
  for (const t of toggles) t.paint();
}

/** How long a notice stays on screen, and the beat between clearing and filling the region. */
export const NOTICE_MS = 8_000;
export const NOTICE_FILL_MS = 50;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Say why a turn-on failed where everyone can see and hear it: a polite live region,
 * because a `title` is invisible on touch and to the keyboard.
 */
function showNotice(message: string): void {
  const el = noticeRegion();
  // Empty it first, then fill it a moment later: a screen reader announces a change
  // to a region it already holds, and a repeat of the same message is a change too.
  el.textContent = "";
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    el.textContent = message;
    noticeTimer = setTimeout(() => {
      el.textContent = "";
    }, NOTICE_MS);
  }, NOTICE_FILL_MS);
}

/**
 * The live region for notices. Always in the page and never `hidden` or
 * `display:none` (a screen reader does not announce what changes in one); CSS hides
 * it while empty.
 */
function noticeRegion(): HTMLElement {
  let el = document.getElementById("alert-notice");
  if (el === null) {
    el = document.createElement("div");
    el.id = "alert-notice";
    el.className = "alert-notice";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    document.body.append(el);
  }
  return el;
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
    const permission = currentPermission();
    if (permission === "granted") blocked = null; // allowed since: drop the old reason
    const popupsBlocked = on && permission !== "granted";
    const c = toggleCopy(on, blocked, popupsBlocked);
    el.textContent = c.label;
    el.title = c.title;
    el.setAttribute("aria-pressed", on ? "true" : "false");
    // A constant name: `aria-pressed` carries the state, so it is not said twice.
    el.setAttribute("aria-label", `Alert for ${getName()}`);
    el.classList.toggle("alert-toggle--on", on);
    el.classList.toggle("alert-toggle--degraded", popupsBlocked);
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
      let asked = false;
      if (permission === "default") {
        asked = true;
        try {
          permission = await Notification.requestPermission();
        } catch {
          permission = "default";
        }
      }
      blocked = blockedReason(permission, asked);
      if (permission === "granted") {
        setAlertOn(listId, getName(), true);
      } else {
        paint();
        if (blocked !== null) showNotice(blocked);
      }
    })();
  });

  pruneToggles();
  toggles.add({ el, listId, paint });
  paint();
  return el;
}
