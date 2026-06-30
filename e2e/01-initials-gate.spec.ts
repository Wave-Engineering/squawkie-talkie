import { test, expect } from "@playwright/test";

test.describe("Initials gate (first visit)", () => {
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
