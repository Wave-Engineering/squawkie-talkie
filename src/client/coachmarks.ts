/**
 * Coach-mark engine (Story #70, Epic #69).
 *
 * A reusable, framework-free spotlight-tour primitive. It dims the whole
 * viewport except a target element's rect (a single `box-shadow` cutout — no
 * four-div gymnastics), floats a keyboard-drivable callout beside it, and owns
 * per-surface "seen" bookkeeping in `localStorage`. The three onboarding
 * surfaces (initials gate, lists page, detail page) each call `runTour` once
 * and wire `?` to `replayTour`; this module is deliberately import-free so it
 * has zero coupling to any of them.
 *
 * Design notes that are load-bearing:
 *  - Focus hygiene is explicit: we capture `document.activeElement` at start and
 *    restore it on teardown. A recent auto-focus regression (#62) is why this is
 *    not left to chance.
 *  - Resilience over spectacle: a step whose target has since vanished (e.g. an
 *    SSE mutation removed the row) is skipped, never spotlighted empty. The
 *    engine never throws into its caller.
 *  - Teardown is total: every DOM node and every document-level listener the
 *    tour added is removed when it ends, mirroring the `{ once: true }` dismiss
 *    pattern of the existing keymap overlay.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Where the callout sits relative to the spotlit target. `auto` flips to fit. */
export type CoachPlacement = "auto" | "top" | "bottom" | "left" | "right";

/** One stop on a tour: what to spotlight and what to say about it. */
export interface CoachStep {
  /** A CSS selector or a resolver; resolved fresh immediately before display. */
  target: string | (() => Element | null);
  /** Optional bold heading above the body copy. */
  title?: string;
  /** The callout prose (required — a step with nothing to say is not a step). */
  body: string;
  /** Preferred side; defaults to `auto`. */
  placement?: CoachPlacement;
}

/** Optional hooks for a tour run. */
export interface RunTourOptions {
  /** Invoked once when the tour ends (finished or skipped), after teardown. */
  onDone?: () => void;
}

// ---------------------------------------------------------------------------
// Seen-flag bookkeeping (localStorage)
// ---------------------------------------------------------------------------

const SEEN_PREFIX = "st.coach.";

function seenKey(surfaceKey: string): string {
  return `${SEEN_PREFIX}${surfaceKey}`;
}

/** True once a surface's tour has been finished or skipped on this device. */
export function hasSeen(surfaceKey: string): boolean {
  try {
    return localStorage.getItem(seenKey(surfaceKey)) !== null;
  } catch {
    // localStorage can throw (private mode, disabled). Treat as "not seen"
    // rather than crashing the surface that asked.
    return false;
  }
}

/** Record that a surface's tour has been seen; idempotent. */
export function markSeen(surfaceKey: string): void {
  try {
    localStorage.setItem(seenKey(surfaceKey), "1");
  } catch {
    // Best-effort; a failed write just means the tour may show again later.
  }
}

// ---------------------------------------------------------------------------
// Tour engine
// ---------------------------------------------------------------------------

const SPOTLIGHT_PAD = 6; // px of breathing room around the target rect
const CALLOUT_GAP = 12; // px between the spotlight and the callout

/**
 * Show `steps` for `surfaceKey` only if it has not been seen yet. On any
 * end-state (finish or skip) the surface is marked seen.
 */
export function runTour(
  surfaceKey: string,
  steps: CoachStep[],
  opts?: RunTourOptions,
): void {
  if (hasSeen(surfaceKey)) return;
  startTour(surfaceKey, steps, opts);
}

/**
 * Run `steps` regardless of the seen-flag (the `?`/replay affordance). Still
 * marks the surface seen on end, so it does not resurface automatically.
 */
export function replayTour(
  surfaceKey: string,
  steps: CoachStep[],
  opts?: RunTourOptions,
): void {
  startTour(surfaceKey, steps, opts);
}

/** Is a tour currently on screen? Guards against double-starts. */
let activeTour: (() => void) | null = null;

