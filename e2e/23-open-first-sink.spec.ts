import { test, expect, createList, addSquawk } from "./fixtures.ts";
import type { Page } from "@playwright/test";

/** The squawk texts in display order, top to bottom. */
async function order(page: Page): Promise<string[]> {
  return page
    .locator("[data-squawk-id] .squawk-row__text")
    .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
}

/** A list with squawks "a", "b", "c" added in that order: newest first, so c, b, a. */
async function seedThree(page: Page, name: string): Promise<void> {
  await createList(page, name);
  for (const t of ["a", "b", "c"]) await addSquawk(page, t);
  await expect.poll(() => order(page)).toEqual(["c", "b", "a"]);
}

test.describe("Open first, tremble, then sink (#167)", () => {
  test("a squawk that leaves open trembles, sinks below the open ones, and rises back when reopened", async ({
    seededPage: page,
  }) => {
    await seedThree(page, "SinkOrder");
    // Pick the middle row (b) by position: c, b, a. Pin it by id: a positional
    // locator would re-resolve to whichever row is second after the sink.
    const id = await page.locator("[data-squawk-id]").nth(1).getAttribute("data-squawk-id");
    const middle = page.locator(`[data-squawk-id="${id}"]`);
    await middle.locator("select").selectOption("confirmed");

    // It trembles first, still in place...
    await expect(middle).toHaveClass(/squawk-row--tremble/);
    expect(await order(page)).toEqual(["c", "b", "a"]);

    // ...then it sinks below the remaining open rows, and the tremble ends.
    await expect.poll(() => order(page), { timeout: 5000 }).toEqual(["c", "a", "b"]);
    await expect(middle).not.toHaveClass(/squawk-row--tremble/);

    // Reopened, it rises back into the open group by seq: c, b, a.
    await middle.locator("select").selectOption("open");
    await expect.poll(() => order(page), { timeout: 5000 }).toEqual(["c", "b", "a"]);
  });

  test("with reduced motion the row moves with no tremble", async ({
    seededPage: page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await seedThree(page, "SinkReduced");
    const id = await page.locator("[data-squawk-id]").nth(1).getAttribute("data-squawk-id");
    const middle = page.locator(`[data-squawk-id="${id}"]`);
    await middle.locator("select").selectOption("retired");

    // Moves promptly (well inside the 1s tremble it would otherwise wait for).
    await expect.poll(() => order(page), { timeout: 800 }).toEqual(["c", "a", "b"]);
    await expect(middle).not.toHaveClass(/squawk-row--tremble/);
  });

  test("a state change in another viewer moves the row here too", async ({
    seededPage: page,
    browser,
    baseURL,
  }) => {
    await seedThree(page, "SinkRemote");
    const url = page.url();

    const other = await browser.newContext();
    await other.addCookies([{ name: "st_initials", value: "ZZ", url: baseURL! }]);
    await other.addInitScript(() => {
      try {
        localStorage.setItem("st.coach.initials", "1");
        localStorage.setItem("st.coach.lists", "1");
        localStorage.setItem("st.coach.detail", "1");
      } catch {
        /* ignore */
      }
    });
    const pageB = await other.newPage();
    await pageB.goto(url);
    await expect.poll(() => order(pageB)).toEqual(["c", "b", "a"]);

    // Viewer B rejects the middle row; viewer A sees it tremble, then sink.
    await pageB.locator("[data-squawk-id]").nth(1).locator("select").selectOption("rejected");
    const middleA = page.locator("[data-squawk-id]").nth(1);
    await expect(middleA).toHaveClass(/squawk-row--tremble/);
    await expect.poll(() => order(page), { timeout: 5000 }).toEqual(["c", "a", "b"]);
    await other.close();
  });

  test("lists show the most recently changed first", async ({ seededPage: page }) => {
    await createList(page, "RecentOld");
    await createList(page, "RecentNew");
    // RecentNew was created last, so it leads.
    await page.goto("/");
    await expect(page.locator("[data-list-id]").first()).toContainText("RecentNew");

    // A squawk on RecentOld makes it the most recently changed.
    await page.locator("[data-list-id]").filter({ hasText: "RecentOld" }).click();
    await expect(page.locator(".squawk-row--new .squawk-row__text")).toBeFocused();
    await addSquawk(page, "touch");
    await page.goto("/");
    await expect(page.locator("[data-list-id]").first()).toContainText("RecentOld");
  });
});
