/**
 * List-detail view — the squawk stack editor with Vi-mode navigation.
 *
 * Two modes: NAV (default) and EDIT (text input on an existing squawk row).
 * The entry box (row 0) is always in insert mode — the mode system applies
 * only to existing squawk rows in the stack.
 *
 * NAV mode keys:
 *   j/↓ — move focus down one row
 *   k/↑ — move focus up one row
 *   ←/→ — cycle squawk state (back/forward: open↔retired↔recorded)
 *   i/Enter — enter edit mode on focused squawk text
 *   dd — retire focused squawk
 *   yy — record focused squawk + copy text to clipboard
 *   u — undo (true-delete within settle-in window, text back to entry box)
 *   Esc — jump to entry box
 *   Home — jump to entry box
 *   ? — show keymap overlay
 *
 * EDIT mode keys:
 *   Esc — save + exit to nav mode
 *   ↑/↓/j/k — implicit save + exit to nav + move
 *   All other keys — normal text input
 *   30s idle autosave with amber warning at 15s
 */

import { MAX_IMAGES_PER_SQUAWK } from "../server/types.ts";
import type { Squawk, SquawkState } from "../server/types.ts";
import {
  createSquawk,
  deleteSquawk as apiDeleteSquawk,
  deleteSquawkImage,
  getList,
  ImageLimitError,
  squawkImageUrl,
  updateSquawk,
  uploadSquawkImage,
  type ListDetail,
} from "./api.ts";
import { openCarousel } from "./carousel.ts";
import {
  hasSeen,
  replayTour,
  runTour,
  type CoachStep,
} from "./coachmarks.ts";
import { ensureInitials } from "./initials.ts";
import { activeSquawkId, setActiveView } from "./realtime.ts";
import { registerView } from "./router.ts";

/** The lifecycle states a squawk may be set to, in dropdown order. */
const STATES: readonly SquawkState[] = ["open", "retired", "recorded"];

/** Idle window before an edited squawk autosaves + exits edit mode. */
const AUTOSAVE_IDLE_MS = 30_000;

/** Warning threshold: glow transitions to amber at this point. */
const AUTOSAVE_WARN_MS = 15_000;

/** Window (ms) after creation where `u` does a true-delete. */
const SETTLE_IN_MS = 30_000;

/** Chord timeout: how long to wait for the second key in dd/yy. */
const CHORD_TIMEOUT_MS = 500;

/** Longest edge (px) a picked image is scaled down to before upload. */
const IMAGE_MAX_EDGE = 1600;

/** JPEG quality for the client-side re-encode (bounds size, strips EXIF). */
const IMAGE_QUALITY = 0.8;

// ---------------------------------------------------------------------------
// First-run coaching (Epic #69, Story #73) — consumes the engine (#70).
//
// The detail page coaches progressively: the always-empty entry box is coached
// on first visit even when the list is empty; the squawk-level teachables (the
// state <select>, the (O│R│E) counts, dd/yy/undo/hover) are only meaningful
// once a real squawk row exists, so they are shown immediately when the list
// already has one, or deferred until the user (or a teammate, via SSE) brings
// the first one into existence. The tour never creates or writes a squawk.
// ---------------------------------------------------------------------------

/** localStorage surface key for the detail page's coach tour. */
const COACH_SURFACE = "detail";

/** Always-available step: the perpetually-empty entry box. */
const COACH_ENTRY_STEP: CoachStep = {
  target: ".squawk-row--new .squawk-row__text",
  placement: "bottom",
  body:
    "Now you're cooking — that's your first squawk list, open. This top box " +
    "is always empty, always waiting: type, hit Enter, you're on the next " +
    "line. It autosaves — quit babysitting it.",
};

/**
 * Squawk-level steps, resolved fresh against `stack` so they anchor to whatever
 * the first real row is at display time — the user's own after a create, or a
 * teammate's when the list arrives populated.
 */
function coachSquawkSteps(stack: HTMLElement): CoachStep[] {
  return [
    {
      target: () => stack.querySelector("[data-squawk-id] .squawk-row__state"),
      placement: "left",
      body:
        "Open, retired, or recorded. Flip it with `dd`/`yy` from home row. Or " +
        "reach for the mouse — I'll grab you a juice box and animal crackers " +
        "while you do. I'll certainly have the time.",
    },
    {
      target: () => stack.querySelector("[data-squawk-id]"),
      placement: "left",
      body:
        "Squawked something you didn't mean to? `u` takes it back — but only " +
        "for 30 seconds. After that it's locked in. We look ahead, not back. " +
        "Onward.",
    },
    {
      target: () =>
        stack.querySelector("[data-squawk-id] .squawk-row__recorder"),
      placement: "left",
      body: "Hover any squawk to see who flagged it — no clicking required.",
    },
    {
      target: ".detail__counts",
      placement: "bottom",
      body:
        "Your running tally: Open · Retired · rEcorded — live, as squawks " +
        "change state.",
    },
    {
      target: () => stack.querySelector("[data-squawk-id]"),
      placement: "left",
      body: "Everybody sees this live — no locks, last edit wins. Play nice.",
    },
  ];
}

