import { test, expect, createList, addSquawk } from "./fixtures.ts";

test.describe("Vi-mode: autosave countdown", () => {
  test("amber warning appears at 15s idle, clears on keystroke", async ({
    seededPage: page,
  }) => {
    await page.clock.install();
    await createList(page, "AutosaveWarn");
    await addSquawk(page, "watch me");

    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("i");

    const row = page.locator("[data-squawk-id]").first();
    await expect(row).toHaveClass(/squawk-row--editing/);
    await expect(row).not.toHaveClass(/squawk-row--warn/);

    // Fast-forward 15s
    await page.clock.fastForward(15_000);
    await expect(row).toHaveClass(/squawk-row--warn/);

    // Type clears the warning
    await page.keyboard.type("x");
    await expect(row).not.toHaveClass(/squawk-row--warn/);
  });

  test("auto-exits edit mode after 30s idle", async ({
    seededPage: page,
  }) => {
    await page.clock.install();
    await createList(page, "AutosaveExit");
    await addSquawk(page, "watch me");

    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("i");

    const row = page.locator("[data-squawk-id]").first();
    await expect(row).toHaveClass(/squawk-row--editing/);

    // Fast-forward 30s
    await page.clock.fastForward(30_000);
    await expect(row).not.toHaveClass(/squawk-row--editing/);
    await expect(row).toHaveClass(/squawk-row--nav-focus/);
  });
});
