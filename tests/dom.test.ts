/**
 * DOM integration tests for the list-detail view.
 *
 * The rest of the client suite tests pure helpers (debounce, onEnter,
 * shouldApplyToInput, …). This file exercises the *rendered DOM* end to end:
 * it mounts `renderList` against a happy-dom document with a stubbed fetch, then
 * drives realtime `applyEvent`s through the registered view to prove the
 * focused-element protection actually holds on real elements — the behaviour
 * that has no automated coverage at the pure-function level.
 *
 * happy-dom is registered/unregistered around this file only, so the server
 * tests keep Bun's native fetch/Request/Response.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(() => {
  GlobalRegistrator.unregister();
});

const mkSquawk = (id: number, seq: number, state = "open") => ({
  id,
  list_id: 1,
  seq,
  text: `squawk ${seq}`,
  state,
  initials: "BJ",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
});

/** A list payload as `GET /api/lists/:id` returns it (squawks newest-first). */
function listPayload() {
  return {
    id: 1,
    name: "Regression",
    created_at: "2026-01-01T00:00:00.000Z",
    squawks: [mkSquawk(10, 2), mkSquawk(11, 1)],
  };
}

/** Stub global fetch to return the list payload for `GET /api/lists/:id`. */
function stubFetch(): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(listPayload()), {
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

/** Dispatch a keydown for `key` on `el`. */
function press(el: HTMLElement, key: string): void {
  el.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
  );
}

beforeEach(() => {
  document.body.replaceChildren();
  document.cookie = "st_initials=QA"; // skip the initials prompt
  stubFetch();
});

test("renderList renders squawks newest-first with seq, input, and state select", async () => {
  const { renderList } = await import("../src/client/detail.ts");
  const container = document.createElement("div");
  document.body.append(container);

  await renderList(container, "1");

  const rows = container.querySelectorAll<HTMLElement>("[data-squawk-id]");
  expect(rows.length).toBe(2);
  // Newest (seq 2 / id 10) is on top.
  expect(rows[0]!.dataset.squawkId).toBe("10");
  expect(rows[1]!.dataset.squawkId).toBe("11");
  expect(rows[0]!.querySelector("input")!.value).toBe("squawk 2");
  expect(rows[0]!.querySelector("select")!.value).toBe("open");
});

test("a remote state update does NOT clobber a focused <select>, but recolors the row", async () => {
  const { renderList } = await import("../src/client/detail.ts");
  const { applyEvent, activeView } = await import("../src/client/realtime.ts");

  const container = document.createElement("div");
  document.body.append(container);
  await renderList(container, "1");

  const row10 = container.querySelector<HTMLElement>('[data-squawk-id="10"]')!;
  const select10 = row10.querySelector("select")!;
  select10.focus();
  expect(document.activeElement).toBe(select10);

  applyEvent(
    { type: "squawk.updated", squawk: mkSquawk(10, 2, "recorded") },
    { view: activeView(), activeElement: document.activeElement },
  );

  // Focused select's value is preserved (the viewer's own change is last write)…
  expect(select10.value).toBe("open");
  // …but the row still recolors to reflect the remote state.
  expect(row10.classList.contains("state-recorded")).toBe(true);
});

test("a remote state update DOES apply to a row whose select is not focused", async () => {
  const { renderList } = await import("../src/client/detail.ts");
  const { applyEvent, activeView } = await import("../src/client/realtime.ts");

  const container = document.createElement("div");
  document.body.append(container);
  await renderList(container, "1");

  // Focus row 10's select; the update targets row 11 (not focused).
  container.querySelector<HTMLSelectElement>('[data-squawk-id="10"] select')!.focus();

  applyEvent(
    { type: "squawk.updated", squawk: mkSquawk(11, 1, "retired") },
    { view: activeView(), activeElement: document.activeElement },
  );

  const select11 = container.querySelector<HTMLSelectElement>(
    '[data-squawk-id="11"] select',
  )!;
  expect(select11.value).toBe("retired");
});

