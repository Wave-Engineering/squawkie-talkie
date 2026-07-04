# Changelog

All notable changes to Squawkie-Talkie. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Entries `0.1.0`–`0.2.0` were
pre-tag logical milestones (Phase 1 → tech-debt → Phase 2); **git-tagged releases begin
at `v0.3.0`**.

## [Unreleased]

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
