import { test, expect } from "@playwright/test";

test.describe("Multi-viewer realtime", () => {
  test("squawk created by viewer A appears live in viewer B", async ({
    browser,
    baseURL,
  }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    await ctxA.addCookies([{ name: "st_initials", value: "AA", url: baseURL! }]);
    await ctxB.addCookies([{ name: "st_initials", value: "BB", url: baseURL! }]);

    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    // Create a list via A
    await pageA.goto("/");
    await pageA.fill(".lists__new-input", "RealtimeSync");
    await pageA.click(".lists__new-button");
    await pageA.click('.list-row__open:has-text("RealtimeSync")');

    // B navigates to the same list
    await pageB.goto("/");
    await pageB.click('.list-row__open:has-text("RealtimeSync")');

    // A creates a squawk
    const entryA = pageA.locator(".squawk-row--new .squawk-row__text");
    await entryA.fill("hello from A");
    await entryA.press("Enter");

    // B sees it live
    const rowB = pageB.locator("[data-squawk-id] input").first();
    await expect(rowB).toHaveValue("hello from A", { timeout: 5000 });

    await ctxA.close();
    await ctxB.close();
  });

  test("state change by B reflects in A", async ({ browser, baseURL }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    await ctxA.addCookies([{ name: "st_initials", value: "AA", url: baseURL! }]);
    await ctxB.addCookies([{ name: "st_initials", value: "BB", url: baseURL! }]);

    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    // A creates list + squawk
    await pageA.goto("/");
    await pageA.fill(".lists__new-input", "StateSync");
    await pageA.click(".lists__new-button");
    await pageA.click('.list-row__open:has-text("StateSync")');
    const entryA = pageA.locator(".squawk-row--new .squawk-row__text");
    await entryA.fill("sync me");
    await entryA.press("Enter");

    // B opens the same list
    await pageB.goto("/");
    await pageB.click('.list-row__open:has-text("StateSync")');
    await expect(pageB.locator("[data-squawk-id]")).toHaveCount(1);

    // B changes state via select
    const selectB = pageB.locator("[data-squawk-id] select").first();
    await selectB.selectOption("retired");

    // A sees the state change
    const rowA = pageA.locator("[data-squawk-id]").first();
    await expect(rowA).toHaveClass(/state-retired/, { timeout: 5000 });

    await ctxA.close();
    await ctxB.close();
  });

  test("remote update does NOT clobber a focused input", async ({
    browser,
    baseURL,
  }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    await ctxA.addCookies([{ name: "st_initials", value: "AA", url: baseURL! }]);
    await ctxB.addCookies([{ name: "st_initials", value: "BB", url: baseURL! }]);

    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    // A creates list + squawk
    await pageA.goto("/");
    await pageA.fill(".lists__new-input", "NoClobber");
    await pageA.click(".lists__new-button");
    await pageA.click('.list-row__open:has-text("NoClobber")');
    const entryA = pageA.locator(".squawk-row--new .squawk-row__text");
    await entryA.fill("editable");
    await entryA.press("Enter");

    // B opens, starts editing the squawk
    await pageB.goto("/");
    await pageB.click('.list-row__open:has-text("NoClobber")');
    await expect(pageB.locator("[data-squawk-id]")).toHaveCount(1);
    const inputB = pageB.locator("[data-squawk-id] input").first();
    // Enter edit mode via keyboard
    await pageB.keyboard.press("ArrowDown");
    await pageB.keyboard.press("i");
    // Clear and type new text
    await inputB.fill("B is typing");

    // A updates the same squawk text (triggering SSE to B)
    const inputA = pageA.locator("[data-squawk-id] input").first();
    await pageA.keyboard.press("ArrowDown");
    await pageA.keyboard.press("i");
    await inputA.fill("A overwrites");
    await pageA.keyboard.press("Escape"); // saves

    // Give SSE time to reach B
    await pageB.waitForTimeout(2000);

    // B's input should NOT have been clobbered (B has focus on it)
    await expect(inputB).toHaveValue("B is typing");

    await ctxA.close();
    await ctxB.close();
  });
});
