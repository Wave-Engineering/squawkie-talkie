import { test, expect } from "@playwright/test";

test.describe("Initials gate (first visit)", () => {
  // Keep this spec about the initials gate alone. The empty-system first-list
  // gate (#71) is avoided by seeding a list. The onboarding coach now fires WITH
  // the gate (its seen-flag is reset on identity, #93) and can't be suppressed via
  // localStorage, so the tests dismiss it where it would obscure the gate controls.
  test.beforeEach(async ({ page }) => {
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

    // The onboarding coach fires with the gate; dismiss it so its callout does
    // not obscure the gate controls (Escape ends the tour; the modal stays).
    await page.keyboard.press("Escape");
    await expect(page.locator(".coach-overlay")).toHaveCount(0);

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
