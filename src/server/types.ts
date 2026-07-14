/**
 * Shared domain types for the Squawkie-Talkie data layer.
 *
 * These mirror the SQLite schema declared in `db.ts`. A "list" is a named
 * collection of "squawks"; each squawk carries a per-list monotonic `seq`,
 * a lifecycle `state`, and the initials of the operator who logged it.
 */

/** Lifecycle state of a squawk. Matches the CHECK constraint on `squawks.state`. */
export type SquawkState = "open" | "retired" | "recorded";

/** A named list. `next_seq` is the next per-list squawk number to allocate. */
export interface List {
  id: number;
  name: string;
  next_seq: number;
  created_at: string;
}

/**
 * A single squawk belonging to a list.
 *
 * `has_image` is a *derived* wire field, not a stored column: it reflects
 * whether a row exists in `squawk_images` for this squawk. The image bytes are
 * never inlined here — clients lazy-load `GET /api/squawks/:id/image` when the
 * flag is set (bytes must never ride the squawk JSON or an SSE frame).
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
}
