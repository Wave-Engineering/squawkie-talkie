import { expect, test, type Page } from "@playwright/test";

/**
 * Lists-page onboarding coaching (#72, Epic #69).
 *
 * Drives the real coach-mark engine (#70) wired into `renderLists`. Because
 * #71's first-list gate forces a brand-new user to name their first list before
 * the app mounts, the lists page is never empty on first run — so this tour is
 * populated-only: it anchors the create input, the mode bar, `?`, and the
 * user's first real row. There is deliberately no empty-state variant (AC#3);
 * on an empty system the #71 gate — not a lists tour — is what the user meets.
 *
 * These specs use the *base* Playwright `page` (not `./fixtures.ts`, which
 * presets every seen-flag for a returning user) so the first-run tour actually
 * fires. Lists are seeded via the REST API; the `st_initials` cookie skips the
 * identity gate.
 *
 * The e2e server keeps one in-memory DB for the whole run, so lists persist
 * across tests — each test wipes the slate first. localStorage (the seen-flag
 * store) is per-context, so it is fresh each test unless preset.
 */

const LISTS_FLAG = "st.coach.lists";

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

/**
 * Assert the spotlight is anchored over `selector` — its centre falls inside
 * the spotlight rect. Reads the spotlight's *inline* top/left/width/height (the
 * engine sets these synchronously to the target's rect) rather than
 * `boundingBox()`, which would sample mid-way through the 140ms CSS transition.
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

test.describe("Lists-page onboarding coach (populated-only)", () => {
  test.beforeEach(async ({ page }) => {
    await clearLists(page);
    // Singleton-engine setup (load-bearing): #70's engine runs one tour per
    // render, so preset the *sibling* surfaces' seen-flags (initials #71,
    // detail #73) — the lists tour must be the sole contender, and the detail
    // preset also keeps the detail tour from firing when a test navigates into
    // a list. Clear the lists flag so this surface fires as a first-run visitor.
    // Registered before each test body, so a body's own `setItem(LISTS_FLAG)`
    // (the suppression/replay specs) runs afterwards and still wins.
    await page.addInitScript(() => {
      try {
        localStorage.setItem("st.coach.initials", "1");
        localStorage.setItem("st.coach.detail", "1");
        localStorage.removeItem("st.coach.lists");
      } catch {
        /* localStorage unavailable — the tour simply shows, which is fine here */
      }
    });
  });

  test("fresh + populated: tour anchors input, mode bar, ?, and the first row", async ({
    page,
    baseURL,
  }) => {
    await seedInitials(page, baseURL!);
    await seedList(page, "Alpha");
    await page.goto("/");
    await expect(page.locator(".list-row")).toHaveCount(1);

    const counter = page.locator(".coach-callout__counter");
    const body = page.locator(".coach-callout__body");

    // Auto-fires; the populated tour is exactly four steps.
    await expect(page.locator(".coach-overlay")).toBeVisible();
    await expect(counter).toHaveText("1 / 4");
    await expect(body).toContainText("Name it, hit Enter. Done.");
    await expectSpotlightOn(page, ".lists__new-input");

    // Step 2 — the mode bar.
    await page.keyboard.press("Enter");
    await expect(counter).toHaveText("2 / 4");
    await expect(body).toContainText("Two modes");
    await expect(body).toContainText("Esc"); // names the real switch keys
    await expectSpotlightOn(page, ".lists__mode-bar");

    // Step 3 — the `?` help hint.
    await page.keyboard.press("Enter");
    await expect(counter).toHaveText("3 / 4");
    await expect(body).toContainText("cheat sheet");
    await expectSpotlightOn(page, ".lists__help-hint");

    // Step 4 — the user's first real row, with the j/k / dd / yy copy.
    await page.keyboard.press("Enter");
    await expect(counter).toHaveText("4 / 4");
    await expect(body).toContainText("Stay on the keys");
    await expect(body).toContainText("disk access"); // BJ's house line
    await expect(body).toContainText("dd");
    await expect(body).toContainText("yy");
    await expectSpotlightOn(page, ".list-row");

    // Done closes the tour and records the seen-flag.
    await page.keyboard.press("Enter");
    await expect(page.locator(".coach-overlay")).toHaveCount(0);
    const flag = await page.evaluate((k) => localStorage.getItem(k), LISTS_FLAG);
    expect(flag).not.toBeNull();
  });

  test("no empty-state variant: an empty system shows the #71 gate, not a lists tour", async ({
    page,
    baseURL,
  }) => {
    await seedInitials(page, baseURL!);
    // No list seeded: an empty instance. #71's first-list gate intercepts before
    // the lists view mounts, so the empty lists page is unreachable and the
    // lists tour never contends there.
    await page.goto("/");

    await expect(page.locator(".first-list-gate")).toBeVisible();
    await expect(page.locator(".coach-overlay")).toHaveCount(0);
    const flag = await page.evaluate((k) => localStorage.getItem(k), LISTS_FLAG);
    expect(flag).toBeNull();
  });

  test("a set seen-flag suppresses the tour", async ({ page, baseURL }) => {
    await seedInitials(page, baseURL!);
    await seedList(page, "Alpha");
    await page.addInitScript((k) => localStorage.setItem(k, "1"), LISTS_FLAG);
    await page.goto("/");
    await expect(page.locator(".list-row")).toHaveCount(1);

    // Populated page, but the flag is set: no auto-tour.
    await expect(page.locator(".coach-overlay")).toHaveCount(0);
  });

  test("? overlay replays the tour", async ({ page, baseURL }) => {
    await seedInitials(page, baseURL!);
    await seedList(page, "Alpha");
    await page.addInitScript((k) => localStorage.setItem(k, "1"), LISTS_FLAG);
    await page.goto("/");
    await expect(page.locator(".list-row")).toHaveCount(1);

    // Seen-flag set: no auto-tour.
    await expect(page.locator(".coach-overlay")).toHaveCount(0);

    // Open the `?` overlay and use its Replay affordance.
    await page.locator(".lists__help-hint").click();
    await expect(page.locator(".keymap-overlay")).toBeVisible();
    await page.locator(".keymap-overlay__replay").click();

    // The tour replays regardless of the seen-flag; the overlay is dismissed.
    await expect(page.locator(".coach-overlay")).toBeVisible();
    await expect(page.locator(".coach-callout__counter")).toHaveText("1 / 4");
    await expect(page.locator(".keymap-overlay")).toHaveCount(0);
  });

  test("does not fight #60 auto-open: creating a list still opens it", async ({
    page,
    baseURL,
  }) => {
    await seedInitials(page, baseURL!);
    await seedList(page, "Alpha");
    await page.goto("/");

    // The populated tour fires; dismiss it, then create a list the normal way.
    await expect(page.locator(".coach-overlay")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".coach-overlay")).toHaveCount(0);

    await page.fill(".lists__new-input", "Auto Opened");
    await page.press(".lists__new-input", "Enter");

    // #60: the freshly created list is auto-opened into the detail view — and
    // the lists tour does not follow onto it.
    await expect(page).toHaveURL(/#\/list\/\d+$/);
    await expect(
      page.locator(".squawk-row--new .squawk-row__text"),
    ).toBeFocused();
    await expect(page.locator(".coach-overlay")).toHaveCount(0);
  });

  test("navigation teardown: no capture-phase listener survives the unmount", async ({
    page,
    baseURL,
  }) => {
    await seedInitials(page, baseURL!);
    const id = await seedList(page, "Alpha");
    await page.goto("/");

    // The tour is live — its capture-phase keydown listener is installed.
    await expect(page.locator(".coach-overlay")).toBeVisible();

    // Navigate into a list via the in-app hash router. The self-removing
    // hashchange listener in renderLists fires endActiveTour, tearing the tour
    // (and its capture listener) down before the detail page takes over.
    await page.evaluate((listId) => {
      location.hash = `#/list/${listId}`;
    }, id);

    const entry = page.locator(".squawk-row--new .squawk-row__text");
    await expect(entry).toBeVisible();
    // The lists tour did not linger onto the detail view.
    await expect(page.locator(".coach-overlay")).toHaveCount(0);

    // Enter reaches the detail entry box (not swallowed by a stale listener):
    // a squawk is created and the box clears.
    await entry.fill("first squawk");
    await entry.press("Enter");
    await expect(page.locator("[data-squawk-id]")).toHaveCount(1);
    await expect(entry).toHaveValue("");

    // Escape reaches the detail entry box too — it clears the field.
    await entry.fill("scratch");
    await entry.press("Escape");
    await expect(entry).toHaveValue("");
  });
});