test("a remote text update does NOT clobber the focused input, but updates other rows", async () => {
  const { renderList } = await import("../src/client/detail.ts");
  const { applyEvent, activeView } = await import("../src/client/realtime.ts");

  const container = document.createElement("div");
  document.body.append(container);
  await renderList(container, "1");

  const input10 = container.querySelector<HTMLInputElement>(
    '[data-squawk-id="10"] input',
  )!;
  input10.value = "i am mid-edit";
  input10.focus();

  // Remote text update to the focused squawk 10 — must not overwrite the input.
  applyEvent(
    { type: "squawk.updated", squawk: { ...mkSquawk(10, 2), text: "remote text" } },
    { view: activeView(), activeElement: document.activeElement },
  );
  expect(input10.value).toBe("i am mid-edit");

  // Remote text update to the unfocused squawk 11 — applies.
  applyEvent(
    { type: "squawk.updated", squawk: { ...mkSquawk(11, 1), text: "remote text" } },
    { view: activeView(), activeElement: document.activeElement },
  );
  const input11 = container.querySelector<HTMLInputElement>(
    '[data-squawk-id="11"] input',
  )!;
  expect(input11.value).toBe("remote text");
});

// --- Phase 2: keyboard interactions -----------------------------------------

test("Up/Down arrows navigate between the new box and squawk rows", async () => {
  const { renderList } = await import("../src/client/detail.ts");
  const container = document.createElement("div");
  document.body.append(container);
  await renderList(container, "1");

  const newInput = container.querySelector<HTMLInputElement>(
    ".squawk-row--new .squawk-row__text",
  )!;
  const input10 = container.querySelector<HTMLInputElement>(
    '[data-squawk-id="10"] input',
  )!;
  const input11 = container.querySelector<HTMLInputElement>(
    '[data-squawk-id="11"] input',
  )!;

  newInput.focus();
  press(newInput, "ArrowDown"); // into the stack (newest)
  expect(document.activeElement).toBe(input10);
  press(input10, "ArrowDown"); // older
  expect(document.activeElement).toBe(input11);
  press(input11, "ArrowDown"); // at the bottom — no-op
  expect(document.activeElement).toBe(input11);
  press(input11, "ArrowUp"); // back up
  expect(document.activeElement).toBe(input10);
  press(input10, "ArrowUp"); // back to the new box (top)
  expect(document.activeElement).toBe(newInput);
});

test("Escape in nav mode jumps focus to the entry box", async () => {
  const { renderList } = await import("../src/client/detail.ts");
  const container = document.createElement("div");
  document.body.append(container);
  await renderList(container, "1");

  const newInput = container.querySelector<HTMLInputElement>(
    ".squawk-row--new .squawk-row__text",
  )!;
  const input10 = container.querySelector<HTMLInputElement>(
    '[data-squawk-id="10"] input',
  )!;
  // Navigate into the stack first (so focusedSquawkId is set)
  newInput.focus();
  press(newInput, "ArrowDown");
  expect(document.activeElement).toBe(input10);
  // Now Escape in nav mode → jump to entry box
  press(input10, "Escape");
  expect(document.activeElement).toBe(newInput);
});

test("Escape on the new-squawk box clears it", async () => {
  const { renderList } = await import("../src/client/detail.ts");
  const container = document.createElement("div");
  document.body.append(container);
  await renderList(container, "1");

  const newInput = container.querySelector<HTMLInputElement>(
    ".squawk-row--new .squawk-row__text",
  )!;
  newInput.focus();
  newInput.value = "abandon me";
  press(newInput, "Escape");
  expect(newInput.value).toBe("");
});

// --- Vi-mode: j/k navigation -------------------------------------------------

test("j/k navigate between rows like ArrowDown/ArrowUp", async () => {
  const { renderList } = await import("../src/client/detail.ts");
  const container = document.createElement("div");
  document.body.append(container);
  await renderList(container, "1");

  const newInput = container.querySelector<HTMLInputElement>(
    ".squawk-row--new .squawk-row__text",
  )!;
  const input10 = container.querySelector<HTMLInputElement>(
    '[data-squawk-id="10"] input',
  )!;
  const input11 = container.querySelector<HTMLInputElement>(
    '[data-squawk-id="11"] input',
  )!;

  // Empty entry box → j navigates down
  newInput.focus();
  newInput.value = "";
  press(newInput, "j");
  expect(document.activeElement).toBe(input10);
  // k navigates up from a squawk row
  press(input10, "k");
  expect(document.activeElement).toBe(newInput);
  // Navigate back down with j (now on stack via ArrowDown)
  press(newInput, "ArrowDown");
  expect(document.activeElement).toBe(input10);
  press(input10, "j");
  expect(document.activeElement).toBe(input11);
});

