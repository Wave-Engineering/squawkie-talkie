/**
 * Lists screen (Story 1.6 / #7).
 *
 * The landing view after the initials gate. Renders every Squawk List, lets the
 * viewer create a list (no full reload), open one (`#/list/:id`), and delete one
 * behind a two-step *inline* confirm — never `window.confirm`/`alert`, because
 * delete is the only irreversible multi-user action and deserves a deliberate,
 * non-modal-native gate.
 *
 * A small in-memory model (`model`) backs the rows so renders stay surgical:
 * create appends one row, delete removes one row, nothing else repaints. That
 * same model is the seam realtime patching plugs into in #9.
 */
import type { List } from "../server/types.ts";
import { createList, deleteList, getList, getLists } from "./api.ts";
import {
  type CoachStep,
  endActiveTour,
  replayTour,
  runTour,
} from "./coachmarks.ts";
import { setActiveView } from "./realtime.ts";
import { navigate } from "./router.ts";

// ---------------------------------------------------------------------------
// Export helpers
// ---------------------------------------------------------------------------

/** Safe download filename for a list export, e.g. `squawk-sprint-7-3.json`. */
export function exportFilename(name: string, id: number): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "list";
  return `squawk-${slug}-${id}.json`;
}

/** Trigger a browser download of `data` as a pretty-printed JSON file. */
function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** Fetch a list (with its squawks) and download it as a JSON file. */
async function exportList(list: List): Promise<void> {
  const detail = await getList(list.id);
  downloadJson(exportFilename(list.name, list.id), detail);
}

// ---------------------------------------------------------------------------
// Confirm-state reducer (pure; the oracle for a row's delete control)
// ---------------------------------------------------------------------------

/** A delete control is idle, awaiting confirmation, or mid-delete. */
export type DeleteState = "idle" | "confirming" | "deleting";

/** First click requests; then the viewer cancels or confirms. */
export type DeleteAction = "request" | "cancel" | "confirm";

/**
 * Drive a single delete control's lifecycle. Transitions only fire from their
 * legal source state, so stray actions (double clicks, cancel-while-idle) are
 * no-ops rather than glitches.
 */
