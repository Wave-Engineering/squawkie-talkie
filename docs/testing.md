# Test Plan

Strategy: **functional behavior is automated; humans check only aesthetics.** Tests trace
to the numbered behaviors in [`requirements.md`](requirements.md).

## The pyramid

| Tier | Tool | Scope | Status |
|---|---|---|---|
| **Unit** | `bun test` | Pure logic — `db.ts` repo fns, `countByState`, `debounce`, `onEnter`, `normalizeInitials`, `shouldApplyToInput`, `exportFilename`, API routing/validation, and the optional API-token check (`tests/auth.test.ts` → R-28). | **In place** |
| **Component / DOM** | `bun test` + happy-dom | Rendered-DOM behavior — focus/keyboard, arrow nav, Esc, counts, hover badge, focused-input/select protection, export wiring. | **In place** |
| **End-to-end** | Playwright | Real browser, real server, real cookies/SSE; cross-tab realtime via two browser contexts. | **In place** |
| **Manual** | human | Visual/UX judgment only — does the cyberpunk look land, does it *feel* right. | Checklist below |

Run the automated tiers:

```bash
bun run typecheck
bun test            # unit + DOM
bun run test:e2e    # Playwright (chromium)
```

## What's automated today

`bun test` covers the unit + DOM tiers. DOM tests (`tests/dom.test.ts`) register happy-dom
in `beforeAll` / unregister in `afterAll` so the global `document`/`fetch` never leak into
the server tests. Server tests set `SQUAWK_DB=":memory:"` before importing `db.ts` so each
file gets a throwaway database.

## End-to-end (Playwright)

The specs live in [`e2e/`](../e2e). Playwright is the tier that exercises what unit/DOM
can't: a real browser against a running server, the real cookie gate, real SSE, and
**realtime across two `BrowserContext`s** hitting the same instance. Playwright's
`webServer` config starts the app on an ephemeral port for the run.

Coverage (→ requirements): initials gate R-1–R-3 · list CRUD + export R-4–R-8 (the
download is intercepted) · editor flow R-9–R-16 (Enter/Esc/↑↓, autosave, states) · hover +
counts R-17–R-18 · **two-context realtime + focused-control protection R-19–R-21**
(`11-multi-viewer-realtime.spec.ts`) · vi-mode keymap and chords · onboarding coach marks.

## Manual UX checklist (aesthetics only)

Everything functional is (or will be) automated; a human only judges feel. On
[the running app](http://localhost:7700):

- [ ] Header reads clean — logo glow, wordmark tracking, sticky behavior.
- [ ] Background grid/glow is present but subtle (not noisy).
- [ ] State colors are clearly distinguishable at a glance (open vs retired vs recorded).
- [ ] Focused input/row "lift" feels responsive, not jumpy.
- [ ] Recorded strike-through reads as "filed elsewhere," not as a glitch.
- [ ] Generous whitespace between rows; nothing feels crowded at the margins.
- [ ] Hover recorder badge and `(O│R│E)` counts are legible and well-placed.

## CI

`.github/workflows/ci.yml` runs on `pull_request` and on `push` to `main`, in three jobs:

- **`test`** — `bun install` → `bun run typecheck` → `bun test`
- **`e2e`** — the Playwright suite (chromium)
- **`docker`** — build the image → `scripts/ci/docker-smoke.sh`

All three are required checks on `main`, which also requires a branch to be up to date
before merging. There is no merge queue.
