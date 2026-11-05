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
import { MAX_IMAGES_PER_SQUAWK, SQUAWK_STATES } from "./types.ts";
import type {
  List,
  ListWithStats,
  Squawk,
  SquawkState,
  StateCounts,
} from "./types.ts";

/**
 * `CREATE TABLE` for `squawks` under `name`, its `state` CHECK built from
 * `SQUAWK_STATES` so the constraint cannot drift from the type. Shared by the
 * fresh-DB create and the state migration's rebuild.
 */
function squawksTableSql(name: string): string {
  const states = SQUAWK_STATES.map((s) => `'${s}'`).join(",");
  return `CREATE TABLE IF NOT EXISTS ${name} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'open' CHECK(state IN (${states})),
      initials TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      options_json TEXT,
      choice TEXT,
      note TEXT NOT NULL DEFAULT ''
    )`;
}

/**
 * The columns #168 added to `squawks`, each with the definition `ALTER TABLE`
 * needs. A table created before them gains them in place (`migrateSquawkColumns`);
 * a fresh one has them from `squawksTableSql`.
 */
const SQUAWK_ADDED_COLUMNS: ReadonlyArray<readonly [name: string, ddl: string]> = [
  ["options_json", "options_json TEXT"],
  ["choice", "choice TEXT"],
  ["note", "note TEXT NOT NULL DEFAULT ''"],
];

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

    ${squawksTableSql("squawks")};
  `);
  // An existing DB keeps the CHECK it was created with (CREATE IF NOT EXISTS is a
  // no-op over it), so widen it in place when it predates a state (#137).
  migrateSquawkStates(db);
  // A table that predates answer options, choices and notes (#168) gains them in place.
  migrateSquawkColumns(db);
  // squawk_images owns its own lifecycle below: the 1:N schema plus a one-time,
  // self-detecting migration from the legacy 1:1 table (squawk_id as PK). Kept
  // out of the block above so the migration can rebuild an existing table before
  // a CREATE IF NOT EXISTS would otherwise no-op over the old shape.
  migrateSquawkImages(db);
  connection = db;
  return connection;
}

/**
 * Ensure the `squawks.state` CHECK admits every state in `SQUAWK_STATES`,
 * rebuilding the table if it was created before one of them existed (#137: the
 * original `('open','retired','recorded')` gains `confirmed` and `rejected`).
 *
 * SQLite cannot alter a CHECK, so this is the documented table rebuild: create
 * `squawks_new`, copy every row with its `id` intact, drop, rename. Foreign keys
 * are switched OFF around it, because with them on, `DROP TABLE squawks` would
 * cascade-delete every row of `squawk_images` (its FK is `ON DELETE CASCADE`).
 * The pragma is a no-op inside a transaction, so it brackets the transaction
 * rather than sitting in it, and `foreign_key_check` proves no reference broke
 * before the rebuild commits. The AUTOINCREMENT high-water mark is carried over
 * too: copying rows only raises it to max(id), which would let the id of a
 * deleted newest squawk be reused.
 *
 * Idempotent and self-detecting: it reads the table's stored SQL and does nothing
 * when every state is already there, or when the table does not exist yet.
 * Exported so the migration can be unit-tested against a throwaway connection.
 */
export function migrateSquawkStates(db: Database): void {
  const row = db
    .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'squawks'")
    .get() as { sql: string } | null;
  if (!row || SQUAWK_STATES.every((s) => row.sql.includes(`'${s}'`))) {
    return;
  }

  const fkWasOn =
    (db.query("PRAGMA foreign_keys").get() as { foreign_keys: number })
      .foreign_keys === 1;
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.transaction(() => {
      const seqRow = db
        .query("SELECT seq FROM sqlite_sequence WHERE name = 'squawks'")
        .get() as { seq: number } | null;
      db.exec(`
        DROP TABLE IF EXISTS squawks_new;
        ${squawksTableSql("squawks_new")};
      `);
      // Copy every column both tables have, so a rebuild never drops data that a
      // later column (options, choice, note: #168) holds in the old table.
      const columnsOf = (table: string): string[] =>
        (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
          (c) => c.name,
        );
      const oldCols = new Set(columnsOf("squawks"));
      const shared = columnsOf("squawks_new")
        .filter((c) => oldCols.has(c))
        .join(", ");
      db.exec(`
        INSERT INTO squawks_new (${shared}) SELECT ${shared} FROM squawks;
        DROP TABLE squawks;
        ALTER TABLE squawks_new RENAME TO squawks;
      `);
      if (seqRow) {
        // The copy left a row only if it copied any squawks, so set it outright.
        db.query("DELETE FROM sqlite_sequence WHERE name = 'squawks'").run();
        db.query(
          "INSERT INTO sqlite_sequence (name, seq) VALUES ('squawks', MAX(?, (SELECT COALESCE(MAX(id), 0) FROM squawks)))",
        ).run(seqRow.seq);
      }
      const broken = db.query("PRAGMA foreign_key_check").all();
      if (broken.length > 0) {
        throw new Error(
          `migrateSquawkStates: ${broken.length} foreign-key violation(s) after rebuild`,
        );
      }
    })();
  } finally {
    if (fkWasOn) {
      db.exec("PRAGMA foreign_keys = ON");
    }
  }
}

/**
 * Ensure `squawks` has the columns #168 added: `options_json`, `choice` and
 * `note`. Each is nullable or defaulted, so `ALTER TABLE ... ADD COLUMN` is all it
 * takes and no existing row changes (a note reads as `''`, options as none).
 *
 * Idempotent and self-detecting, in the style of {@link migrateSquawkImages}: it
 * probes `PRAGMA table_info` and adds only what is missing, so a fresh table (which
 * already has them) and an already-migrated one are no-ops. Exported so a
 * pre-migration fixture can be tested against a throwaway connection.
 */
export function migrateSquawkColumns(db: Database): void {
  const cols = db.query("PRAGMA table_info(squawks)").all() as Array<{ name: string }>;
  if (cols.length === 0) return; // no squawks table yet
  const have = new Set(cols.map((c) => c.name));
  for (const [name, ddl] of SQUAWK_ADDED_COLUMNS) {
    if (!have.has(name)) db.exec(`ALTER TABLE squawks ADD COLUMN ${ddl}`);
  }
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

/** One row of the stats query: a list, joined to one of its states (or none). */
interface ListStatsRow extends List {
  state: SquawkState | null;
  n: number;
  max_updated: string | null;
  max_created: string | null;
}

/**
 * Lists with their counts and `last_activity` (#145), oldest first, in one query:
 * a row per (list, state) present, folded here. `where` narrows it to one list.
 */
function queryListsWithStats(where = "", ...params: number[]): ListWithStats[] {
  const rows = getDb()
    .query(
      `SELECT l.*, s.state AS state, COUNT(s.id) AS n,
              MAX(s.updated_at) AS max_updated, MAX(s.created_at) AS max_created
       FROM lists l LEFT JOIN squawks s ON s.list_id = l.id
       ${where}
       GROUP BY l.id, s.state
       ORDER BY l.id ASC`,
    )
    .all(...params) as ListStatsRow[];

  const byId = new Map<number, ListWithStats>();
  for (const { state, n, max_updated, max_created, ...list } of rows) {
    let entry = byId.get(list.id);
    if (!entry) {
      const counts = Object.fromEntries(SQUAWK_STATES.map((s) => [s, 0])) as StateCounts;
      entry = { ...list, counts, last_activity: list.created_at };
      byId.set(list.id, entry);
    }
    if (state === null) continue; // a list with no squawks
    entry.counts[state] = n;
    // ISO timestamps from now() order as strings.
    for (const ts of [max_updated, max_created]) {
      if (ts !== null && ts > entry.last_activity) entry.last_activity = ts;
    }
  }
  return [...byId.values()];
}

/**
 * Return all lists with their counts and `last_activity`, most recently changed
 * first (#167). Ties fall to the newer list (`id` descending). ISO timestamps
 * order correctly as strings. `getListWithStats` is a single list and needs no order.
 */
export function listListsWithStats(): ListWithStats[] {
  return queryListsWithStats().sort((a, b) =>
    a.last_activity === b.last_activity
      ? b.id - a.id
      : a.last_activity < b.last_activity
        ? 1
        : -1,
  );
}

/** Return one list with its counts and `last_activity`, or null if absent. */
export function getListWithStats(id: number): ListWithStats | null {
  return queryListsWithStats("WHERE l.id = ?", id)[0] ?? null;
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
type SquawkRow = Omit<Squawk, "has_image" | "image_ids" | "options"> & {
  /** The answer options as stored: a JSON array of strings, or NULL for none (#168). */
  options_json: string | null;
};

/**
 * Correlated subquery yielding a JSON array of a squawk's image ids ordered by
 * `position` (upload order). The inner ordered subquery fixes the row order that
 * `json_group_array` then aggregates, so the array is position-sorted; an
 * imageless squawk yields `'[]'`. Bytes never leave the DB — only ids ride here.
 */
const IMAGE_IDS_JSON_SELECT =
  "(SELECT json_group_array(id) FROM (SELECT id FROM squawk_images WHERE squawk_id = squawks.id ORDER BY position ASC)) AS image_ids_json";

/** Build the public `Squawk` from a stored row and its ordered image ids. */
function toSquawk(row: SquawkRow, image_ids: number[]): Squawk {
  const { options_json, ...rest } = row;
  const options = options_json === null ? [] : (JSON.parse(options_json) as string[]);
  return { ...rest, options, image_ids, has_image: image_ids.length > 0 };
}

/** Project a raw row (+ its `image_ids_json`) into the public `Squawk`. */
function projectSquawk(row: SquawkRow & { image_ids_json: string }): Squawk {
  const { image_ids_json, ...rest } = row;
  return toSquawk(rest, JSON.parse(image_ids_json) as number[]);
}

/**
 * Create a squawk under `listId`, allocating a per-list monotonic `seq`.
 *
 * Wrapped in a transaction so the seq read+increment and the insert are
 * atomic. `next_seq` is advanced on allocation and never rolled back, so a
 * seq is never reused even if its squawk is later deleted.
 */
type SquawkTx = (
  listId: number,
  text: string,
  initials: string,
  options: readonly string[],
) => Squawk;
let squawkTx: SquawkTx | null = null;

/** Build (once) the prepared transaction bound to the open connection. */
function getSquawkTx(): SquawkTx {
  if (squawkTx) {
    return squawkTx;
  }
  const db = getDb();
  squawkTx = db.transaction(
    (
      listId: number,
      text: string,
      initials: string,
      options: readonly string[],
    ): Squawk => {
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
          `INSERT INTO squawks (list_id, seq, text, state, initials, created_at, updated_at, options_json)
           VALUES (?, ?, ?, 'open', ?, ?, ?, ?) RETURNING *`,
        )
        .get(
          listId,
          seqRow.seq,
          text,
          initials,
          ts,
          ts,
          options.length > 0 ? JSON.stringify(options) : null,
        ) as SquawkRow;
      // A just-created squawk has no images yet; RETURNING can't carry a subquery.
      return toSquawk(row, []);
    },
  );
  return squawkTx;
}

/**
 * Create a squawk. `options` are its answer choices (#168), already validated by
 * `validateOptions`; they are fixed here and never change afterwards.
 */
export function createSquawk(
  listId: number,
  text: string,
  initials: string,
  options: readonly string[] = [],
): Squawk {
  return getSquawkTx()(listId, text, initials, options);
}

/** `updateSquawk` was given a `choice` that is not one of the squawk's options. */
export class InvalidChoiceError extends Error {}

/**
 * Update a squawk's `text`, `state`, `choice` and/or `note`, and refresh
 * `updated_at`. When `initials` is provided it records who made the change.
 * Throws if the squawk does not exist.
 *
 * A `choice` (#168) must be one of the squawk's own options, else it throws
 * {@link InvalidChoiceError}; it resolves the squawk as `confirmed` with that label
 * recorded. Any other `state` change clears the `choice`, so a recorded choice
 * always belongs to the state it was made in. The caller gives `state` or `choice`,
 * not both.
 *
 * A patch that changes only the `note` leaves `updated_at` alone: a draft note is
 * not a change to the item, so it must not mark the list as active.
 */
export function updateSquawk(
  id: number,
  patch: { text?: string; state?: SquawkState; choice?: string; note?: string },
  initials?: string,
): Squawk {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];

  if (patch.text !== undefined) {
    sets.push("text = ?");
    params.push(patch.text);
  }
  if (patch.choice !== undefined) {
    const stored = getDb()
      .query("SELECT options_json FROM squawks WHERE id = ?")
      .get(id) as { options_json: string | null } | null;
    if (!stored) {
      throw new Error(`updateSquawk: squawk ${id} not found`);
    }
    const options = stored.options_json === null ? [] : (JSON.parse(stored.options_json) as string[]);
    if (!options.includes(patch.choice)) {
      throw new InvalidChoiceError(`"${patch.choice}" is not one of this squawk's options`);
    }
    sets.push("state = 'confirmed'", "choice = ?");
    params.push(patch.choice);
  } else if (patch.state !== undefined) {
    sets.push("state = ?", "choice = NULL");
    params.push(patch.state);
  }
  if (patch.note !== undefined) {
    sets.push("note = ?");
    params.push(patch.note);
  }
  if (initials !== undefined) {
    sets.push("initials = ?");
    params.push(initials);
  }

  const noteOnly =
    patch.note !== undefined &&
    patch.text === undefined &&
    patch.state === undefined &&
    patch.choice === undefined;
  if (!noteOnly) {
    sets.push("updated_at = ?");
    params.push(now());
  }
  params.push(id);

  const row = getDb()
    .query(`UPDATE squawks SET ${sets.join(", ")} WHERE id = ? RETURNING *`)
    .get(...params) as SquawkRow | null;
  if (!row) {
    throw new Error(`updateSquawk: squawk ${id} not found`);
  }
  return toSquawk(row, listSquawkImageIds(id));
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

/**
 * Return a list's squawks, each with `image_ids`: open ones first (they are the
 * ones that need redress), then the rest, each group newest first (`seq DESC`) (#167).
 */
export function listSquawks(listId: number): Squawk[] {
  const rows = getDb()
    .query(
      `SELECT squawks.*, ${IMAGE_IDS_JSON_SELECT}
       FROM squawks WHERE list_id = ? ORDER BY (state = 'open') DESC, seq DESC`,
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