// ---------------------------------------------------------------------------
// Pure helpers (unit tested in tests/detail.test.ts)
// ---------------------------------------------------------------------------

/** Map a squawk state to its CSS color class (`state-open`, …). */
export function stateClass(state: SquawkState): string {
  return `state-${state}`;
}

/** Per-state tallies for the `(O│R│E)` counts badge. */
export interface StateCounts {
  open: number;
  retired: number;
  recorded: number;
}

/** Count squawks by state. */
export function countByState(squawks: Iterable<Squawk>): StateCounts {
  const counts: StateCounts = { open: 0, retired: 0, recorded: 0 };
  for (const s of squawks) {
    counts[s.state] += 1;
  }
  return counts;
}

/** A debounced function with imperative `flush`/`cancel` controls. */
export interface Debounced {
  (): void;
  flush(): void;
  cancel(): void;
}

export function debounce(fn: () => void, ms: number): Debounced {
  let handle: ReturnType<typeof setTimeout> | null = null;

  const run = (): void => {
    handle = null;
    fn();
  };

  const debounced = (() => {
    if (handle !== null) {
      clearTimeout(handle);
    }
    handle = setTimeout(run, ms);
  }) as Debounced;

  debounced.flush = (): void => {
    if (handle !== null) {
      clearTimeout(handle);
      run();
    }
  };

  debounced.cancel = (): void => {
    if (handle !== null) {
      clearTimeout(handle);
      handle = null;
    }
  };

  return debounced;
}

/** Decision returned by {@link onEnter} for a keydown on a squawk input. */
export type EnterDecision =
  | { action: "create"; focusNewBox: true }
  | { action: "commit"; focusNewBox: true }
  | { action: "ignore"; focusNewBox: false };

export interface EnterInput {
  key: string;
  isNewRow: boolean;
  value: string;
}

export function onEnter(input: EnterInput): EnterDecision {
  if (input.key !== "Enter") {
    return { action: "ignore", focusNewBox: false };
  }
  if (input.isNewRow) {
    return input.value.trim().length > 0
      ? { action: "create", focusNewBox: true }
      : { action: "ignore", focusNewBox: false };
  }
  return { action: "commit", focusNewBox: true };
}

/**
 * Target dimensions to fit `(w, h)` inside a `maxEdge`×`maxEdge` box while
 * preserving aspect ratio. Never upscales — a source already within the box is
 * returned unchanged. Pure (no DOM), so it's unit-tested; the canvas re-encode
 * that consumes it lives in {@link resizeImageToBlob}.
 */
