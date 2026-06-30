import { test, expect, createList, addSquawk } from "./fixtures.ts";

test.describe("Vi-mode: u (undo within settle-in window)", () => {
  test("u within settle-in window deletes squawk and returns text to entry", async ({
    seededPage: page,
  }) => {
    await createList(page, "UndoNow");
    await addSquawk(page, "undo me");
    await expect(page.locator("[data-squawk-id]")).toHaveCount(1);

    // Navigate to the new squawk immediately (within 30s)
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("u");

    // Row is gone
    await expect(page.locator("[data-squawk-id]")).toHaveCount(0);

    // Text is back in entry box
    const entry = page.locator(".squawk-row--new .squawk-row__text");
    await expect(entry).toHaveValue("undo me");
    await expect(entry).toBeFocused();
  });

  test("u after settle-in window (30s) does nothing", async ({
    seededPage: page,
  }) => {
    await page.clock.install();
    await createList(page, "UndoExpired");
    await addSquawk(page, "settled");
    await expect(page.locator("[data-squawk-id]")).toHaveCount(1);

    // Fast-forward past the settle-in window
    await page.clock.fastForward(31_000);

    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("u");

    // Row still there
    await expect(page.locator("[data-squawk-id]")).toHaveCount(1);
  });
});
