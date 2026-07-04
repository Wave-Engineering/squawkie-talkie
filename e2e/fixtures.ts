import { test as base, expect, type Page } from "@playwright/test";

export { expect };

export const test = base.extend<{ seededPage: Page }>({
  // Feature specs exercise a *returning* user: the first-run onboarding coach
  // marks (Epic #69) are already seen on every surface, so no tour auto-fires
  // and captures the keyboard mid-test. The dedicated coach specs opt out by
  // importing the base `@playwright/test` page instead of this fixture.
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem("st.coach.initials", "1");
        localStorage.setItem("st.coach.lists", "1");
        localStorage.setItem("st.coach.detail", "1");
      } catch {
        /* localStorage unavailable — tours simply show, which is harmless. */
      }
    });
    await use(page);
  },
  seededPage: async ({ page, baseURL }, use) => {
    await page.context().addCookies([
      { name: "st_initials", value: "E2E", url: baseURL! },
    ]);
    await use(page);
  },
});

export async function createList(page: Page, name: string): Promise<void> {
  await page.goto("/");
  await page.fill(".lists__new-input", name);
  await page.click(".lists__new-button");
  await expect(page.locator(".squawk-row--new .squawk-row__text")).toBeFocused();
}

export async function addSquawk(page: Page, text: string): Promise<void> {
  const entry = page.locator(".squawk-row--new .squawk-row__text");
  const countBefore = await page.locator("[data-squawk-id]").count();
  await entry.fill(text);
  await entry.press("Enter");
  await expect(page.locator("[data-squawk-id]")).toHaveCount(countBefore + 1);
  await expect(entry).toHaveValue("");
  await expect(entry).toBeFocused();
}
