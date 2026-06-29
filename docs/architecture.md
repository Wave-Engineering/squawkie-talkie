# Architecture & Design

## Overview

Squawkie-Talkie is one self-contained Bun process that serves a vanilla-TypeScript
single-page client and a JSON + Server-Sent-Events API backed by a `bun:sqlite` file.
No external services, no build-time framework, no auth.

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
order: `GET /healthz` → `GET /api/stream` (SSE) → `handleApi` (returns `null` for
non-`/api` paths) → static asset under `public/` → `index.html` SPA fallback.

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
| DELETE | `/api/lists/:id` | — | `{ ok: true }` (cascades squawks) |
| GET | `/api/lists/:id/squawks` | — | `Squawk[]` |
| POST | `/api/lists/:id/squawks` | `{ text, initials }` | `201 Squawk` |
| PATCH | `/api/squawks/:id` | `{ text?, state?, initials? }` | `200 Squawk` (needs `text` or `state`) |
| GET | `/api/stream` | — | `text/event-stream` |

**SSE events:** `{type:"list.created", list}` · `{type:"list.deleted", id}` ·
`{type:"squawk.created", squawk}` · `{type:"squawk.updated", squawk}`.

**Export format:** a list export is exactly the `GET /api/lists/:id` body
(`{id, name, created_at, squawks[]}`), pretty-printed.

## Security posture

**No authentication. Initials are a label, not an identity** — anyone can type "BJ", and
any viewer can edit or delete any list. Combined with **last-write-wins**, concurrent
edits silently overwrite. This is by design for a small, trusted team tool.

**Deploy on a trusted internal network only — never expose to the public internet.** See
[`deployment.md`](deployment.md) for the operational consequences (and the SSE reverse-proxy
setting). If wider exposure is ever needed, authentication and an authorization model are
prerequisites and are explicitly out of current scope.
