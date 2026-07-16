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
 *   POST   /api/squawks               -> quick-add by list name          (201/400)
 *   PATCH  /api/squawks/:id           -> updateSquawk(id, patch, init)  (200/404)
 *   DELETE /api/squawks/:id           -> deleteSquawk(id)               (200/404)
 *
 * Invalid input yields 400 `{ error }`; unknown list/squawk yields 404.
 */

import {
  addSquawkImage,
  createList,
  createSquawk,
  deleteList,
  deleteSquawk,
  deleteSquawkImageById,
  getList,
  getListByName,
  getSquawk,
  getSquawkImageById,
  ImageLimitError,
  listLists,
  listSquawkImageIds,
  listSquawks,
  updateSquawk,
} from "./db.ts";
import { broadcast } from "./sse.ts";
import { MAX_IMAGES_PER_SQUAWK } from "./types.ts";
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

  // /api/lists/by-name?name=<name> — look up a list by its exact name.
  // Checked before /api/lists/:id so "by-name" isn't parsed as an id.
  if (
    segments.length === 3 &&
    segments[1] === "lists" &&
    segments[2] === "by-name"
  ) {
    if (method !== "GET") {
      return json({ error: "method not allowed" }, 405);
    }
    const name = url.searchParams.get("name");
    if (!name) {
      return json({ error: "name query parameter is required" }, 400);
    }
    const list = getListByName(name);
    if (!list) {
      return json({ error: "list not found" }, 404);
    }
    return json({ ...publicList(list), squawks: listSquawks(list.id) });
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

  // /api/squawks (top-level quick-add)
  if (segments.length === 2 && segments[1] === "squawks") {
    if (method === "POST") {
      return quickAddSquawkRoute(req);
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
    if (method === "DELETE") {
      if (deleteSquawk(id)) {
        broadcast({ type: "squawk.deleted", id });
        return json({ ok: true });
      }
      return json({ error: "squawk not found" }, 404);
    }
    return json({ error: "method not allowed" }, 405);
  }

  // /api/squawks/:id/images — the squawk's image collection (append; up to 5).
  if (
    segments.length === 4 &&
    segments[1] === "squawks" &&
    segments[3] === "images"
  ) {
    const id = parseId(segments[2]!);
    if (id === null) {
      return json({ error: "squawk not found" }, 404);
    }
    if (method === "POST") {
      return addSquawkImageRoute(req, id);
    }
    return json({ error: "method not allowed" }, 405);
  }

  // /api/squawks/:id/images/:id — one image within a squawk's collection.
  if (
    segments.length === 5 &&
    segments[1] === "squawks" &&
    segments[3] === "images"
  ) {
    const id = parseId(segments[2]!);
    const imageId = parseId(segments[4]!);
    if (id === null || imageId === null) {
      return json({ error: "image not found" }, 404);
    }
    if (method === "GET") {
      return getSquawkImageRoute(id, imageId);
    }
    if (method === "DELETE") {
      return deleteSquawkImageRoute(id, imageId);
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

/** POST /api/squawks — body `{ list_name, text, initials }`. Quick-add by list name. */
async function quickAddSquawkRoute(req: Request): Promise<Response> {
  const body = await readJson(req);
  if (!body) {
    return json({ error: "invalid request body" }, 400);
  }

  if (typeof body.list_name !== "string" || !body.list_name.trim()) {
    return json({ error: "list_name is required" }, 400);
  }
  const listName = body.list_name.trim();

  if (body.text !== undefined && typeof body.text !== "string") {
    return json({ error: "text must be a string" }, 400);
  }
  const text = typeof body.text === "string" ? body.text : "";

  if (typeof body.initials !== "string") {
    return json({ error: "initials is required" }, 400);
  }
  const initials = normalizeInitials(body.initials);

  let list = getListByName(listName);
  let listCreated = false;
  if (!list) {
    list = createList(listName);
    listCreated = true;
    broadcast({ type: "list.created", list: publicList(list) });
  }

  const squawk = createSquawk(list.id, text, initials);
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

// ---------------------------------------------------------------------------
// Squawk image routes
// ---------------------------------------------------------------------------

/**
 * Raster types we accept and serve back. SVG is deliberately excluded — an
 * uploaded `<svg>` can carry script and would be an XSS vector when served
 * same-origin, so the boundary is a strict raster allowlist, not a denylist.
 */
const IMAGE_MIME_ALLOWLIST: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

/**
 * Server-side cap on stored image bytes. The client resizes to a bounded JPEG
 * first, so this is the backstop against a raw-camera or crafted upload, not
 * the primary size control. ~2 MB comfortably clears a 1600px q0.8 JPEG.
 */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** POST /api/squawks/:id/images — append one image (raw bytes body); caps at 5. */
async function addSquawkImageRoute(req: Request, id: number): Promise<Response> {
  // Existence first: a *specific* 404 (not the generic "not found") both matches
  // the sibling squawk routes and keeps the route probeable by the drift guard.
  if (!getSquawk(id)) {
    return json({ error: "squawk not found" }, 404);
  }

  const mime = (req.headers.get("content-type") ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  if (!IMAGE_MIME_ALLOWLIST.has(mime)) {
    return json({ error: "unsupported image type" }, 415);
  }

  // Cheap early cap check so a 6th upload is rejected *before* buffering its
  // body; addSquawkImage re-checks atomically as the real guard against races.
  if (listSquawkImageIds(id).length >= MAX_IMAGES_PER_SQUAWK) {
    return json(
      { error: `at most ${MAX_IMAGES_PER_SQUAWK} images per squawk` },
      409,
    );
  }

  // Fast-reject an over-cap upload on its declared Content-Length *before*
  // buffering the whole body into memory. Content-Length can lie, so the actual
  // byte check below still runs — this just bounds peak memory for honest (and
  // most crafted) clients instead of buffering up to Bun's 128 MB default first.
  const declaredLen = Number(req.headers.get("content-length"));
  if (Number.isFinite(declaredLen) && declaredLen > MAX_IMAGE_BYTES) {
    return json({ error: "image too large" }, 413);
  }

  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength === 0) {
    return json({ error: "empty image body" }, 400);
  }
  // Backstop: enforce on actual bytes too (a spoofed/absent Content-Length can
  // slip past the fast-reject above).
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return json({ error: "image too large" }, 413);
  }

  try {
    addSquawkImage(id, { mime, bytes, byteSize: bytes.byteLength });
  } catch (err) {
    // Lost the race between the early check and the atomic insert.
    if (err instanceof ImageLimitError) {
      return json(
        { error: `at most ${MAX_IMAGES_PER_SQUAWK} images per squawk` },
        409,
      );
    }
    throw err;
  }
  const squawk = getSquawk(id)!; // image_ids now includes the appended id
  broadcast({ type: "squawk.updated", squawk });
  return json(squawk);
}

/** GET /api/squawks/:id/images/:id — one stored image with its stored (raster) mime. */
function getSquawkImageRoute(id: number, imageId: number): Response {
  const img = getSquawkImageById(id, imageId);
  if (!img) {
    return json({ error: "image not found" }, 404);
  }
  // Wrap in a Blob (a well-typed BodyInit) — a bare Uint8Array trips TS's
  // ArrayBufferLike strictness, and the Blob carries the bytes verbatim.
  return new Response(new Blob([img.bytes]), {
    headers: {
      // Always the stored allowlisted raster type — never text/html or svg.
      "Content-Type": img.mime,
      "Content-Length": String(img.byteSize),
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** DELETE /api/squawks/:id/images/:id — drop one image (not the squawk). */
function deleteSquawkImageRoute(id: number, imageId: number): Response {
  if (!deleteSquawkImageById(id, imageId)) {
    // No such image on this squawk (absent squawk, or wrong/gone id) → specific 404.
    return json({ error: "image not found" }, 404);
  }
  const squawk = getSquawk(id);
  if (squawk) {
    broadcast({ type: "squawk.updated", squawk });
  }
  return json({ ok: true });
}
