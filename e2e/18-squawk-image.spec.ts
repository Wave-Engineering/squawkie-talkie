import { test, expect, createList, addSquawk } from "./fixtures.ts";

// A minimal valid 2×2 RGBA PNG — real Chromium decodes it via createImageBitmap,
// so the client's canvas resize + upload path runs end-to-end (unlike happy-dom,
// which has no canvas.toBlob). The upload is re-encoded to a bounded JPEG.
const PNG_2x2 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=",
  "base64",
);

/** Attach an image to the first squawk row via its 📷 button + the file chooser. */
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

test.describe("squawk image attach / remove (#113)", () => {
  test("attach shows a thumbnail that persists across reload; remove clears it", async ({
    seededPage: page,
  }) => {
    await createList(page, "PhotoList");
    await addSquawk(page, "with a photo");

    const thumb = page.locator("[data-squawk-id]").first().locator(".squawk-row__thumb");
    // No image yet — the thumbnail is hidden, only the camera button shows.
    await expect(thumb).toBeHidden();

    await attachPhoto(page);

    // The thumbnail (and its remove control) appear once the upload completes.
    await expect(thumb).toBeVisible();
    await expect(
      page.locator("[data-squawk-id]").first().locator(".squawk-row__image-remove"),
    ).toBeVisible();

    // Persists: has_image round-trips via the API, so a reload re-renders it.
    await page.reload();
    await expect(
      page.locator("[data-squawk-id]").first().locator(".squawk-row__thumb"),
    ).toBeVisible();

    // Remove clears the thumbnail...
    await page
      .locator("[data-squawk-id]")
      .first()
      .locator(".squawk-row__image-remove")
      .click();
    await expect(
      page.locator("[data-squawk-id]").first().locator(".squawk-row__thumb"),
    ).toBeHidden();

    // ...and it stays cleared across another reload.
    await page.reload();
    await expect(
      page.locator("[data-squawk-id]").first().locator(".squawk-row__thumb"),
    ).toBeHidden();
  });
});
