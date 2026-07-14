/**
 * SQLite data layer for Squawkie-Talkie.
 *
 * This module is the single source of truth for persistence. It opens one
 * `bun:sqlite` connection (path from `SQUAWK_DB`, default `squawk.db`; tests
 * pass `:memory:`), enables foreign keys, ensures the schema, and exports
 * typed repository functions used by the REST API.
 *
 * "Expunge from the instance" is implemented as a foreign-key cascade delete:
 * removing a list removes all of its squawks.
 */

import { Database } from "bun:sqlite";
import type { List, Squawk, SquawkState } from "./types.ts";

/**
 * Lazily-opened shared connection. The DB is NOT opened at import time: the
 * path (`SQUAWK_DB`, default `squawk.db`) is resolved on first use, so merely
 * importing this module (e.g. a healthz test importing the server) never
 * creates a database file, and a test can set `SQUAWK_DB=:memory:` any time
 * before the first query.
 */
let connection: Database | null = null;

/** Open the connection (once), applying pragmas + schema, and return it. */
export function getDb(): Database {
  if (connection) {
    return connection;
  }
  const db = new Database(process.env.SQUAWK_DB ?? "squawk.db");
  // Foreign keys are per-connection in SQLite; required for ON DELETE CASCADE.
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS lists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      next_seq INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS squawks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','retired','recorded')),
      initials TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- One optional image per squawk. Bytes live in-DB so the "instance = one
    -- file" backup/expunge story holds and the cascade below reclaims them for
    -- free: deleting the squawk (the undo) or its list drops the image with no
    -- app-level cleanup. squawk_id is both PK and FK, enforcing the 1:1.
    CREATE TABLE IF NOT EXISTS squawk_images (
      squawk_id INTEGER PRIMARY KEY REFERENCES squawks(id) ON DELETE CASCADE,
      mime TEXT NOT NULL,
      bytes BLOB NOT NULL,
      byte_size INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  connection = db;
  return connection;
}

/** Current timestamp as an ISO-8601 string. */
function now(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

/** Create a list and return the persisted row. */
export function createList(name: string): List {
  return getDb()
    .query(
      "INSERT INTO lists (name, next_seq, created_at) VALUES (?, 1, ?) RETURNING *",
    )
    .get(name, now()) as List;
}

/** Return all lists, oldest first. */
export function listLists(): List[] {
  return getDb().query("SELECT * FROM lists ORDER BY id ASC").all() as List[];
}

/** Return one list by id, or null if it does not exist. */
export function getList(id: number): List | null {
  return (
    (getDb().query("SELECT * FROM lists WHERE id = ?").get(id) as List | null) ??
    null
  );
}

/**
 * Return the list with this exact `name`, or null if none. Names are not unique,
 * so the oldest match (lowest id) wins.
 */
export function getListByName(name: string): List | null {
  return (
    (getDb()
      .query("SELECT * FROM lists WHERE name = ? ORDER BY id ASC LIMIT 1")
      .get(name) as List | null) ?? null
  );
}

/**
 * Delete a list and (via the FK cascade) all of its squawks.
 * Returns true if a list row was removed.
 */
export function deleteList(id: number): boolean {
  return getDb().query("DELETE FROM lists WHERE id = ?").run(id).changes > 0;
}

// ---------------------------------------------------------------------------
// Squawks
// ---------------------------------------------------------------------------

/**
 * The stored squawk columns, exactly as they come back from `RETURNING *` /
 * `SELECT *`. The public `Squawk` adds the derived `has_image` flag on top; DB
 * helpers project a `SquawkRow` up to a `Squawk` by attaching that flag (either
 * a known constant, or an `EXISTS`/lookup against `squawk_images`).
 */
type SquawkRow = Omit<Squawk, "has_image">;

/** Coerce SQLite's 0/1 `EXISTS` result into the `has_image` boolean. */
function rowWithImageFlag(row: SquawkRow & { has_image: number }): Squawk {
  return { ...row, has_image: !!row.has_image };
}

/**
 * Create a squawk under `listId`, allocating a per-list monotonic `seq`.
 *
 * Wrapped in a transaction so the seq read+increment and the insert are
 * atomic. `next_seq` is advanced on allocation and never rolled back, so a
 * seq is never reused even if its squawk is later deleted.
 */
type SquawkTx = (listId: number, text: string, initials: string) => Squawk;
let squawkTx: SquawkTx | null = null;

/** Build (once) the prepared transaction bound to the open connection. */
function getSquawkTx(): SquawkTx {
  if (squawkTx) {
    return squawkTx;
  }
  const db = getDb();
  squawkTx = db.transaction(
    (listId: number, text: string, initials: string): Squawk => {
      const seqRow = db
        .query(
          "UPDATE lists SET next_seq = next_seq + 1 WHERE id = ? RETURNING next_seq - 1 AS seq",
        )
        .get(listId) as { seq: number } | null;
      if (!seqRow) {
        throw new Error(`createSquawk: list ${listId} not found`);
      }

      const ts = now();
      const row = db
        .query(
          `INSERT INTO squawks (list_id, seq, text, state, initials, created_at, updated_at)
           VALUES (?, ?, ?, 'open', ?, ?, ?) RETURNING *`,
        )
        .get(listId, seqRow.seq, text, initials, ts, ts) as SquawkRow;
      // A just-created squawk has no image yet; RETURNING can't carry a subquery.
      return { ...row, has_image: false };
    },
  );
  return squawkTx;
}

export function createSquawk(
  listId: number,
  text: string,
  initials: string,
): Squawk {
  return getSquawkTx()(listId, text, initials);
}

/**
 * Update a squawk's `text` and/or `state` and refresh `updated_at`.
 * When `initials` is provided it records who made the change.
 * Throws if the squawk does not exist.
 */
export function updateSquawk(
  id: number,
  patch: { text?: string; state?: SquawkState },
  initials?: string,
): Squawk {
  const sets: string[] = [];
  const params: (string | number)[] = [];

  if (patch.text !== undefined) {
    sets.push("text = ?");
    params.push(patch.text);
  }
  if (patch.state !== undefined) {
    sets.push("state = ?");
    params.push(patch.state);
  }
  if (initials !== undefined) {
    sets.push("initials = ?");
    params.push(initials);
  }

  sets.push("updated_at = ?");
  params.push(now());
  params.push(id);

  const row = getDb()
    .query(`UPDATE squawks SET ${sets.join(", ")} WHERE id = ? RETURNING *`)
    .get(...params) as SquawkRow | null;
  if (!row) {
    throw new Error(`updateSquawk: squawk ${id} not found`);
  }
  return { ...row, has_image: squawkHasImage(id) };
}

/** Return one squawk by id (with its derived `has_image`), or null if absent. */
export function getSquawk(id: number): Squawk | null {
  const row = getDb()
    .query(
      `SELECT squawks.*,
              EXISTS(SELECT 1 FROM squawk_images WHERE squawk_id = squawks.id) AS has_image
       FROM squawks WHERE id = ?`,
    )
    .get(id) as (SquawkRow & { has_image: number }) | null;
  return row ? rowWithImageFlag(row) : null;
}

/**
 * Delete a squawk by id. Returns true if a row was removed.
 * Used only for the "undo" window (within seconds of creation).
 */
export function deleteSquawk(id: number): boolean {
  return getDb().query("DELETE FROM squawks WHERE id = ?").run(id).changes > 0;
}

/** Return a list's squawks, newest first (`seq DESC`), each with `has_image`. */
export function listSquawks(listId: number): Squawk[] {
  const rows = getDb()
    .query(
      `SELECT squawks.*,
              EXISTS(SELECT 1 FROM squawk_images WHERE squawk_id = squawks.id) AS has_image
       FROM squawks WHERE list_id = ? ORDER BY seq DESC`,
    )
    .all(listId) as (SquawkRow & { has_image: number })[];
  return rows.map(rowWithImageFlag);
}

// ---------------------------------------------------------------------------
// Squawk images (one optional image per squawk; bytes stored in-DB)
// ---------------------------------------------------------------------------

/** An image's stored bytes plus the metadata needed to serve it. */
export interface SquawkImage {
  mime: string;
  // ArrayBuffer-backed so it serves as a BodyInit/BlobPart without a copy.
  bytes: Uint8Array<ArrayBuffer>;
  byteSize: number;
}

/**
 * Attach (or replace) the image for a squawk. Upsert on the `squawk_id` PK so
 * re-attaching swaps the bytes rather than erroring. Caller is responsible for
 * validating `mime` (allowlist) and size before calling.
 */
export function setSquawkImage(
  squawkId: number,
  img: { mime: string; bytes: Uint8Array; byteSize: number },
): void {
  getDb()
    .query(
      `INSERT INTO squawk_images (squawk_id, mime, bytes, byte_size, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(squawk_id) DO UPDATE SET
         mime = excluded.mime, bytes = excluded.bytes,
         byte_size = excluded.byte_size, created_at = excluded.created_at`,
    )
    .run(squawkId, img.mime, img.bytes, img.byteSize, now());
}

/** Return a squawk's image bytes + mime, or null if it has none. */
export function getSquawkImage(squawkId: number): SquawkImage | null {
  const row = getDb()
    .query("SELECT mime, bytes, byte_size FROM squawk_images WHERE squawk_id = ?")
    .get(squawkId) as
    | { mime: string; bytes: Uint8Array<ArrayBuffer>; byte_size: number }
    | null;
  return row
    ? { mime: row.mime, bytes: row.bytes, byteSize: row.byte_size }
    : null;
}

/** Remove a squawk's image. Returns true if a row was deleted. */
export function deleteSquawkImage(squawkId: number): boolean {
  return (
    getDb().query("DELETE FROM squawk_images WHERE squawk_id = ?").run(squawkId)
      .changes > 0
  );
}

/** Whether a squawk currently has an image (cheap existence probe). */
export function squawkHasImage(squawkId: number): boolean {
  return !!getDb()
    .query("SELECT 1 FROM squawk_images WHERE squawk_id = ? LIMIT 1")
    .get(squawkId);
}
