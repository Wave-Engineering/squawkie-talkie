import { test, expect, createList, addSquawk } from "./fixtures.ts";

// A minimal valid 2×2 RGBA PNG — real Chromium decodes it via createImageBitmap,
// so the client's canvas resize + upload path runs end-to-end (unlike happy-dom,
// which has no canvas.toBlob). The upload is re-encoded to a bounded JPEG.
const PNG_2x2 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=",
  "base64",
);

/** Attach one image to the first squawk row via its 📷 button + the file chooser. */
async function attachPhoto(page: import("@playwright/test").Page): Promise<void> {
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.locator("[data-squawk-id]").first().locator(".squawk-row__image-btn").click(),
  ]);
  await chooser.setFiles({
    name: "photo.png",
    mimeType: "image/png",
    buffer: PNG_2x2,
  });
}

test.describe("squawk images: multi-image + carousel (#127)", () => {
  test("append up to 5 with a count badge; carousel flips + removes; persists", async ({
    seededPage: page,
  }) => {
    await createList(page, "PhotoList");
    await addSquawk(page, "with photos");

    const row = page.locator("[data-squawk-id]").first();
    const thumb = row.locator(".squawk-row__thumb");
    const badge = row.locator(".squawk-row__thumb-count");

    // No images yet — the thumbnail is hidden, only the 📷 button shows.
    await expect(thumb).toBeHidden();

    // First photo: the thumbnail appears, but with one image there is no badge.
    await attachPhoto(page);
    await expect(thumb).toBeVisible();
    await expect(badge).toBeHidden();

    // Two more — the count badge appears and tracks the total. Awaiting each
    // count also serializes the uploads so the next attach can't race.
    await attachPhoto(page);
    await expect(badge).toHaveText("2");
    await attachPhoto(page);
    await expect(badge).toHaveText("3");

    // Clicking the thumbnail opens the carousel at the first image.
    await thumb.click();
    const carousel = page.locator(".carousel");
    await expect(carousel).toBeVisible();
    const counter = carousel.locator(".carousel__counter");
    await expect(counter).toHaveText("1 / 3");

    // Flip forward with the next control.
    await carousel.locator(".carousel__nav--next").click();
    await expect(counter).toHaveText("2 / 3");

    // Remove the current photo — two remain, and the carousel stays open.
    await carousel.locator(".carousel__remove").click();
    await expect(counter).toHaveText("2 / 2");

    // Escape closes the carousel.
    await page.keyboard.press("Escape");
    await expect(carousel).toBeHidden();

    // The row badge reflects the remaining two, and it persists across a reload
    // (the ids round-trip via the API).
    await expect(badge).toHaveText("2");
    await page.reload();
    await expect(
      page.locator("[data-squawk-id]").first().locator(".squawk-row__thumb"),
    ).toBeVisible();
    await expect(
      page.locator("[data-squawk-id]").first().locator(".squawk-row__thumb-count"),
    ).toHaveText("2");
  });
});