// --- Vi-mode: state cycling with arrows in nav mode --------------------------

test("Left/Right arrows cycle squawk state in nav mode", async () => {
  const { renderList } = await import("../src/client/detail.ts");
  const container = document.createElement("div");
  document.body.append(container);
  await renderList(container, "1");

  // Navigate to first squawk
  const newInput = container.querySelector<HTMLInputElement>(
    ".squawk-row--new .squawk-row__text",
  )!;
  newInput.focus();
  press(newInput, "ArrowDown");

  const row10 = container.querySelector<HTMLElement>('[data-squawk-id="10"]')!;
  const select10 = row10.querySelector<HTMLSelectElement>("select")!;
  const input10 = row10.querySelector<HTMLInputElement>("input")!;

  // Starts as "open"
  expect(select10.value).toBe("open");
  // Right → forward → retired
  press(input10, "ArrowRight");
  expect(select10.value).toBe("retired");
  expect(row10.classList.contains("state-retired")).toBe(true);
  // Right → forward → recorded
  press(input10, "ArrowRight");
  expect(select10.value).toBe("recorded");
  // Left → backward → retired
  press(input10, "ArrowLeft");
  expect(select10.value).toBe("retired");
});

// --- Vi-mode: nav-focus visual class -----------------------------------------

test("navigated row gets squawk-row--nav-focus class", async () => {
  const { renderList } = await import("../src/client/detail.ts");
  const container = document.createElement("div");
  document.body.append(container);
  await renderList(container, "1");

  const newInput = container.querySelector<HTMLInputElement>(
    ".squawk-row--new .squawk-row__text",
  )!;
  const row10 = container.querySelector<HTMLElement>('[data-squawk-id="10"]')!;
  const row11 = container.querySelector<HTMLElement>('[data-squawk-id="11"]')!;

  newInput.focus();
  press(newInput, "ArrowDown");
  expect(row10.classList.contains("squawk-row--nav-focus")).toBe(true);
  expect(row11.classList.contains("squawk-row--nav-focus")).toBe(false);

  // Move down — previous loses focus class
  const input10 = row10.querySelector<HTMLInputElement>("input")!;
  press(input10, "ArrowDown");
  expect(row10.classList.contains("squawk-row--nav-focus")).toBe(false);
  expect(row11.classList.contains("squawk-row--nav-focus")).toBe(true);
});

// --- Vi-mode: Home key jumps to entry ----------------------------------------

test("Home key always jumps to the entry box", async () => {
  const { renderList } = await import("../src/client/detail.ts");
  const container = document.createElement("div");
  document.body.append(container);
  await renderList(container, "1");

  const newInput = container.querySelector<HTMLInputElement>(
    ".squawk-row--new .squawk-row__text",
  )!;
  const input10 = container.querySelector<HTMLInputElement>(
    '[data-squawk-id="10"] input',
  )!;

  newInput.focus();
  press(newInput, "ArrowDown");
  expect(document.activeElement).toBe(input10);
  press(input10, "Home");
  expect(document.activeElement).toBe(newInput);
});

// --- Vi-mode: ? keymap overlay -----------------------------------------------

test("? key shows the keymap overlay and any key dismisses it", async () => {
  const { renderList } = await import("../src/client/detail.ts");
  const container = document.createElement("div");
  document.body.append(container);
  await renderList(container, "1");

  const newInput = container.querySelector<HTMLInputElement>(
    ".squawk-row--new .squawk-row__text",
  )!;
  // Navigate to a squawk row so we're in nav mode on a row
  newInput.focus();
  press(newInput, "ArrowDown");

  const input10 = container.querySelector<HTMLInputElement>(
    '[data-squawk-id="10"] input',
  )!;
  press(input10, "?");
  // Overlay should be in the DOM
  expect(container.querySelector(".keymap-overlay")).not.toBeNull();

  // Dismiss with any key (use setTimeout 0 to match the implementation)
  await new Promise((r) => setTimeout(r, 0));
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "x", bubbles: true }),
  );
  expect(container.querySelector(".keymap-overlay")).toBeNull();
});

