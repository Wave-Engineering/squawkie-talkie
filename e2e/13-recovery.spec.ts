import { test, expect, createList, addSquawk } from "./fixtures.ts";

test.describe("Responsiveness / recovery", () => {
  test("reload mid-edit loads clean, no stale state", async ({
    seededPage: page,
  }) => {
    await createList(page, "RecoverReload");
    await addSquawk(page, "before reload");

    // Enter edit mode
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("i");
    await page.keyboard.type(" extra");

    // Reload while editing
    await page.reload();

    // Page loads clean
    const entry = page.locator(".squawk-row--new .squawk-row__text");
    await expect(entry).toBeFocused();
    await expect(page.locator("[data-squawk-id]")).toHaveCount(1);
    // No editing classes
    await expect(page.locator(".squawk-row--editing")).toHaveCount(0);
    await expect(page.locator(".squawk-row--nav-focus")).toHaveCount(0);
  });

  test("no console errors on navigation away during edit", async ({
    seededPage: page,
  }) => {
    await createList(page, "RecoverNav");
    await addSquawk(page, "navigate away");

    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    // Enter edit
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("i");

    // Navigate away to home
    await page.goto("/");
    await page.waitForTimeout(500);

    expect(errors).toHaveLength(0);
  });
});