/**
 * Immediately end whatever tour is on screen (no-op if none). A surface that is
 * unmounting calls this so its tour never outlives its anchors — e.g. the lists
 * page tearing down when the router navigates into a list. Idempotent: `end()`
 * guards against a second teardown.
 */
export function endActiveTour(): void {
  activeTour?.();
}

function startTour(
  surfaceKey: string,
  steps: CoachStep[],
  opts?: RunTourOptions,
): void {
  // Never stack tours; a second start is a no-op while one is live.
  if (activeTour) return;

  // Empty tour: nothing to show, but honour the contract (mark seen, notify).
  if (!steps || steps.length === 0) {
    markSeen(surfaceKey);
    opts?.onDone?.();
    return;
  }

  const previouslyFocused =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

  const overlay = document.createElement("div");
  overlay.className = "coach-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");

  const spotlight = document.createElement("div");
  spotlight.className = "coach-spotlight";

  const callout = document.createElement("div");
  callout.className = "coach-callout";

  overlay.append(spotlight, callout);
  document.body.append(overlay);

  let index = 0;
  let ended = false;

  function resolveTarget(step: CoachStep): Element | null {
    try {
      if (typeof step.target === "function") {
        return step.target();
      }
      return document.querySelector(step.target);
    } catch {
      // A bad selector or a throwing resolver must not take the tour down.
      return null;
    }
  }

  /** Advance to the next step that has a live target; end if none remain. */
  function render(): void {
    if (ended) return;

    // Skip forward over any steps whose target is currently absent.
    let step: CoachStep | undefined;
    let el: Element | null = null;
    while (index < steps.length) {
      step = steps[index];
      el = step ? resolveTarget(step) : null;
      if (el) break;
      index++;
    }

    if (index >= steps.length || !step || !el) {
      end(); // finished (or every remaining target vanished)
      return;
    }

    try {
      el.scrollIntoView({ block: "nearest" });
    } catch {
      // scrollIntoView is a no-op / absent in some test DOMs; ignore.
    }

    positionSpotlight(spotlight, el);
    paintCallout(callout, step, index + 1, steps.length);
    positionCallout(callout, el, step.placement ?? "auto");
  }

  function next(): void {
    index++;
    render();
  }

  function end(): void {
    if (ended) return;
    ended = true;
    activeTour = null;
    document.removeEventListener("keydown", onKeydown, true);
    window.removeEventListener("resize", onReflow);
    window.removeEventListener("scroll", onReflow, true);
    overlay.remove();
    markSeen(surfaceKey);
    // Restore focus only if the origin element is still in the document.
    if (previouslyFocused && previouslyFocused.isConnected) {
      try {
        previouslyFocused.focus();
      } catch {
        /* element became unfocusable; nothing to do */
      }
    }
    opts?.onDone?.();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" || event.key === "ArrowRight") {
      event.preventDefault();
      event.stopPropagation();
      next();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      end();
    }
  }

  function onReflow(): void {
    // Re-anchor to the current step's target on viewport changes.
    const step = steps[index];
    if (!step) return;
    const el = resolveTarget(step);
    if (!el) {
      render(); // target vanished during scroll/resize — re-evaluate.
      return;
    }
    positionSpotlight(spotlight, el);
    positionCallout(callout, el, step.placement ?? "auto");
  }

  // Buttons drive the same transitions as the keyboard.
  callout.addEventListener("click", (event) => {
    const btn = (event.target as Element | null)?.closest?.(
      "[data-coach-action]",
    );
    if (!btn) return;
    const action = btn.getAttribute("data-coach-action");
    if (action === "next") next();
    else if (action === "skip") end();
  });

  // Listen in the capture phase so the tour's keys win over surface handlers.
  document.addEventListener("keydown", onKeydown, true);
  window.addEventListener("resize", onReflow);
  window.addEventListener("scroll", onReflow, true);
  activeTour = end;

  render();
}

// ---------------------------------------------------------------------------
// Rendering / positioning helpers
// ---------------------------------------------------------------------------

