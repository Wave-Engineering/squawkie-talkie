import { test, expect, createList, addSquawk } from "./fixtures.ts";

test.describe("Vi-mode: dd and yy chords", () => {
  test("dd retires the focused squawk", async ({ seededPage: page }) => {
    await createList(page, "ChordDD");
    await addSquawk(page, "retire me");

    await page.keyboard.press("ArrowDown");
    const row = page.locator("[data-squawk-id]").first();
    await expect(row.locator("select")).toHaveValue("open");

    await page.keyboard.press("d");
    await page.keyboard.press("d");
    await expect(row.locator("select")).toHaveValue("retired");
    await expect(row).toHaveClass(/state-retired/);
  });

  test("yy records the focused squawk and copies text to clipboard", async ({
    seededPage: page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await createList(page, "ChordYY");
    await addSquawk(page, "record me");

    await page.keyboard.press("ArrowDown");
    const row = page.locator("[data-squawk-id]").first();
    await expect(row).toHaveClass(/squawk-row--nav-focus/);
    await expect(row.locator("select")).toHaveValue("open");

    await page.keyboard.press("y");
    await page.keyboard.press("y");
    await expect(row.locator("select")).toHaveValue("recorded");
    await expect(row).toHaveClass(/state-recorded/);

    // Verify clipboard
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toBe("record me");
  });

  test("single d without follow-up does nothing (chord timeout)", async ({
    seededPage: page,
  }) => {
    await createList(page, "ChordTimeout");
    await addSquawk(page, "stay open");

    await page.keyboard.press("ArrowDown");
    const row = page.locator("[data-squawk-id]").first();

    await page.keyboard.press("d");
    await page.waitForTimeout(600);
    await expect(row.locator("select")).toHaveValue("open");
  });
});