export function fitWithin(
  w: number,
  h: number,
  maxEdge: number,
): { width: number; height: number } {
  const longest = Math.max(w, h);
  if (longest <= maxEdge) {
    return { width: w, height: h };
  }
  const scale = maxEdge / longest;
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

/** Cycle a state forward or backward through the STATES array. */
export function cycleState(
  current: SquawkState,
  direction: "forward" | "backward",
): SquawkState {
  const idx = STATES.indexOf(current);
  if (direction === "forward") {
    return STATES[(idx + 1) % STATES.length]!;
  }
  return STATES[(idx - 1 + STATES.length) % STATES.length]!;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export async function renderList(
  container: HTMLElement,
  listId: string,
): Promise<void> {
  const id = Number(listId);
  const initials = await ensureInitials();

  let detail: ListDetail;
  try {
    detail = await getList(id);
  } catch {
    setActiveView(null);
    renderError(container, listId);
    return;
  }

  container.replaceChildren();

  const stack = document.createElement("div");
  stack.className = "detail__stack";

  const model = new Map<number, Squawk>();
  const rowHandles = new Map<number, RowHandle>();

  // One shared file picker for the whole detail view. Keeping it here (not per
  // row) means each squawk row has exactly one <input> — its text box — so
  // row-scoped selectors stay unambiguous. A row's 📷 button sets the target
  // squawk and opens this picker; on pick we resize on a <canvas> and upload.
  const imageFileInput = document.createElement("input");
  imageFileInput.type = "file";
  imageFileInput.accept = "image/*";
  imageFileInput.hidden = true;
  // No `capture` attribute on purpose: it would force the camera on mobile and
  // hide the photo library, but the feature is "take *or* upload". `accept`
  // still offers "Take Photo" in the native picker, so both paths stay open.
  imageFileInput.setAttribute("aria-label", "Attach a photo");
  let pendingImageSquawkId: number | null = null;

  function pickImage(squawkId: number): void {
    pendingImageSquawkId = squawkId;
    imageFileInput.click();
  }

  imageFileInput.addEventListener("change", () => {
    const file = imageFileInput.files?.[0];
    imageFileInput.value = ""; // let the same file be re-picked later
    const targetId = pendingImageSquawkId;
    pendingImageSquawkId = null;
    if (!file || targetId === null) return;
    resizeImageToBlob(file)
      .then((blob) => uploadSquawkImage(targetId, blob))
      .then((updated) => {
        model.set(updated.id, updated);
        rowHandles.get(targetId)?.setImageIds(updated.image_ids);
      })
      .catch((err) => {
        // The 📷 button is disabled at the cap, so a 409 is only reachable via a
        // race; resync the row from the model so its disabled state is honest.
        if (err instanceof ImageLimitError) {
          rowHandles
            .get(targetId)
            ?.setImageIds(model.get(targetId)?.image_ids ?? []);
        }
        console.error("image upload failed", err);
      });
  });

  // Header
  const header = document.createElement("div");
  header.className = "detail__header";
  const title = document.createElement("h2");
  title.className = "detail__title";
  title.textContent = detail.name;
  const counts = document.createElement("span");
  counts.className = "detail__counts mono";
  header.append(title, counts);
  const updateCounts = (): void =>
    renderCounts(counts, countByState(model.values()));

  // --- Mode state ---
  type Mode = "nav" | "edit";
  let mode: Mode = "nav";
  let focusedSquawkId: number | null = null;
  let chordPending: string | null = null;
  let chordTimer: ReturnType<typeof setTimeout> | null = null;

  // Settle-in tracking: squawk id → creation timestamp
  const settleInTimes = new Map<number, number>();

  // Undo buffer: last locally-created squawk
  let undoBuffer: { id: number; text: string } | null = null;

  // First-run coaching: armed only when the entry-box tour ran on an empty
  // list, so the squawk-level steps fire once against the first real row.
  let coachSquawksPending = false;

  // Autosave timer state for edit mode
  let editTimerHandle: ReturnType<typeof setTimeout> | null = null;
  let editWarnHandle: ReturnType<typeof setTimeout> | null = null;

  function clearEditTimers(): void {
    if (editTimerHandle !== null) {
      clearTimeout(editTimerHandle);
      editTimerHandle = null;
    }
    if (editWarnHandle !== null) {
      clearTimeout(editWarnHandle);
      editWarnHandle = null;
    }
  }

  function enterEditMode(squawkId: number): void {
    mode = "edit";
    focusedSquawkId = squawkId;
    const handle = rowHandles.get(squawkId);
    if (!handle) return;
    handle.el.classList.add("squawk-row--editing");
    handle.el.classList.remove("squawk-row--nav-focus");
    handle.input.dataset.viMode = "edit";
    handle.input.focus();
    const end = handle.input.value.length;
    handle.input.setSelectionRange(end, end);
    resetEditTimer(squawkId);
    stack.classList.add("detail__stack--has-edit");
    updateModeBar();
  }

  function exitEditMode(save = true): void {
    if (mode !== "edit" || focusedSquawkId === null) return;
    const handle = rowHandles.get(focusedSquawkId);
    if (handle) {
      handle.el.classList.remove("squawk-row--editing", "squawk-row--warn");
      if (save) {
        handle.flushSave();
      } else {
        handle.cancelSave();
      }
    }
    clearEditTimers();
    mode = "nav";
    stack.classList.remove("detail__stack--has-edit");
    if (handle) {
      handle.input.dataset.viMode = "nav";
      handle.el.classList.add("squawk-row--nav-focus");
    }
    updateModeBar();
  }

  function resetEditTimer(squawkId: number): void {
    clearEditTimers();
    editWarnHandle = setTimeout(() => {
      const handle = rowHandles.get(squawkId);
      if (handle) handle.el.classList.add("squawk-row--warn");
    }, AUTOSAVE_WARN_MS);
    editTimerHandle = setTimeout(() => {
      exitEditMode(true);
    }, AUTOSAVE_IDLE_MS);
  }

  function setNavFocus(squawkId: number | null): void {
    // Remove previous nav focus
    if (focusedSquawkId !== null) {
      const prev = rowHandles.get(focusedSquawkId);
      if (prev) prev.el.classList.remove("squawk-row--nav-focus");
    }
    focusedSquawkId = squawkId;
    if (squawkId !== null) {
      const handle = rowHandles.get(squawkId);
      if (handle) {
        handle.el.classList.add("squawk-row--nav-focus");
        handle.input.focus();
        const end = handle.input.value.length;
        handle.input.setSelectionRange?.(end, end);
      }
    }
  }

  function clearChord(): void {
    chordPending = null;
    if (chordTimer !== null) {
      clearTimeout(chordTimer);
      chordTimer = null;
    }
  }

  /** Get ordered list of squawk IDs as they appear in the DOM (top to bottom). */
  function getOrderedIds(): number[] {
    const rows = stack.querySelectorAll<HTMLElement>("[data-squawk-id]");
    return Array.from(rows).map((r) => Number(r.dataset.squawkId));
  }

  function navigateRow(direction: "up" | "down"): void {
    const ids = getOrderedIds();
    if (ids.length === 0) return;

    if (focusedSquawkId === null) {
      // Enter the stack from entry box
      setNavFocus(ids[0]!);
      return;
    }

    const idx = ids.indexOf(focusedSquawkId);
    if (direction === "up") {
      if (idx <= 0) {
        // Move to entry box
        focusedSquawkId = null;
        const prev = rowHandles.get(ids[0]!);
        if (prev) prev.el.classList.remove("squawk-row--nav-focus");
        newRow.input.focus();
        return;
      }
      setNavFocus(ids[idx - 1]!);
    } else {
      if (idx >= ids.length - 1) return; // at bottom
      setNavFocus(ids[idx + 1]!);
    }
  }

  function handleNavKey(event: KeyboardEvent): void {
    const key = event.key;

    // Chord handling (dd, yy)
    if (chordPending !== null) {
      if (key === chordPending && focusedSquawkId !== null) {
        event.preventDefault();
        clearChord();
        if (key === "d") {
          // dd → retire
          doStateChange(focusedSquawkId, "retired");
        } else if (key === "y") {
          // yy → record + clipboard
          doStateChange(focusedSquawkId, "recorded");
          const sq = model.get(focusedSquawkId);
          if (sq) {
            navigator.clipboard?.writeText(sq.text).catch(() => {});
          }
        }
        return;
      }
      clearChord();
    }

    if (key === "j" || key === "ArrowDown") {
      event.preventDefault();
      navigateRow("down");
      return;
    }
    if (key === "k" || key === "ArrowUp") {
      event.preventDefault();
      navigateRow("up");
      return;
    }
    if (key === "Home" || key === "Escape") {
      event.preventDefault();
      if (focusedSquawkId !== null) {
        const prev = rowHandles.get(focusedSquawkId);
        if (prev) prev.el.classList.remove("squawk-row--nav-focus");
      }
      focusedSquawkId = null;
      newRow.input.focus();
      return;
    }
    if ((key === "i" || key === "Enter") && focusedSquawkId !== null) {
      event.preventDefault();
      enterEditMode(focusedSquawkId);
      return;
    }
    if (key === "ArrowRight" && focusedSquawkId !== null) {
      event.preventDefault();
      const sq = model.get(focusedSquawkId);
      if (sq) doStateChange(focusedSquawkId, cycleState(sq.state, "forward"));
      return;
    }
    if (key === "ArrowLeft" && focusedSquawkId !== null) {
      event.preventDefault();
      const sq = model.get(focusedSquawkId);
      if (sq) doStateChange(focusedSquawkId, cycleState(sq.state, "backward"));
      return;
    }
    if (key === "d") {
      event.preventDefault();
      chordPending = "d";
      chordTimer = setTimeout(clearChord, CHORD_TIMEOUT_MS);
      return;
    }
    if (key === "y") {
      event.preventDefault();
      chordPending = "y";
      chordTimer = setTimeout(clearChord, CHORD_TIMEOUT_MS);
      return;
    }
    if (key === "u" && focusedSquawkId !== null) {
      event.preventDefault();
      doUndo(focusedSquawkId);
      return;
    }
    if (key === "?") {
      event.preventDefault();
      showKeymapOverlay(event);
      return;
    }

    // Block all other printable keys from reaching the input in nav mode.
    // Without this, unrecognized keys silently type into the focused input,
    // desynchronizing the mode system from the DOM state.
    if (key.length === 1 && focusedSquawkId !== null) {
      event.preventDefault();
    }
  }

  function handleEditKey(event: KeyboardEvent): void {
    const key = event.key;

    if (key === "Escape") {
      event.preventDefault();
      exitEditMode(true);
      return;
    }
    if (key === "ArrowUp" || key === "ArrowDown") {
      event.preventDefault();
      exitEditMode(true);
      navigateRow(key === "ArrowUp" ? "up" : "down");
      return;
    }

    // All other keys (including j/k which are text in edit mode) reset the
    // autosave timer and clear the amber warning.
    if (focusedSquawkId !== null) {
      const handle = rowHandles.get(focusedSquawkId);
      if (handle) handle.el.classList.remove("squawk-row--warn");
      resetEditTimer(focusedSquawkId);
    }
  }

  function doStateChange(squawkId: number, newState: SquawkState): void {
    const handle = rowHandles.get(squawkId);
    if (!handle) return;
    const sq = model.get(squawkId);
    if (!sq) return;

    applyState(handle.el, newState);
    handle.select.value = newState;
    model.set(squawkId, { ...sq, state: newState });
    updateCounts();

    updateSquawk(squawkId, { state: newState }, initials)
      .then((updated) => {
        model.set(updated.id, updated);
        updateCounts();
      })
      .catch((err) => console.error("state update failed", err));
  }

  function doUndo(squawkId: number): void {
    // Only works within the settle-in window
    const createdAt = settleInTimes.get(squawkId);
    if (!createdAt || Date.now() - createdAt > SETTLE_IN_MS) return;

    const sq = model.get(squawkId);
    if (!sq) return;

    // Remove from DOM + model
    removeSquawkRow(squawkId);

    // Put text back in entry box
    newRow.input.value = sq.text;
    newRow.input.focus();
    focusedSquawkId = null;

    // Set as undo buffer in case we want it
    undoBuffer = { id: squawkId, text: sq.text };

    // Delete from server
    apiDeleteSquawk(squawkId).catch((err) =>
      console.error("undo-delete failed", err),
    );
  }

  function removeSquawkRow(squawkId: number): void {
    const handle = rowHandles.get(squawkId);
    if (handle) {
      handle.el.remove();
      rowHandles.delete(squawkId);
    }
    model.delete(squawkId);
    settleInTimes.delete(squawkId);
    if (focusedSquawkId === squawkId) {
      focusedSquawkId = null;
    }
    updateCounts();
  }

  // --- Keymap overlay ---
  let overlayEl: HTMLElement | null = null;

  function showKeymapOverlay(openingEvent?: Event): void {
    if (overlayEl) return;
    overlayEl = document.createElement("div");
    overlayEl.className = "keymap-overlay";
    overlayEl.innerHTML = `
      <div class="keymap-overlay__content">
        <h3 class="keymap-overlay__title">Keyboard Shortcuts</h3>
        <table class="keymap-overlay__table">
          <tr><th>Key</th><th>Action</th></tr>
          <tr><td><kbd>j</kbd> / <kbd>↓</kbd></td><td>Move down</td></tr>
          <tr><td><kbd>k</kbd> / <kbd>↑</kbd></td><td>Move up</td></tr>
          <tr><td><kbd>←</kbd> / <kbd>→</kbd></td><td>Cycle state</td></tr>
          <tr><td><kbd>i</kbd> / <kbd>Enter</kbd></td><td>Edit mode</td></tr>
          <tr><td><kbd>Esc</kbd></td><td>Exit edit / Jump to entry</td></tr>
          <tr><td><kbd>Home</kbd></td><td>Jump to entry</td></tr>
          <tr><td><kbd>dd</kbd></td><td>Retire squawk</td></tr>
          <tr><td><kbd>yy</kbd></td><td>Record + copy</td></tr>
          <tr><td><kbd>u</kbd></td><td>Undo (within 30s)</td></tr>
          <tr><td><kbd>?</kbd></td><td>This help</td></tr>
        </table>
        <p class="keymap-overlay__dismiss">Press any key to dismiss</p>
      </div>
    `;
    container.append(overlayEl);

    // Any key or click closes the overlay — except the very keydown/click that
    // opened it. Openers run in the capture phase (on `stack`) or on the help
    // hint, so that same event bubbles up to `document` after we attach here;
    // ignore it by identity. Comparing the event object — dispatched exactly
    // once — is race-free, unlike the old setTimeout(0), which left a macrotask
    // window in which a fast dismiss keypress was silently lost (#108).
    const dismiss = (event: Event): void => {
      if (event === openingEvent) return;
      overlayEl?.remove();
      overlayEl = null;
      document.removeEventListener("keydown", dismiss);
      document.removeEventListener("click", dismiss);
    };
    document.addEventListener("keydown", dismiss);
    document.addEventListener("click", dismiss);
  }

  // --- Row 0: the always-empty new-squawk input ---
  const newRow = buildNewRow();
  stack.append(newRow.el);

  // Help hint in the corner
  const helpHint = document.createElement("span");
  helpHint.className = "detail__help-hint mono";
  helpHint.textContent = "?";
  helpHint.title = "Keyboard shortcuts";
  helpHint.addEventListener("click", showKeymapOverlay);

  function insertSquawk(squawk: Squawk, isLocal = false): void {
    if (isLocal) {
      settleInTimes.set(squawk.id, Date.now());
      undoBuffer = { id: squawk.id, text: squawk.text };
    }
    if (rowHandles.has(squawk.id)) return;
    model.set(squawk.id, squawk);
    const handle = buildSquawkRow(
      squawk,
      id,
      initials,
      model,
      updateCounts,
      pickImage,
    );
    rowHandles.set(squawk.id, handle);
    newRow.el.insertAdjacentElement("afterend", handle.el);
    updateCounts();
    coachSquawksIfPending();
  }

  function patchSquawk(squawk: Squawk, applyToInput: boolean): void {
    const handle = rowHandles.get(squawk.id);
    if (!handle) {
      insertSquawk(squawk);
      return;
    }
    model.set(squawk.id, squawk);
    handle.setState(squawk.state);
    handle.setRecorder(squawk.initials);
    handle.setImageIds(squawk.image_ids);
    if (applyToInput) {
      handle.setText(squawk.text);
    }
    updateCounts();
  }

  // --- New-row keyboard handling (always in "insert" mode) ---
  newRow.input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      newRow.input.value = "";
      return;
    }
    if (event.key === "ArrowDown" || event.key === "j") {
      // j only navigates if input is empty (avoid swallowing typed 'j')
      if (event.key === "j" && newRow.input.value.length > 0) return;
      event.preventDefault();
      event.stopPropagation();
      mode = "nav";
      navigateRow("down");
      updateModeBar();
      return;
    }
    if (event.key === "?") {
      // From the entry box, `?` replays the surface's coaching (Epic #69).
      // The keymap cheat-sheet stays reachable from a focused squawk row and
      // the corner hint. Only when the box is empty, so a literal "?" can be
      // typed into a squawk.
      if (newRow.input.value.length === 0) {
        event.preventDefault();
        event.stopPropagation();
        replayCoach();
        return;
      }
    }
    const decision = onEnter({
      key: event.key,
      isNewRow: true,
      value: newRow.input.value,
    });
    if (decision.action !== "create") return;
    event.preventDefault();
    const text = newRow.input.value;
    createSquawk(id, text, initials)
      .then((created) => {
        insertSquawk(created, true);
        newRow.input.value = "";
        newRow.input.focus();
      })
      .catch((err) => console.error("createSquawk failed", err));
  });

  // --- Global keyboard dispatcher (on the stack container) ---
  // Uses capture phase so preventDefault() fires before the input's default
  // text-insertion behavior (which happens between the target's keydown and
  // the bubbling phase in some browsers).
  stack.addEventListener("keydown", (event) => {
    // Don't intercept when focus is on the new-row input (it handles its own keys)
    if (document.activeElement === newRow.input) return;
    // Don't intercept when overlay is showing
    if (overlayEl) return;

    if (mode === "nav") {
      handleNavKey(event);
    } else if (mode === "edit") {
      handleEditKey(event);
    }
  }, true);

  // Existing squawks arrive newest-first from the API; append in order.
  for (const squawk of detail.squawks) {
    model.set(squawk.id, squawk);
    const handle = buildSquawkRow(
      squawk,
      id,
      initials,
      model,
      updateCounts,
      pickImage,
    );
    rowHandles.set(squawk.id, handle);
    stack.append(handle.el);
  }
  updateCounts();

  // --- Mode indicator bar (vim-style footer) ---
  const modeBar = document.createElement("div");
  modeBar.className = "detail__mode-bar";
  modeBar.textContent = "-- INSERT --";

  function updateModeBar(): void {
    if (document.activeElement === newRow.input) {
      modeBar.textContent = "-- INSERT --";
      modeBar.dataset.mode = "insert";
    } else if (mode === "edit") {
      modeBar.textContent = "-- EDIT --";
      modeBar.dataset.mode = "edit";
    } else {
      modeBar.textContent = "-- NAV --";
      modeBar.dataset.mode = "nav";
    }
  }

  newRow.input.addEventListener("focus", updateModeBar);
  newRow.input.addEventListener("blur", updateModeBar);

  container.append(header, stack, helpHint, modeBar, imageFileInput);
  newRow.input.focus();

  // Realtime seam
  setActiveView({
    kind: "detail",
    listId: id,
    upsertSquawk: (squawk) => insertSquawk(squawk),
    patchSquawk,
    removeSquawk: (sqId) => removeSquawkRow(sqId),
    // On reconnect: re-fetch this list and reconcile what changed while offline,
    // without clobbering the control the viewer is actively editing (invariant #1).
    resync: async () => {
      let fresh: ListDetail;
      try {
        fresh = await getList(id);
      } catch {
        return; // leave rows as-is; the indicator already signals the problem
      }
      const activeId = activeSquawkId(document.activeElement);
      const freshIds = new Set(fresh.squawks.map((s) => s.id));
      // Iterate oldest-first: `getList` is newest-first but `insertSquawk`
      // prepends, so inserting oldest-first leaves a missed batch newest-on-top
      // (matching the live single-event path). Patches are order-independent.
      for (const squawk of [...fresh.squawks].reverse()) {
        if (rowHandles.has(squawk.id)) {
          patchSquawk(squawk, squawk.id !== activeId);
        } else {
          insertSquawk(squawk);
        }
      }
      for (const sid of [...rowHandles.keys()]) {
        if (!freshIds.has(sid)) removeSquawkRow(sid);
      }
    },
  });

  // --- First-run coaching (Epic #69, Story #73) ---
  function hasSquawkRow(): boolean {
    return stack.querySelector("[data-squawk-id]") !== null;
  }

  /** The full applicable tour: entry box always, squawk steps once a row exists. */
  function coachSteps(): CoachStep[] {
    return hasSquawkRow()
      ? [COACH_ENTRY_STEP, ...coachSquawkSteps(stack)]
      : [COACH_ENTRY_STEP];
  }

  /** Replay the applicable tour regardless of the seen-flag (the `?` affordance). */
  function replayCoach(): void {
    replayTour(COACH_SURFACE, coachSteps());
  }

  /** Fire the deferred squawk-level steps once, when the first row appears. */
  function coachSquawksIfPending(): void {
    if (!coachSquawksPending || !hasSquawkRow()) return;
    coachSquawksPending = false;
    replayTour(COACH_SURFACE, coachSquawkSteps(stack));
  }

  // Auto-run once per browser. A populated list coaches the entry box and the
  // first real row together; an empty list coaches only the entry box now and
  // arms the squawk-level steps for the first row the user brings into being.
  if (!hasSeen(COACH_SURFACE)) {
    if (hasSquawkRow()) {
      runTour(COACH_SURFACE, [COACH_ENTRY_STEP, ...coachSquawkSteps(stack)]);
    } else {
      coachSquawksPending = true;
      runTour(COACH_SURFACE, [COACH_ENTRY_STEP]);
    }
  }
}

