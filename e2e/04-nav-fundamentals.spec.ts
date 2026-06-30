import { test, expect, createList, addSquawk } from "./fixtures.ts";

test.describe("Vi-mode: nav fundamentals", () => {
  test("ArrowDown from entry enters nav, focuses first squawk with glow", async ({
    seededPage: page,
  }) => {
    await createList(page, "NavFocus");
    await addSquawk(page, "alpha");

    const entry = page.locator(".squawk-row--new .squawk-row__text");
    await expect(entry).toBeFocused();
    await page.keyboard.press("ArrowDown");

    const firstRow = page.locator("[data-squawk-id]").first();
    await expect(firstRow).toHaveClass(/squawk-row--nav-focus/);
  });

  test("j/k navigate through rows, stop at boundaries", async ({
    seededPage: page,
  }) => {
    await createList(page, "NavJK");
    await addSquawk(page, "alpha");
    await addSquawk(page, "beta");
    await addSquawk(page, "gamma");

    const entry = page.locator(".squawk-row--new .squawk-row__text");
    await page.keyboard.press("ArrowDown");

    const rows = page.locator("[data-squawk-id]");
    await expect(rows.nth(0)).toHaveClass(/squawk-row--nav-focus/);

    await page.keyboard.press("j");
    await expect(rows.nth(1)).toHaveClass(/squawk-row--nav-focus/);

    await page.keyboard.press("j");
    await expect(rows.nth(2)).toHaveClass(/squawk-row--nav-focus/);

    // At bottom — j is a no-op
    await page.keyboard.press("j");
    await expect(rows.nth(2)).toHaveClass(/squawk-row--nav-focus/);

    // k back up
    await page.keyboard.press("k");
    await expect(rows.nth(1)).toHaveClass(/squawk-row--nav-focus/);

    // k all the way to entry
    await page.keyboard.press("k");
    await page.keyboard.press("k");
    await expect(entry).toBeFocused();
  });

  test("Home jumps to entry from anywhere", async ({ seededPage: page }) => {
    await createList(page, "NavHome");
    await addSquawk(page, "alpha");
    await addSquawk(page, "beta");

    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("j");
    await page.keyboard.press("Home");

    const entry = page.locator(".squawk-row--new .squawk-row__text");
    await expect(entry).toBeFocused();
  });

  test("Esc in nav jumps to entry", async ({ seededPage: page }) => {
    await createList(page, "NavEsc");
    await addSquawk(page, "alpha");

    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");

    const entry = page.locator(".squawk-row--new .squawk-row__text");
    await expect(entry).toBeFocused();
  });
});