export function deleteReducer(
  state: DeleteState,
  action: DeleteAction,
): DeleteState {
  switch (action) {
    case "request":
      return state === "idle" ? "confirming" : state;
    case "cancel":
      return state === "confirming" ? "idle" : state;
    case "confirm":
      return state === "confirming" ? "deleting" : state;
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

/** Render the Lists screen into `container`. Called by the router on `#/`. */
export function renderLists(container: HTMLElement): void {
  // Surgical-render model: the source of truth for which rows exist.
  const model: List[] = [];

  const heading = document.createElement("h2");
  heading.className = "lists__heading";
  heading.textContent = "Squawk Lists";

  const error = document.createElement("p");
  error.className = "lists__error";
  error.setAttribute("role", "alert");
  error.hidden = true;

  const rows = document.createElement("ul");
  rows.className = "lists__rows";

  // Welcome / empty-state card. Doubles as the onboarding coach anchor when
  // there are zero rows (#72), while keeping the "create above" affordance.
  const empty = document.createElement("div");
  empty.className = "lists__empty";
  empty.hidden = true;
  const emptyTitle = document.createElement("h3");
  emptyTitle.className = "lists__empty-title";
  emptyTitle.textContent = "Welcome to Squawkie-Talkie";
  const emptyText = document.createElement("p");
  emptyText.className = "lists__empty-text";
  emptyText.textContent =
    "No lists yet. Name one in the box above and hit Enter to hatch your first Squawk List.";
  empty.append(emptyTitle, emptyText);

  container.append(heading, buildNewListForm(), error, rows, empty);

  function showError(message: string): void {
    error.textContent = message;
    error.hidden = false;
  }

  function clearError(): void {
    error.hidden = true;
    error.textContent = "";
  }

  function syncEmpty(): void {
    empty.hidden = model.length > 0;
  }

  function addList(list: List): void {
    if (model.some((l) => l.id === list.id)) {
      return; // already shown — keep create idempotent (realtime + initial load)
    }
    model.push(list);
    rows.append(buildRow(list));
    syncEmpty();
  }

  function removeList(id: number, rowEl: HTMLElement): void {
    const index = model.findIndex((l) => l.id === id);
    if (index >= 0) {
      model.splice(index, 1);
    }
    rowEl.remove();
    syncEmpty();
    if (index >= 0) {
      adjustFocusAfterRemoval(index);
    }
  }

  function adjustFocusAfterRemoval(removedIndex: number): void {
    if (focusedIndex < 0) return;
    if (removedIndex < focusedIndex) {
      focusedIndex--;
    } else if (removedIndex === focusedIndex) {
      const rowEls = getRowEls();
      if (rowEls.length === 0) {
        exitToInput();
      } else if (focusedIndex >= model.length) {
        setNavFocus(model.length - 1);
      } else {
        setNavFocus(focusedIndex);
      }
    }
  }

  // --- new-list form -------------------------------------------------------

  function buildNewListForm(): HTMLFormElement {
    const form = document.createElement("form");
    form.className = "lists__new";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "lists__new-input";
    input.placeholder = "New list name";
    input.autocomplete = "off";
    input.setAttribute("aria-label", "New list name");

    const button = document.createElement("button");
    button.type = "submit";
    button.className = "lists__new-button";
    button.textContent = "Create";
    button.disabled = true;

    input.addEventListener("input", () => {
      button.disabled = input.value.trim().length === 0;
    });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = input.value.trim();
      if (!name) {
        return;
      }
      button.disabled = true;
      clearError();
      void createList(name)
        .then((created) => {
          addList(created);
          input.value = "";
          navigate(`#/list/${created.id}`);
        })
        .catch(() => {
          showError(`Could not create "${name}".`);
        })
        .finally(() => {
          button.disabled = input.value.trim().length === 0;
        });
    });

    form.append(input, button);
    return form;
  }

  // --- a single list row ---------------------------------------------------

  function buildRow(list: List): HTMLLIElement {
    const row = document.createElement("li");
    row.className = "list-row";
    row.dataset.listId = String(list.id);

    const open = document.createElement("button");
    open.type = "button";
    open.className = "list-row__open";
    open.textContent = list.name;
    open.addEventListener("click", () => navigate(`#/list/${list.id}`));

    const controls = document.createElement("div");
    controls.className = "list-row__controls";

    let state: DeleteState = "idle";

    function dispatch(action: DeleteAction): void {
      state = deleteReducer(state, action);
      paint();
    }

    function performDelete(): void {
      dispatch("confirm"); // -> deleting
      void deleteList(list.id)
        .then(() => {
          removeList(list.id, row);
        })
        .catch(() => {
          // Roll the control back so the viewer can retry or cancel.
          state = "confirming";
          paint();
          showError(`Could not delete "${list.name}".`);
        });
    }

    function paint(): void {
      controls.replaceChildren();

      if (state === "idle") {
        const exp = document.createElement("button");
        exp.type = "button";
        exp.className = "list-row__export";
        exp.textContent = "Export";
        exp.setAttribute("aria-label", `Export ${list.name}`);
        exp.addEventListener("click", () => {
          clearError();
          void exportList(list).catch(() =>
            showError(`Could not export "${list.name}".`),
          );
        });

        const del = document.createElement("button");
        del.type = "button";
        del.className = "list-row__delete";
        del.textContent = "Delete";
        del.setAttribute("aria-label", `Delete ${list.name}`);
        del.addEventListener("click", () => dispatch("request"));
        controls.append(exp, del);
        return;
      }

      if (state === "confirming") {
        const label = document.createElement("span");
        label.className = "list-row__confirm-label";
        label.textContent = `Delete "${list.name}"?`;

        const confirm = document.createElement("button");
        confirm.type = "button";
        confirm.className = "list-row__confirm";
        confirm.textContent = "confirm";
        confirm.addEventListener("click", performDelete);

        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "list-row__cancel";
        cancel.textContent = "cancel";
        cancel.addEventListener("click", () => dispatch("cancel"));

        controls.append(label, confirm, cancel);
        return;
      }

      // deleting
      const note = document.createElement("span");
      note.className = "list-row__deleting mono";
      note.textContent = "Deleting…";
      controls.append(note);
    }

    paint();
    row.append(open, controls);
    return row;
  }

  // --- Keyboard navigation (vim-style, matching detail view) ---------------

  type Mode = "insert" | "nav";
  let mode: Mode = "insert";
  let focusedIndex: number = -1;
  let chordPending: string | null = null;
  let chordTimer: ReturnType<typeof setTimeout> | null = null;
  let overlayEl: HTMLElement | null = null;

  const formInput = container.querySelector<HTMLInputElement>(".lists__new-input")!;

  function clearChord(): void {
    chordPending = null;
    if (chordTimer !== null) {
      clearTimeout(chordTimer);
      chordTimer = null;
    }
  }

  function getRowEls(): HTMLElement[] {
    return Array.from(rows.querySelectorAll<HTMLElement>(".list-row"));
  }

  function setNavFocus(index: number): void {
    const rowEls = getRowEls();
    if (focusedIndex >= 0 && focusedIndex < rowEls.length) {
      rowEls[focusedIndex]!.classList.remove("list-row--nav-focus");
    }
    focusedIndex = index;
    if (index >= 0 && index < rowEls.length) {
      const el = rowEls[index]!;
      el.setAttribute("tabindex", "-1");
      el.classList.add("list-row--nav-focus");
      el.focus();
      el.scrollIntoView({ block: "nearest" });
    }
    updateModeBar();
  }

  function enterNavMode(): void {
    const rowEls = getRowEls();
    if (rowEls.length === 0) return;
    mode = "nav";
    formInput.blur();
    setNavFocus(focusedIndex >= 0 ? focusedIndex : 0);
  }

  function exitToInput(): void {
    mode = "insert";
    clearChord();
    if (focusedIndex >= 0) {
      const rowEls = getRowEls();
      if (focusedIndex < rowEls.length) {
        rowEls[focusedIndex]!.classList.remove("list-row--nav-focus");
      }
    }
    focusedIndex = -1;
    formInput.focus();
    updateModeBar();
  }

  function handleNavKey(event: KeyboardEvent): void {
    const key = event.key;
    const rowEls = getRowEls();

    if (chordPending !== null) {
      if (key === chordPending && focusedIndex >= 0 && focusedIndex < rowEls.length) {
        event.preventDefault();
        const list = model[focusedIndex];
        clearChord();
        if (key === "d" && list) {
          const row = rowEls[focusedIndex]!;
          const deleteBtn = row.querySelector<HTMLButtonElement>(".list-row__delete");
          if (deleteBtn) deleteBtn.click();
        } else if (key === "y" && list) {
          clearError();
          void exportList(list).catch(() =>
            showError(`Could not export "${list.name}".`),
          );
        }
        return;
      }
      clearChord();
    }

    if (key === "j" || key === "ArrowDown") {
      event.preventDefault();
      if (focusedIndex < rowEls.length - 1) {
        setNavFocus(focusedIndex + 1);
      }
      return;
    }
    if (key === "k" || key === "ArrowUp") {
      event.preventDefault();
      if (focusedIndex <= 0) {
        exitToInput();
      } else {
        setNavFocus(focusedIndex - 1);
      }
      return;
    }
    if (key === "Enter" && focusedIndex >= 0) {
      event.preventDefault();
      const list = model[focusedIndex];
      if (list) navigate(`#/list/${list.id}`);
      return;
    }
    if (key === "Escape" || key === "Home") {
      event.preventDefault();
      exitToInput();
      return;
    }
    if (key === "?" && rowEls.length > 0) {
      event.preventDefault();
      showKeymapOverlay();
      return;
    }
    if ((key === "d" || key === "y") && focusedIndex >= 0) {
      event.preventDefault();
      chordPending = key;
      chordTimer = setTimeout(() => clearChord(), 500);
      return;
    }
  }

  // Input keyboard: arrow-down enters nav, ? shows help
  formInput.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "j") {
      if (event.key === "j" && formInput.value.length > 0) return;
      event.preventDefault();
      enterNavMode();
      return;
    }
    if (event.key === "?" && formInput.value.length === 0) {
      event.preventDefault();
      showKeymapOverlay();
      return;
    }
  });

  // Nav keydown on the rows list (capture phase). This listener is on the
  // persistent <ul>, not a per-row node, so it is torn down only when the
  // router calls container.replaceChildren() on unmount — not by paint().
  rows.addEventListener("keydown", (event) => {
    if (overlayEl) return;
    if (mode === "nav") handleNavKey(event);
  }, true);

  // Focus tracking for the mode bar. Also clears any lingering nav-focus when
  // the input is (re-)focused — e.g. clicked while a row is highlighted — so the
  // caret and the mode bar never disagree about where focus is.
  formInput.addEventListener("focus", () => {
    mode = "insert";
    clearChord();
    if (focusedIndex >= 0) {
      getRowEls()[focusedIndex]?.classList.remove("list-row--nav-focus");
      focusedIndex = -1;
    }
    updateModeBar();
  });

  // --- Mode bar (cyan variant for lists page) ---
  const modeBar = document.createElement("div");
  modeBar.className = "lists__mode-bar";
  modeBar.textContent = "-- INSERT --";

  function updateModeBar(): void {
    if (mode === "insert") {
      modeBar.textContent = "-- INSERT --";
      modeBar.dataset.mode = "insert";
    } else {
      modeBar.textContent = "-- NAV --";
      modeBar.dataset.mode = "nav";
    }
  }

  // --- Coach-mark tour (onboarding spotlight; #72) ---
  // Build the tour fresh each run so the row step is present exactly when rows
  // exist: an empty page anchors the Welcome card + input + mode bar + `?`; a
  // populated page anchors input + mode bar + `?` + the first row. Resolvers are
  // defensive — a target that has since vanished is skipped, never spotlit.
  const SURFACE = "lists";

  // A tour must never outlive this view. When the router navigates away (opening
  // or creating a list — #60 auto-open included), end any live tour so its dim +
  // capture-phase key handler do not linger on the next page. Self-removing so
  // each mount contributes exactly one listener, cleared when this view unmounts.
  function endTourOnLeave(): void {
    endActiveTour();
    window.removeEventListener("hashchange", endTourOnLeave);
  }
  window.addEventListener("hashchange", endTourOnLeave);

  function buildTourSteps(): CoachStep[] {
    const hasRows = getRowEls().length > 0;
    const steps: CoachStep[] = [];

    if (!hasRows) {
      steps.push({
        target: () => (empty.hidden ? null : empty),
        title: "Welcome to the roost",
        body: "This is where your Squawk Lists live — none yet. The box above is how you hatch the first. Squawkie-Talkie is keyboard-first; here's the ten-second tour.",
        placement: "bottom",
      });
    }

    steps.push({
      target: ".lists__new-input",
      title: "Create a list",
      body: "Name it, hit Enter. Done.",
      placement: "bottom",
    });
    steps.push({
      target: ".lists__mode-bar",
      title: "Two modes",
      body: "Two modes, like your editor: INSERT (typing) and NAV (flying through rows). The bar always tells you which. Yes, this is vim energy — no apologies.",
      placement: "top",
    });
    steps.push({
      target: ".lists__help-hint",
      title: "Your cheat sheet",
      body: "Your cheat sheet, one keystroke away. Learn five keys and outrun every mouse-clicker in the building.",
      placement: "auto",
    });

    if (hasRows) {
      steps.push({
        target: () => rows.querySelector(".list-row"),
        title: "Fly through your lists",
        body: "`j`/`k` to move, `Enter` to open, `dd` to delete (two-step), `yy` to export. Reaching for the mouse is a round-trip to spinning rust — death to efficiency. Stay on the keys.",
        placement: "auto",
      });
    }

    return steps;
  }

  // --- Keymap overlay ---
  function showKeymapOverlay(): void {
    if (overlayEl) return;
    overlayEl = document.createElement("div");
    overlayEl.className = "keymap-overlay";
    overlayEl.innerHTML = `
      <div class="keymap-overlay__content">
        <h3 class="keymap-overlay__title">Keyboard shortcuts</h3>
        <table class="keymap-overlay__table">
          <tr><td><kbd>j</kbd> / <kbd>↓</kbd></td><td>Move down</td></tr>
          <tr><td><kbd>k</kbd> / <kbd>↑</kbd></td><td>Move up</td></tr>
          <tr><td><kbd>Enter</kbd></td><td>Open list</td></tr>
          <tr><td><kbd>dd</kbd></td><td>Delete list</td></tr>
          <tr><td><kbd>yy</kbd></td><td>Export list</td></tr>
          <tr><td><kbd>Esc</kbd></td><td>Back to input</td></tr>
          <tr><td><kbd>Home</kbd></td><td>Back to input</td></tr>
          <tr><td><kbd>?</kbd></td><td>This help</td></tr>
        </table>
        <button type="button" class="keymap-overlay__replay">Replay the tour ▸</button>
        <p class="keymap-overlay__dismiss">Press any key or click to dismiss</p>
      </div>`;
    container.append(overlayEl);

    function dismiss(): void {
      overlayEl?.remove();
      overlayEl = null;
      document.removeEventListener("keydown", dismiss);
      document.removeEventListener("click", dismiss);
    }

    // Replay this surface's tour from the `?` overlay (ignores the seen-flag).
    // Stop propagation so the overlay's own dismiss-on-click does not also fire;
    // dismiss it explicitly, then hand off to the engine.
    const replayBtn = overlayEl.querySelector<HTMLButtonElement>(
      ".keymap-overlay__replay",
    );
    replayBtn?.addEventListener("click", (event) => {
      event.stopPropagation();
      dismiss();
      replayTour(SURFACE, buildTourSteps());
    });

    setTimeout(() => {
      document.addEventListener("keydown", dismiss, { once: true });
      document.addEventListener("click", dismiss, { once: true });
    }, 0);
  }

  // Help hint in the corner
  const helpHint = document.createElement("span");
  helpHint.className = "lists__help-hint mono";
  helpHint.textContent = "?";
  helpHint.title = "Keyboard shortcuts";
  helpHint.addEventListener("click", showKeymapOverlay);

  container.append(helpHint, modeBar);

  // --- realtime seam (#9) --------------------------------------------------
  // Register this mount as the active realtime sink: a list created or deleted
  // by another viewer is applied live to these same rows. Both ops are
  // idempotent (addList de-dupes; removeList no-ops on a missing row).
  setActiveView({
    kind: "lists",
    upsertList: (list) => addList(list),
    removeList: (id) => {
      const row = rows.querySelector<HTMLElement>(`[data-list-id="${id}"]`);
      if (row) {
        removeList(id, row);
      }
    },
  });

  // --- initial load --------------------------------------------------------

  void getLists()
    .then((lists) => {
      for (const list of lists) {
        addList(list);
      }
      syncEmpty();
      // First visit to the lists page (per browser): run the onboarding tour.
      // `runTour` is a no-op once this surface has been seen, so the return trip
      // after #60 auto-opens a freshly created list does not re-fire it, and the
      // row step is present only when rows already exist at this point.
      runTour(SURFACE, buildTourSteps());
    })
    .catch(() => {
      showError("Could not load lists.");
    });

  // Land the caret in the entry box on mount (mirrors detail.ts's entry focus),
  // so the mode bar's INSERT state is real and the ArrowDown/j entry gestures
  // are live immediately — not dead keys until the user clicks the input.
  formInput.focus();
}
