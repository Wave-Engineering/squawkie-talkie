# Changelog

All notable changes to Squawkie-Talkie. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project is pre-1.0, so
versions below are logical milestones (Phase 1 → tech-debt → Phase 2), not git tags.

## [Unreleased]

- Project documentation backfill: `README`, `AGENTS.md`, `CHANGELOG`, and
  `docs/{architecture,requirements,deployment,testing}.md`.

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
