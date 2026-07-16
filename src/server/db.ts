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
import { MAX_IMAGES_PER_SQUAWK } from "./types.ts";
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

  `);
  // squawk_images owns its own lifecycle below: the 1:N schema plus a one-time,
  // self-detecting migration from the legacy 1:1 table (squawk_id as PK). Kept
  // out of the block above so the migration can rebuild an existing table before
  // a CREATE IF NOT EXISTS would otherwise no-op over the old shape.
  migrateSquawkImages(db);
  connection = db;
  return connection;
}

/**
 * Ensure `squawk_images` is in the 1:N shape (own `id` PK, `squawk_id` FK,
 * `position` for ordering), migrating from the legacy 1:1 shape if needed.
 *
 * Idempotent and self-detecting: it probes the current columns and only rebuilds
 * when it finds the old table (no `id` column). On a fresh DB it just creates the
 * new shape; on an already-migrated DB both branches are no-ops. Exported so the
 * migration can be unit-tested against a throwaway connection without going
 * through the memoized `getDb()` singleton.
 */
export function migrateSquawkImages(db: Database): void {
  const cols = db.query("PRAGMA table_info(squawk_images)").all() as Array<{
    name: string;
  }>;
  const isLegacyShape = cols.length > 0 && !cols.some((c) => c.name === "id");

  if (isLegacyShape) {
    // Rebuild the 1:1 table into the 1:N shape, mapping the single existing
    // image onto position 0. Wrapped in a transaction so a partial rebuild can
    // never leave a torn/half-renamed table behind.
    db.transaction(() => {
      db.exec(`
        CREATE TABLE squawk_images_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          squawk_id INTEGER NOT NULL REFERENCES squawks(id) ON DELETE CASCADE,
          position INTEGER NOT NULL,
          mime TEXT NOT NULL,
          bytes BLOB NOT NULL,
          byte_size INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(squawk_id, position)
        );
        INSERT INTO squawk_images_new (squawk_id, position, mime, bytes, byte_size, created_at)
          SELECT squawk_id, 0, mime, bytes, byte_size, created_at FROM squawk_images;
        DROP TABLE squawk_images;
        ALTER TABLE squawk_images_new RENAME TO squawk_images;
      `);
    })();
  } else {
    db.exec(`
      CREATE TABLE IF NOT EXISTS squawk_images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        squawk_id INTEGER NOT NULL REFERENCES squawks(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        mime TEXT NOT NULL,
        bytes BLOB NOT NULL,
        byte_size INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(squawk_id, position)
      );
    `);
  }
  // Index the FK so per-squawk lookups/ordering don't scan the whole table.
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_squawk_images_squawk ON squawk_images(squawk_id)",
  );
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
 * `SELECT *`. The public `Squawk` adds the derived `image_ids` list (and the
 * `has_image` flag derived from it) on top; DB helpers project a `SquawkRow` up
 * to a `Squawk` by attaching those from a lookup against `squawk_images`.
 */
type SquawkRow = Omit<Squawk, "has_image" | "image_ids">;

/**
 * Correlated subquery yielding a JSON array of a squawk's image ids ordered by
 * `position` (upload order). The inner ordered subquery fixes the row order that
 * `json_group_array` then aggregates, so the array is position-sorted; an
 * imageless squawk yields `'[]'`. Bytes never leave the DB — only ids ride here.
 */
const IMAGE_IDS_JSON_SELECT =
  "(SELECT json_group_array(id) FROM (SELECT id FROM squawk_images WHERE squawk_id = squawks.id ORDER BY position ASC)) AS image_ids_json";

/** Project a raw row (+ its `image_ids_json`) into the public `Squawk`. */
function projectSquawk(row: SquawkRow & { image_ids_json: string }): Squawk {
  const { image_ids_json, ...rest } = row;
  const image_ids = JSON.parse(image_ids_json) as number[];
  return { ...rest, image_ids, has_image: image_ids.length > 0 };
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
      // A just-created squawk has no images yet; RETURNING can't carry a subquery.
      return { ...row, image_ids: [], has_image: false };
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
  const image_ids = listSquawkImageIds(id);
  return { ...row, image_ids, has_image: image_ids.length > 0 };
}

/** Return one squawk by id (with its derived `image_ids`), or null if absent. */
export function getSquawk(id: number): Squawk | null {
  const row = getDb()
    .query(`SELECT squawks.*, ${IMAGE_IDS_JSON_SELECT} FROM squawks WHERE id = ?`)
    .get(id) as (SquawkRow & { image_ids_json: string }) | null;
  return row ? projectSquawk(row) : null;
}

/**
 * Delete a squawk by id. Returns true if a row was removed.
 * Used only for the "undo" window (within seconds of creation).
 */
export function deleteSquawk(id: number): boolean {
  return getDb().query("DELETE FROM squawks WHERE id = ?").run(id).changes > 0;
}

/** Return a list's squawks, newest first (`seq DESC`), each with `image_ids`. */
export function listSquawks(listId: number): Squawk[] {
  const rows = getDb()
    .query(
      `SELECT squawks.*, ${IMAGE_IDS_JSON_SELECT}
       FROM squawks WHERE list_id = ? ORDER BY seq DESC`,
    )
    .all(listId) as (SquawkRow & { image_ids_json: string })[];
  return rows.map(projectSquawk);
}

// ---------------------------------------------------------------------------
// Squawk images (up to MAX_IMAGES_PER_SQUAWK per squawk; bytes stored in-DB)
// ---------------------------------------------------------------------------

/** An image's stored bytes plus the metadata needed to serve it. */
export interface SquawkImage {
  mime: string;
  // ArrayBuffer-backed so it serves as a BodyInit/BlobPart without a copy.
  bytes: Uint8Array<ArrayBuffer>;
  byteSize: number;
}

/**
 * Raised by {@link addSquawkImage} when a squawk already holds the maximum
 * number of images. The route layer maps this to a `409`.
 */
export class ImageLimitError extends Error {
  constructor(public readonly squawkId: number) {
    super(
      `squawk ${squawkId} already has the maximum of ${MAX_IMAGES_PER_SQUAWK} images`,
    );
    this.name = "ImageLimitError";
  }
}

/**
 * Append an image to a squawk at the next `position`, up to
 * {@link MAX_IMAGES_PER_SQUAWK}. Throws {@link ImageLimitError} once the squawk
 * is full. The count-check and insert run in one transaction so the cap holds
 * even under concurrent appends. Caller validates `mime` + size first; the FK
 * enforces that `squawkId` exists. Returns the new image's id and position.
 */
export function addSquawkImage(
  squawkId: number,
  img: { mime: string; bytes: Uint8Array; byteSize: number },
): { id: number; position: number } {
  const db = getDb();
  return db.transaction(() => {
    const agg = db
      .query(
        "SELECT COUNT(*) AS n, COALESCE(MAX(position), -1) AS maxpos FROM squawk_images WHERE squawk_id = ?",
      )
      .get(squawkId) as { n: number; maxpos: number };
    if (agg.n >= MAX_IMAGES_PER_SQUAWK) {
      throw new ImageLimitError(squawkId);
    }
    const position = agg.maxpos + 1;
    const row = db
      .query(
        `INSERT INTO squawk_images (squawk_id, position, mime, bytes, byte_size, created_at)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(squawkId, position, img.mime, img.bytes, img.byteSize, now()) as {
      id: number;
    };
    return { id: row.id, position };
  })();
}

