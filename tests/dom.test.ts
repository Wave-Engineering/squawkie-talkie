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
  has_image: false,
  image_ids: [] as number[],
});

/** A list payload as `GET /api/lists/:id` returns it (squawks newest-first). */
function listPayload() {
  return {
    id: 1,
    name: "Regression",
    created_at: "2026-01-01T00:00:00.000Z",
    counts: { open: 2, confirmed: 0, rejected: 0, retired: 0, recorded: 0 },
    last_activity: "2026-01-01T00:00:00.000Z",
    squawks: [mkSquawk(10, 2), mkSquawk(11, 1)],
  };
}

/** A row of `GET /api/lists`, with its stats (#145). */
function mkListRow(
  id: number,
  name: string,
  counts: Partial<Record<"open" | "confirmed" | "rejected" | "retired" | "recorded", number>> = {},
  times: { created_at?: string; last_activity?: string } = {},
) {
  const created_at = times.created_at ?? "2026-01-01T00:00:00.000Z";
  return {
    id,
    name,
    created_at,
    counts: { open: 0, confirmed: 0, rejected: 0, retired: 0, recorded: 0, ...counts },
    last_activity: times.last_activity ?? created_at,
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
  // Returning user: the first-run coach tours (Epic #69, #72/#73) are already
  // seen, so no tour auto-fires and captures keys during these behavioural
  // tests. The dedicated lists-tour test below opts back out by clearing its
  // flag.
  try {
    localStorage.setItem("st.coach.detail", "1");
    localStorage.setItem("st.coach.lists", "1");
    localStorage.removeItem("sqtk.lastSeen"); // #145: each test starts unseen
  } catch {
    /* no localStorage in this environment — ignore */
  }
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

  // Starts as "open"; Right walks all five states in order and wraps (#137).
  expect(select10.value).toBe("open");
  for (const next of ["confirmed", "rejected", "retired", "recorded", "open"]) {
    press(input10, "ArrowRight");
    expect(select10.value).toBe(next);
    expect(row10.classList.contains(`state-${next}`)).toBe(true);
  }
  // Exactly one state class at a time — the old one is always removed.
  expect(
    [...row10.classList].filter((c) => c.startsWith("state-")),
  ).toEqual(["state-open"]);
  // Left → backward → recorded → retired
  press(input10, "ArrowLeft");
  expect(select10.value).toBe("recorded");
  press(input10, "ArrowLeft");
  expect(select10.value).toBe("retired");
});

// --- #137: every state shows its glyph -----------------------------------------

test("the state dropdown offers all five states, each with its glyph", async () => {
  const { renderList } = await import("../src/client/detail.ts");
  const container = document.createElement("div");
  document.body.append(container);
  await renderList(container, "1");

  const select = container.querySelector<HTMLSelectElement>(
    '[data-squawk-id="10"] select',
  )!;
  expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
    ["open", "○ open"],
    ["confirmed", "✓ confirmed"],
    ["rejected", "✗ rejected"],
    ["retired", "◌ retired"],
    ["recorded", "↗ recorded"],
  ]);
});

