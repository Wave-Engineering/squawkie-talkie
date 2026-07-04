import type { Page } from "@playwright/test";

import { test, expect, createList } from "./fixtures.ts";

// The E2E server keeps one in-memory DB for the whole run, so lists persist
// across tests. Wipe the slate first so row counts and ordering are
// deterministic per test.
async function clearLists(page: Page): Promise<void> {
  const res = await page.request.get("/api/lists");
  const lists: Array<{ id: number }> = await res.json();
  for (const list of lists) {
    await page.request.delete(`/api/lists/${list.id}`);
  }
}

// Creating a list auto-opens it into the detail view (#60), so seed each list
// then return to the lists screen where the rows — and their vi-mode nav — live.
async function seedLists(page: Page, names: string[]): Promise<void> {
  await clearLists(page);
  for (const name of names) {
    await createList(page, name);
  }
  await page.goto("/");
  await expect(page.locator(".list-row")).toHaveCount(names.length);
  // The lists view auto-focuses the new-list input on mount, so the entry
  // gestures are live with no manual click. Assert it (also a focus barrier).
  await expect(page.locator(".lists__new-input")).toBeFocused();
}

test.describe("Vi-mode: lists-page nav", () => {
  test("fresh load auto-focuses the new-list input — nav works with no manual click", async ({
    seededPage: page,
  }) => {
    await clearLists(page);
    await createList(page, "Alpha");
    await page.goto("/");
    await expect(page.locator(".list-row")).toHaveCount(1);

    // On mount the input holds focus, so the mode bar is truthful and the
    // ArrowDown entry gesture fires without any prior interaction.
    await expect(page.locator(".lists__new-input")).toBeFocused();
    await expect(page.locator(".lists__mode-bar")).toHaveText("-- INSERT --");

    await page.keyboard.press("ArrowDown");
    await expect(page.locator(".list-row").first()).toHaveClass(
      /list-row--nav-focus/,
    );
    await expect(page.locator(".lists__mode-bar")).toHaveText("-- NAV --");
  });

  test("ArrowDown from input enters nav, focuses first row, mode bar -> NAV", async ({
    seededPage: page,
  }) => {
    await seedLists(page, ["Alpha"]);

    const bar = page.locator(".lists__mode-bar");
    await expect(bar).toHaveText("-- INSERT --");

    await page.keyboard.press("ArrowDown");

    await expect(page.locator(".list-row").first()).toHaveClass(
      /list-row--nav-focus/,
    );
    await expect(bar).toHaveText("-- NAV --");
  });

  test("j/k navigate through rows, stop at bottom, k off the top returns to input", async ({
    seededPage: page,
  }) => {
    await seedLists(page, ["Alpha", "Beta", "Gamma"]);
    const input = page.locator(".lists__new-input");
    const rows = page.locator(".list-row");

    await page.keyboard.press("ArrowDown");
    await expect(rows.nth(0)).toHaveClass(/list-row--nav-focus/);

    await page.keyboard.press("j");
    await expect(rows.nth(1)).toHaveClass(/list-row--nav-focus/);

    await page.keyboard.press("j");
    await expect(rows.nth(2)).toHaveClass(/list-row--nav-focus/);

    // At the bottom — j is a no-op.
    await page.keyboard.press("j");
    await expect(rows.nth(2)).toHaveClass(/list-row--nav-focus/);

    // k back up through the rows...
    await page.keyboard.press("k");
    await expect(rows.nth(1)).toHaveClass(/list-row--nav-focus/);
    await page.keyboard.press("k");
    await expect(rows.nth(0)).toHaveClass(/list-row--nav-focus/);

    // ...and k off the top row drops back to the input.
    await page.keyboard.press("k");
    await expect(input).toBeFocused();
  });

  test("Enter opens the focused list", async ({ seededPage: page }) => {
    await seedLists(page, ["Alpha", "Beta"]);

    await page.keyboard.press("ArrowDown");
    const firstRow = page.locator(".list-row").first();
    const listId = await firstRow.getAttribute("data-list-id");

    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(new RegExp(`#/list/${listId}$`));
    await expect(
      page.locator(".squawk-row--new .squawk-row__text"),
    ).toBeVisible();
  });

  test("dd arms the two-step delete confirm without deleting outright", async ({
    seededPage: page,
  }) => {
    await seedLists(page, ["Doomed", "Keeper"]);
    const rows = page.locator(".list-row");

    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("d");
    await page.keyboard.press("d");

    // Two-step confirm is preserved: the confirm control appears, nothing is
    // deleted yet, and the row count is unchanged.
    await expect(rows.first().locator(".list-row__confirm")).toBeVisible();
    await expect(rows).toHaveCount(2);
  });

  test("yy exports the focused list", async ({ seededPage: page }) => {
    await seedLists(page, ["Export Me"]);

    await page.keyboard.press("ArrowDown");

    const downloadPromise = page.waitForEvent("download");
    await page.keyboard.press("y");
    await page.keyboard.press("y");
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/^squawk-export-me-\d+\.json$/);
  });

  test("Esc from nav returns focus to the input and mode bar to INSERT", async ({
    seededPage: page,
  }) => {
    await seedLists(page, ["Alpha", "Beta"]);
    const input = page.locator(".lists__new-input");
    const bar = page.locator(".lists__mode-bar");

    await page.keyboard.press("ArrowDown");
    await expect(bar).toHaveText("-- NAV --");

    await page.keyboard.press("Escape");
    await expect(input).toBeFocused();
    await expect(bar).toHaveText("-- INSERT --");
  });

  test("single d without a follow-up is a no-op (chord timeout)", async ({
    seededPage: page,
  }) => {
    await seedLists(page, ["Sticky"]);
    const rows = page.locator(".list-row");

    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("d");
    await page.waitForTimeout(600);

    // No confirm control armed, list still present.
    await expect(rows.first().locator(".list-row__confirm")).toHaveCount(0);
    await expect(rows).toHaveCount(1);
  });
});