/** A squawk's image ids ordered by `position` (upload order). Cheap — no BLOBs. */
export function listSquawkImageIds(squawkId: number): number[] {
  return (
    getDb()
      .query(
        "SELECT id FROM squawk_images WHERE squawk_id = ? ORDER BY position ASC",
      )
      .all(squawkId) as Array<{ id: number }>
  ).map((r) => r.id);
}

/**
 * Return one image's bytes + mime, scoped to its squawk so a mismatched
 * `(squawkId, imageId)` pair yields null (→ 404) rather than another squawk's image.
 */
export function getSquawkImageById(
  squawkId: number,
  imageId: number,
): SquawkImage | null {
  const row = getDb()
    .query(
      "SELECT mime, bytes, byte_size FROM squawk_images WHERE id = ? AND squawk_id = ?",
    )
    .get(imageId, squawkId) as
    | { mime: string; bytes: Uint8Array<ArrayBuffer>; byte_size: number }
    | null;
  return row
    ? { mime: row.mime, bytes: row.bytes, byteSize: row.byte_size }
    : null;
}

/** Remove one image (scoped to its squawk). Returns true if a row was deleted. */
export function deleteSquawkImageById(
  squawkId: number,
  imageId: number,
): boolean {
  return (
    getDb()
      .query("DELETE FROM squawk_images WHERE id = ? AND squawk_id = ?")
      .run(imageId, squawkId).changes > 0
  );
}
