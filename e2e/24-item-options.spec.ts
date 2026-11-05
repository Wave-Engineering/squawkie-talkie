import { test, expect, createList, addSquawk } from "./fixtures.ts";
import type { Page } from "@playwright/test";

/** The id of the list the page is showing (`#/list/<id>`). */
function listIdOf(page: Page): number {
  const id = Number(new URL(page.url()).hash.split("/").pop());
  if (!Number.isInteger(id) || id <= 0) throw new Error(`no list id in ${page.url()}`);
  return id;
}

/** Add a squawk with answer options through the API, as an agent would. */
async function postWithOptions(page: Page, text: string, options: string[]): Promise<number> {
  const res = await page.request.post(`/api/lists/${listIdOf(page)}/squawks`, {
    data: { text, initials: "AA", options },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { id: number }).id;
}

const rowById = (page: Page, id: number) => page.locator(`[data-squawk-id="${id}"]`);

test.describe("Per-item answer options (#168)", () => {
  test("the dropdown offers the item's answers, and picking one resolves it as confirmed", async ({
    seededPage: page,
  }) => {
    await createList(page, "Answers");
    const id = await postWithOptions(page, "Ship the release?", ["Ship it", "Hold"]);

    // The agent's squawk arrives live; its dropdown has the five states, then the answers.
    const row = rowById(page, id);
    await expect(row).toHaveCount(1);
    const select = row.locator("select.squawk-row__state");
    await expect(select.locator("option")).toHaveCount(5 + 2);
    await expect(select.locator("optgroup[label='Answers'] option")).toHaveText([
      "✓ Ship it",
      "✓ Hold",
    ]);
    await expect(select).toHaveValue("open");

    // Choosing an answer shows its label beside the confirmed glyph and moves the counts.
    await select.selectOption({ label: "✓ Hold" });
    await expect(select).toHaveValue("answer:Hold");
    await expect(row).toHaveClass(/state-confirmed/);
    await expect(page.locator(".detail__counts")).toContainText("✓1");
    await expect(page.locator(".detail__counts")).not.toContainText("○");

    // The server recorded a choice on a confirmed squawk, not a new state.
    await expect
      .poll(async () => {
        const detail = (await (await page.request.get(`/api/lists/${listIdOf(page)}`)).json()) as {
          squawks: Array<{ id: number; state: string; choice: string | null }>;
        };
        const sq = detail.squawks.find((s) => s.id === id)!;
        return `${sq.state}/${sq.choice}`;
      })
      .toBe("confirmed/Hold");

    // It survives a reload: the row still reads as the answer.
    await page.reload();
    const after = rowById(page, id).locator("select.squawk-row__state");
    await expect(after).toHaveValue("answer:Hold");
    await expect(after).toHaveClass(/squawk-row__state--answer/);

    // A plain state change clears it again, and the answers are still offered.
    await after.selectOption("rejected");
    await expect(after).toHaveValue("rejected");
    await expect
      .poll(async () => {
        const detail = (await (await page.request.get(`/api/lists/${listIdOf(page)}`)).json()) as {
          squawks: Array<{ id: number; choice: string | null }>;
        };
        return detail.squawks.find((s) => s.id === id)!.choice;
      })
      .toBeNull();
    await expect(after.locator("optgroup[label='Answers'] option")).toHaveCount(2);
  });

  test("a squawk without options looks exactly as it did", async ({ seededPage: page }) => {
    await createList(page, "NoAnswers");
    await addSquawk(page, "plain");
    const select = page.locator("[data-squawk-id] select.squawk-row__state").first();
    await expect(select.locator("option")).toHaveCount(5);
    await expect(select.locator("optgroup")).toHaveCount(0);
  });

  test("a remote viewer sees the choice appear on the row", async ({
    seededPage: page,
    browser,
    baseURL,
  }) => {
    await createList(page, "RemoteAnswer");
    const id = await postWithOptions(page, "Which?", ["Left", "Right"]);
    await expect(rowById(page, id)).toHaveCount(1);

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
    await expect(rowById(viewer, id)).toHaveCount(1);

    await rowById(page, id).locator("select").selectOption({ label: "✓ Right" });
    await expect(rowById(viewer, id).locator("select")).toHaveValue("answer:Right");
    await ctx.close();
  });
});
