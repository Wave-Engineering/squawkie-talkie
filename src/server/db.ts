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
      return db
        .query(
          `INSERT INTO squawks (list_id, seq, text, state, initials, created_at, updated_at)
           VALUES (?, ?, ?, 'open', ?, ?, ?) RETURNING *`,
        )
        .get(listId, seqRow.seq, text, initials, ts, ts) as Squawk;
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
    .get(...params) as Squawk | null;
  if (!row) {
    throw new Error(`updateSquawk: squawk ${id} not found`);
  }
  return row;
}

/** Return a list's squawks, newest first (`seq DESC`). */
export function listSquawks(listId: number): Squawk[] {
  return getDb()
    .query("SELECT * FROM squawks WHERE list_id = ? ORDER BY seq DESC")
    .all(listId) as Squawk[];
}
