import { test, expect, createList, addSquawk } from "./fixtures.ts";
import type { Page } from "@playwright/test";

function listIdOf(page: Page): number {
  const id = Number(new URL(page.url()).hash.split("/").pop());
  if (!Number.isInteger(id) || id <= 0) throw new Error(`no list id in ${page.url()}`);
  return id;
}

/** The stored note of the list's first squawk, as GET returns it. */
async function storedNote(page: Page, listId: number): Promise<string> {
  const detail = (await (await page.request.get(`/api/lists/${listId}`)).json()) as {
    squawks: Array<{ note: string }>;
  };
  return detail.squawks[0]!.note;
}

test.describe("Note on a squawk (#168)", () => {
  test("the note button opens a box that saves on blur, keeps keys as text, and shows a dot", async ({
    seededPage: page,
  }) => {
    await createList(page, "Notes");
    await addSquawk(page, "needs a note");
    const listId = listIdOf(page);
    const row = page.locator("[data-squawk-id]").first();
    const btn = row.locator(".squawk-row__note-btn");
    const box = row.locator(".squawk-row__note");

    // Beside the camera button, closed, with no dot.
    await expect(btn).toHaveAttribute("aria-label", "Edit note");
    await expect(box).toBeHidden();
    await expect(btn).not.toHaveClass(/squawk-row__note-btn--has/);
    expect(await row.locator("input").count()).toBe(1); // the text box is still its only <input>

    await btn.click();
    await expect(box).toBeVisible();
    await expect(box).toBeFocused();

    // Vi keys are text in this box, not commands: nothing navigates, nothing is deleted.
    await box.pressSequentially("jk dd i remember the vendor");
    await expect(box).toHaveValue("jk dd i remember the vendor");
    await expect(page.locator("[data-squawk-id]")).toHaveCount(1);
    await expect(btn).toHaveClass(/squawk-row__note-btn--has/);

    // Moving focus away saves it.
    await page.locator(".squawk-row--new .squawk-row__text").click();
    await expect.poll(() => storedNote(page, listId)).toBe("jk dd i remember the vendor");

    // It is still there after a reload, with its dot, and the box opens on it.
    await page.reload();
    const again = page.locator("[data-squawk-id]").first();
    await expect(again.locator(".squawk-row__note-btn")).toHaveClass(/squawk-row__note-btn--has/);
    await again.locator(".squawk-row__note-btn").click();
    await expect(again.locator(".squawk-row__note")).toHaveValue("jk dd i remember the vendor");
  });

  test("Escape closes the box and keeps the note", async ({ seededPage: page }) => {
    await createList(page, "NoteEscape");
    await addSquawk(page, "escape me");
    const listId = listIdOf(page);
    const row = page.locator("[data-squawk-id]").first();
    await row.locator(".squawk-row__note-btn").click();
    await row.locator(".squawk-row__note").fill("kept on escape");
    await page.keyboard.press("Escape");

    await expect(row.locator(".squawk-row__note")).toBeHidden();
    await expect(row.locator(".squawk-row__note-btn")).toBeFocused();
    await expect.poll(() => storedNote(page, listId)).toBe("kept on escape");
    await expect(row.locator(".squawk-row__note-btn")).toHaveClass(/squawk-row__note-btn--has/);
  });

  test("a second viewer does not see the note while the item is open, and does once it is disposed", async ({
    seededPage: page,
    browser,
    baseURL,
  }) => {
    await createList(page, "NoteBroadcast");
    await addSquawk(page, "who sees the note");
    const listId = listIdOf(page);
    const idA = (await page.locator("[data-squawk-id]").first().getAttribute("data-squawk-id"))!;

    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: "st_initials", value: "ZZ", url: baseURL! }]);
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem("st.coach.initials", "1");
        localStorage.setItem("st.coach.lists", "1");
        localStorage.setItem("st.coach.detail", "1");
      } catch {
        /* ignore */
      }
    });
    const viewer = await ctx.newPage();
    await viewer.goto(page.url());
    const rowB = viewer.locator(`[data-squawk-id="${idA}"]`);
    await expect(rowB).toHaveCount(1);

    // A writes a note on the open item; it is stored, but B is told nothing.
    const rowA = page.locator(`[data-squawk-id="${idA}"]`);
    await rowA.locator(".squawk-row__note-btn").click();
    await rowA.locator(".squawk-row__note").fill("only for the reader");
    await page.keyboard.press("Escape");
    await expect.poll(() => storedNote(page, listId)).toBe("only for the reader");
    await viewer.waitForTimeout(1500);
    await expect(rowB.locator(".squawk-row__note")).toHaveValue("");
    await expect(rowB.locator(".squawk-row__note-btn")).not.toHaveClass(/squawk-row__note-btn--has/);

    // Disposing the item sends the note along.
    await rowA.locator("select").selectOption("confirmed");
    await expect(rowB.locator(".squawk-row__note")).toHaveValue("only for the reader");
    await expect(rowB.locator(".squawk-row__note-btn")).toHaveClass(/squawk-row__note-btn--has/);

    // A's own note box was not wiped by the frames that came back to it.
    await expect(rowA.locator(".squawk-row__note")).toHaveValue("only for the reader");
    await ctx.close();
  });

  test("an update to an open item does not wipe the note being shown", async ({
    seededPage: page,
  }) => {
    await createList(page, "NoteKept");
    await addSquawk(page, "keep my note");
    const listId = listIdOf(page);
    const row = page.locator("[data-squawk-id]").first();
    await row.locator(".squawk-row__note-btn").click();
    await row.locator(".squawk-row__note").fill("still here");
    await page.keyboard.press("Escape");
    await expect.poll(() => storedNote(page, listId)).toBe("still here");

    // Another client edits the open item's text: its SSE frame carries an empty note.
    // The viewer's focused row keeps its own text (invariant #1), so let go of focus first.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const id = await row.getAttribute("data-squawk-id");
    const res = await page.request.patch(`/api/squawks/${id}`, {
      data: { text: "edited elsewhere", initials: "ZZ" },
    });
    expect(res.status()).toBe(200);
    await expect(row.locator("input.squawk-row__text")).toHaveValue("edited elsewhere");
    await expect(row.locator(".squawk-row__note")).toHaveValue("still here");
    await expect(row.locator(".squawk-row__note-btn")).toHaveClass(/squawk-row__note-btn--has/);
  });
});
