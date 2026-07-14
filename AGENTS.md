# AGENTS.md — orientation for AI dev agents

This repo is primarily developed by AI agents. This file gets you productive fast and
names the invariants you must not break. It is **codebase orientation**; for *workflow*
(issues, branches, gates, precheck) see [`CLAUDE.md`](CLAUDE.md), and for depth see
[`docs/`](docs/).

## What it is

Squawkie-Talkie: a self-hosted, real-time team "squawk list." One Bun process serves a
vanilla-TS client and a JSON+SSE API backed by `bun:sqlite`. Two entities: **Squawk
Lists** and **Squawks** (state: open/retired/recorded). Read [`README.md`](README.md)
for the feature set and [`docs/architecture.md`](docs/architecture.md) for the design.

## Squawking from the CLI (`sqtk`)

Agents manage squawklists via the repo-root **`sqtk`** CLI — a thin `curl`/`jq` wrapper over
the JSON API, so you never hand-roll HTTP. Point it at an instance with `SQUAWK_URL` — it is
**required, with no default**: unset, `sqtk` fails loud rather than silently talking to some
`localhost` instance nobody is watching (per-process SSE makes a misrouted write a split-brain
trap). Use `http://localhost:7700` for local dev, or your deployed URL. Initials auto-fill
from `./.claude/agent-identity.json` (override with `SQUAWK_INITIALS`).

```bash
sqtk add    "wave-engine" "ENG-1 corrupts state on blocked exit"   # log (creates the list if new)
sqtk show   "wave-engine"                                          # list + squawks + (O│R│E)
sqtk set    "wave-engine" 3 --state recorded                       # retire/record/reopen by #seq
sqtk lists                                                         # all lists  ·  sqtk help
```

