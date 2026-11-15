import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * Per-list alerts (#177) in a real browser against a real server and real SSE.
 *
 * Chromium here has no user to grant notification permission and no way to put its
 * tab in the background, so the page is given two stand-ins before it loads: a
 * `Notification` that records what it was asked to show, and a `window.__away` flag
 * that drives `document.hidden` and `document.hasFocus()`. Everything else, the
 * toggle, localStorage, the EventSource stream and the decision to alert, is real.
 */

type Win = Window & {
  __away: boolean;
  __notes: { title: string; body?: string; tag?: string }[];
};

test.describe("per-list alerts (#177)", () => {
  test.beforeEach(async ({ page }) => {
    // Context-wide, so a second tab opened by a test gets the same stand-ins.
    await page.context().addInitScript(() => {
      const w = window as unknown as Win & { Notification: unknown };
      w.__away = false;
      w.__notes = [];
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => w.__away,
      });
      document.hasFocus = () => !w.__away;
      class FakeNotification {
        static permission = "granted";
        static async requestPermission(): Promise<string> {
          return "granted";
        }
        onclick: (() => void) | null = null;
        constructor(title: string, opts?: { body?: string; tag?: string }) {
          w.__notes.push({ title, body: opts?.body, tag: opts?.tag });
        }
        close(): void {}
      }
      w.Notification = FakeNotification;
    });
  });

  async function makeList(page: Page, name: string): Promise<number> {
    const res = await page.context().request.post("/api/lists", { data: { name } });
    return ((await res.json()) as { id: number }).id;
  }

  async function addTo(page: Page, listId: number, text: string): Promise<void> {
    // SSE has no replay: the page must be on the stream before the add is broadcast.
    await expect(page.locator('.conn-status[data-state="online"]')).toBeVisible();
    await page
      .context()
      .request.post(`/api/lists/${listId}/squawks`, { data: { text, initials: "ZZ" } });
  }

  const notes = (page: Page) => page.evaluate(() => (window as unknown as Win).__notes);
  const setAway = (page: Page, away: boolean) =>
    page.evaluate((a) => {
      (window as unknown as Win).__away = a;
      window.dispatchEvent(new Event(a ? "blur" : "focus"));
    }, away);
  const row = (page: Page, name: string) =>
    page.locator(".list-row", { has: page.locator(`.list-row__open:has-text("${name}")`) });

  test("every list starts with its alert off", async ({ seededPage: page }) => {
    await makeList(page, "AlertOff-1");
    await makeList(page, "AlertOff-2");
    await page.goto("/");
    for (const name of ["AlertOff-1", "AlertOff-2"]) {
      const toggle = row(page, name).locator(".alert-toggle");
      await expect(toggle).toHaveText("Alert: off");
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
    }
  });

  test("an add to an alert-on list while away notifies; an add to an off list does not", async ({
    seededPage: page,
  }) => {
    const on = await makeList(page, "AlertOn-A");
    const off = await makeList(page, "AlertOff-B");
    await page.goto("/");
    await row(page, "AlertOn-A").locator(".alert-toggle").click();
    await expect(row(page, "AlertOn-A").locator(".alert-toggle")).toHaveText("Alert: on");
    await expect(row(page, "AlertOff-B").locator(".alert-toggle")).toHaveText("Alert: off");

    await setAway(page, true);
    await addTo(page, off, "should stay quiet");
    await addTo(page, on, "needs a look");

    // The stream is ordered, so by the time the on-list's add has arrived the
    // off-list's has been handled too: exactly one notification, and it is the on-list's.
    await expect.poll(async () => (await notes(page)).length).toBe(1);
    const [n] = await notes(page);
    expect(n!.title).toBe("AlertOn-A: new squawk");
    expect(n!.body).toBe("needs a look");
    expect(n!.tag).toBe(`st-list-${on}`);
    // The tab title carries the unseen count until the viewer comes back.
    await expect.poll(() => page.title()).toMatch(/^\(1\) /);
    await setAway(page, false);
    await expect.poll(() => page.title()).not.toMatch(/^\(/);
  });

  test("nothing alerts while the viewer is looking", async ({ seededPage: page }) => {
    const id = await makeList(page, "AlertLooking");
    await page.goto("/");
    await row(page, "AlertLooking").locator(".alert-toggle").click();
    await expect(row(page, "AlertLooking").locator(".alert-toggle")).toHaveText("Alert: on");

    await addTo(page, id, "seen at once"); // looking: no alert
    await setAway(page, true);
    await addTo(page, id, "missed while away"); // away: alert

    await expect.poll(async () => (await notes(page)).length).toBe(1);
    expect((await notes(page))[0]!.body).toBe("missed while away");
  });

  test("adds in one burst replace the popup and say how many", async ({ seededPage: page }) => {
    const id = await makeList(page, "AlertBurst");
    await page.goto("/");
    await row(page, "AlertBurst").locator(".alert-toggle").click();
    await expect(row(page, "AlertBurst").locator(".alert-toggle")).toHaveText("Alert: on");
    await setAway(page, true);
    await addTo(page, id, "one");
    await addTo(page, id, "two");
    await addTo(page, id, "three");
    await expect.poll(async () => (await notes(page)).length).toBe(3);
    const all = await notes(page);
    expect(all[0]!.title).toBe("AlertBurst: new squawk");
    expect(all[2]!.title).toBe("AlertBurst: 3 new squawks");
    expect(new Set(all.map((x) => x.tag)).size).toBe(1); // one tag, so the browser replaces
  });

  test("with two tabs open, none alerts while one is looked at, and only one once both are away", async ({
    seededPage: a,
  }) => {
    const id = await makeList(a, "AlertTwoTabs");
    await a.goto("/");
    await row(a, "AlertTwoTabs").locator(".alert-toggle").click();
    await expect(row(a, "AlertTwoTabs").locator(".alert-toggle")).toHaveText("Alert: on");

    // Tab B is the one the viewer is looking at; tab A is away.
    const b = await a.context().newPage();
    await b.goto("/");
    await expect(row(b, "AlertTwoTabs").locator(".alert-toggle")).toHaveText("Alert: on");
    await setAway(a, true);

    await addTo(a, id, "tab B is being looked at");
    await expect(b.locator('.conn-status[data-state="online"]')).toBeVisible();
    await a.waitForTimeout(500); // the add has reached A by now; give a wrong alert time to show
    expect(await notes(a)).toHaveLength(0);
    expect(await notes(b)).toHaveLength(0);

    // Now the viewer leaves both: exactly one of the two tabs alerts, not both.
    await setAway(b, true);
    await addTo(a, id, "both tabs away");
    await expect
      .poll(async () => (await notes(a)).length + (await notes(b)).length)
      .toBeGreaterThan(0);
    await a.waitForTimeout(500);
    expect((await notes(a)).length + (await notes(b)).length).toBe(1);
  });

  test("the toggle survives a reload, matches in the list header, and a deleted list forgets it", async ({
    seededPage: page,
  }) => {
    const id = await makeList(page, "AlertPersist");
    await page.goto("/");
    await row(page, "AlertPersist").locator(".alert-toggle").click();
    await expect(row(page, "AlertPersist").locator(".alert-toggle")).toHaveText("Alert: on");

    await page.reload();
    await expect(row(page, "AlertPersist").locator(".alert-toggle")).toHaveText("Alert: on");

    await page.goto(`/#/list/${id}`);
    const header = page.locator(".detail__header .alert-toggle");
    await expect(header).toHaveText("Alert: on");
    await header.click();
    await expect(header).toHaveText("Alert: off");

    await page.goto("/");
    await expect(row(page, "AlertPersist").locator(".alert-toggle")).toHaveText("Alert: off");

    // Turn it back on, delete the list, and the stored entry goes with it.
    await row(page, "AlertPersist").locator(".alert-toggle").click();
    await expect(row(page, "AlertPersist").locator(".alert-toggle")).toHaveText("Alert: on");
    await page.context().request.delete(`/api/lists/${id}`);
    await expect
      .poll(() => page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem("st.alerts") ?? "{}"))))
      .not.toContain(String(id));
  });
});
