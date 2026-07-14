# Requirements — behavioral spec

The testable behaviors of Squawkie-Talkie, as numbered requirements. This is the **trace
target** for the test suite: each requirement should map to one or more automated tests
(unit / DOM / E2E) — see [`testing.md`](testing.md). It captures *behavior*, not
implementation; for design see [`architecture.md`](architecture.md).

## Identity (initials)

- **R-1** On first visit (no `st_initials` cookie) the user is prompted for initials before
  the lists screen is usable.
- **R-2** Initials are normalized to **1–3 uppercase alphanumerics** (client and server).
- **R-3** Initials persist in the `st_initials` cookie; a return visit skips the prompt.
  Clearing the cookie re-prompts.

## Lists screen

- **R-4** All existing lists are shown (oldest first).
- **R-5** Creating a list adds it without a full reload; empty names are rejected.
- **R-6** Opening a list navigates to its detail view (`#/list/:id`).
- **R-7** Deleting a list requires a **two-step inline confirm** (no native `confirm()`),
  then removes the list and **all its squawks**.
- **R-8** Exporting a list downloads a JSON file (`squawk-<slug>-<id>.json`) containing the
  list and its squawks; the internal `next_seq` is absent.

## Squawk editor (list detail)

- **R-9** Squawks render newest-first, each as `[seq] [text input] [state select]`, with an
  always-empty new-squawk box pinned on top.
- **R-10** Typing in the top box + **Enter** creates a squawk, clears the box, and keeps
  focus on it (ready for the next).
- **R-11** Editing an existing squawk autosaves **on blur** and after **10s idle**; a failed
  save does not drop the edit (retries on the next blur/idle).
- **R-12** **Enter** in an existing row commits immediately and returns focus to the top box.
- **R-13** **Esc** in an existing row restores the last-saved text and drops the pending
  autosave; **Esc** in the new-squawk box clears it.
- **R-14** **↑/↓** move focus between rows (and the top box); no wrap at the ends.
- **R-15** The state dropdown sets **open / retired / recorded**; the row recolors per state.
- **R-16** Each squawk shows its `seq` as a stable identifier; `seq` is per-list, monotonic,
  and never reused (gaps after deletes are expected).
- **R-17** Hovering (or focusing) a squawk reveals the recorder's initials.
- **R-18** The list header shows the name and live **`(O│R│E)`** counts (open/retired/
  recorded), each state-distinct; counts update on create, state change, and remote update.

## Realtime

- **R-19** A list created or deleted by another viewer appears/disappears live on the lists
  screen.
- **R-20** A squawk created or updated by another viewer appears/updates live for viewers on
  that list (last-write-wins).
- **R-21** A remote update **never overwrites the control the viewer is actively in** — the
  focused text input *and* the focused state `<select>` are preserved; other rows still update.

## API contract

- **R-22** Endpoints behave per [`architecture.md`](architecture.md): valid input succeeds
  with the documented status; invalid input → `400 {error}`; unknown list/squawk → `404`.
- **R-23** `next_seq` never appears in any API response.
- **R-24** A `PATCH /api/squawks/:id` with neither `text` nor `state` is rejected and does
  not change the squawk (no `updated_at` bump).
- **R-27** `GET /api/lists/by-name?name=<name>` returns the exact-name list (with its
  squawks; oldest match when names duplicate); `400` if `name` is missing, `404` if none.

## Non-functional

- **R-25** No *user* authentication and no authorization model; trusted-network deployment
  only (see security posture). R-28 does not relax this — the reverse proxy remains the
  security boundary.
- **R-26** The instance state is the single `squawk.db` file; deleting a list is permanent.
- **R-28** *Optional* API-token auth on the `/api` surface (REST + `/api/stream`),
  configured via `SQUAWK_API_TOKEN` or `SQUAWK_API_TOKEN_FILE` (a secret-file path, which
  wins over the inline var). Disabled unless configured. When enabled it **validates only
  if an `Authorization` header is present**: a header-absent request passes through, a
  valid `Bearer` token is accepted (constant-time compare), and a wrong or malformed
  header is rejected `401`. `/healthz` and static assets are never gated; the token is
  never logged. The check **fails open**: a missing, unreadable, or empty
  `SQUAWK_API_TOKEN_FILE` resolves to unconfigured (feature off) rather than crashing, and
  does not fall back to `SQUAWK_API_TOKEN`. The token is re-resolved per request, so the
  boot log reports boot-time state only.