Squawks are referenced by their per-list `#seq` (what `show`/`add` print) and **change state
rather than being deleted** (`set --state retired`) — the one true-delete is the editor's `u`
undo (invariant #6), which `sqtk` does not expose. Symlink `sqtk` onto
`PATH` (`~/.local/bin/sqtk`) to call it from anywhere. Wraps the routes in `src/server/api.ts`; see #95.

## Map (where things live)

| Area | File | Role |
|---|---|---|
| Server entry/routing | `src/server/index.ts` | `routeRequest()` → healthz, optional `/api` token check, `/api/stream`, `handleApi`, static, SPA fallback. `exec`s `Bun.serve` only under `import.meta.main`. |
| API-token auth | `src/server/auth.ts` | `resolveApiToken()`, `checkApiToken(req)` → `null` (allow) or `401`. Optional + additive; see the auth bullet below. |
| REST API | `src/server/api.ts` | `handleApi(req,url)` returns `null` for non-`/api` paths; `routeApi` dispatches. |
| Data layer | `src/server/db.ts` | `bun:sqlite`; **lazy** `getDb()`; typed repo fns. |
| Realtime (server) | `src/server/sse.ts` | subscriber set; `subscribe()`, `broadcast()`, `shutdown()`. |
| Shared types | `src/server/types.ts` | `List`, `Squawk`, `SquawkState`. Client imports these **type-only**. |
| Client bootstrap | `src/client/app.ts` | initials → register views → router → connect SSE. |
| Lists screen | `src/client/lists.ts` | create/open/delete-confirm/**export**. |
| Squawk editor | `src/client/detail.ts` | the heart: stack, autosave, states, counts, keyboard. |
| Realtime (client) | `src/client/realtime.ts` | `EventSource`; `applyEvent`; focused-box rule. |
| Fetch wrappers | `src/client/api.ts` | typed `/api` calls; throw on non-2xx. |

**Request flow:** browser → `routeRequest` → [optional `/api` token check] → (`/api/stream`
SSE | `handleApi` REST | static | `index.html`). Mutations in `api.ts` call `broadcast()`;
the client's `EventSource` applies events through the mounted view's binding.

## Load-bearing invariants — do NOT break these

1. **Last-write-wins, and never clobber a focused control.** `realtime.ts`
   `shouldApplyToInput` + `detail.ts` `setState`/`setText` skip the element the viewer is
   actively in (text input *and* state `<select>`). DOM-tested in `tests/dom.test.ts`.
2. **Per-list `seq` is monotonic and never reused** (even after delete) — allocated in a
   `db.ts` transaction off `lists.next_seq`. `seq` is identity, not an index.
3. **DB opens lazily** (`getDb()`), never at import. Importing the server must not create
   `squawk.db`. Don't reintroduce an import-time `new Database(...)`.
4. **`next_seq` never leaves the API** — `api.ts` `publicList()` strips it. Don't return raw `List` rows.
5. **Autosave baseline updates only on PATCH success** (`detail.ts`), so a failed save
   retries instead of silently dropping the edit.
6. **Delete cascades** (`ON DELETE CASCADE`) = "expunge from the instance." List delete
   needs an inline confirm. Squawks move through their lifecycle by **changing state** and
   are never deleted *that* way — the sole **direct** squawk true-delete is the editor's `u`
   **undo**, which retracts a just-created squawk within the settle-in window
   (`DELETE /api/squawks/:id`, `detail.ts` `doUndo`; a mistake being taken back, not a
   lifecycle event). (Deleting the *list* cascades its squawks — a separate list-level op.)
   Don't add any other squawk-delete path.
7. **Initials normalize to ≤3 uppercase alphanumerics**, server-side (`api.ts`) and client (`initials.ts`).

## Run / test / build

```bash
bun install
bun run dev        # PORT=7700 bun run dev  → http://localhost:7700  (keep 3000 free)
bun run typecheck  # tsc --noEmit (strict, verbatimModuleSyntax)
bun test           # unit + happy-dom DOM tests
bun run build      # → public/dist/app.js (run before prod serve)
```

**Test conventions:**
- Server tests set `process.env.SQUAWK_DB = ":memory:"` **before** dynamically importing
  `db.ts`/the server (gives each file its own throwaway DB).
- DOM tests register happy-dom in `beforeAll`/unregister in `afterAll` so the global
  `document`/`fetch` don't leak into server tests.
- Pure logic → unit test; rendered-DOM behavior (focus, nav, counts) → DOM test.

## Conventions & gotchas

- **Vanilla TS client — do not add a framework.** The focus/cursor control depends on
  owning the DOM; surgical, id-keyed row updates are the seam realtime patches.
- **TS is strict + `verbatimModuleSyntax`** — use `import type` for type-only imports.
- **`main` is protected by required checks** — `test`, `e2e`, `docker` must be green and the
  branch up to date before a squash merge (`.github/workflows/ci.yml`). No merge queue.
  Don't add >5 procedural lines to CI YAML — use a script (see CLAUDE.md).
- **SSE behind a proxy needs buffering OFF** (see `docs/deployment.md`) or realtime dies silently.
- **No user auth.** Initials are a label, not identity — any viewer can edit or delete any
  list. Trusted-network tool; the reverse proxy is the real boundary.
- **`/api` has an *optional* bearer-token gate** (`src/server/auth.ts`), OFF unless
  `SQUAWK_API_TOKEN`/`_FILE` is set. It **validates only if an `Authorization` header is
  present** — a header-absent request passes through (native `EventSource` can't send
  headers, so a mandatory gate would break browser SSE). `/healthz` and static assets are
  never gated. It's an alternative credential for machine clients, **not** a standalone
  boundary. Full contract: `docs/deployment.md` § *Optional API-token auth*.

## Common changes — where to start

- **New REST endpoint:** add a branch in `api.ts` `routeApi`; `broadcast()` if it mutates;
  add a wrapper in `client/api.ts`; cover in `tests/api.test.ts`.
- **New client view:** render fn + `registerView(...)` (see `lists.ts`/`detail.ts`); add a
  `realtime.ts` binding if it shows live data; DOM-test it.
- **New squawk state:** extend `SquawkState` + the DB `CHECK` + `STATES`/`SQUAWK_STATES` +
  state CSS + `countByState`.
