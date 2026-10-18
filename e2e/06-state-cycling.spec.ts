import { test, expect, createList, addSquawk } from "./fixtures.ts";

test.describe("Vi-mode: state cycling with arrows", () => {
  test("Right cycles forward, Left cycles backward, wraps", async ({
    seededPage: page,
  }) => {
    await createList(page, "StateCycle");
    await addSquawk(page, "cycle me");

    await page.keyboard.press("ArrowDown");
    const row = page.locator("[data-squawk-id]").first();
    const select = row.locator("select");

    // Starts open
    await expect(select).toHaveValue("open");
    await expect(row).toHaveClass(/state-open/);

    // Right walks all five in order (#137): confirmed → rejected → retired → recorded
    for (const state of ["confirmed", "rejected", "retired", "recorded"]) {
      await page.keyboard.press("ArrowRight");
      await expect(select).toHaveValue(state);
      await expect(row).toHaveClass(new RegExp(`state-${state}`));
    }

    // Right wraps → open
    await page.keyboard.press("ArrowRight");
    await expect(select).toHaveValue("open");

    // Left → recorded (backward wrap)
    await page.keyboard.press("ArrowLeft");
    await expect(select).toHaveValue("recorded");

    // Left → retired
    await page.keyboard.press("ArrowLeft");
    await expect(select).toHaveValue("retired");
  });
});
