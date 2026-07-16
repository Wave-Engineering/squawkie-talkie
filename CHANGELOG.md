# Changelog

All notable changes to Squawkie-Talkie. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Entries `0.1.0`–`0.2.0` were
pre-tag logical milestones (Phase 1 → tech-debt → Phase 2); **git-tagged releases begin
at `v0.3.0`**.

## [Unreleased]

## [0.7.0] — 2026-07-16 — Multiple photos per squawk & carousel viewer

### Added
- **Up to 5 photos per squawk** — extends the single-photo feature (#113) to a
  small gallery. The upload interaction is unchanged (tap 📷, capture or upload),
  but now **appends** into the next slot and disables at the cap of 5. The row
  shows the first image as a thumbnail with a **count badge** (only when > 1);
  clicking it opens a new accessible **carousel** — prev/next, a dot strip, an
  "N / M" counter, per-image remove, ←/→/Esc keys, and a focus trap that restores
  focus on close — with no new timeline chrome. New plural API
  `POST /api/squawks/:id/images` (`409` at the cap), `GET`/`DELETE
  /api/squawks/:id/images/:id`; the public squawk gains an ordered **`image_ids`**
  list, with `has_image` derived from it. Bytes stay in SQLite, addressed by
  reference, never inlined into squawk JSON or an SSE frame. The `squawk_images`
  table moves 1:1 → 1:N (own `id` PK, indexed `squawk_id` FK, 0-based `position`);
  an idempotent, self-detecting migration maps any existing single image to
  `position 0`, so photos from v0.6.0 survive the upgrade. (#127)

### Internal
- **Container publish to GHCR** — CI now builds and pushes
  `ghcr.io/wave-engineering/squawkie-talkie:<version>` when a `vX.Y.Z` release tag
  is pushed, so operators can `docker pull` the tagged image instead of building
  from source. Images are tagged **without** the `v` prefix (e.g. `0.7.0`).
  (#124, #126)

## [0.6.0] — 2026-07-14 — Photos on squawks & live connection status

### Added
- **Photos on squawks** — attach an optional single image to a squawk, captured
  from a phone camera (`<input capture>`) or uploaded from any device. Bytes are
  stored **in SQLite** (a 1:1 `squawk_images` BLOB table, `ON DELETE CASCADE`) so
  the "instance = one file" backup/expunge story holds and undo/list-delete
  reclaim bytes for free. Images are addressed by reference
  (`GET /api/squawks/:id/image`), never inlined into squawk JSON or an SSE frame;
  the public squawk carries a derived `has_image` flag. Uploads are a strict
  raster allowlist (jpeg/png/webp — no SVG), size-capped server-side, and
  client-resized on a `<canvas>` before upload (bounds size, strips EXIF/GPS,
  normalizes HEIC). Export stays text-only for now (#113).
- **Live connection indicator** — the header shows realtime liveness on theme:
  a subtle **on air** when the SSE stream is live, an amber **off air ·
  reconnecting…** when it drops (after a 2s grace), and a **back on air** flash
  on recovery. Because SSE has no replay, a reconnect **resyncs** the active view
  — re-fetching and reconciling anything missed while offline without clobbering
  a focused control — so "back on air" means actually caught up. The off-air copy
  is worst-case honest ("changes may not be saved"), covering both an SSE-only
  drop and a full-server outage (#116).

### Fixed
- **Realtime no longer silently dies on idle** — `Bun.serve`'s default
  `idleTimeout` (10s) was *shorter* than the SSE heartbeat (25s), so every
  `/api/stream` connection was killed before it could heartbeat, then reconnected
  and killed again — dropping any event broadcast during the gaps. Raised
  `idleTimeout` well above the heartbeat, and the server now flushes an initial
  `: connected` comment on subscribe so the client's `open` fires promptly rather
  than waiting for the first heartbeat (#115, #116).
- **Lists sort newest-first** — the Lists screen showed the oldest list on top;
  it now renders newest-first on initial load, local create, and realtime create,
  matching the detail view's newest-first squawks (#118).
- **`?` keymap overlay deflake** — dismiss listeners now attach synchronously and
  ignore the opening event by identity, closing a `setTimeout(0)` race that could
  swallow a fast dismiss keypress (#108).
- **`sqtk` requires `SQUAWK_URL`** — the CLI now fails loud when `SQUAWK_URL` is
  unset instead of silently talking to `localhost:3000`; `sqtk help` still works
  config-free (#97).

### Docs
- Purged stale merge-queue claims — `main` was never queue-enforced (#102).
- Corrected the "No auth" claim — v0.5.0 shipped optional API-token auth (#104).
- Corrected the squawk-delete invariant — the `u` undo is a real true-delete of a
  just-created squawk, not a lifecycle event (#105).

### Internal
- **Doc-drift guard** — a `test` check now fails if `docs/architecture.md`'s API
  reference or SSE-events line drifts from the routes/events the server actually
  registers (#111).

## [0.5.0] — 2026-07-11 — API-token auth & the sqtk client CLI

### Added
- **Optional API-token auth** — gate the `/api` surface (REST + `/api/stream`)
  with a bearer token via `SQUAWK_API_TOKEN` (or `SQUAWK_API_TOKEN_FILE`, a
  Docker/Swarm secret path that wins over the inline var). Additive "validate
  only if an `Authorization` header is present": a header-absent request passes
  through unchanged (the browser UI and internal-LAN/proxy path carry no token,
  and native `EventSource` cannot send headers), a valid `Bearer` token is
  allowed via a constant-time compare, and a wrong/malformed header is `401`.
  OFF unless configured; `/healthz` and static/SPA assets are never gated; the
  token is never logged (boot reports `ENABLED`/`DISABLED`). The token is an
  *alternative* credential, not a standalone gate — the real boundary stays the
  reverse proxy (#98).
- **`sqtk` client CLI** — a thin `curl`/`jq` wrapper over the JSON API so agents
  can manage squawklists (`lists`/`show`/`add`/`set`/`new`/`rmlist`) without
  hand-writing HTTP; initials resolve from `SQUAWK_INITIALS` or the agent
  identity file (#96).

### Fixed
- **Onboarding** — reset the per-identity coach "seen" flags on identity so a
  fresh identity gets a coherent first-run onboarding instead of a half-seen
  tour (#94).

### Internal
- Deflake the interactive-initials e2e test by presetting sibling coach
  seen-flags (#92).

## [0.4.0] — 2026-07-04 — First-run onboarding coach marks

### Added
- **First-run coach marks** — a reusable, framework-free spotlight-tour engine
  (per-surface "seen" tracking in `localStorage`, keyboard-driven, `?` to replay)
  plus onboarding on all three screens: an initials Welcome + empty-system
  first-list gate, a lists-page tour, and progressive detail-page coaching. Each
  surface coaches once per browser, independently; no coach path writes the shared
  DB or broadcasts a tutorial artifact over SSE (#77, #84).
- **Interactive coach targets** — a coach step can host a live control: viewer
  initials are typed into the real field with the coach still up, and `Enter`
  submits and dismisses in one motion (#86).

### Changed
- Onboarding copy is keyboard-first and opinionated — the lists "Two modes" mark
  names the real switch keys (`Esc` / `j` / `↓`), the row mark carries the house
  line ("the mouse is like disk access — death to efficiency"), the detail entry
  acknowledges the freshly-opened list, and the undo/hover and metrics/realtime
  hints are each split into their own mark (#86).

### Fixed
- **a11y** — the coach overlay no longer hides an interactive step's target from
  assistive tech: `aria-modal` is toggled per step, so a focused control that
  lives outside the overlay (the initials field) stays exposed (#88).

### Internal
- `.gitignore` broadened to the whole per-clone `.claude/` agent runtime; the
  stray `package-lock.json` is ignored (this project uses `bun.lock`) (#75).

## [0.3.0] — 2026-07-04 — First tagged release

### Added
- **Vi-mode keyboard navigation** — `j`/`k` (and `↑`/`↓`) movement, `Enter` to open,
  `dd`/`yy` chords, an INSERT/NAV mode bar, and a `?` keymap overlay — on both the squawk
  editor (#51) and the lists screen (#62).
- **Auto-open** a newly created list straight into its editor, with a mode-indicator
  footer bar (#60).
- **Docker support** — `Dockerfile`, `docker-compose.yml`, `.dockerignore`, and a CI
  docker smoke-test job; run the whole app with `docker compose up` (#54).
- **Quick-add a squawk by list name** — `POST /api/squawks` with
  `{ list_name, text, initials }` (#49).
- **Look up a list by exact name** — `GET /api/lists/by-name?name=<name>` (oldest match
  when names duplicate; `400` if `name` missing, `404` if none) (#47).
- **Playwright end-to-end suite** — multi-viewer realtime, keyboard nav, chords, export,
  and recovery flows (#52).
- Top-level launcher script (`squawk-to-me-goose`) (#58).

### Docs
- **Container deployment** — README quick-start plus a `docs/deployment.md` section
  (image shape, persistence via named volume, backup, ports, reverse proxy, security),
  every command verified against the built image (#54).
- Project documentation backfill: `README`, `AGENTS.md`, `CHANGELOG`, and
  `docs/{architecture,requirements,deployment,testing}.md` (#45).

### Fixed
- Eliminate an SSE subscription race that made the multi-viewer realtime e2e test flaky
  on CI (the test mutated before the second viewer's detail view had mounted) (#66).

### Internal
- Refresh the `.claude-project.md` toolchain/CI cache, which had gone stale (reported no
  CI and no toolchain despite both existing) (#64).

## [0.2.0] — 2026-06-28 — Phase 2 (UX completeness & polish)

### Added
- **Export a list to JSON** — per-row Export downloads the list + squawks
  (`squawk-<slug>-<id>.json`).
- **Header** — designed cyberpunk broadcast-signal SVG logo + wordmark (left), viewer
  initials (right).
- **`(O│R│E)` counts** — open / retired / recorded tallies on the list-detail view,
  each state-tinted, updating live.
- **Hover popover** — reveals the recorder's initials on a squawk.
- **Keyboard** — **Esc** reverts an edit to last-saved (clears the new-squawk box);
  **↑/↓** navigate between squawks.
- **Cyberpunk visual system** — depth tiers, faint grid + accent glow, sticky blurred
  header, per-state row treatments (open/recorded edge-glow, retired recede, recorded
  strike-while-idle), focused-input "expand into focus" treatment.

## [0.1.1] — 2026-06-27 — Tech-debt paydown

### Changed
- **Lazy database** — `bun:sqlite` opens on first use (`getDb()`), not at import;
  importing the server no longer writes `squawk.db`.
- **API hygiene** — internal `next_seq` stripped from list responses; a PATCH with
  neither `text` nor `state` is rejected (no silent `updated_at` bump).
- Client `detail.ts` uses the shared `api.ts` fetch wrappers (de-duplicated).
- `tsconfig` `verbatimModuleSyntax: true`; CI pins Bun to `1.3.11`.

### Added
- Graceful SSE `shutdown()` (clears heartbeat + closes streams), wired to SIGINT/SIGTERM.
- Realtime protection extended to the focused state `<select>`.
- **happy-dom DOM test harness** — covers focused-input/select protection end-to-end.

## [0.1.0] — 2026-06-27 — Phase 1 (walking skeleton)

### Added
- Bun + `bun:sqlite` + SSE service; one process serves UI + REST API; GitHub Actions CI.
- Data layer: `lists` / `squawks` schema, per-list monotonic `seq`, cascade delete.
- JSON REST API for lists and squawks with validation.
- Server-Sent Events broadcast on every mutation (realtime spine).
- Client shell, cyberpunk design tokens, initials cookie gate, hash router.
- Lists screen: create / open / delete-with-confirm.
- Squawk stack editor: always-empty top box, Enter-to-new, state dropdown, autosave
  (blur + 10s idle).
- Realtime client wiring with focused-box protection (last-write-wins).

### Fixed
- Autosave no longer drops a user's edit on a failed save (baseline updates only on success).
