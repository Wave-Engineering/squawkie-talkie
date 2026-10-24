/**
 * Shared domain types for the Squawkie-Talkie data layer.
 *
 * These mirror the SQLite schema declared in `db.ts`. A "list" is a named
 * collection of "squawks"; each squawk carries a per-list monotonic `seq`,
 * a lifecycle `state`, and the initials of the operator who logged it.
 */

/**
 * Every lifecycle state a squawk may hold, in dropdown and `←/→` cycle order. The
 * single source of truth: the `squawks.state` CHECK constraint, the API's
 * validation, the client's dropdown and the counts are all built from it (#137).
 */
export const SQUAWK_STATES = [
  "open",
  "confirmed",
  "rejected",
  "retired",
  "recorded",
] as const;

/** Lifecycle state of a squawk. Matches the CHECK constraint on `squawks.state`. */
export type SquawkState = (typeof SQUAWK_STATES)[number];

/**
 * The glyph each state shows everywhere it appears (dropdown, row, counts, CLI).
 * Monochrome Unicode, not emoji, so it takes the text color; the glyph carries the
 * meaning and color only reinforces it. `○` → `◌` is deliberate: retired reads as
 * the open item faded out, not as a verdict. The `sqtk` CLI keeps its own copy of
 * this map (it is bash); `tests/cli.test.ts` holds the two in step.
 */
export const STATE_GLYPHS: Readonly<Record<SquawkState, string>> = {
  open: "○",
  confirmed: "✓",
  rejected: "✗",
  retired: "◌",
  recorded: "↗",
};

/**
 * Maximum images attachable to a single squawk. Shared by the server (cap
 * enforcement) and the client (disabling the attach control at the limit) so the
 * number can't drift between the two.
 */
export const MAX_IMAGES_PER_SQUAWK = 5;

/** A named list. `next_seq` is the next per-list squawk number to allocate. */
export interface List {
  id: number;
  name: string;
  next_seq: number;
  created_at: string;
}

/** A count for every state, zero-filled. */
export type StateCounts = Record<SquawkState, number>;

/**
 * A list with what the lists page shows about it (#145): its squawk counts by
 * state, and `last_activity`, the latest of its own `created_at` and its squawks'
 * `created_at`/`updated_at` (ISO, the same format as `updated_at`). A squawk
 * deleted from the list does not move it.
 */
export interface ListWithStats extends List {
  counts: StateCounts;
  last_activity: string;
}

/**
 * A single squawk belonging to a list.
 *
 * `image_ids` is a *derived* wire field, not a stored column: the ordered ids
 * (upload order, up to {@link MAX_IMAGES_PER_SQUAWK}) of this squawk's images.
 * `has_image` is derived from it (`image_ids.length > 0`) and kept for existing
 * consumers. Image bytes are never inlined here — clients lazy-load
 * `GET /api/squawks/:id/images/:imageId` per id (bytes must never ride the
 * squawk JSON or an SSE frame).
 */
export interface Squawk {
  id: number;
  list_id: number;
  seq: number;
  text: string;
  state: SquawkState;
  initials: string;
  created_at: string;
  updated_at: string;
  has_image: boolean;
  image_ids: number[];
}
