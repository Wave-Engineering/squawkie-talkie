import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";

/**
 * Coach-mark engine, in a real browser (#70).
 *
 * The engine has no consuming surface yet, so we bun-build the harness entry
 * (`e2e/support/coach-harness.ts`) once, then inject the *real* compiled engine
 * into a blank-shell page and drive it. This proves the browser behaviours the
 * happy-dom unit tests cannot: real focus, real keyboard, real localStorage,
 * and the box-shadow spotlight actually painting.
 */

const SURFACE = "e2e-demo";
const FLAG_KEY = `st.coach.${SURFACE}`;

let harnessBundle = "";

test.beforeAll(() => {
  const root = process.cwd();
  const entry = path.join(root, "e2e", "support", "coach-harness.ts");
  const outDir = mkdtempSync(path.join(tmpdir(), "coach-"));
  const outFile = path.join(outDir, "coach-harness.js");
  execFileSync("bun", ["build", entry, "--outfile", outFile], {
    cwd: root,
    stdio: "pipe",
  });
  harnessBundle = readFileSync(outFile, "utf8");
});

/**
 * Load a clean shell (app.js neutralised so the SPA does not interfere), inject
 * the real engine, and plant three focusable elements: an origin the tour
 * should return focus to, plus two spotlight targets.
 */
async function bootHarness(page: import("@playwright/test").Page): Promise<void> {
  // Neutralise the SPA bundle so nothing else grabs focus or keys.
  await page.route("**/dist/app.js", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: "",
    }),
  );
  await page.goto("/");
  await page.addScriptTag({ content: harnessBundle, type: "module" });
  await page.waitForFunction(() => "__coach" in window);

  await page.evaluate(() => {
    const origin = document.createElement("input");
    origin.id = "origin";
    const a = document.createElement("button");
    a.id = "coach-a";
    a.textContent = "Target A";
    const b = document.createElement("button");
    b.id = "coach-b";
    b.textContent = "Target B";
    document.body.append(origin, a, b);
    origin.focus();
  });
}

const STEPS = [
  { target: "#coach-a", title: "First", body: "This is target A." },
  { target: "#coach-b", title: "Second", body: "This is target B." },
];

test.describe("Coach-mark engine", () => {
  test("fresh context shows the tour; Enter advances, Esc ends + restores focus", async ({
    page,
  }) => {
    await bootHarness(page);

    await page.evaluate((steps) => window.__coach.runTour("e2e-demo", steps), STEPS);

    const overlay = page.locator(".coach-overlay");
    await expect(overlay).toBeVisible();
    await expect(page.locator(".coach-spotlight")).toBeVisible();
    await expect(page.locator(".coach-callout__counter")).toHaveText("1 / 2");

    // Enter advances to step 2.
    await page.keyboard.press("Enter");
    await expect(page.locator(".coach-callout__counter")).toHaveText("2 / 2");

    // Esc ends the tour.
    await page.keyboard.press("Escape");
    await expect(overlay).toHaveCount(0);

    // Seen-flag was set on end.
    const flag = await page.evaluate((k) => localStorage.getItem(k), FLAG_KEY);
    expect(flag).not.toBeNull();

    // Focus returned to the pre-tour element.
    const active = await page.evaluate(() => document.activeElement?.id);
    expect(active).toBe("origin");
  });

  test("a set seen-flag suppresses runTour auto-show", async ({ page }) => {
    await bootHarness(page);
    await page.evaluate((k) => localStorage.setItem(k, "1"), FLAG_KEY);

    await page.evaluate((steps) => window.__coach.runTour("e2e-demo", steps), STEPS);

    await expect(page.locator(".coach-overlay")).toHaveCount(0);
  });

  test("replayTour runs regardless of the seen-flag", async ({ page }) => {
    await bootHarness(page);
    await page.evaluate((k) => localStorage.setItem(k, "1"), FLAG_KEY);

    await page.evaluate(
      (steps) => window.__coach.replayTour("e2e-demo", steps),
      STEPS,
    );

    await expect(page.locator(".coach-overlay")).toBeVisible();
    await expect(page.locator(".coach-callout__counter")).toHaveText("1 / 2");
  });
});
