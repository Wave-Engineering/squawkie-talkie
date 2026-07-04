import { test, expect } from "@playwright/test";

test.describe("Initials gate (first visit)", () => {
  // Keep this spec about the initials gate alone. The onboarding coach mark and
  // the empty-system first-list gate (#71) are exercised in 00-onboarding; here
  // we suppress the coach (its seen-flag) and ensure the instance is populated
  // so neither surface interferes with the initials-only assertions.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem("st.coach.initials", "1");
      } catch {
        /* localStorage unavailable — coach simply may show; not this spec's concern */
      }
    });
    const res = await page.request.get("/api/lists");
    const lists: Array<{ id: number }> = await res.json();
    if (lists.length === 0) {
      await page.request.post("/api/lists", { data: { name: "Seed" } });
    }
  });

  test("shows modal on first visit, blocks until valid initials", async ({
    page,
  }) => {
    await page.goto("/");
    const modal = page.locator(".modal-backdrop");
    await expect(modal).toBeVisible();

    const input = page.locator(".modal__input");
    const button = page.locator(".modal__button");
    await expect(button).toBeDisabled();

    await input.fill("BJ");
    await expect(button).toBeEnabled();
    await button.click();
    await expect(modal).not.toBeVisible();

    // Lands on the lists screen
    await expect(page.locator(".lists__heading")).toBeVisible();
  });

  test("skips modal on subsequent visits (cookie persists)", async ({
    page,
    baseURL,
  }) => {
    await page.context().addCookies([
      { name: "st_initials", value: "BJ", url: baseURL! },
    ]);
    await page.goto("/");
    await expect(page.locator(".modal-backdrop")).not.toBeVisible();
    await expect(page.locator(".lists__heading")).toBeVisible();
  });
});