// ---------------------------------------------------------------------------
// Client-side image resize (bounds upload size, strips EXIF, normalizes format)
// ---------------------------------------------------------------------------

/** A decoded image plus the metadata + teardown a canvas draw needs. */
interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  cleanup(): void;
}

/** Decode a picked file to a drawable source. Prefers `createImageBitmap`. */
async function decodeImage(file: Blob): Promise<DecodedImage> {
  // createImageBitmap decodes most platform-supported formats (incl. HEIC on
  // Apple devices) without a DOM node.
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      cleanup: () => bitmap.close(),
    };
  }
  // Fallback: object URL + <img>, revoked once drawn.
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("image decode failed"));
      img.src = url;
    });
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      cleanup: () => URL.revokeObjectURL(url),
    };
  } catch (err) {
    // Decode failed before we could hand back a cleanup — revoke here so the
    // object URL doesn't leak for the document's lifetime.
    URL.revokeObjectURL(url);
    throw err;
  }
}

/**
 * Re-encode a picked image file as a bounded JPEG via a `<canvas>`. Scales the
 * longest edge down to {@link IMAGE_MAX_EDGE}, which caps the payload; the
 * re-encode also drops EXIF/GPS metadata (a privacy win on phone photos) and
 * normalizes odd source formats to JPEG. Rejects if the browser can't decode
 * the file or lacks a 2D context.
 */
