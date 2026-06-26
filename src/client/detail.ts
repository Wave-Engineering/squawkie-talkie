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
 * NOTE: the `getList` / `createSquawk` / `updateSquawk` fetch helpers below are
 * intentionally local. The shared `src/client/api.ts` wrappers land with #7 in
 * the same wave; depending on that not-yet-merged module would couple the two
 * parallel flights. A Phase-2 cleanup should fold these into the shared module.
 */

import type { List, Squawk, SquawkState } from "../server/types.ts";
import { ensureInitials } from "./initials.ts";
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
// Data access (local fetch helpers — see module note above)
// ---------------------------------------------------------------------------

/** A list plus its squawks (newest first), as returned by `GET /api/lists/:id`. */
interface ListDetail extends List {
  squawks: Squawk[];
}

async function getList(id: number): Promise<ListDetail> {
  const res = await fetch(`/api/lists/${id}`);
  if (!res.ok) {
    throw new Error(`getList ${id}: ${res.status}`);
  }
  return (await res.json()) as ListDetail;
}

async function createSquawk(
  listId: number,
  text: string,
  initials: string,
): Promise<Squawk> {
  const res = await fetch(`/api/lists/${listId}/squawks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, initials }),
  });
  if (!res.ok) {
    throw new Error(`createSquawk: ${res.status}`);
  }
  return (await res.json()) as Squawk;
}

async function updateSquawk(
  id: number,
  patch: { text?: string; state?: SquawkState },
  initials: string,
): Promise<Squawk> {
  const res = await fetch(`/api/squawks/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...patch, initials }),
  });
  if (!res.ok) {
    throw new Error(`updateSquawk ${id}: ${res.status}`);
  }
  return (await res.json()) as Squawk;
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

  // Row 0: the always-empty new-squawk input.
  const newRow = buildNewRow();
  stack.append(newRow.el);

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
        model.set(created.id, created);
        const row = buildSquawkRow(created, id, initials, model);
        // Newest on top: insert directly beneath the new-squawk row.
        newRow.el.insertAdjacentElement("afterend", row);
        newRow.input.value = "";
        newRow.input.focus();
      })
      .catch((err) => console.error("createSquawk failed", err));
  });

  // Existing squawks arrive newest-first from the API; append in order.
  for (const squawk of detail.squawks) {
    model.set(squawk.id, squawk);
    stack.append(buildSquawkRow(squawk, id, initials, model));
  }

  container.append(title, stack);
  newRow.input.focus();
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
 * Build one existing-squawk row: `[seq] [text input] [state select]`, keyed by
 * `data-squawk-id`, with autosave + state-change handlers wired in.
 */
function buildSquawkRow(
  squawk: Squawk,
  listId: number,
  initials: string,
  model: Map<number, Squawk>,
): HTMLElement {
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
    lastSaved = text;
    updateSquawk(squawk.id, { text }, initials)
      .then((updated) => model.set(updated.id, updated))
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
  return row;
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
