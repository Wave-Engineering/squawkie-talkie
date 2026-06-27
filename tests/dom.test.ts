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
