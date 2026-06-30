import { test, expect, createList, addSquawk } from "./fixtures.ts";

test.describe("Vi-mode: ? keymap overlay", () => {
  test("? shows overlay, any key dismisses it", async ({
    seededPage: page,
  }) => {
    await createList(page, "HelpShow");
    await addSquawk(page, "helper");

    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("?");

    const overlay = page.locator(".keymap-overlay");
    await expect(overlay).toBeVisible();
    await expect(overlay.locator("text=dd")).toBeVisible();
    await expect(overlay.locator("text=yy")).toBeVisible();

    // Dismiss with a key
    await page.keyboard.press("x");
    await expect(overlay).not.toBeVisible();
  });

  test("click also dismisses the overlay", async ({ seededPage: page }) => {
    await createList(page, "HelpClick");
    await addSquawk(page, "helper");

    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("?");
    await expect(page.locator(".keymap-overlay")).toBeVisible();

    await page.click("body");
    await expect(page.locator(".keymap-overlay")).not.toBeVisible();
  });

  test("? hint button in corner also opens overlay", async ({
    seededPage: page,
  }) => {
    await createList(page, "HelpHint");
    await addSquawk(page, "helper");

    await page.click(".detail__help-hint");
    await expect(page.locator(".keymap-overlay")).toBeVisible();
  });
});
