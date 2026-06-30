import { test, expect, createList, addSquawk } from "./fixtures.ts";

test.describe("Vi-mode: edit mode lifecycle", () => {
  test("i enters edit mode, typing works, Esc saves and exits", async ({
    seededPage: page,
  }) => {
    await createList(page, "EditIEsc");
    await addSquawk(page, "original text");

    await page.keyboard.press("ArrowDown");
    const row = page.locator("[data-squawk-id]").first();
    const input = row.locator("input");

    await expect(row).toHaveClass(/squawk-row--nav-focus/);

    // Enter edit mode
    await page.keyboard.press("i");
    await expect(row).toHaveClass(/squawk-row--editing/);
    await expect(row).not.toHaveClass(/squawk-row--nav-focus/);

    // Type text
    await input.selectText();
    await page.keyboard.type("modified text");
    await expect(input).toHaveValue("modified text");

    // Esc exits edit → nav
    await page.keyboard.press("Escape");
    await expect(row).not.toHaveClass(/squawk-row--editing/);
    await expect(row).toHaveClass(/squawk-row--nav-focus/);

    // Verify save persisted (reload the page)
    await page.reload();
    await expect(page.locator("[data-squawk-id] input").first()).toHaveValue(
      "modified text",
    );
  });

  test("Enter also enters edit mode", async ({ seededPage: page }) => {
    await createList(page, "EditEnter");
    await addSquawk(page, "original text");

    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    const row = page.locator("[data-squawk-id]").first();
    await expect(row).toHaveClass(/squawk-row--editing/);
  });

  test("ArrowUp/ArrowDown exits edit + saves + moves", async ({
    seededPage: page,
  }) => {
    await createList(page, "EditArrow");
    await addSquawk(page, "first");
    await addSquawk(page, "second");

    await page.keyboard.press("ArrowDown"); // first row (second/newest)
    await page.keyboard.press("i");

    const input = page.locator("[data-squawk-id]").first().locator("input");
    await input.selectText();
    await page.keyboard.type("edited");

    // ArrowDown exits edit and moves
    await page.keyboard.press("ArrowDown");
    const secondRow = page.locator("[data-squawk-id]").nth(1);
    await expect(secondRow).toHaveClass(/squawk-row--nav-focus/);

    // First row's edit was saved
    await expect(page.locator("[data-squawk-id]").first().locator("input")).toHaveValue(
      "edited",
    );
  });
});
