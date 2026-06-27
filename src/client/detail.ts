/**
 * List-detail view — the squawk stack editor.
 *
 * Renders a list's squawks as a vertical stack, newest on top, with an
 * always-empty new-squawk input pinned at the top (row 0). The interaction
 * model is deliberately predictable: type a line, press Enter, and you are
 * immediately ready to type the next one.
 *
 * Behaviour:
 *   - Row 0 (new-squawk): Enter creates the squawk, clears the box, and keeps
 *     focus on it; the created row is inserted directly beneath row 0.
 *   - Existing rows: the text input autosaves after 10s of idle AND on blur
 *     (`PATCH /api/squawks/:id`); Enter commits immediately and returns focus
 *     to row 0. A per-row state <select> recolors the row on change.
 *
 * Rows are keyed by `data-squawk-id` and updated surgically — a focused input
 * is never rebuilt on update. This is the seam #9 relies on to patch rows from
 * realtime events without disturbing whoever is typing.
 *
 * Data access uses the shared `src/client/api.ts` fetch wrappers.
 */

import type { Squawk, SquawkState } from "../server/types.ts";
import {
  createSquawk,
  getList,
  updateSquawk,
  type ListDetail,
} from "./api.ts";
import { ensureInitials } from "./initials.ts";
import { setActiveView } from "./realtime.ts";
import { registerView } from "./router.ts";

/** Idle window before an edited squawk autosaves. */
const AUTOSAVE_IDLE_MS = 10_000;

/** The lifecycle states a squawk may be set to, in dropdown order. */
const STATES: readonly SquawkState[] = ["open", "retired", "recorded"];

// ---------------------------------------------------------------------------
// Pure helpers (unit tested in tests/detail.test.ts)
// ---------------------------------------------------------------------------

/** Map a squawk state to its CSS color class (`state-open`, …). */
export function stateClass(state: SquawkState): string {
  return `state-${state}`;
}

/** A debounced function with imperative `flush`/`cancel` controls. */
export interface Debounced {
  (): void;
  /** Run the pending invocation now, if one is scheduled. */
  flush(): void;
  /** Drop the pending invocation without running it. */
  cancel(): void;
}

/**
 * Coalesce rapid calls: `fn` runs once, `ms` after the last call. `flush`
 * fires a pending call immediately (used on blur / Enter); `cancel` drops it.
 */
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

/** Inputs to the (pure) Enter-key decision. */
export interface EnterInput {
  key: string;
  /** True for row 0 (the always-empty new-squawk input). */
  isNewRow: boolean;
  value: string;
}

