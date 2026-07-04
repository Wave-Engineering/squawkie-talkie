import type { Page } from "@playwright/test";

import { test, expect } from "./fixtures.ts";

/**
 * Lists-page onboarding coaching (#72, Epic #69).
 *
 * Drives the real coach-mark engine wired into `renderLists`: the first visit
 * to the lists page (per browser) fires a spotlight tour that anchors the
 * Welcome card + create input + mode bar + `?` when empty, and additionally the
 * first row when populated. The `?` overlay replays it; a set seen-flag
 * suppresses it; creating a list still auto-opens (#60).
 *
 * The e2e server keeps one in-memory DB for the whole run, so lists persist
 * across tests — each test wipes the slate first. localStorage (the seen-flag
 * store) is per-context, so it is naturally fresh each test unless preset.
 */

const SEEN_KEY = "st.coach.lists";

async function clearLists(page: Page): Promise<void> {
  const res = await page.request.get("/api/lists");
  const lists: Array<{ id: number }> = await res.json();
  for (const list of lists) {
    await page.request.delete(`/api/lists/${list.id}`);
  }
}

async function seedList(page: Page, name: string): Promise<void> {
  await page.request.post("/api/lists", { data: { name } });
}

/**
 * Assert the spotlight is anchored over `selector` — its centre falls inside
 * the spotlight rect. Reads the spotlight's *inline* top/left/width/height
 * (the engine sets these synchronously to the target's rect, before the callout
 * counter updates) rather than `boundingBox()`, which would return the position
 * mid-way through the 140ms CSS transition.
 */
async function expectSpotlightOn(page: Page, selector: string): Promise<void> {
  const geo = await page.evaluate((sel) => {
    const t = document.querySelector(sel);
    const s = document.querySelector<HTMLElement>(".coach-spotlight");
    if (!t || !s) return null;
    const r = t.getBoundingClientRect();
    const px = (v: string): number => Number.parseFloat(v || "NaN");
    return {
      cx: r.left + r.width / 2,
      cy: r.top + r.height / 2,
      sx: px(s.style.left),
      sy: px(s.style.top),
      sw: px(s.style.width),
      sh: px(s.style.height),
    };
  }, selector);
  expect(geo, `geometry for ${selector}`).not.toBeNull();
  expect(geo!.cx).toBeGreaterThanOrEqual(geo!.sx);
  expect(geo!.cx).toBeLessThanOrEqual(geo!.sx + geo!.sw);
  expect(geo!.cy).toBeGreaterThanOrEqual(geo!.sy);
  expect(geo!.cy).toBeLessThanOrEqual(geo!.sy + geo!.sh);
}

test.describe("Lists onboarding coach", () => {
  test("fresh + empty: tour anchors Welcome card, input, mode bar, and ?", async ({
    seededPage: page,
  }) => {
    await clearLists(page);
    await page.goto("/");

    const counter = page.locator(".coach-callout__counter");
    const body = page.locator(".coach-callout__body");

    // Tour auto-fires; the empty variant is four steps.
    await expect(page.locator(".coach-overlay")).toBeVisible();
    await expect(counter).toHaveText("1 / 4");

    // Step 1 — the Welcome / empty-state card.
    await expect(page.locator(".lists__empty")).toBeVisible();
    await expectSpotlightOn(page, ".lists__empty");

    // Step 2 — the create input.
    await page.keyboard.press("Enter");
    await expect(counter).toHaveText("2 / 4");
    await expect(body).toContainText("Name it, hit Enter. Done.");
    await expectSpotlightOn(page, ".lists__new-input");

    // Step 3 — the mode bar.
    await page.keyboard.press("Enter");
    await expect(counter).toHaveText("3 / 4");
    await expect(body).toContainText("Two modes");
    await expectSpotlightOn(page, ".lists__mode-bar");

    // Step 4 — the `?` help hint.
    await page.keyboard.press("Enter");
    await expect(counter).toHaveText("4 / 4");
    await expect(body).toContainText("cheat sheet");
    await expectSpotlightOn(page, ".lists__help-hint");

    // Done closes the tour and records the seen-flag.
    await page.keyboard.press("Enter");
    await expect(page.locator(".coach-overlay")).toHaveCount(0);
    const flag = await page.evaluate((k) => localStorage.getItem(k), SEEN_KEY);
    expect(flag).not.toBeNull();
  });

  test("fresh + populated: tour additionally anchors the first row", async ({
    seededPage: page,
  }) => {
    await clearLists(page);
    await seedList(page, "Alpha");
    await page.goto("/");
    await expect(page.locator(".list-row")).toHaveCount(1);

    const counter = page.locator(".coach-callout__counter");
    const body = page.locator(".coach-callout__body");

    // Populated variant is four steps: input, mode bar, `?`, then the row.
    await expect(page.locator(".coach-overlay")).toBeVisible();
    await expect(counter).toHaveText("1 / 4");
    await expectSpotlightOn(page, ".lists__new-input");

    await page.keyboard.press("Enter");
    await expect(counter).toHaveText("2 / 4");
    await expectSpotlightOn(page, ".lists__mode-bar");

    await page.keyboard.press("Enter");
    await expect(counter).toHaveText("3 / 4");
    await expectSpotlightOn(page, ".lists__help-hint");

    // The extra populated step: anchored to the first real row.
    await page.keyboard.press("Enter");
    await expect(counter).toHaveText("4 / 4");
    await expect(body).toContainText("Stay on the keys");
    await expectSpotlightOn(page, ".list-row");
  });

  test("a set seen-flag suppresses the tour", async ({ seededPage: page }) => {
    await clearLists(page);
    await page.addInitScript((k) => localStorage.setItem(k, "1"), SEEN_KEY);
    await page.goto("/");

    // Wait for the load to fully settle (empty card visible == getLists
    // resolved and runTour was reached), then assert nothing spotlit.
    await expect(page.locator(".lists__empty")).toBeVisible();
    await expect(page.locator(".coach-overlay")).toHaveCount(0);
  });

  test("? overlay replays the tour", async ({ seededPage: page }) => {
    await clearLists(page);
    await seedList(page, "Alpha");
    await page.addInitScript((k) => localStorage.setItem(k, "1"), SEEN_KEY);
    await page.goto("/");
    await expect(page.locator(".list-row")).toHaveCount(1);

    // Seen-flag set: no auto-tour.
    await expect(page.locator(".coach-overlay")).toHaveCount(0);

    // Open the `?` overlay and use its Replay affordance.
    await page.locator(".lists__help-hint").click();
    await expect(page.locator(".keymap-overlay")).toBeVisible();
    await page.locator(".keymap-overlay__replay").click();

    // The tour replays regardless of the seen-flag.
    await expect(page.locator(".coach-overlay")).toBeVisible();
    await expect(page.locator(".coach-callout__counter")).toHaveText("1 / 4");
    await expect(page.locator(".keymap-overlay")).toHaveCount(0);
  });

  test("does not fight #60 auto-open: creating a list still opens it", async ({
    seededPage: page,
  }) => {
    await clearLists(page);
    await page.goto("/");

    // The empty tour fires; dismiss it, then create a list the normal way.
    await expect(page.locator(".coach-overlay")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".coach-overlay")).toHaveCount(0);

    await page.fill(".lists__new-input", "Auto Opened");
    await page.press(".lists__new-input", "Enter");

    // #60: the freshly created list is auto-opened into the detail view.
    await expect(page).toHaveURL(/#\/list\/\d+$/);
    await expect(
      page.locator(".squawk-row--new .squawk-row__text"),
    ).toBeFocused();
  });
});
