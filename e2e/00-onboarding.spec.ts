import type { Page } from "@playwright/test";

import { test, expect } from "@playwright/test";

/**
 * First-run onboarding (Story #71, Epic #69).
 *
 * Two gates, driven in a real browser:
 *  - the initials gate carries the Welcome/ConOps copy + a coach mark on the
 *    initials field (the #70 engine), shown only on a fresh device, and
 *  - the empty-system first-list gate, which blocks a brand-new instance until
 *    a list is named and never fires once any list exists.
 *
 * The E2E server keeps one in-memory DB for the whole run, so each test sets its
 * own list precondition through the API rather than trusting accumulated state.
 * Playwright gives every test a fresh context (no cookie, clean localStorage),
 * which is exactly the "brand-new device" these gates key off.
 */

async function resetLists(page: Page): Promise<void> {
  const res = await page.request.get("/api/lists");
  const lists: Array<{ id: number }> = await res.json();
  for (const list of lists) {
    await page.request.delete(`/api/lists/${list.id}`);
  }
}

async function seedList(page: Page, name: string): Promise<void> {
  await page.request.post("/api/lists", { data: { name } });
}

test.describe("Onboarding: initials welcome + empty-system first-list gate", () => {
  test("empty system: welcome + coach, and a first list is required before the app", async ({
    page,
  }) => {
    await resetLists(page);
    await page.goto("/");

    // Initials gate carries the Welcome/ConOps copy.
    await expect(page.locator(".modal-backdrop")).toBeVisible();
    await expect(page.locator(".modal__welcome")).toContainText(
      "shared scratchpad",
    );

    // A coach mark anchors to the initials field with the field copy.
    await expect(page.locator(".coach-overlay")).toBeVisible();
    await expect(page.locator(".coach-callout__body")).toContainText(
      "Drop your initials",
    );

    // Dismiss the coach, then set initials.
    await page.keyboard.press("Escape");
    await expect(page.locator(".coach-overlay")).toHaveCount(0);
    await page.fill(".modal__input", "BJ");
    await page.click(".modal__button");
    await expect(page.locator(".modal-backdrop")).toHaveCount(0);

    // The empty-system first-list gate now blocks: the lists view is NOT yet
    // reachable until a list is named.
    await expect(page.locator(".first-list-gate")).toBeVisible();
    await expect(page.locator(".first-list-gate .modal__title")).toHaveText(
      "What are you squawkin' about?",
    );
    await expect(page.locator(".first-list-gate .modal__hint")).toHaveText(
      "(name your first list)",
    );
    await expect(page.locator(".lists__heading")).toHaveCount(0);

    // Name the first list -> gate clears -> the app (lists view) is reached.
    await page.fill(".first-list-gate__input", "Sprint 7");
    await page.click(".first-list-gate .modal__button");
    await expect(page.locator(".first-list-gate")).toHaveCount(0);
    await expect(page.locator(".lists__heading")).toBeVisible();
    await expect(
      page.locator('.list-row__open:has-text("Sprint 7")'),
    ).toBeVisible();
  });

  test("populated system: no first-list gate after initials", async ({
    page,
  }) => {
    await resetLists(page);
    await seedList(page, "Existing");
    await page.goto("/");

    // Fresh context still meets the initials gate; clear its coach, set initials.
    await expect(page.locator(".modal-backdrop")).toBeVisible();
    await expect(page.locator(".coach-overlay")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".coach-overlay")).toHaveCount(0);
    await page.fill(".modal__input", "BJ");
    await page.click(".modal__button");

    // Straight to the lists view — the first-list gate never appears.
    await expect(page.locator(".lists__heading")).toBeVisible();
    await expect(page.locator(".first-list-gate")).toHaveCount(0);
  });

  test("st_initials preset: no Welcome", async ({ page, baseURL }) => {
    await resetLists(page);
    await seedList(page, "Existing");
    await page.context().addCookies([
      { name: "st_initials", value: "BJ", url: baseURL! },
    ]);
    await page.goto("/");

    await expect(page.locator(".lists__heading")).toBeVisible();
    await expect(page.locator(".modal__welcome")).toHaveCount(0);
    await expect(page.locator(".modal-backdrop")).toHaveCount(0);
  });

  test("initials coach is interactive: type into the real field, Enter submits and dismisses", async ({
    page,
  }) => {
    await resetLists(page);
    await seedList(page, "Existing"); // populated -> no first-list gate to distract
    // Suppress the sibling surfaces' tours so ONLY the initials coach is in play.
    // Without this, submitting initials navigates to the populated lists page, whose
    // lists tour auto-fires the same tick and races the "coach dismissed" assertion
    // below (the lists overlay, not the initials one, is what intermittently lingers).
    await page.addInitScript(() => {
      try {
        localStorage.setItem("st.coach.lists", "1");
        localStorage.setItem("st.coach.detail", "1");
      } catch {
        /* localStorage unavailable — not this spec's concern */
      }
    });
    await page.goto("/");

    // The coach spotlights the real initials field, which holds focus under it.
    await expect(page.locator(".coach-overlay")).toBeVisible();
    const input = page.locator(".modal__input");
    await expect(input).toBeFocused();

    // Type into the REAL field (no proxy) with the coach still up, then submit
    // with Enter — the form's submit tears the coach down in the same motion.
    await input.fill("BJ");
    await expect(page.locator(".coach-overlay")).toBeVisible(); // still up while typing
    await input.press("Enter");

    await expect(page.locator(".coach-overlay")).toHaveCount(0);
    await expect(page.locator(".modal-backdrop")).toHaveCount(0);
    await expect(page.locator(".lists__heading")).toBeVisible();
  });
});
