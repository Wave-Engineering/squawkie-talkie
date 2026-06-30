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

import type { Squawk, SquawkState } from "../server/types.ts";
import {
  createSquawk,
  deleteSquawk as apiDeleteSquawk,
  getList,
  updateSquawk,
  type ListDetail,
} from "./api.ts";
import { ensureInitials } from "./initials.ts";
import { setActiveView } from "./realtime.ts";
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
      showKeymapOverlay();
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

  function showKeymapOverlay(): void {
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

    const dismiss = (): void => {
      overlayEl?.remove();
      overlayEl = null;
      document.removeEventListener("keydown", dismiss);
      document.removeEventListener("click", dismiss);
    };
    // Use setTimeout so the '?' keydown that opened it doesn't immediately close
    setTimeout(() => {
      document.addEventListener("keydown", dismiss, { once: true });
      document.addEventListener("click", dismiss, { once: true });
    }, 0);
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
    const handle = buildSquawkRow(squawk, id, initials, model, updateCounts);
    rowHandles.set(squawk.id, handle);
    newRow.el.insertAdjacentElement("afterend", handle.el);
    updateCounts();
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
      return;
    }
    if (event.key === "?") {
      // Only trigger help if input is empty
      if (newRow.input.value.length === 0) {
        event.preventDefault();
        event.stopPropagation();
        showKeymapOverlay();
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
    const handle = buildSquawkRow(squawk, id, initials, model, updateCounts);
    rowHandles.set(squawk.id, handle);
    stack.append(handle.el);
  }
  updateCounts();

  container.append(header, stack, helpHint);
  newRow.input.focus();

  // Realtime seam
  setActiveView({
    kind: "detail",
    listId: id,
    upsertSquawk: (squawk) => insertSquawk(squawk),
    patchSquawk,
    removeSquawk: (sqId) => removeSquawkRow(sqId),
  });
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
  flushSave(): void;
  cancelSave(): void;
}

function buildSquawkRow(
  squawk: Squawk,
  listId: number,
  initials: string,
  model: Map<number, Squawk>,
  onChange: () => void,
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

  row.append(seq, input, select, recorder);

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