function positionSpotlight(spotlight: HTMLElement, target: Element): void {
  const r = target.getBoundingClientRect();
  spotlight.style.top = `${r.top - SPOTLIGHT_PAD}px`;
  spotlight.style.left = `${r.left - SPOTLIGHT_PAD}px`;
  spotlight.style.width = `${r.width + SPOTLIGHT_PAD * 2}px`;
  spotlight.style.height = `${r.height + SPOTLIGHT_PAD * 2}px`;
}

function paintCallout(
  callout: HTMLElement,
  step: CoachStep,
  position: number,
  total: number,
): void {
  const title = step.title
    ? `<h3 class="coach-callout__title">${escapeHtml(step.title)}</h3>`
    : "";
  callout.innerHTML = `
    ${title}
    <p class="coach-callout__body">${escapeHtml(step.body)}</p>
    <div class="coach-callout__foot">
      <span class="coach-callout__counter mono">${position} / ${total}</span>
      <span class="coach-callout__actions">
        <button type="button" class="coach-btn coach-btn--skip" data-coach-action="skip">Skip</button>
        <button type="button" class="coach-btn coach-btn--next" data-coach-action="next">${
          position >= total ? "Done" : "Next"
        }</button>
      </span>
    </div>`;
}

/**
 * Place the callout beside the target, flipping to the opposite side when the
 * preferred side would overflow the viewport. Deliberately simple — this is a
 * hint card, not a tooltip library.
 */
function positionCallout(
  callout: HTMLElement,
  target: Element,
  placement: CoachPlacement,
): void {
  const r = target.getBoundingClientRect();
  const vw = window.innerWidth || 1024;
  const vh = window.innerHeight || 768;
  const cw = callout.offsetWidth || 280;
  const ch = callout.offsetHeight || 140;

  let side = placement;
  if (side === "auto") {
    // Prefer below, then above, then right, then left — whichever fits.
    if (r.bottom + CALLOUT_GAP + ch <= vh) side = "bottom";
    else if (r.top - CALLOUT_GAP - ch >= 0) side = "top";
    else if (r.right + CALLOUT_GAP + cw <= vw) side = "right";
    else side = "left";
  } else {
    // Honour the preference, but flip if it clearly would not fit.
    if (side === "bottom" && r.bottom + CALLOUT_GAP + ch > vh && r.top - CALLOUT_GAP - ch >= 0) side = "top";
    else if (side === "top" && r.top - CALLOUT_GAP - ch < 0 && r.bottom + CALLOUT_GAP + ch <= vh) side = "bottom";
    else if (side === "right" && r.right + CALLOUT_GAP + cw > vw && r.left - CALLOUT_GAP - cw >= 0) side = "left";
    else if (side === "left" && r.left - CALLOUT_GAP - cw < 0 && r.right + CALLOUT_GAP + cw <= vw) side = "right";
  }

  let top: number;
  let left: number;
  switch (side) {
    case "top":
      top = r.top - CALLOUT_GAP - ch;
      left = r.left + r.width / 2 - cw / 2;
      break;
    case "left":
      top = r.top + r.height / 2 - ch / 2;
      left = r.left - CALLOUT_GAP - cw;
      break;
    case "right":
      top = r.top + r.height / 2 - ch / 2;
      left = r.right + CALLOUT_GAP;
      break;
    case "bottom":
    default:
      top = r.bottom + CALLOUT_GAP;
      left = r.left + r.width / 2 - cw / 2;
      break;
  }

  // Clamp into the viewport so the card is never partly off-screen.
  top = clamp(top, CALLOUT_GAP, Math.max(CALLOUT_GAP, vh - ch - CALLOUT_GAP));
  left = clamp(left, CALLOUT_GAP, Math.max(CALLOUT_GAP, vw - cw - CALLOUT_GAP));

  callout.style.top = `${top}px`;
  callout.style.left = `${left}px`;
  callout.dataset.placement = side;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
