/**
 * Realtime client wiring (Story 1.8 / #9) — the client half of the realtime
 * spine. It opens the Server-Sent Events stream broadcast by #5 and patches the
 * surgical, id-keyed rows rendered by #7 (lists) and #8 (detail) so changes made
 * by other viewers appear live.
 *
 * Two seams keep this decoupled from the views' internals:
 *
 *   1. Each view registers a small {@link ViewBinding} on mount (`setActiveView`)
 *      describing how to upsert/remove its rows. Realtime never rebuilds rows
 *      itself, so a remotely-created squawk row keeps the view's own autosave /
 *      edit handlers — no duplication, no drift.
 *   2. The focused-box-protection rule is a pure, unit-tested function
 *      ({@link shouldApplyToInput}): a remote `squawk.updated` overwrites the
 *      stored value of every row EXCEPT the input the viewer is currently typing
 *      in. Its own blur is the last write; yanking the value would move the
 *      cursor out from under them.
 *
 * Last-write-wins: for any row that is NOT focused, the remote value overwrites
 * the local value unconditionally.
 */

import type { List, Squawk } from "../server/types.ts";

// ---------------------------------------------------------------------------
// Event shapes (mirror the broadcasts emitted by src/server/sse.ts)
// ---------------------------------------------------------------------------

/** A realtime event as broadcast by the server over `/api/stream`. */
export type RealtimeEvent =
  | { type: "list.created"; list: List }
  | { type: "list.deleted"; id: number }
  | { type: "squawk.created"; squawk: Squawk }
  | { type: "squawk.updated"; squawk: Squawk }
  | { type: "squawk.deleted"; id: number }
  // Forward-compatible catch-all for event types this client doesn't model yet.
  | { type: string; [k: string]: unknown };

// ---------------------------------------------------------------------------
// Active-view registry seam
// ---------------------------------------------------------------------------

/** The Lists screen's realtime sink. Operations are idempotent. */
export interface ListsViewBinding {
  kind: "lists";
  /** Add the list's row if it is not already shown. */
  upsertList(list: List): void;
  /** Remove the list's row if present. */
  removeList(id: number): void;
  /**
   * Re-fetch and reconcile this view after an SSE reconnect. SSE has no replay,
   * so events missed while offline are only recoverable by re-fetching. Idempotent.
   */
  resync?(): void | Promise<void>;
}

/** The list-detail screen's realtime sink. Operations are idempotent. */
export interface DetailViewBinding {
  kind: "detail";
  /** The list currently being viewed; events for other lists are ignored. */
  listId: number;
  /** Insert the squawk's row if absent. */
  upsertSquawk(squawk: Squawk): void;
  /**
   * Apply a remote update to an existing squawk's row. The stored value and
   * state always update (last-write-wins); `applyToInput` is false only when the
   * row's text input currently holds focus, in which case the input's DOM value
   * is left untouched so the typing viewer's cursor is preserved.
   */
  patchSquawk(squawk: Squawk, applyToInput: boolean): void;
  /** Remove a squawk's row (undo/delete). */
  removeSquawk(id: number): void;
  /**
   * Re-fetch and reconcile this view after an SSE reconnect. SSE has no replay,
   * so events missed while offline are only recoverable by re-fetching. Must not
   * clobber a control the viewer is actively editing (invariant #1).
   */
  resync?(): void | Promise<void>;
}

/** Whichever view is presently mounted, or none. */
export type ViewBinding = ListsViewBinding | DetailViewBinding;

let active: ViewBinding | null = null;

/** Register (or clear) the realtime sink for the currently-mounted view. */
export function setActiveView(binding: ViewBinding | null): void {
  active = binding;
}

/** The realtime sink for the currently-mounted view, or null. */
export function activeView(): ViewBinding | null {
  return active;
}

// ---------------------------------------------------------------------------
// Connection status (drives the on-air / off-air indicator)
// ---------------------------------------------------------------------------

/**
 * Liveness of the realtime channel:
 *  - `connecting` — before the first `open` (or an initial connect in progress)
 *  - `online`     — the SSE stream is open; changes flow live
 *  - `offline`    — the stream dropped and reconnection is failing (surfaced only
 *                   after a short grace so a quick reconnect doesn't strobe)
 */
export type ConnStatus = "connecting" | "online" | "offline";

let connStatus: ConnStatus = "connecting";
const connSubs = new Set<(s: ConnStatus) => void>();

/** Grace before a dropped stream is surfaced as `offline` (avoid strobing quick reconnects). */
const OFFLINE_GRACE_MS = 2_000;

/** Current realtime connection status. */
export function connectionStatus(): ConnStatus {
  return connStatus;
}

/** Subscribe to connection-status changes; emits the current status immediately. Returns an unsubscribe. */
export function onConnectionStatus(fn: (s: ConnStatus) => void): () => void {
  connSubs.add(fn);
  fn(connStatus);
  return () => connSubs.delete(fn);
}

function setConnStatus(next: ConnStatus): void {
  if (next === connStatus) return;
  connStatus = next;
  for (const fn of [...connSubs]) fn(next);
}

// ---------------------------------------------------------------------------
// Pure helpers (unit tested in tests/realtime.test.ts)
// ---------------------------------------------------------------------------

/**
 * The load-bearing focused-box-protection rule. Should a remote
 * `squawk.updated` overwrite the focused input's DOM value?
 *
 * No when the focused input belongs to the very squawk being updated — its own
 * blur is the last write, so overwriting it would yank the cursor. Yes in every
 * other case (a different squawk is focused, or nothing is focused).
 */
