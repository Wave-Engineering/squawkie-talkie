import { test, expect, type BrowserContext, type Page } from "@playwright/test";

/**
 * #145: the lists page shows each list's counts, strikes a settled list, and
 * badges a list that changed since this browser last opened it. Two viewers: A
 * writes, B reads the lists page. Both are returning users, so no coach tour
 * takes the keyboard.
 */
async function markCoachSeen(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    try {
      localStorage.setItem("st.coach.initials", "1");
      localStorage.setItem("st.coach.lists", "1");
      localStorage.setItem("st.coach.detail", "1");
    } catch {
      /* localStorage unavailable — ignore */
    }
  });
}

async function viewer(
  browser: import("@playwright/test").Browser,
  baseURL: string,
  initials: string,
): Promise<Page> {
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: "st_initials", value: initials, url: baseURL }]);
  await markCoachSeen(ctx);
  return ctx.newPage();
}

test("another viewer's squawk badges the list and bumps its open count", async ({
  browser,
  baseURL,
}) => {
  const pageA = await viewer(browser, baseURL!, "AA");
  const pageB = await viewer(browser, baseURL!, "BB");

  // A makes a list with one squawk.
  await pageA.goto("/");
  await pageA.fill(".lists__new-input", "BadgeList");
  await pageA.click(".lists__new-button");
  const entryA = pageA.locator(".squawk-row--new .squawk-row__text");
  await expect(entryA).toBeFocused();
  await entryA.fill("first");
  await entryA.press("Enter");
  await expect(pageA.locator("[data-squawk-id]")).toHaveCount(1);

  // B opens it (so it is seen), then returns to the lists page.
  await pageB.goto("/");
  await pageB.click('.list-row__open:has-text("BadgeList")');
  await expect(pageB.locator("[data-squawk-id]")).toHaveCount(1);
  await pageB.goto("/");
  const rowB = pageB.locator('.list-row:has(.list-row__open:has-text("BadgeList"))');
  await expect(rowB.locator(".list-row__counts")).toHaveText("○1");
  await expect(rowB.locator(".list-row__changed")).toBeHidden();
  // SSE has no replay: B's stream must be open before A writes.
  await expect(pageB.locator('.conn-status[data-state="online"]')).toBeVisible({ timeout: 5000 });

  // A adds another: B's row updates live, with no reload.
  await entryA.fill("second");
  await entryA.press("Enter");
  await expect(rowB.locator(".list-row__counts")).toHaveText("○2", { timeout: 5000 });
  await expect(rowB.locator(".list-row__changed")).toBeVisible();

  // The badge survives a reload, and opening the list clears it.
  await pageB.reload();
  await expect(rowB.locator(".list-row__changed")).toBeVisible();
  await rowB.locator(".list-row__open").click();
  await expect(pageB.locator(".detail__changed")).toHaveText("●1 changed");
  await expect(pageB.locator(".squawk-row--changed")).toHaveCount(1);
  await pageB.goto("/");
  await expect(rowB.locator(".list-row__changed")).toBeHidden();
  await expect(rowB).not.toHaveClass(/list-row--settled/);
  await expect(pageB.locator('.conn-status[data-state="online"]')).toBeVisible({ timeout: 5000 });

  // A retires both: B's row is struck through, live.
  await pageA.locator("[data-squawk-id]").first().locator("select").selectOption("retired");
  await pageA.locator("[data-squawk-id]").nth(1).locator("select").selectOption("retired");
  await expect(rowB).toHaveClass(/list-row--settled/, { timeout: 5000 });
  await expect(rowB.locator(".list-row__counts")).toHaveText("◌2");
});