async function resizeImageToBlob(file: Blob): Promise<Blob> {
  const decoded = await decodeImage(file);
  try {
    const { width, height } = fitWithin(
      decoded.width,
      decoded.height,
      IMAGE_MAX_EDGE,
    );
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("2D canvas context unavailable");
    }
    ctx.drawImage(decoded.source, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) =>
          blob ? resolve(blob) : reject(new Error("canvas toBlob returned null")),
        "image/jpeg",
        IMAGE_QUALITY,
      );
    });
  } finally {
    decoded.cleanup();
  }
}

/** Build the always-empty new-squawk row (row 0). */
function buildNewRow(): { el: HTMLElement; input: HTMLInputElement } {
  const el = document.createElement("div");
  el.className = "squawk-row squawk-row--new";

  const seq = document.createElement("span");
  seq.className = "squawk-row__seq mono";
  seq.setAttribute("aria-hidden", "true");
  seq.textContent = "+";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "squawk-row__text";
  input.placeholder = "New squawk — type and press Enter";
  input.autocomplete = "off";
  input.setAttribute("aria-label", "New squawk");

  el.append(seq, input);
  return { el, input };
}

interface RowHandle {
  el: HTMLElement;
  input: HTMLInputElement;
  select: HTMLSelectElement;
  setText(text: string): void;
  setState(state: SquawkState): void;
  setRecorder(initials: string): void;
  /**
   * Reflect a new ordered image-id list onto the row: the thumbnail (first id),
   * the count badge (shown when > 1), and the 📷 button's disabled-at-cap state.
   * Drives both local uploads/removes and remote (SSE) changes.
   */
  setImageIds(ids: number[]): void;
  flushSave(): void;
  cancelSave(): void;
}

