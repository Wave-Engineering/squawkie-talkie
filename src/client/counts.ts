/**
 * What both pages show about a list's contents (#145): its glyph counts
 * (`○3 ✓2 ✗1 ◌4 ↗1`), whether it is settled, and what changed since this
 * browser last looked. The list's own header and every row on the lists page
 * render the counts through the same two functions, so they cannot drift.
 */
import { SQUAWK_STATES, STATE_GLYPHS } from "../server/types.ts";
import type { SquawkState, StateCounts } from "../server/types.ts";

/**
 * Render the counts as glyph tallies in state order, omitting every state with a
 * zero count, so the glyph says what each number counts (#137).
 */
export function renderCounts(el: HTMLElement, counts: StateCounts): void {
  el.replaceChildren(
    ...SQUAWK_STATES.filter((s) => counts[s] > 0).map((s) => countSpan(counts[s], s)),
  );
}

function countSpan(n: number, state: SquawkState): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = `count count--${state}`;
  span.textContent = `${STATE_GLYPHS[state]}${n}`;
  span.title = `${state}: ${n}`;
  return span;
}

/** The counts in words, for assistive tech: `2 open, 1 retired`, or `empty`. */
export function describeCounts(counts: StateCounts): string {
  const parts = SQUAWK_STATES.filter((s) => counts[s] > 0).map((s) => `${counts[s]} ${s}`);
  return parts.length > 0 ? parts.join(", ") : "empty";
}

/** A list is settled, and struck through, when it has squawks and none is open. */
export function isSettled(counts: StateCounts): boolean {
  const total = SQUAWK_STATES.reduce((sum, s) => sum + counts[s], 0);
  return total > 0 && counts.open === 0;
}

// ---------------------------------------------------------------------------
// Last seen, per list, in this browser
// ---------------------------------------------------------------------------

/** The `localStorage` key holding `{ [listId]: iso }`. */
export const LAST_SEEN_KEY = "sqtk.lastSeen";

/** What this browser last saw of each list, or null when storage is unavailable. */
export function readLastSeen(): Record<string, string> | null {
  try {
    const raw = window.localStorage.getItem(LAST_SEEN_KEY);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return null;
  }
}

/**
 * Record that this browser has seen `listId` as of `iso`. It never moves the value
 * back, so an older timestamp arriving late can't re-badge a list. A failure to
 * write is silent: no storage means no badges, not errors.
 *
 * The item page also marks the reader's own edits seen, from the PATCH response.
 * That response doesn't ride the event stream, so if the stream had dropped, an
 * earlier change by someone else could be marked seen without being shown. It
 * needs a dropped stream and leaving before the reconnect's resync; the tight
 * fix would need the server to send the previous timestamp, so we accept it.
 */
export function markSeen(listId: number, iso: string): void {
  try {
    const seen = readLastSeen();
    if (seen === null) return;
    const prev = seen[String(listId)];
    if (prev !== undefined && prev >= iso) return;
    seen[String(listId)] = iso;
    window.localStorage.setItem(LAST_SEEN_KEY, JSON.stringify(seen));
  } catch {
    /* storage full or blocked: no badge, no error */
  }
}

/**
 * Whether a list shows the changed badge: it changed after this browser last saw
 * it. `seen` is null when storage is unavailable, and then nothing is badged. It
 * is undefined for a list this browser has never opened, which is badged when it
 * has anything newer than its own creation: a list someone else filled reads as
 * news, and an empty one doesn't.
 */
export function isChanged(
  list: { last_activity: string; created_at: string },
  seen: string | undefined | null,
): boolean {
  if (seen === null) return false;
  if (seen === undefined) return list.last_activity > list.created_at;
  return list.last_activity > seen;
}

/**
 * The squawks the item page marks as changed since the last load (#145): those
 * created or updated after `seen`. Nothing is marked when storage is unavailable
 * or the list was never opened in this browser, since then every row would be.
 */
export function changedSquawkIds(
  squawks: Iterable<{ id: number; created_at: string; updated_at: string }>,
  seen: string | undefined | null,
): number[] {
  if (seen === undefined || seen === null) return [];
  const ids: number[] = [];
  for (const s of squawks) {
    if (s.updated_at > seen || s.created_at > seen) ids.push(s.id);
  }
  return ids;
}