// --- Phase 2: hover recorder badge ------------------------------------------

test("each squawk row carries a recorder badge with the recorder's initials", async () => {
  const { renderList } = await import("../src/client/detail.ts");
  const container = document.createElement("div");
  document.body.append(container);
  await renderList(container, "1");

  const badge = container.querySelector<HTMLElement>(
    '[data-squawk-id="10"] .squawk-row__recorder',
  )!;
  expect(badge.textContent).toBe("BJ");
  expect(badge.getAttribute("aria-label")).toBe("recorded by BJ");
});

test("a remote update refreshes the recorder initials", async () => {
  const { renderList } = await import("../src/client/detail.ts");
  const { applyEvent, activeView } = await import("../src/client/realtime.ts");
  const container = document.createElement("div");
  document.body.append(container);
  await renderList(container, "1");

  applyEvent(
    { type: "squawk.updated", squawk: { ...mkSquawk(10, 2), initials: "ZZ" } },
    { view: activeView(), activeElement: null },
  );

  const badge = container.querySelector<HTMLElement>(
    '[data-squawk-id="10"] .squawk-row__recorder',
  )!;
  expect(badge.textContent).toBe("ZZ");
});

// --- Phase 2: (O│R│E) counts ------------------------------------------------

test("the (O│R│E) counts render and update live on a state change", async () => {
  const { renderList } = await import("../src/client/detail.ts");
  const { applyEvent, activeView } = await import("../src/client/realtime.ts");
  const container = document.createElement("div");
  document.body.append(container);
  await renderList(container, "1");

  const counts = container.querySelector<HTMLElement>(".detail__counts")!;
  const cell = (s: string) =>
    counts.querySelector<HTMLElement>(`.count--${s}`)!.textContent;

  // both seeded squawks start open
  expect([cell("open"), cell("retired"), cell("recorded")]).toEqual([
    "2",
    "0",
    "0",
  ]);

  applyEvent(
    { type: "squawk.updated", squawk: mkSquawk(10, 2, "recorded") },
    { view: activeView(), activeElement: null },
  );
  expect([cell("open"), cell("retired"), cell("recorded")]).toEqual([
    "1",
    "0",
    "1",
  ]);
});

// --- Phase 2: export list -> JSON -------------------------------------------

test("each list row has an Export button that downloads the list as JSON", async () => {
  const { renderLists } = await import("../src/client/lists.ts");

  const fetched: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    fetched.push(url);
    const body = url.endsWith("/api/lists")
      ? JSON.stringify([{ id: 7, name: "Sprint 7", created_at: "t" }])
      : JSON.stringify({ id: 7, name: "Sprint 7", created_at: "t", squawks: [] });
    return Promise.resolve(
      new Response(body, { headers: { "content-type": "application/json" } }),
    );
  }) as typeof fetch;

  // Stub the browser download plumbing so the test is deterministic.
  const urlApi = URL as unknown as {
    createObjectURL: (b: Blob) => string;
    revokeObjectURL: (u: string) => void;
  };
  const origCreate = urlApi.createObjectURL;
  const origRevoke = urlApi.revokeObjectURL;
  urlApi.createObjectURL = () => "blob:stub";
  urlApi.revokeObjectURL = () => {};
  const origClick = HTMLAnchorElement.prototype.click;
  let downloadName = "";
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement): void {
    downloadName = this.download;
  };

  try {
    const container = document.createElement("div");
    document.body.append(container);
    renderLists(container);
    await new Promise((r) => setTimeout(r, 0)); // getLists() resolves -> rows

    const exp = container.querySelector<HTMLButtonElement>(".list-row__export");
    expect(exp).not.toBeNull();

    exp!.click();
    await new Promise((r) => setTimeout(r, 0)); // exportList() resolves

    expect(fetched).toContain("/api/lists/7");
    expect(downloadName).toBe("squawk-sprint-7-7.json");
  } finally {
    urlApi.createObjectURL = origCreate;
    urlApi.revokeObjectURL = origRevoke;
    HTMLAnchorElement.prototype.click = origClick;
  }
});