function buildSquawkRow(
  squawk: Squawk,
  listId: number,
  initials: string,
  model: Map<number, Squawk>,
  onChange: () => void,
  onPickImage: (squawkId: number) => void,
): RowHandle {
  const row = document.createElement("div");
  row.className = `squawk-row ${stateClass(squawk.state)}`;
  row.dataset.squawkId = String(squawk.id);

  const seq = document.createElement("span");
  seq.className = "squawk-row__seq mono";
  seq.textContent = String(squawk.seq);

  const input = document.createElement("input");
  input.type = "text";
  input.className = "squawk-row__text";
  input.value = squawk.text;
  input.autocomplete = "off";
  input.setAttribute("aria-label", `Squawk ${squawk.seq}`);
  input.dataset.viMode = "nav";

  let lastSaved = squawk.text;
  const save = debounce(() => {
    const text = input.value;
    if (text === lastSaved) return;
    updateSquawk(squawk.id, { text }, initials)
      .then((updated) => {
        lastSaved = text;
        model.set(updated.id, updated);
      })
      .catch((err) => console.error("autosave failed", err));
  }, AUTOSAVE_IDLE_MS);

  input.addEventListener("input", () => save());
  input.addEventListener("blur", () => save.flush());

  const select = document.createElement("select");
  select.className = "squawk-row__state";
  select.setAttribute("aria-label", `State of squawk ${squawk.seq}`);
  for (const state of STATES) {
    const option = document.createElement("option");
    option.value = state;
    option.textContent = state;
    option.selected = state === squawk.state;
    select.append(option);
  }
  select.addEventListener("change", () => {
    const state = select.value as SquawkState;
    applyState(row, state);
    const current = model.get(squawk.id);
    if (current) {
      model.set(squawk.id, { ...current, state });
    }
    onChange();
    updateSquawk(squawk.id, { state }, initials)
      .then((updated) => {
        model.set(updated.id, updated);
        onChange();
      })
      .catch((err) => console.error("state update failed", err));
  });

  const recorder = document.createElement("span");
  recorder.className = "squawk-row__recorder mono";
  setRecorderText(recorder, squawk.initials);

  // --- Image affordance: capture/upload button + thumbnail that opens a carousel ---
  // The file <input> is NOT per-row — a single shared one lives in `renderList`
  // so each squawk row keeps exactly one <input> (its text box). The 📷 button
  // asks `renderList` to open that picker targeting this squawk (append, up to
  // MAX_IMAGES_PER_SQUAWK). The thumbnail shows the first image plus, when there
  // is more than one, a count badge; clicking it opens the carousel.
  const imageCell = document.createElement("div");
  imageCell.className = "squawk-row__image";

  let imageIds = squawk.image_ids ?? [];

  const attachBtn = document.createElement("button");
  attachBtn.type = "button";
  attachBtn.className = "squawk-row__image-btn";
  attachBtn.textContent = "📷";
  attachBtn.setAttribute("aria-label", `Attach a photo to squawk ${squawk.seq}`);
  attachBtn.addEventListener("click", () => onPickImage(squawk.id));

  const thumbBtn = document.createElement("button");
  thumbBtn.type = "button";
  thumbBtn.className = "squawk-row__thumb-btn";
  thumbBtn.hidden = true;

  const thumb = document.createElement("img");
  thumb.className = "squawk-row__thumb";
  thumb.alt = `Photo on squawk ${squawk.seq}`;
  thumb.loading = "lazy";

  const countBadge = document.createElement("span");
  countBadge.className = "squawk-row__thumb-count";
  countBadge.hidden = true;

  thumbBtn.append(thumb, countBadge);

  /** Reflect `imageIds` onto the thumbnail, badge, and the 📷 cap state. */
  function renderImage(): void {
    const count = imageIds.length;
    if (count === 0) {
      thumbBtn.hidden = true;
      thumb.removeAttribute("src");
      attachBtn.disabled = false;
      attachBtn.title = "Attach a photo";
      return;
    }
    // The first image is the thumbnail; its per-id URL is stable across appends
    // (so it won't refetch) and changes when the first image is removed (so it does).
    thumb.src = squawkImageUrl(squawk.id, imageIds[0]!);
    thumbBtn.hidden = false;
    thumbBtn.setAttribute(
      "aria-label",
      count === 1
        ? `View photo on squawk ${squawk.seq}`
        : `View ${count} photos on squawk ${squawk.seq}`,
    );
    countBadge.textContent = String(count);
    countBadge.hidden = count <= 1;
    const atCap = count >= MAX_IMAGES_PER_SQUAWK;
    attachBtn.disabled = atCap;
    attachBtn.title = atCap
      ? `Max ${MAX_IMAGES_PER_SQUAWK} photos`
      : "Add another photo";
  }

  thumbBtn.addEventListener("click", () => {
    if (imageIds.length === 0) return;
    openCarousel({
      squawkId: squawk.id,
      seq: squawk.seq,
      imageIds: [...imageIds],
      imageUrl: (imageId) => squawkImageUrl(squawk.id, imageId),
      onRemove: (imageId) =>
        deleteSquawkImage(squawk.id, imageId).then(() => undefined),
      onChange: (ids) => {
        imageIds = ids;
        const current = model.get(squawk.id);
        if (current) {
          model.set(squawk.id, {
            ...current,
            image_ids: ids,
            has_image: ids.length > 0,
          });
        }
        renderImage();
      },
    });
  });

  imageCell.append(attachBtn, thumbBtn);
  renderImage();

  row.append(seq, input, select, recorder, imageCell);

  return {
    el: row,
    input,
    select,
    setText: (text: string): void => {
      input.value = text;
      lastSaved = text;
    },
    setState: (state: SquawkState): void => {
      applyState(row, state);
      if (document.activeElement !== select) {
        select.value = state;
      }
    },
    setRecorder: (init: string): void => setRecorderText(recorder, init),
    setImageIds: (ids: number[]): void => {
      // Coerce a missing list to empty — patchSquawk feeds this from external
      // SSE/server data, and a malformed frame must not crash the row render.
      imageIds = ids ?? [];
      renderImage();
    },
    flushSave: (): void => save.flush(),
    cancelSave: (): void => {
      save.cancel();
      input.value = lastSaved;
    },
  };
}