export function shouldApplyToInput(
  activeElementSquawkId: number | null,
  eventSquawkId: number,
): boolean {
  return activeElementSquawkId !== eventSquawkId;
}

/**
 * The squawk id of the row that owns `el` (the focused element), or null when
 * `el` is not inside a squawk row. Reads the `data-squawk-id` seam set by #8.
 */
export function activeSquawkId(el: Element | null): number | null {
  const row = el?.closest?.("[data-squawk-id]") as HTMLElement | null;
  const raw = row?.dataset?.squawkId;
  return raw ? Number(raw) : null;
}

// ---------------------------------------------------------------------------
// Event application
// ---------------------------------------------------------------------------

/** Everything {@link applyEvent} needs: the active view and the focused element. */
export interface ApplyContext {
  view: ViewBinding | null;
  activeElement: Element | null;
}

/**
 * Apply one realtime event against the active view. A no-op when no view is
 * mounted, or when the event targets a screen/list the viewer is not on. Safe to
 * call repeatedly with the same event (EventSource may replay after reconnect).
 */
export function applyEvent(event: RealtimeEvent, ctx: ApplyContext): void {
  const { view, activeElement } = ctx;

  switch (event.type) {
    case "list.created": {
      if (view?.kind === "lists" && isListEvent(event)) {
        view.upsertList(event.list);
      }
      return;
    }
    case "list.deleted": {
      if (view?.kind === "lists" && typeof event.id === "number") {
        view.removeList(event.id);
      }
      return;
    }
    case "squawk.created": {
      if (view?.kind === "detail" && isSquawkEvent(event)) {
        if (view.listId === event.squawk.list_id) {
          view.upsertSquawk(event.squawk);
        }
      }
      return;
    }
    case "squawk.updated": {
      if (view?.kind === "detail" && isSquawkEvent(event)) {
        if (view.listId === event.squawk.list_id) {
          const applyToInput = shouldApplyToInput(
            activeSquawkId(activeElement),
            event.squawk.id,
          );
          view.patchSquawk(event.squawk, applyToInput);
        }
      }
      return;
    }
    case "squawk.deleted": {
      if (view?.kind === "detail" && typeof event.id === "number") {
        view.removeSquawk(event.id);
      }
      return;
    }
    default:
      // Unknown event type — ignore (forward compatible).
      return;
  }
}

/** Narrow a catch-all event to one carrying a `list` payload. */
function isListEvent(event: RealtimeEvent): event is { type: string; list: List } {
  return "list" in event && event.list != null;
}

/** Narrow a catch-all event to one carrying a `squawk` payload. */
function isSquawkEvent(
  event: RealtimeEvent,
): event is { type: string; squawk: Squawk } {
  return "squawk" in event && event.squawk != null;
}

// ---------------------------------------------------------------------------
// Stream subscription
// ---------------------------------------------------------------------------

/** Handles a parsed realtime event. */
export type Dispatch = (event: RealtimeEvent) => void;

/**
 * The default dispatch: apply the event against the currently-mounted view,
 * reading focus from `document.activeElement` at delivery time.
 */
export function dispatch(event: RealtimeEvent): void {
  applyEvent(event, {
    view: activeView(),
    activeElement: document.activeElement,
  });
}

/**
 * Subscribe to the server SSE stream. Each `message` frame is parsed as JSON and
 * handed to `handler` (defaulting to {@link dispatch}). `EventSource`
 * auto-reconnects on drop; because handlers are idempotent, a post-reconnect
 * replay is harmless. Returns the `EventSource` for teardown in tests.
 */
export function connect(handler: Dispatch = dispatch): EventSource {
  const source = new EventSource("/api/stream");

  // Reconnect grace: EventSource fires `error` on every dropped/failed attempt
  // and auto-retries. Only surface `offline` if we stay down past the grace, so
  // a quick reconnect doesn't strobe the indicator.
  let offlineTimer: ReturnType<typeof setTimeout> | null = null;
  // Whether the stream dropped since the last successful `open`. Drives the
  // resync independently of the indicator's offline grace, so a reconnect that
  // races inside the grace window still recovers missed events (SSE has no replay).
  let droppedSinceOpen = false;

  source.addEventListener("open", () => {
    if (offlineTimer !== null) {
      clearTimeout(offlineTimer);
      offlineTimer = null;
    }
    const wasDropped = droppedSinceOpen;
    droppedSinceOpen = false;
    setConnStatus("online");
    // Reconnected after a drop: SSE has no replay, so re-fetch the active view
    // to recover anything broadcast while we were disconnected.
    if (wasDropped) {
      void active?.resync?.();
    }
  });

  source.addEventListener("error", () => {
    droppedSinceOpen = true;
    // Already offline, or the grace timer is running — nothing to schedule.
    if (connStatus === "offline" || offlineTimer !== null) {
      return;
    }
    offlineTimer = setTimeout(() => {
      offlineTimer = null;
      setConnStatus("offline");
    }, OFFLINE_GRACE_MS);
  });

  source.addEventListener("message", (ev) => {
    let event: RealtimeEvent;
    try {
      event = JSON.parse((ev as MessageEvent).data) as RealtimeEvent;
    } catch {
      // Non-JSON frame (e.g. a stray comment) — nothing to apply.
      return;
    }
    handler(event);
  });

  return source;
}
