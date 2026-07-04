import { expect, test, type Page } from "@playwright/test";

/**
 * Detail-page coaching (Epic #69, Story #73).
 *
 * These specs use the *base* Playwright `page` (not `./fixtures.ts`, which
 * presets the seen-flags for a returning user) so the first-run tour actually
 * fires. The `st_initials` cookie is set manually to skip the initials gate,
 * and lists/squawks are seeded via the REST API so no coach path is required
 * to create them.
 */

const DETAIL_FLAG = "st.coach.detail";
const ENTRY_COPY = "Top box is always empty";
const STATE_COPY = "Open, retired, or recorded";

interface List {
  id: number;
}

async function clearLists(page: Page): Promise<void> {
  const res = await page.request.get("/api/lists");
  const lists: List[] = await res.json();
  for (const list of lists) {
    await page.request.delete(`/api/lists/${list.id}`);
  }
}

async function seedInitials(page: Page, baseURL: string): Promise<void> {
  await page.context().addCookies([
    { name: "st_initials", value: "E2E", url: baseURL },
  ]);
}

async function seedList(page: Page, name: string): Promise<number> {
  const res = await page.request.post("/api/lists", { data: { name } });
  const list: List = await res.json();
  return list.id;
}

test.describe("Detail-page coaching (progressive)", () => {
  test.beforeEach(async ({ page }) => {
    await clearLists(page);
  });

  test("fresh empty list: entry-box coach shows, no squawk step, no DB write", async ({
    page,
    baseURL,
  }) => {
    await seedInitials(page, baseURL!);
    const id = await seedList(page, "CoachEmpty");

    // Watch for any squawk-create POST the tour must never issue.
    let squawkPosts = 0;
    page.on("request", (req) => {
      if (
        req.method() === "POST" &&
        /\/api\/lists\/\d+\/squawks$/.test(req.url())
      ) {
        squawkPosts += 1;
      }
    });

    await page.goto(`/#/list/${id}`);

    const overlay = page.locator(".coach-overlay");
    await expect(overlay).toBeVisible();
    await expect(page.locator(".coach-callout__body")).toContainText(ENTRY_COPY);
    // On an empty list only the entry-box step is reachable.
    await expect(page.locator(".coach-callout__counter")).toHaveText("1 / 1");

    // No squawk row exists and nothing was written.
    await expect(page.locator("[data-squawk-id]")).toHaveCount(0);
    expect(squawkPosts).toBe(0);

    // Finishing the tour records the seen-flag.
    await page.keyboard.press("Enter");
    await expect(overlay).toHaveCount(0);
    const flag = await page.evaluate((k) => localStorage.getItem(k), DETAIL_FLAG);
    expect(flag).not.toBeNull();
  });

  test("fresh populated list: squawk-level steps anchor to the existing row", async ({
    page,
    baseURL,
  }) => {
    await seedInitials(page, baseURL!);
    const id = await seedList(page, "CoachFull");
    // Seed a teammate's squawk directly via the API — a pre-existing row.
    await page.request.post(`/api/lists/${id}/squawks`, {
      data: { text: "pre-existing squawk", initials: "TM" },
    });

    await page.goto(`/#/list/${id}`);

    await expect(page.locator(".coach-overlay")).toBeVisible();
    // Entry box + three squawk-level steps, all reachable immediately.
    await expect(page.locator(".coach-callout__counter")).toHaveText("1 / 4");
    await expect(page.locator(".coach-callout__body")).toContainText(ENTRY_COPY);
    await expect(page.locator("[data-squawk-id]")).toHaveCount(1);

    // Advancing lands on the state step, spotlighting the existing row.
    await page.keyboard.press("Enter");
    await expect(page.locator(".coach-callout__counter")).toHaveText("2 / 4");
    await expect(page.locator(".coach-callout__body")).toContainText(STATE_COPY);
  });

  test("empty list then first squawk: deferred state/counts steps fire against it", async ({
    page,
    baseURL,
  }) => {
    await seedInitials(page, baseURL!);
    const id = await seedList(page, "CoachDefer");

    await page.goto(`/#/list/${id}`);

    // Entry-box coach only; dismiss it.
    await expect(page.locator(".coach-callout__counter")).toHaveText("1 / 1");
    await page.keyboard.press("Escape");
    await expect(page.locator(".coach-overlay")).toHaveCount(0);

    // The user adds their first squawk through the entry box.
    const entry = page.locator(".squawk-row--new .squawk-row__text");
    await entry.fill("my first squawk");
    await entry.press("Enter");
    await expect(page.locator("[data-squawk-id]")).toHaveCount(1);

    // The deferred squawk-level tour now fires against that real row.
    await expect(page.locator(".coach-overlay")).toBeVisible();
    await expect(page.locator(".coach-callout__counter")).toHaveText("1 / 3");
    await expect(page.locator(".coach-callout__body")).toContainText(STATE_COPY);
  });

  test("seen-flag preset suppresses the tour; ? replays it", async ({
    page,
    baseURL,
  }) => {
    await seedInitials(page, baseURL!);
    const id = await seedList(page, "CoachSeen");
    await page.addInitScript(
      (k) => {
        try {
          localStorage.setItem(k, "1");
        } catch {
          /* ignore */
        }
      },
      DETAIL_FLAG,
    );

    await page.goto(`/#/list/${id}`);

    // No auto-tour; the entry box holds focus as usual.
    await expect(
      page.locator(".squawk-row--new .squawk-row__text"),
    ).toBeFocused();
    await expect(page.locator(".coach-overlay")).toHaveCount(0);

    // `?` from the entry box replays the coaching.
    await page.keyboard.press("?");
    await expect(page.locator(".coach-overlay")).toBeVisible();
    await expect(page.locator(".coach-callout__body")).toContainText(ENTRY_COPY);
  });
});
