/**
 * Typed fetch wrappers for the Squawkie-Talkie JSON REST API (#4).
 *
 * Each wrapper hits a single `/api/...` route, parses the JSON body, and throws
 * an `Error` on any non-2xx response so callers can `try/catch` instead of
 * inspecting `res.ok`. The thrown message includes the method, path, status,
 * and the server's `{ error }` detail when present.
 *
 * Domain shapes are reused (type-only) from the server so the client and data
 * layer never drift; `import type` is fully erased, so this adds no runtime
 * coupling and the client bundle never pulls in server code.
 */
import type { List, Squawk, SquawkState } from "../server/types.ts";

/** A list plus its squawks, as returned by `GET /api/lists/:id`. */
export interface ListDetail extends List {
  squawks: Squawk[];
}

/** Patch shape accepted by `updateSquawk` (`PATCH /api/squawks/:id`). */
export interface SquawkPatch {
  text?: string;
  state?: SquawkState;
}

/**
 * Core request helper: issue `fetch`, throw on non-2xx, return parsed JSON.
 * Sets a JSON content-type whenever a body is sent (all our bodies are JSON).
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined && init.body !== null) {
    headers["content-type"] = "application/json";
  }

  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${path} failed: ${res.status}${await errorDetail(res)}`,
    );
  }
  return (await res.json()) as T;
}

/** Best-effort `{ error }` extraction for the thrown message; never throws. */
async function errorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as unknown;
    if (
      body !== null &&
      typeof body === "object" &&
      "error" in body &&
      typeof (body as { error: unknown }).error === "string"
    ) {
      return ` ${(body as { error: string }).error}`;
    }
  } catch {
    // Non-JSON or empty body — the status alone is enough.
  }
  return "";
}

/** GET /api/lists — all lists, oldest first. */
export function getLists(): Promise<List[]> {
  return request<List[]>("/api/lists");
}

/** POST /api/lists — create a list and return the persisted row. */
export function createList(name: string): Promise<List> {
  return request<List>("/api/lists", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

/** GET /api/lists/:id — a list plus its squawks. */
export function getList(id: number): Promise<ListDetail> {
  return request<ListDetail>(`/api/lists/${id}`);
}

/** DELETE /api/lists/:id — remove a list (and, server-side, its squawks). */
export function deleteList(id: number): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/lists/${id}`, { method: "DELETE" });
}

/** POST /api/lists/:id/squawks — log a squawk under a list. */
export function createSquawk(
  listId: number,
  text: string,
  initials: string,
): Promise<Squawk> {
  return request<Squawk>(`/api/lists/${listId}/squawks`, {
    method: "POST",
    body: JSON.stringify({ text, initials }),
  });
}

/** PATCH /api/squawks/:id — update a squawk's text and/or state. */
export function updateSquawk(
  id: number,
  patch: SquawkPatch,
  initials: string,
): Promise<Squawk> {
  return request<Squawk>(`/api/squawks/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ ...patch, initials }),
  });
}