test("a remote change to each state shows that state's glyph and class on the row", async () => {
  const { renderList } = await import("../src/client/detail.ts");
  const { applyEvent, activeView } = await import("../src/client/realtime.ts");
  const container = document.createElement("div");
  document.body.append(container);
  await renderList(container, "1");

  const row = container.querySelector<HTMLElement>('[data-squawk-id="10"]')!;
  const select = row.querySelector<HTMLSelectElement>("select")!;
  const glyphs: Record<string, string> = {
    open: "○",
    confirmed: "✓",
    rejected: "✗",
    retired: "◌",
    recorded: "↗",
  };
  for (const [state, glyph] of Object.entries(glyphs)) {
    applyEvent(
      { type: "squawk.updated", squawk: mkSquawk(10, 2, state) },
      { view: activeView(), activeElement: null },
    );
    expect(select.value).toBe(state);
    // The shown (selected) option carries the glyph, so the row reads correctly
    // in monochrome; the class drives color + the closed-state strike-through.
    // (options[selectedIndex], not selectedOptions: happy-dom leaves the latter
    // stale after a programmatic `value` set.)
    expect(select.options[select.selectedIndex]!.textContent).toBe(
      `${glyph} ${state}`,
    );
    expect(row.classList.contains(`state-${state}`)).toBe(true);
  }
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

  // Any key other than the one that opened it dismisses — the dismiss
  // listeners attach synchronously, so no tick is needed here.
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

// --- Phase 2 / #137: glyph counts --------------------------------------------

test("the glyph counts render, omit zeros, and update live on a state change", async () => {
  const { renderList } = await import("../src/client/detail.ts");
  const { applyEvent, activeView } = await import("../src/client/realtime.ts");
  const container = document.createElement("div");
  document.body.append(container);
  await renderList(container, "1");

  const counts = container.querySelector<HTMLElement>(".detail__counts")!;
  const cells = () =>
    [...counts.querySelectorAll<HTMLElement>(".count")].map((c) => [
      c.className,
      c.textContent,
    ]);

  // both seeded squawks start open; every zero-count state is omitted
  expect(cells()).toEqual([["count count--open", "○2"]]);
  expect(counts.textContent).toBe("○2");

  applyEvent(
    { type: "squawk.updated", squawk: mkSquawk(10, 2, "confirmed") },
    { view: activeView(), activeElement: null },
  );
  expect(cells()).toEqual([
    ["count count--open", "○1"],
    ["count count--confirmed", "✓1"],
  ]);

  applyEvent(
    { type: "squawk.updated", squawk: mkSquawk(11, 1, "rejected") },
    { view: activeView(), activeElement: null },
  );
  // open dropped out at zero; the tallies stay in state order
  expect(cells()).toEqual([
    ["count count--confirmed", "✓1"],
    ["count count--rejected", "✗1"],
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
      ? JSON.stringify([mkListRow(7, "Sprint 7")])
      : JSON.stringify({ ...mkListRow(7, "Sprint 7"), squawks: [] });
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

// --- #146: wrapped text, clamped, tap to expand ------------------------------

test("an idle row shows its text in a display block, with the input riding along", async () => {
  const { renderList } = await import("../src/client/detail.ts");
  const container = document.createElement("div");
  document.body.append(container);
  await renderList(container, "1");

  const row10 = container.querySelector<HTMLElement>('[data-squawk-id="10"]')!;
  const display = row10.querySelector<HTMLElement>(".squawk-row__display")!;
  expect(display.textContent).toBe("squawk 2");
  expect(display.getAttribute("aria-hidden")).toBe("true");
  expect(row10.classList.contains("squawk-row--editing")).toBe(false);
  // The input is still the row's one field (focus, keys, autosave), but a tap
  // on it raises no soft keyboard outside edit mode.
  const input10 = row10.querySelector<HTMLInputElement>("input")!;
  expect(row10.querySelectorAll("input")).toHaveLength(1);
  expect(input10.value).toBe("squawk 2");
  expect(input10.inputMode).toBe("none");
});

test("edit mode brings the field; leaving it shows the edited text in the block", async () => {
  const { renderList } = await import("../src/client/detail.ts");
  const container = document.createElement("div");
  document.body.append(container);
  await renderList(container, "1");

  const newInput = container.querySelector<HTMLInputElement>(".squawk-row--new .squawk-row__text")!;
  const row10 = container.querySelector<HTMLElement>('[data-squawk-id="10"]')!;
  const input10 = row10.querySelector<HTMLInputElement>("input")!;
  const display = row10.querySelector<HTMLElement>(".squawk-row__display")!;

  newInput.focus();
  press(newInput, "ArrowDown");
  press(input10, "i");
  expect(row10.classList.contains("squawk-row--editing")).toBe(true);
  expect(input10.inputMode).toBe("text");

  input10.value = "squawk 2, edited";
  input10.dispatchEvent(new Event("input", { bubbles: true }));
  press(input10, "Escape");

  expect(row10.classList.contains("squawk-row--editing")).toBe(false);
  expect(display.textContent).toBe("squawk 2, edited");
  expect(input10.inputMode).toBe("none");
});

test("a click toggles the row's expansion, and does nothing while editing", async () => {
  const { renderList } = await import("../src/client/detail.ts");
  const container = document.createElement("div");
  document.body.append(container);
  await renderList(container, "1");

  const row11 = container.querySelector<HTMLElement>('[data-squawk-id="11"]')!;
  const input11 = row11.querySelector<HTMLInputElement>("input")!;
  input11.click();
  expect(row11.classList.contains("squawk-row--expanded")).toBe(true);
  input11.click();
  expect(row11.classList.contains("squawk-row--expanded")).toBe(false);

  row11.classList.add("squawk-row--editing");
  input11.click();
  expect(row11.classList.contains("squawk-row--expanded")).toBe(false);
});

test("a click on the nav-focused row leaves it unexpanded", async () => {
  const { renderList } = await import("../src/client/detail.ts");
  const container = document.createElement("div");
  document.body.append(container);
  await renderList(container, "1");

  const newInput = container.querySelector<HTMLInputElement>(".squawk-row--new .squawk-row__text")!;
  newInput.focus();
  press(newInput, "ArrowDown");
  const row10 = container.querySelector<HTMLElement>('[data-squawk-id="10"]')!;
  expect(row10.classList.contains("squawk-row--nav-focus")).toBe(true);
  row10.querySelector<HTMLInputElement>("input")!.click();
  expect(row10.classList.contains("squawk-row--expanded")).toBe(false);
});

test("a double-click edits the row, moving nav focus off another", async () => {
  const { renderList } = await import("../src/client/detail.ts");
  const container = document.createElement("div");
  document.body.append(container);
  await renderList(container, "1");

  const newInput = container.querySelector<HTMLInputElement>(".squawk-row--new .squawk-row__text")!;
  newInput.focus();
  press(newInput, "ArrowDown");
  const row10 = container.querySelector<HTMLElement>('[data-squawk-id="10"]')!;
  const row11 = container.querySelector<HTMLElement>('[data-squawk-id="11"]')!;
  const input11 = row11.querySelector<HTMLInputElement>("input")!;
  expect(row10.classList.contains("squawk-row--nav-focus")).toBe(true);

  input11.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  expect(row11.classList.contains("squawk-row--editing")).toBe(true);
  expect(row10.classList.contains("squawk-row--nav-focus")).toBe(false);
  expect(input11.inputMode).toBe("text");
  expect(document.activeElement).toBe(input11);
});

test("focus leaving the edited row ends the edit and its nav focus", async () => {
  const { renderList } = await import("../src/client/detail.ts");
  const container = document.createElement("div");
  document.body.append(container);
  await renderList(container, "1");

  const stack = container.querySelector<HTMLElement>(".detail__stack")!;
  const newInput = container.querySelector<HTMLInputElement>(".squawk-row--new .squawk-row__text")!;
  const row11 = container.querySelector<HTMLElement>('[data-squawk-id="11"]')!;
  const input11 = row11.querySelector<HTMLInputElement>("input")!;
  input11.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  expect(row11.classList.contains("squawk-row--editing")).toBe(true);

  // Within the row (the state select): still editing. Then out, from the select.
  row11.querySelector<HTMLSelectElement>("select")!.focus();
  expect(row11.classList.contains("squawk-row--editing")).toBe(true);
  newInput.focus();
  expect(row11.classList.contains("squawk-row--editing")).toBe(false);
  expect(row11.classList.contains("squawk-row--nav-focus")).toBe(false);
  expect(stack.classList.contains("detail__stack--has-edit")).toBe(false);
  expect(input11.inputMode).toBe("none");
});

test("a remote text update refreshes an unfocused row's display block", async () => {
  const { renderList } = await import("../src/client/detail.ts");
  const { applyEvent, activeView } = await import("../src/client/realtime.ts");
  const container = document.createElement("div");
  document.body.append(container);
  await renderList(container, "1");

  applyEvent(
    { type: "squawk.updated", squawk: { ...mkSquawk(11, 1), text: "remote text" } },
    { view: activeView(), activeElement: document.activeElement },
  );
  const display = container.querySelector<HTMLElement>(
    '[data-squawk-id="11"] .squawk-row__display',
  )!;
  expect(display.textContent).toBe("remote text");
});

// --- #145: list counts, settled strike, changed badge -------------------------

/** Let the lists page's initial `getLists()` resolve and render. */
const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test("each list row shows its non-zero counts, and a settled list is struck", async () => {
  const { renderLists } = await import("../src/client/lists.ts");
  stubLists([
    mkListRow(1, "Open work", { open: 2, retired: 1 }),
    mkListRow(2, "All settled", { confirmed: 1, recorded: 2 }),
    mkListRow(3, "Empty"),
  ]);
  const container = document.createElement("div");
  document.body.append(container);
  renderLists(container);
  await settle();

  const row = (id: number) => container.querySelector<HTMLElement>(`[data-list-id="${id}"]`)!;
  expect(row(1).querySelector(".list-row__counts")!.textContent).toBe("○2◌1");
  expect(row(2).querySelector(".list-row__counts")!.textContent).toBe("✓1↗2");
  expect(row(3).querySelector(".list-row__counts")!.textContent).toBe("");
  expect(row(1).classList.contains("list-row--settled")).toBe(false);
  expect(row(2).classList.contains("list-row--settled")).toBe(true);
  expect(row(3).classList.contains("list-row--settled")).toBe(false);
});

test("a list changed since it was last opened is badged; opening it clears the badge", async () => {
  const { renderLists } = await import("../src/client/lists.ts");
  const { renderList } = await import("../src/client/detail.ts");
  const later = "2026-01-02T00:00:00.000Z";
  // Seen before the payload's last_activity, so opening the list must move it.
  localStorage.setItem("sqtk.lastSeen", JSON.stringify({ "1": "2025-12-31T00:00:00.000Z" }));

  stubLists([mkListRow(1, "Regression", { open: 2 }, { last_activity: later })]);
  const before = document.createElement("div");
  document.body.append(before);
  renderLists(before);
  await settle();
  expect(before.querySelector<HTMLElement>(".list-row__changed")!.hidden).toBe(false);

  // Open it: the item page records the list's last_activity as seen.
  stubFetch();
  const detailEl = document.createElement("div");
  document.body.append(detailEl);
  await renderList(detailEl, "1");
  expect(JSON.parse(localStorage.getItem("sqtk.lastSeen")!)["1"]).toBe(
    listPayload().last_activity,
  );

  // The list's own last_activity is now what was seen: no badge.
  stubLists([mkListRow(1, "Regression", { open: 2 }, { last_activity: listPayload().last_activity })]);
  const after = document.createElement("div");
  document.body.append(after);
  renderLists(after);
  await settle();
  expect(after.querySelector<HTMLElement>(".list-row__changed")!.hidden).toBe(true);
});

test("the item page marks rows changed since the last open and counts them", async () => {
  const { renderList } = await import("../src/client/detail.ts");
  // Row 10 changed after the stored value; row 11 didn't.
  const payload = listPayload();
  payload.squawks[0]!.updated_at = "2026-01-03T00:00:00.000Z";
  payload.last_activity = "2026-01-03T00:00:00.000Z";
  localStorage.setItem("sqtk.lastSeen", JSON.stringify({ "1": "2026-01-02T00:00:00.000Z" }));
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

  const container = document.createElement("div");
  document.body.append(container);
  await renderList(container, "1");

  const row = (id: number) => container.querySelector<HTMLElement>(`[data-squawk-id="${id}"]`)!;
  expect(row(10).classList.contains("squawk-row--changed")).toBe(true);
  expect(row(11).classList.contains("squawk-row--changed")).toBe(false);
  expect(container.querySelector(".detail__changed")!.textContent).toBe("●1 changed");
  expect(JSON.parse(localStorage.getItem("sqtk.lastSeen")!)["1"]).toBe(payload.last_activity);
});

test("the reader's own edit is recorded as seen, with no event needed", async () => {
  const { renderList } = await import("../src/client/detail.ts");
  const edited = "2026-01-05T00:00:00.000Z";
  globalThis.fetch = (async (_url: string, init?: RequestInit) =>
    new Response(
      JSON.stringify(
        init?.method === "PATCH" ? { ...mkSquawk(10, 2), state: "retired", updated_at: edited } : listPayload(),
      ),
      { headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;

  const container = document.createElement("div");
  document.body.append(container);
  await renderList(container, "1");
  expect(JSON.parse(localStorage.getItem("sqtk.lastSeen")!)["1"]).toBe(listPayload().last_activity);

  const select = container.querySelector<HTMLSelectElement>('[data-squawk-id="10"] select')!;
  select.value = "retired";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  // Only the PATCH response moved it: no squawk.updated event was applied.
  expect(JSON.parse(localStorage.getItem("sqtk.lastSeen")!)["1"]).toBe(edited);
});

test("with localStorage throwing, both pages render with no badge and no error", async () => {
  const { renderLists } = await import("../src/client/lists.ts");
  const { renderList } = await import("../src/client/detail.ts");
  const errors: unknown[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  // Storage blocked outright, as in a sandboxed frame: touching it throws.
  const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    get() {
      throw new Error("SecurityError: storage is blocked");
    },
  });
  try {
    stubLists([mkListRow(1, "Regression", { open: 2 }, { last_activity: "2026-01-02T00:00:00.000Z" })]);
    const lists = document.createElement("div");
    document.body.append(lists);
    renderLists(lists);
    await settle();
    expect(lists.querySelector(".list-row__counts")!.textContent).toBe("○2");
    expect(lists.querySelector<HTMLElement>(".list-row__changed")!.hidden).toBe(true);

    stubFetch();
    const detailEl = document.createElement("div");
    document.body.append(detailEl);
    await renderList(detailEl, "1");
    expect(detailEl.querySelectorAll("[data-squawk-id]")).toHaveLength(2);
    expect(detailEl.querySelector<HTMLElement>(".detail__changed")!.hidden).toBe(true);
    expect(detailEl.querySelectorAll(".squawk-row--changed")).toHaveLength(0);
  } finally {
    if (descriptor) Object.defineProperty(window, "localStorage", descriptor);
    else delete (window as { localStorage?: Storage }).localStorage;
    // Unreadable seen-flags read as unseen, so the lists tour ran: end it.
    const { endActiveTour } = await import("../src/client/coachmarks.ts");
    endActiveTour();
    console.error = origError;
  }
  expect(errors).toEqual([]);
});

test("a squawk event on the lists page refreshes counts, strike and badge in place", async () => {
  const { renderLists } = await import("../src/client/lists.ts");
  const { applyEvent, activeView } = await import("../src/client/realtime.ts");
  localStorage.setItem("sqtk.lastSeen", JSON.stringify({ "1": "2026-01-01T00:00:00.000Z" }));
  stubLists([mkListRow(1, "Regression", { retired: 1 })]);
  const container = document.createElement("div");
  document.body.append(container);
  renderLists(container);
  await settle();
  const row = container.querySelector<HTMLElement>('[data-list-id="1"]')!;
  expect(row.classList.contains("list-row--settled")).toBe(true);
  expect(row.querySelector<HTMLElement>(".list-row__changed")!.hidden).toBe(true);

  // Another viewer adds a squawk: the next fetch carries it.
  stubLists([
    mkListRow(1, "Regression", { open: 1, retired: 1 }, { last_activity: "2026-01-02T00:00:00.000Z" }),
  ]);
  applyEvent(
    { type: "squawk.created", squawk: { ...mkSquawk(12, 3), list_id: 1 } },
    { view: activeView(), activeElement: null },
  );
  await settle(200);
  expect(container.querySelector('[data-list-id="1"]')).toBe(row); // same element, patched
  expect(row.querySelector(".list-row__counts")!.textContent).toBe("○1◌1");
  expect(row.classList.contains("list-row--settled")).toBe(false);
  expect(row.querySelector<HTMLElement>(".list-row__changed")!.hidden).toBe(false);
});

// --- Onboarding coach tour (Epic #69, #72): seen-flag gate ------------------

/** Stub fetch so `GET /api/lists` returns the given rows (default: one list). */
function stubLists(lists: unknown[] = [mkListRow(7, "Sprint 7")]): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(lists), {
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

test("lists tour fires once on the first populated visit, then the seen-flag suppresses it", async () => {
  const { renderLists } = await import("../src/client/lists.ts");
  // Opt out of the beforeEach preset so this mount is a genuine first visit.
  localStorage.removeItem("st.coach.lists");
  stubLists();

  const c1 = document.createElement("div");
  document.body.append(c1);
  renderLists(c1);
  await new Promise((r) => setTimeout(r, 0)); // getLists() resolves -> rows + tour

  // The spotlight tour auto-fired against the populated page.
  expect(document.querySelector(".coach-overlay")).not.toBeNull();
  // Not yet recorded — the engine marks seen only on end.
  expect(localStorage.getItem("st.coach.lists")).toBeNull();

  // Esc ends the tour (engine's capture-phase listener is on `document`): the
  // overlay is torn down and the seen-flag is written.
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
  expect(document.querySelector(".coach-overlay")).toBeNull();
  expect(localStorage.getItem("st.coach.lists")).not.toBeNull();

  // A second mount is suppressed by the now-set flag.
  const c2 = document.createElement("div");
  document.body.append(c2);
  renderLists(c2);
  await new Promise((r) => setTimeout(r, 0));
  expect(document.querySelector(".coach-overlay")).toBeNull();
});

test("lists tour does not auto-fire on a zero-row board (no empty-state variant)", async () => {
  const { renderLists } = await import("../src/client/lists.ts");
  localStorage.removeItem("st.coach.lists");
  stubLists([]); // empty system

  const c = document.createElement("div");
  document.body.append(c);
  renderLists(c);
  await new Promise((r) => setTimeout(r, 0)); // getLists() resolves -> zero rows

  // Populated-only (AC#3): nothing spotlit, and the flag is untouched so a later
  // populated visit still coaches.
  expect(document.querySelector(".coach-overlay")).toBeNull();
  expect(localStorage.getItem("st.coach.lists")).toBeNull();
});
