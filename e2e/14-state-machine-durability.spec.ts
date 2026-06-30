import { test, expect, createList, addSquawk } from "./fixtures.ts";

test.describe("State machine durability — keyboard never dies", () => {
  test("mashing printable keys in nav mode does not insert text", async ({
    seededPage: page,
  }) => {
    await createList(page, "DurMash");
    await addSquawk(page, "durable one");
    await addSquawk(page, "durable two");

    await page.keyboard.press("ArrowDown");
    const firstRow = page.locator("[data-squawk-id]").first();
    await expect(firstRow).toHaveClass(/squawk-row--nav-focus/);

    const input = firstRow.locator("input");
    const original = await input.inputValue();

    // Mash random keys
    for (const key of "abcxyz1234!@#$".split("")) {
      await page.keyboard.press(key);
    }

    // Text unchanged
    await expect(input).toHaveValue(original);
    // Still in nav mode
    await expect(firstRow).toHaveClass(/squawk-row--nav-focus/);
  });

  test("rapid mode transitions never stall", async ({ seededPage: page }) => {
    await createList(page, "DurTransit");
    await addSquawk(page, "durable one");
    await addSquawk(page, "durable two");

    await page.keyboard.press("ArrowDown");

    // Rapid sequence: i, Esc, i, Esc, j, j, k, i, Esc
    await page.keyboard.press("i");
    await page.keyboard.press("Escape");
    await page.keyboard.press("i");
    await page.keyboard.press("Escape");
    await page.keyboard.press("j");
    await page.keyboard.press("j");
    await page.keyboard.press("k");
    await page.keyboard.press("i");
    await page.keyboard.press("Escape");

    // Keyboard still works — verify nav-focus is on exactly one row
    const anyFocused = page.locator(".squawk-row--nav-focus");
    await expect(anyFocused).toHaveCount(1);
  });

  test("interrupted chord (d then j) clears chord and navigates", async ({
    seededPage: page,
  }) => {
    await createList(page, "DurChord");
    await addSquawk(page, "stay open");
    await addSquawk(page, "target");

    await page.keyboard.press("ArrowDown");
    const row1 = page.locator("[data-squawk-id]").first();

    // Start a chord but interrupt with j
    await page.keyboard.press("d");
    await page.keyboard.press("j");

    // Original row NOT retired (chord was interrupted)
    await expect(row1.locator("select")).toHaveValue("open");
    // Focus moved to next row
    const row2 = page.locator("[data-squawk-id]").nth(1);
    await expect(row2).toHaveClass(/squawk-row--nav-focus/);
  });

  test("click into a row during nav restores keyboard functionality", async ({
    seededPage: page,
  }) => {
    await createList(page, "DurClick");
    await addSquawk(page, "row one");
    await addSquawk(page, "row two");

    await page.keyboard.press("ArrowDown");

    // Click a different row's input directly
    const secondInput = page.locator("[data-squawk-id]").nth(1).locator("input");
    await secondInput.click();

    // Now press Escape — should jump to entry
    await page.keyboard.press("Escape");
    const entry = page.locator(".squawk-row--new .squawk-row__text");
    await expect(entry).toBeFocused();

    // And ArrowDown still works
    await page.keyboard.press("ArrowDown");
    await expect(page.locator(".squawk-row--nav-focus")).toHaveCount(1);
  });

  test("Tab away and back — keyboard resumes after re-entering stack", async ({
    seededPage: page,
  }) => {
    await createList(page, "DurTab");
    await addSquawk(page, "row one");

    await page.keyboard.press("ArrowDown");

    // Tab out of the stack
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");

    // Click back into a squawk row
    const firstInput = page.locator("[data-squawk-id]").first().locator("input");
    await firstInput.click();

    // Keyboard should work — Escape to entry
    await page.keyboard.press("Escape");
    const entry = page.locator(".squawk-row--new .squawk-row__text");
    await expect(entry).toBeFocused();
  });
});
