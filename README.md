# Squawkie-Talkie

Lightweight, self-hosted, real-time **squawk list** for a team. Testers jot down
concerns ("squawks") the instant they hit them — no heavyweight issue forms, no
accounts, just initials and a text box. Lists are shared; everyone sees and edits
everything; changes sync live across viewers.

Two concepts only: **Squawk Lists** and **Squawks**.

- **Squawk List** — a named collection of squawks (e.g. *Sprint 7 Regression*).
- **Squawk** — one line of concern, numbered, with a state (**open / retired /
  recorded**) and the recorder's initials.

## Features

- **Initials-only identity** — prompted once, stored in a cookie. No auth, no accounts.
- **Lists screen** — create, open, delete (inline confirm), and **export a list to JSON**.
- **Squawk editor** — newest-on-top stack; an always-empty top box (type, **Enter**,
  you're on the next line); **autosave** on blur and after 10s idle; per-squawk **state
  dropdown** with distinct color schemes.
- **Keyboard-first** — **Enter** commits, **Esc** reverts to last-saved, **↑/↓** move
  between squawks.
- **Real-time** — changes by other viewers appear live (Server-Sent Events,
  last-write-wins); the box you're actively typing in is never clobbered.
- **`(O│R│E)` counts** — open / retired / recorded tallies on each list, live.
- **Hover** a squawk to see who recorded it.
- **Restrained cyberpunk** UI — near-black, one cyan accent, edge-glow states.

## Tech stack

[Bun](https://bun.sh) (runtime + test runner + bundler) · TypeScript · `bun:sqlite`
(file DB) · Server-Sent Events for realtime · **vanilla TypeScript** client (no
framework) · hand-authored CSS. One self-contained process serves the UI and the API.

## Quick start

```bash
bun install
bun run dev          # http://localhost:3000  (override with PORT=…)
```

Open the URL, enter your initials, and start squawking. For development:

```bash
bun run typecheck    # tsc --noEmit
bun test             # unit + DOM tests
bun run build        # bundle the client → public/dist/app.js
```

### Run in a container

Prefer Docker? A `Dockerfile` and `docker-compose.yml` ship with the repo:

```bash
docker compose up --build     # → http://localhost:3000
```

The image builds the client itself (no separate `bun run build` step) and
persists the SQLite database in a named volume, so your lists survive restarts.
Full container notes — persistence, ports, reverse proxy — are in
[`docs/deployment.md`](docs/deployment.md#run-in-a-container-docker).

> **Production note:** run `bun run build` before serving in prod, and read
> [`docs/deployment.md`](docs/deployment.md) first — there's one load-bearing
> reverse-proxy setting for SSE, and a **security posture** you must understand
> (no auth → trusted network only).

## Project layout

```
src/server/   index.ts (routing+listen) · api.ts (REST) · db.ts (bun:sqlite) ·
              sse.ts (realtime broadcast) · types.ts
src/client/   app.ts (bootstrap) · lists.ts · detail.ts (editor) · realtime.ts ·
              api.ts (fetch wrappers) · router.ts · initials.ts · cookies.ts
public/       index.html · styles.css · dist/ (built client, gitignored)
tests/        unit + happy-dom DOM tests
docs/         architecture · requirements · deployment · testing
```

## Documentation

| Doc | What's in it |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | System design, data model, key decisions, **API reference**, security posture |
| [`docs/requirements.md`](docs/requirements.md) | The testable behavioral spec |
| [`docs/deployment.md`](docs/deployment.md) | Self-hosting: **Docker**/compose, SSE/proxy, persistence, env, **security** |
| [`docs/testing.md`](docs/testing.md) | Test strategy (unit → DOM → E2E) + manual UX checklist |
| [`CHANGELOG.md`](CHANGELOG.md) | Release history |
| [`AGENTS.md`](AGENTS.md) | Orientation for AI dev agents working in this repo |
| [`CLAUDE.md`](CLAUDE.md) | Team workflow / rules of engagement |

## License

See [`LICENSE`](LICENSE).
