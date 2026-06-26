/**
 * Tiny hash router.
 *
 * Routes:
 *   #/           -> lists view
 *   #/list/:id   -> list-detail view
 *
 * The real view rendering lands in #7 (lists) and #8 (detail). Until then a
 * mounted view falls back to a stub renderer. #7/#8 wire their real renderers
 * in via `registerView`, so this module never has to import not-yet-existent
 * files (keeping typecheck and the bundler green in the meantime).
 */

export type ViewName = "lists" | "detail";
export type RouteParams = Record<string, string>;
export type ViewRenderer = (container: HTMLElement, params: RouteParams) => void;

const renderers: Partial<Record<ViewName, ViewRenderer>> = {};

/** Register the real renderer for a view (called by #7 / #8). */
export function registerView(view: ViewName, render: ViewRenderer): void {
  renderers[view] = render;
}

/** Resolve a location hash to a view + params. Pure; exported for testing. */
export function matchRoute(hash: string): { view: ViewName; params: RouteParams } {
  const path = hash.replace(/^#/, "") || "/";
  const listMatch = path.match(/^\/list\/([^/]+)$/);
  if (listMatch) {
    return { view: "detail", params: { id: decodeURIComponent(listMatch[1]) } };
  }
  return { view: "lists", params: {} };
}

/** Navigate to a hash path (e.g. `#/list/42` or `/list/42`). */
export function navigate(path: string): void {
  const hash = path.startsWith("#") ? path : `#${path}`;
  if (location.hash === hash) {
    render();
  } else {
    location.hash = hash;
  }
}

/** Render `view` (with `params`) into the `#view` container. */
export function mount(view: ViewName, params: RouteParams): void {
  const container = document.getElementById("view");
  if (!container) {
    return;
  }
  const renderer = renderers[view] ?? stubRenderer(view);
  container.replaceChildren();
  renderer(container, params);
}

function stubRenderer(view: ViewName): ViewRenderer {
  return (container, params) => {
    const note = document.createElement("p");
    note.className = "mono";
    note.textContent =
      view === "detail"
        ? `list-detail view (#${params.id}) - wired up in #8`
        : "lists view - wired up in #7";
    container.append(note);
  };
}

function render(): void {
  const { view, params } = matchRoute(location.hash);
  mount(view, params);
}

/** Begin reacting to hash changes and render the current route. */
export function startRouter(): void {
  window.addEventListener("hashchange", render);
  render();
}
