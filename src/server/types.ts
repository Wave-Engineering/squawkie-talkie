/**
 * Shared domain types for the Squawkie-Talkie data layer.
 *
 * These mirror the SQLite schema declared in `db.ts`. A "list" is a named
 * collection of "squawks"; each squawk carries a per-list monotonic `seq`,
 * a lifecycle `state`, and the initials of the operator who logged it.
 */

/** Lifecycle state of a squawk. Matches the CHECK constraint on `squawks.state`. */
export type SquawkState = "open" | "retired" | "recorded";

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
