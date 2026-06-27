/**
 * JSON REST API for Squawkie-Talkie.
 *
 * Exposes the data layer (`db.ts`) over a handful of `/api/...` routes that the
 * client consumes. `handleApi` is the single entry point: it returns `null`
 * for any path that is not under `/api/`, so `index.ts` can fall through to
 * static asset serving. For `/api/...` paths it returns a `Promise<Response>`
 * (body parsing for POST/PATCH is async).
 *
 * Routes:
 *   GET    /api/lists                 -> listLists()                    (200)
 *   POST   /api/lists                 -> createList(name)               (201)
 *   GET    /api/lists/:id             -> { ...getList, squawks }        (200/404)
 *   DELETE /api/lists/:id             -> { ok: true }                   (200/404)
 *   GET    /api/lists/:id/squawks     -> listSquawks(id)                (200/404)
 *   POST   /api/lists/:id/squawks     -> createSquawk(id, text, init)   (201/404)
 *   PATCH  /api/squawks/:id           -> updateSquawk(id, patch, init)  (200/404)
 *
 * Invalid input yields 400 `{ error }`; unknown list/squawk yields 404.
 */

import {
  createList,
  createSquawk,
  deleteList,
  getList,
  listLists,
  listSquawks,
  updateSquawk,
} from "./db.ts";
import { broadcast } from "./sse.ts";
import type { List, SquawkState } from "./types.ts";

/** The valid lifecycle states a squawk may be set to. */
const SQUAWK_STATES: ReadonlySet<string> = new Set<SquawkState>([
  "open",
  "retired",
  "recorded",
]);

/** A list as exposed over the API — without the internal `next_seq` counter. */
export type PublicList = Omit<List, "next_seq">;

/** Drop the internal `next_seq` counter so it never leaks to clients. */
function publicList(list: List): PublicList {
  const { next_seq: _next_seq, ...rest } = list;
  return rest;
}

/** Centralized JSON response helper. */
export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

/** Server-side initials normalization: uppercase, alphanumerics only, ≤3 chars. */
function normalizeInitials(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 3);
}

/** Parse a positive-integer path segment, or null if it is not one. */
function parseId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Parse a JSON request body into a plain object, or null when the body is
 * missing, malformed, or not a JSON object.
 */
async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = (await req.json()) as unknown;
    if (body !== null && typeof body === "object" && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Handle an API request. Returns `null` when `url` is not under `/api/` so the
 * caller can fall through to static serving; otherwise returns the response.
 */
export function handleApi(req: Request, url: URL): Promise<Response> | null {
  if (!url.pathname.startsWith("/api/")) {
    return null;
  }
  return routeApi(req, url);
}

async function routeApi(req: Request, url: URL): Promise<Response> {
  // ["api", "lists", ...]
  const segments = url.pathname.split("/").filter(Boolean);
  const { method } = req;

  // /api/lists
  if (segments.length === 2 && segments[1] === "lists") {
    if (method === "GET") {
      return json(listLists().map(publicList));
    }
    if (method === "POST") {
      return createListRoute(req);
    }
    return json({ error: "method not allowed" }, 405);
  }

  // /api/lists/:id
  if (segments.length === 3 && segments[1] === "lists") {
    const id = parseId(segments[2]!);
    if (id === null) {
      return json({ error: "list not found" }, 404);
    }
    if (method === "GET") {
      const list = getList(id);
      if (!list) {
        return json({ error: "list not found" }, 404);
      }
      return json({ ...publicList(list), squawks: listSquawks(id) });
    }
    if (method === "DELETE") {
      if (deleteList(id)) {
        broadcast({ type: "list.deleted", id });
        return json({ ok: true });
      }
      return json({ error: "list not found" }, 404);
    }
    return json({ error: "method not allowed" }, 405);
  }

  // /api/lists/:id/squawks
  if (
    segments.length === 4 &&
    segments[1] === "lists" &&
    segments[3] === "squawks"
  ) {
    const id = parseId(segments[2]!);
    if (id === null || !getList(id)) {
      return json({ error: "list not found" }, 404);
    }
    if (method === "GET") {
      return json(listSquawks(id));
    }
    if (method === "POST") {
      return createSquawkRoute(req, id);
    }
    return json({ error: "method not allowed" }, 405);
  }

  // /api/squawks/:id
  if (segments.length === 3 && segments[1] === "squawks") {
    const id = parseId(segments[2]!);
    if (id === null) {
      return json({ error: "squawk not found" }, 404);
    }
    if (method === "PATCH") {
      return patchSquawkRoute(req, id);
    }
    return json({ error: "method not allowed" }, 405);
  }

  return json({ error: "not found" }, 404);
}

/** POST /api/lists — body `{ name }`. */
async function createListRoute(req: Request): Promise<Response> {
  const body = await readJson(req);
  const name =
    body && typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return json({ error: "name is required" }, 400);
  }
  const list = publicList(createList(name));
  broadcast({ type: "list.created", list });
  return json(list, 201);
}

/** POST /api/lists/:id/squawks — body `{ text, initials }`. */
async function createSquawkRoute(
  req: Request,
  listId: number,
): Promise<Response> {
  const body = await readJson(req);
  if (!body) {
    return json({ error: "invalid request body" }, 400);
  }

  if (body.text !== undefined && typeof body.text !== "string") {
    return json({ error: "text must be a string" }, 400);
  }
  const text = typeof body.text === "string" ? body.text : "";

  if (typeof body.initials !== "string") {
    return json({ error: "initials are required" }, 400);
  }
  const initials = normalizeInitials(body.initials);
  if (!initials) {
    return json({ error: "initials are required" }, 400);
  }

  const squawk = createSquawk(listId, text, initials);
  broadcast({ type: "squawk.created", squawk });
  return json(squawk, 201);
}

/** PATCH /api/squawks/:id — body `{ text?, state?, initials? }`. */
async function patchSquawkRoute(req: Request, id: number): Promise<Response> {
  const body = await readJson(req);
  if (!body) {
    return json({ error: "invalid request body" }, 400);
  }

  const patch: { text?: string; state?: SquawkState } = {};

  if (body.text !== undefined) {
    if (typeof body.text !== "string") {
      return json({ error: "text must be a string" }, 400);
    }
    patch.text = body.text;
  }

  if (body.state !== undefined) {
    if (typeof body.state !== "string" || !SQUAWK_STATES.has(body.state)) {
      return json({ error: "invalid state" }, 400);
    }
    patch.state = body.state as SquawkState;
  }

  // Require at least one editable field; an empty patch must not silently bump
  // updated_at (or "record" a change that didn't happen).
  if (patch.text === undefined && patch.state === undefined) {
    return json({ error: "no updatable fields: provide text or state" }, 400);
  }

  let initials: string | undefined;
  if (body.initials !== undefined) {
    if (typeof body.initials !== "string") {
      return json({ error: "invalid initials" }, 400);
    }
    // Empty after normalization → leave initials untouched rather than wiping.
    initials = normalizeInitials(body.initials) || undefined;
  }

  try {
    const squawk = updateSquawk(id, patch, initials);
    broadcast({ type: "squawk.updated", squawk });
    return json(squawk);
  } catch (err) {
    if (err instanceof Error && err.message.includes("not found")) {
      return json({ error: "squawk not found" }, 404);
    }
    throw err;
  }
}
