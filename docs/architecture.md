# Architecture & Design

## Overview

Squawkie-Talkie is one self-contained Bun process that serves a vanilla-TypeScript
single-page client and a JSON + Server-Sent-Events API backed by a `bun:sqlite` file.
No external services, no build-time framework, no user accounts.

```
┌── browser ───────────────┐         ┌── Bun process ─────────────────────────┐
│ index.html + styles.css  │  HTTP   │ src/server/index.ts  routeRequest()     │
│ dist/app.js (vanilla TS) │ ───────▶│   ├─ GET /healthz                       │
│   lists.ts / detail.ts   │         │   ├─ GET /api/stream  → sse.subscribe() │
│   realtime.ts (EventSource)        │   ├─ /api/*  → api.handleApi()           │
└──────────▲───────────────┘         │   │            └─ db.ts (bun:sqlite)    │
           │  SSE events             │   └─ static / SPA fallback (public/)    │
           └─────────────────────────┤  mutations → sse.broadcast()            │
                                      └─────────────────────── squawk.db ──────┘
```

**Request flow:** every request enters `routeRequest` (`src/server/index.ts`), checked in
order: `GET /healthz` → optional `/api/` token check (`auth.ts`; a no-op unless configured)
→ `GET /api/stream` (SSE) → `handleApi` (returns `null` for non-`/api` paths) → static asset
under `public/` → `index.html` SPA fallback. The token check sits after `/healthz` and
before the stream so it covers REST *and* SSE while leaving healthz and static assets open.

## Data model

`bun:sqlite`, foreign keys ON, schema created lazily on first connection (`db.ts`).

```
lists                              squawks
  id        INTEGER PK              id          INTEGER PK
  name      TEXT                    list_id     INTEGER FK → lists(id) ON DELETE CASCADE
  next_seq  INTEGER (allocator)     seq         INTEGER  (per-list, monotonic, never reused)
  created_at TEXT (ISO)             text        TEXT
                                    state       TEXT  CHECK in (open|retired|recorded)
                                    initials    TEXT  (recorder)
                                    created_at  TEXT
                                    updated_at  TEXT
```

- **Per-list `seq`** is allocated in a transaction by incrementing `lists.next_seq`; it is
  identity, not a row index, so gaps after a delete are correct.
- **Delete cascades** — removing a list removes its squawks ("expunge from the instance").
- **`next_seq` is internal** — `api.ts` `publicList()` strips it before any response.

## Realtime

Server→client is **Server-Sent Events** (`GET /api/stream`); client→server is ordinary
`POST`/`PATCH`/`DELETE`. After each successful mutation the API calls `broadcast()`, which
writes a framed `data: {…}\n\n` event to every subscriber. A ~25s heartbeat keeps idle
connections alive.

The client (`realtime.ts`) holds one `EventSource` and applies each event through the
currently-mounted view's binding. **Last-write-wins**, with one rule: a remote update is
**never applied to the control the viewer is actively in** — `shouldApplyToInput` checks
`document.activeElement`'s `data-squawk-id`; the focused text input and the focused state
`<select>` are left untouched (their own next change is the last write). This is the single
most important interaction guarantee and is DOM-tested.

## Key decisions (the *why*)

| Decision | Why |
|---|---|
| **Bun + SQLite + SSE, one process** | Self-hosted "instance"; zero external deps; SQLite file = trivial backup and "expunge." |
| **Vanilla TS client, no framework** | The app *is* focus/cursor/keyboard control; owning the DOM avoids a framework re-rendering the input mid-keystroke. Bespoke CSS also avoids a generic component-library look. |
| **SSE, not WebSocket** | One-way server→client fanout + plain POST writes is simpler and enough; no bidirectional channel needed. |
| **Last-write-wins** | A team squawk list doesn't need CRDdts/locking; the only sharp edge (clobbering a typing user) is solved by the focused-control rule, not by a merge engine. |
| **Lazy DB open** | Importing the server (e.g. a test) must not create a DB file; tests point `SQUAWK_DB` at `:memory:` before first use. |
| **Per-list monotonic seq** | Stable human-facing identifiers that never get reused. |

## API reference

All responses JSON. Invalid input → `400 {error}`; unknown list/squawk → `404`.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/healthz` | — | `{ ok: true }` |
| GET | `/api/lists` | — | `List[]` (no `next_seq`) |
| POST | `/api/lists` | `{ name }` | `201 List` |
| GET | `/api/lists/:id` | — | `{ ...List, squawks: Squawk[] }` (squawks newest-first) |
| GET | `/api/lists/by-name?name=…` | — | same shape as by-id, looked up by **exact name** (oldest match — names aren't unique); `400` if `name` missing, `404` if none |
| DELETE | `/api/lists/:id` | — | `{ ok: true }` (cascades squawks) |
| GET | `/api/lists/:id/squawks` | — | `Squawk[]` |
| POST | `/api/lists/:id/squawks` | `{ text, initials }` | `201 Squawk` |
| POST | `/api/squawks` | `{ list_name, text, initials }` | `201 Squawk` — quick-add by list name (creates the list if absent); `400` on bad input |
| PATCH | `/api/squawks/:id` | `{ text?, state?, initials? }` | `200 Squawk` (needs `text` or `state`) |
| DELETE | `/api/squawks/:id` | — | `{ ok: true }` — the **one direct** squawk true-delete; its sole caller is the editor `u` undo, retracting a just-created squawk within the settle-in window (`404` if unknown). Every other individual-squawk transition is a state change; whole-list deletion cascades separately via `DELETE /api/lists/:id`. |
| GET | `/api/stream` | — | `text/event-stream` |

**SSE events:** `{type:"list.created", list}` · `{type:"list.deleted", id}` ·
`{type:"squawk.created", squawk}` · `{type:"squawk.updated", squawk}` ·
`{type:"squawk.deleted", id}`.

**Export format:** a list export is exactly the `GET /api/lists/:id` body
(`{id, name, created_at, squawks[]}`), pretty-printed.

## Security posture

**No user authentication. Initials are a label, not an identity** — anyone can type "BJ", and
any viewer can edit or delete any list. Combined with **last-write-wins**, concurrent
edits silently overwrite. This is by design for a small, trusted team tool. There is also
no authorization model: every caller who reaches the API can do everything.

**Optional API-token check (v0.5.0).** `src/server/auth.ts` can *validate* a bearer token on
the `/api` surface (REST + SSE) via `SQUAWK_API_TOKEN` / `SQUAWK_API_TOKEN_FILE`. It never
**requires** one: enforcement is **additive** — the token is checked *only if* an
`Authorization` header is present, so a header-absent request always passes through. There
is no configuration under which the token becomes mandatory. That asymmetry is deliberate —
native `EventSource` cannot set request headers, so a mandatory token would break the
browser's realtime feed. `/healthz` and static assets are never checked. Read it as *an
alternative credential a machine client may present* (curl, or a fetch-based SSE reader),
**not** as the security boundary. Note the bundled `sqtk` CLI does **not** send the header
today — like the browser, it relies on the header-absent pass-through.

**Deploy on a trusted internal network only — never expose to the public internet.** See
[`deployment.md`](deployment.md) for the operational consequences (and the SSE reverse-proxy
setting). The real boundary is and remains the reverse proxy. If wider exposure is ever
needed, *mandatory* authentication and an authorization model are prerequisites, and both
are explicitly out of current scope.
