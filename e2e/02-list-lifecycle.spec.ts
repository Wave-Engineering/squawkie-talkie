import { test, expect, createList } from "./fixtures.ts";

test.describe("List lifecycle", () => {
  test("create a list, navigate into it, back, delete", async ({
    seededPage: page,
  }) => {
    await page.goto("/");

    // Create — auto-navigates to detail view
    await page.fill(".lists__new-input", "E2E List");
    await page.click(".lists__new-button");
    await expect(page.locator(".detail__title")).toHaveText("E2E List");
    const entry = page.locator(".squawk-row--new .squawk-row__text");
    await expect(entry).toBeFocused();

    // Back to lists
    await page.goto("/");
    await expect(page.locator('.list-row__open:has-text("E2E List")')).toBeVisible();

    // Delete
    await page.click(
      '.list-row:has-text("E2E List") .list-row__delete',
    );
    await page.click(
      '.list-row:has-text("E2E List") .list-row__confirm',
    );
    await expect(page.locator('.list-row__open:has-text("E2E List")')).not.toBeVisible();
  });
});
