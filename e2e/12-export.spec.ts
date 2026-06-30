import { test, expect, createList, addSquawk } from "./fixtures.ts";
import { readFile } from "fs/promises";

test.describe("Export list to JSON", () => {
  test("export button downloads correct JSON file", async ({
    seededPage: page,
  }) => {
    await page.goto("/");
    await page.fill(".lists__new-input", "ExportMe");
    await page.click(".lists__new-button");

    await page.click('.list-row__open:has-text("ExportMe")');
    await addSquawk(page, "exported squawk");
    await page.goto("/");

    // Intercept the download
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.click('.list-row:has-text("ExportMe") .list-row__export'),
    ]);

    expect(download.suggestedFilename()).toMatch(/squawk-exportme.*\.json/);

    const filePath = await download.path();
    const content = JSON.parse(await readFile(filePath!, "utf-8"));
    expect(content.name).toBe("ExportMe");
    expect(content.squawks).toHaveLength(1);
    expect(content.squawks[0].text).toBe("exported squawk");
  });
});