function setRecorderText(el: HTMLElement, initials: string): void {
  el.textContent = initials;
  el.setAttribute("aria-label", `recorded by ${initials}`);
}

function renderCounts(el: HTMLElement, counts: StateCounts): void {
  el.replaceChildren();
  el.append(
    document.createTextNode("("),
    countSpan(counts.open, "open"),
    countSep(),
    countSpan(counts.retired, "retired"),
    countSep(),
    countSpan(counts.recorded, "recorded"),
    document.createTextNode(")"),
  );
}

function countSpan(n: number, state: SquawkState): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = `count count--${state}`;
  span.textContent = String(n);
  span.title = `${state}: ${n}`;
  return span;
}

function countSep(): HTMLSpanElement {
  const sep = document.createElement("span");
  sep.className = "count__sep";
  sep.textContent = "│";
  sep.setAttribute("aria-hidden", "true");
  return sep;
}

function applyState(row: HTMLElement, state: SquawkState): void {
  row.classList.remove("state-open", "state-retired", "state-recorded");
  row.classList.add(stateClass(state));
}

function renderError(container: HTMLElement, listId: string): void {
  container.replaceChildren();
  const note = document.createElement("p");
  note.className = "mono";
  note.textContent = `Could not load list #${listId}.`;
  container.append(note);
}

registerView("detail", (container, params) => {
  void renderList(container, params.id ?? "");
});