/**
 * Decide what an Enter keypress should do.
 *   - new-squawk row with text  -> create a squawk, focus stays on the new box
 *   - existing row              -> commit the edit, focus moves to the new box
 *   - anything else / empty new  -> ignore
 */
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

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render the list-detail view for `listId` into `container`.
 * Exported for the router; also re-rendered fresh on each mount.
 */
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
    setActiveView(null); // no live rows to patch on a failed load
    renderError(container, listId);
    return;
  }

  container.replaceChildren();

  const title = document.createElement("h2");
  title.className = "detail__title";
  title.textContent = detail.name;

  const stack = document.createElement("div");
  stack.className = "detail__stack";

  // The client model, keyed by squawk id, kept in step with surgical updates.
  const model = new Map<number, Squawk>();
  // The built rows, keyed by squawk id — the seam realtime (#9) patches.
  const rowHandles = new Map<number, RowHandle>();

  // Row 0: the always-empty new-squawk input.
  const newRow = buildNewRow();
  stack.append(newRow.el);

  /**
   * Insert a squawk's row directly beneath row 0 (newest on top), unless its row
   * already exists. Shared by local creates and realtime `squawk.created`, so a
   * viewer's own create and the echoed broadcast don't double-insert.
   */
  function insertSquawk(squawk: Squawk): void {
    if (rowHandles.has(squawk.id)) {
      return;
    }
    model.set(squawk.id, squawk);
    const handle = buildSquawkRow(squawk, id, initials, model);
    rowHandles.set(squawk.id, handle);
    newRow.el.insertAdjacentElement("afterend", handle.el);
  }

  /**
   * Apply a remote `squawk.updated`. The model and state always update
   * (last-write-wins); the input value updates only when `applyToInput` is true
   * (i.e. this row's box is not the one currently focused).
   */
  function patchSquawk(squawk: Squawk, applyToInput: boolean): void {
    const handle = rowHandles.get(squawk.id);
    if (!handle) {
      insertSquawk(squawk); // missed the create — land it now
      return;
    }
    model.set(squawk.id, squawk);
    handle.setState(squawk.state);
    if (applyToInput) {
      handle.setText(squawk.text);
    }
  }

  newRow.input.addEventListener("keydown", (event) => {
    const decision = onEnter({
      key: event.key,
      isNewRow: true,
      value: newRow.input.value,
    });
    if (decision.action !== "create") {
      return;
    }
    event.preventDefault();
    const text = newRow.input.value;
    createSquawk(id, text, initials)
      .then((created) => {
        insertSquawk(created);
        newRow.input.value = "";
        newRow.input.focus();
      })
      .catch((err) => console.error("createSquawk failed", err));
  });

  // Existing squawks arrive newest-first from the API; append in order.
  for (const squawk of detail.squawks) {
    model.set(squawk.id, squawk);
    const handle = buildSquawkRow(squawk, id, initials, model);
    rowHandles.set(squawk.id, handle);
    stack.append(handle.el);
  }

  container.append(title, stack);
  newRow.input.focus();

  // Realtime seam (#9): this mount is the active sink while the list is shown.
  // A squawk created/updated by another viewer on this list lands live; the
  // focused-box rule (in realtime.ts) decides whether an update overwrites the
  // input the viewer is currently typing in.
  setActiveView({
    kind: "detail",
    listId: id,
    upsertSquawk: (squawk) => insertSquawk(squawk),
    patchSquawk,
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

/**
 * A built squawk row plus the surgical patch points realtime (#9) drives:
 * `setText` overwrites the input value (and resyncs the autosave baseline so a
 * later blur doesn't redundantly re-save the remote value); `setState` recolors
 * the row and syncs the state dropdown.
 */
interface RowHandle {
  el: HTMLElement;
  setText(text: string): void;
  setState(state: SquawkState): void;
}

/**
 * Build one existing-squawk row: `[seq] [text input] [state select]`, keyed by
 * `data-squawk-id`, with autosave + state-change handlers wired in. Returns a
 * {@link RowHandle} so realtime can patch the row without rebuilding it.
 */
function buildSquawkRow(
  squawk: Squawk,
  listId: number,
  initials: string,
  model: Map<number, Squawk>,
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

  // Autosave: only PATCH when the text actually changed.
  let lastSaved = squawk.text;
  const save = debounce(() => {
    const text = input.value;
    if (text === lastSaved) {
      return;
    }
    // Update the saved-baseline only AFTER the PATCH succeeds. Setting it
    // before the await would make the `text === lastSaved` guard suppress every
    // retry on a failed save, silently dropping the user's edit on blur/idle.
    updateSquawk(squawk.id, { text }, initials)
      .then((updated) => {
        lastSaved = text;
        model.set(updated.id, updated);
      })
      .catch((err) => console.error("autosave failed", err));
  }, AUTOSAVE_IDLE_MS);

  input.addEventListener("input", () => save());
  input.addEventListener("blur", () => save.flush());
  input.addEventListener("keydown", (event) => {
    const decision = onEnter({
      key: event.key,
      isNewRow: false,
      value: input.value,
    });
    if (decision.action !== "commit") {
      return;
    }
    event.preventDefault();
    save.flush();
    focusNewSquawkInput(row);
  });

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
    applyState(row, state); // immediate visual feedback
    updateSquawk(squawk.id, { state }, initials)
      .then((updated) => model.set(updated.id, updated))
      .catch((err) => console.error("state update failed", err));
  });

  row.append(seq, input, select);

  return {
    el: row,
    setText: (text: string): void => {
      input.value = text;
      // Resync the autosave baseline: the remote value is now the saved value,
      // so a later focus+blur with no edit won't trigger a redundant PATCH.
      lastSaved = text;
    },
    setState: (state: SquawkState): void => {
      applyState(row, state);
      // Don't yank the dropdown selection out from under a viewer who currently
      // has it focused/open; the row's model already carries the remote state,
      // and their own next change is the last write (mirrors the focused-input
      // rule in realtime.ts). Recoloring the row is harmless, so it still runs.
      if (document.activeElement !== select) {
        select.value = state;
      }
    },
  };
}

/** Swap the row's state color class to `state` (surgical, no rebuild). */
function applyState(row: HTMLElement, state: SquawkState): void {
  row.classList.remove("state-open", "state-retired", "state-recorded");
  row.classList.add(stateClass(state));
}

/** Move focus to the new-squawk input in the same stack as `fromRow`. */
function focusNewSquawkInput(fromRow: HTMLElement): void {
  const input = fromRow.parentElement?.querySelector<HTMLInputElement>(
    ".squawk-row--new .squawk-row__text",
  );
  input?.focus();
}

/** Fallback render when the list cannot be loaded. */
function renderError(container: HTMLElement, listId: string): void {
  container.replaceChildren();
  const note = document.createElement("p");
  note.className = "mono";
  note.textContent = `Could not load list #${listId}.`;
  container.append(note);
}

// Self-register the renderer so the router resolves `#/list/:id` to this view.
registerView("detail", (container, params) => {
  void renderList(container, params.id ?? "");
});
