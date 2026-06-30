import { test, expect, createList, addSquawk } from "./fixtures.ts";

test.describe("Entry box basic flow", () => {
  test("type + Enter creates squawk, clears box, retains focus", async ({
    seededPage: page,
  }) => {
    await createList(page, "EntryCreate");
    const entry = page.locator(".squawk-row--new .squawk-row__text");
    await entry.fill("first squawk");
    await entry.press("Enter");

    // Row appears below
    const rows = page.locator("[data-squawk-id]");
    await expect(rows).toHaveCount(1);
    await expect(rows.first().locator("input")).toHaveValue("first squawk");

    // Entry box cleared + still focused
    await expect(entry).toHaveValue("");
    await expect(entry).toBeFocused();
  });

  test("empty Enter is a no-op", async ({ seededPage: page }) => {
    await createList(page, "EntryEmpty");
    const entry = page.locator(".squawk-row--new .squawk-row__text");
    await entry.press("Enter");
    await expect(page.locator("[data-squawk-id]")).toHaveCount(0);
  });

  test("rapid submits maintain correct order (newest on top)", async ({
    seededPage: page,
  }) => {
    await createList(page, "EntryOrder");
    await addSquawk(page, "one");
    await addSquawk(page, "two");
    await addSquawk(page, "three");

    const rows = page.locator("[data-squawk-id] input");
    await expect(rows.nth(0)).toHaveValue("three");
    await expect(rows.nth(1)).toHaveValue("two");
    await expect(rows.nth(2)).toHaveValue("one");
  });
});
