import { test, expect, createList, addSquawk } from "./fixtures.ts";
import type { Locator, TestInfo } from "@playwright/test";

/**
 * #146: a squawk's text wraps, is clamped to 3 lines while idle with a cue when
 * text is hidden, and a click (a tap on a phone) expands it in place. Runs on
 * the desktop project and on the `mobile` (Pixel 7) project.
 */

// About 900 characters: more than 3 lines at any viewport these projects use.
const LONG = Array.from(
  { length: 15 },
  (_, i) => `Sentence ${i + 1} of a squawk an agent wrote a paragraph long`,
).join(". ");

/** How many lines of text the display block shows, from its own measurements. */
async function shownLines(display: Locator): Promise<number> {
  return display.evaluate((el) => {
    const s = getComputedStyle(el);
    const chrome =
      parseFloat(s.paddingTop) +
      parseFloat(s.paddingBottom) +
      parseFloat(s.borderTopWidth) +
      parseFloat(s.borderBottomWidth);
    return Math.round((el.getBoundingClientRect().height - chrome) / parseFloat(s.lineHeight));
  });
}

/** A click on desktop, a tap where the project has touch. */
async function press(target: Locator, testInfo: TestInfo): Promise<void> {
  if (testInfo.project.use.hasTouch) await target.tap();
  else await target.click();
}

test.describe("Wrapped squawk text (#146)", () => {
  test("a long squawk shows 3 lines and a cue; a tap shows all of it, a second clamps it", async ({
    seededPage: page,
  }, testInfo) => {
    await createList(page, "WrapExpand");
    await addSquawk(page, LONG);

    const row = page.locator("[data-squawk-id]").first();
    const display = row.locator(".squawk-row__display");
    const more = row.locator(".squawk-row__more");
    await expect(display).toHaveText(LONG);

    expect(await shownLines(display)).toBe(3);
    await expect(more).toBeVisible();

    await press(row.locator("input"), testInfo);
    await expect(row).toHaveClass(/squawk-row--expanded/);
    expect(await shownLines(display)).toBeGreaterThan(3);
    await expect(more).toBeHidden();

    await press(row.locator("input"), testInfo);
    await expect(row).not.toHaveClass(/squawk-row--expanded/);
    expect(await shownLines(display)).toBe(3);
    await expect(more).toBeVisible();
  });

  test("a squawk that fits shows no cue", async ({ seededPage: page }) => {
    await createList(page, "WrapShort");
    await addSquawk(page, "short and sweet");

    const row = page.locator("[data-squawk-id]").first();
    expect(await shownLines(row.locator(".squawk-row__display"))).toBe(1);
    await expect(row.locator(".squawk-row__more")).toBeHidden();
  });

  test("the nav-focused row shows its full text", async ({ seededPage: page }) => {
    await createList(page, "WrapNav");
    await addSquawk(page, LONG);

    const row = page.locator("[data-squawk-id]").first();
    const display = row.locator(".squawk-row__display");
    expect(await shownLines(display)).toBe(3);

    await page.keyboard.press("ArrowDown");
    await expect(row).toHaveClass(/squawk-row--nav-focus/);
    expect(await shownLines(display)).toBeGreaterThan(3);
    await expect(row.locator(".squawk-row__more")).toBeHidden();
  });

  test("a closed squawk's idle text is struck through", async ({ seededPage: page }) => {
    await createList(page, "WrapStrike");
    await addSquawk(page, "to be retired");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("d");
    await page.keyboard.press("d");
    const row = page.locator("[data-squawk-id]").first();
    await expect(row).toHaveClass(/state-retired/);

    // Idle again: back to the entry box.
    await page.keyboard.press("Escape");
    await expect(row).not.toHaveClass(/squawk-row--nav-focus/);
    const decoration = await row
      .locator(".squawk-row__display")
      .evaluate((el) => getComputedStyle(el).textDecorationLine);
    expect(decoration).toContain("line-through");
  });
});
