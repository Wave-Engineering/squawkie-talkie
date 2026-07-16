/**
 * Modal image carousel for a squawk's photos (#127).
 *
 * Opened from a squawk row's thumbnail. Shows one image at a time with
 * prev/next controls, a dot strip, an "N / M" counter, and a per-image remove.
 * Keyboard: ←/→ flip, Esc closes; focus is trapped while open and restored on
 * close. The DOM lives directly under <body> so the row grid never reflows.
 *
 * The id list is a snapshot taken at open time plus this carousel's own removes;
 * a concurrent remote change (SSE) won't mutate an already-open carousel — the
 * row it was opened from resyncs via `onChange` after each remove and on next
 * reload. No top-level DOM access, so importing this module is side-effect-free.
 */

export interface CarouselOptions {
  squawkId: number;
  /** The squawk's human-facing seq, for aria labels. */
  seq: number;
  /** Ordered image ids to show (a snapshot). Opening with an empty list is a no-op. */
  imageIds: number[];
  /** Index to show first (clamped into range; default 0). */
  startIndex?: number;
  /** Build the served URL for one image id. */
  imageUrl: (imageId: number) => string;
  /** Remove one image server-side; resolve on success, reject to keep it shown. */
  onRemove: (imageId: number) => Promise<void>;
  /** Called after each successful remove with the surviving ids, for row resync. */
  onChange: (imageIds: number[]) => void;
}

/** The teardown of the currently-open carousel, if any (only one at a time). */
let activeClose: (() => void) | null = null;

export function openCarousel(opts: CarouselOptions): void {
  // Nothing to show — a true no-op that leaves any already-open carousel alone.
  if (opts.imageIds.length === 0) return;
  // Only one carousel at a time — tear down any existing before opening.
  activeClose?.();

  let ids = [...opts.imageIds];
  let index = Math.min(Math.max(opts.startIndex ?? 0, 0), ids.length - 1);
  const previouslyFocused = document.activeElement as HTMLElement | null;

  const backdrop = document.createElement("div");
  backdrop.className = "carousel-backdrop";

  const dialog = document.createElement("div");
  dialog.className = "carousel";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", `Photos on squawk ${opts.seq}`);

  const closeBtn = button("carousel__close", "×", "Close photo viewer");
  closeBtn.title = "Close";

  const stage = document.createElement("div");
  stage.className = "carousel__stage";
  const prevBtn = button("carousel__nav carousel__nav--prev", "‹", "Previous photo");
  prevBtn.title = "Previous photo";
  const img = document.createElement("img");
  img.className = "carousel__img";
  const nextBtn = button("carousel__nav carousel__nav--next", "›", "Next photo");
  nextBtn.title = "Next photo";
  stage.append(prevBtn, img, nextBtn);

  const footer = document.createElement("div");
  footer.className = "carousel__footer";
  const counter = document.createElement("span");
  counter.className = "carousel__counter mono";
  const dots = document.createElement("div");
  dots.className = "carousel__dots";
  const removeBtn = button("carousel__remove", "Remove", "Remove this photo");
  footer.append(counter, dots, removeBtn);

  dialog.append(closeBtn, stage, footer);
  backdrop.append(dialog);
  document.body.append(backdrop);

  function render(): void {
    if (ids.length === 0) {
      close();
      return;
    }
    if (index >= ids.length) index = ids.length - 1;
    img.src = opts.imageUrl(ids[index]!);
    img.alt = `Photo ${index + 1} of ${ids.length} on squawk ${opts.seq}`;
    counter.textContent = `${index + 1} / ${ids.length}`;

    // Nav + dots only make sense with more than one image.
    const many = ids.length > 1;
    prevBtn.hidden = !many;
    nextBtn.hidden = !many;
    dots.hidden = !many;
    prevBtn.disabled = index === 0;
    nextBtn.disabled = index === ids.length - 1;

    dots.replaceChildren();
    ids.forEach((_, i) => {
      const dot = button(
        `carousel__dot${i === index ? " carousel__dot--active" : ""}`,
        "",
        `Go to photo ${i + 1}`,
      );
      if (i === index) dot.setAttribute("aria-current", "true");
      dot.addEventListener("click", () => {
        index = i;
        render();
      });
      dots.append(dot);
    });
  }

  function go(delta: number): void {
    const next = index + delta;
    if (next < 0 || next >= ids.length) return;
    index = next;
    render();
  }

  function close(): void {
    if (activeClose !== close) return; // already closed
    document.removeEventListener("keydown", onKeydown, true);
    backdrop.remove();
    activeClose = null;
    previouslyFocused?.focus?.();
  }

  function trapTab(e: KeyboardEvent): void {
    const items = [...dialog.querySelectorAll<HTMLElement>("button")].filter(
      (el) => !el.hasAttribute("disabled") && !el.hidden,
    );
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement as HTMLElement | null;
    // Focus may have drifted onto a control that just became disabled/hidden
    // (e.g. the remove button mid-delete) and is no longer in the focusable set,
    // or outside the dialog entirely — pull it back in before it can Tab away.
    if (active && !items.includes(active)) {
      e.preventDefault();
      first.focus();
      return;
    }
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      go(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      go(1);
    } else if (e.key === "Tab") {
      trapTab(e);
    }
  }

  prevBtn.addEventListener("click", () => go(-1));
  nextBtn.addEventListener("click", () => go(1));
  closeBtn.addEventListener("click", () => close());
  // Click on the dimmed backdrop (but not the dialog) closes.
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });

  removeBtn.addEventListener("click", () => {
    const id = ids[index];
    if (id === undefined) return;
    removeBtn.disabled = true;
    opts
      .onRemove(id)
      .then(() => {
        ids = ids.filter((x) => x !== id);
        opts.onChange([...ids]);
        render(); // render() closes if the list is now empty
      })
      .catch((err) => console.error("image remove failed", err))
      .finally(() => {
        removeBtn.disabled = false;
      });
  });

  document.addEventListener("keydown", onKeydown, true);
  activeClose = close;
  render();
  closeBtn.focus(); // land focus inside the dialog so the trap + Esc engage
}

/** Small factory for the carousel's buttons (class + text + aria-label). */
function button(className: string, text: string, ariaLabel: string): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = className;
  el.textContent = text;
  el.setAttribute("aria-label", ariaLabel);
  return el;
}
