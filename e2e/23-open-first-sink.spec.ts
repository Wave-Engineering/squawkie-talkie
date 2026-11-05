import { test, expect, createList, addSquawk } from "./fixtures.ts";
import type { Browser, BrowserContext, Page } from "@playwright/test";

/** The squawk texts in display order, top to bottom. */
async function order(page: Page): Promise<string[]> {
  return page
    .locator("[data-squawk-id] .squawk-row__text")
    .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
}

/** The id of the squawk whose text is `text`. */
async function idOf(page: Page, text: string): Promise<string> {
  const id = await page
    .locator("[data-squawk-id]")
    .evaluateAll(
      (els, t) =>
        els.find((e) => (e.querySelector(".squawk-row__text") as HTMLInputElement).value === t)
          ?.getAttribute("data-squawk-id") ?? null,
      text,
    );
  if (id === null) throw new Error(`no squawk with text ${text}`);
  return id;
}

/** A row pinned by id: a positional locator would re-resolve to another row after a move. */
function byId(page: Page, id: string) {
  return page.locator(`[data-squawk-id="${id}"]`);
}

/** Each row's inline transform + transition, in display order. */
async function inlineMotion(page: Page): Promise<string[]> {
  return page
    .locator("[data-squawk-id]")
    .evaluateAll((els) =>
      els.map((e) => (e as HTMLElement).style.transform + (e as HTMLElement).style.transition),
    );
}

/** A second viewer on the same list, with the coaching tours already seen. */
async function openViewer(
  browser: Browser,
  baseURL: string,
  url: string,
): Promise<{ ctx: BrowserContext; viewer: Page }> {
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: "st_initials", value: "ZZ", url: baseURL }]);
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("st.coach.initials", "1");
      localStorage.setItem("st.coach.lists", "1");
      localStorage.setItem("st.coach.detail", "1");
    } catch {
      /* ignore */
    }
  });
  const viewer = await ctx.newPage();
  await viewer.goto(url);
  await expect.poll(() => order(viewer)).toEqual(["c", "b", "a"]);
  return { ctx, viewer };
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
    // No slide either: nothing was given an inline transform or transition.
    expect(await inlineMotion(page)).toEqual(["", "", ""]);
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

  test("of two neighbours that swap, the one whose state changed trembles", async ({
    seededPage: page,
  }) => {
    await seedThree(page, "SinkSwap");
    const rowA = byId(page, await idOf(page, "a"));
    const rowB = byId(page, await idOf(page, "b"));
    // Close b and a: c stays open on top, then b (newer) above a.
    await rowB.locator("select").selectOption("confirmed");
    await expect.poll(() => order(page), { timeout: 5000 }).toEqual(["c", "a", "b"]);
    await rowA.locator("select").selectOption("confirmed");
    await expect.poll(() => order(page), { timeout: 5000 }).toEqual(["c", "b", "a"]);
    await expect(rowA).not.toHaveClass(/squawk-row--tremble/);

    // Reopen a: the order wants c, a, b. Removing either b or a fixes [c, b, a], so
    // the row that trembles has to be the one that changed.
    await rowA.locator("select").selectOption("open");
    await expect(rowA).toHaveClass(/squawk-row--tremble/);
    await expect(rowB).not.toHaveClass(/squawk-row--tremble/);
    await expect.poll(() => order(page), { timeout: 5000 }).toEqual(["c", "a", "b"]);
  });

  test("the slide sets an inverse transform on the moved rows and clears it", async ({
    seededPage: page,
  }) => {
    await seedThree(page, "SinkFlip");
    const rowB = byId(page, await idOf(page, "b"));
    // Record whether any row ever carries an inline transform.
    await page.evaluate(() => {
      const w = window as unknown as { __flipSeen: boolean };
      w.__flipSeen = false;
      const stack = document.querySelector("[data-squawk-id]")!.parentElement!;
      new MutationObserver(() => {
        const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-squawk-id]"));
        if (rows.some((r) => r.style.transform !== "")) w.__flipSeen = true;
      }).observe(stack, { attributes: true, subtree: true, attributeFilter: ["style"] });
    });
    await rowB.locator("select").selectOption("confirmed");
    await expect.poll(() => order(page), { timeout: 5000 }).toEqual(["c", "a", "b"]);
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __flipSeen: boolean }).__flipSeen))
      .toBe(true);
    // And it lets go: no row keeps an inline transform or transition afterwards.
    await expect
      .poll(() => inlineMotion(page), { timeout: 3000 })
      .toEqual(["", "", ""]);
  });

  test("a row being edited waits for the edit to end, then moves", async ({
    seededPage: page,
    browser,
    baseURL,
  }) => {
    await seedThree(page, "SinkEdit");
    const idB = await idOf(page, "b");
    const rowB = byId(page, idB);
    // Enter edit mode on b by keyboard: entry -> c -> b, then i.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("i");
    await expect(rowB.locator(".squawk-row__text")).toHaveAttribute("data-vi-mode", "edit");

    const { ctx, viewer } = await openViewer(browser, baseURL!, page.url());
    await byId(viewer, idB).locator("select").selectOption("rejected");

    // Well past the 1s tremble, b is still where it was and has not trembled.
    await page.waitForTimeout(1600);
    expect(await order(page)).toEqual(["c", "b", "a"]);
    await expect(rowB).not.toHaveClass(/squawk-row--tremble/);

    // The edit ends: now it trembles and sinks.
    await page.keyboard.press("Escape");
    await expect(rowB).toHaveClass(/squawk-row--tremble/);
    await expect.poll(() => order(page), { timeout: 5000 }).toEqual(["c", "a", "b"]);
    await ctx.close();
  });

  test("the vi cursor stays on the same squawk after it moves", async ({
    seededPage: page,
    browser,
    baseURL,
  }) => {
    await seedThree(page, "SinkCursor");
    const idB = await idOf(page, "b");
    // Nav cursor on b (entry -> c -> b), not editing.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(page.locator(".squawk-row--nav-focus .squawk-row__text")).toHaveValue("b");

    const { ctx, viewer } = await openViewer(browser, baseURL!, page.url());
    await byId(viewer, idB).locator("select").selectOption("rejected");

    await expect.poll(() => order(page), { timeout: 5000 }).toEqual(["c", "a", "b"]);
    // Same squawk, still the cursor, still focused: b is now last.
    await expect(page.locator(".squawk-row--nav-focus")).toHaveCount(1);
    await expect(page.locator(".squawk-row--nav-focus .squawk-row__text")).toHaveValue("b");
    await expect(byId(page, idB).locator(".squawk-row__text")).toBeFocused();
    await ctx.close();
  });
});
