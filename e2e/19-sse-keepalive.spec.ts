import { test, expect, type BrowserContext } from "@playwright/test";

/**
 * Regression for #115: an SSE stream must stay open past Bun's idle window so
 * realtime keeps working after a viewer has been connected a while.
 *
 * The bug: Bun.serve defaulted to a 10s idleTimeout, SHORTER than sse.ts's 25s
 * heartbeat, so every /api/stream connection was killed at 10s — before a
 * heartbeat could reset the timer — dropping events during the reconnect gaps.
 *
 * This test is deliberately structured to fail WITHOUT the fix:
 *   - It counts EventSource reconnects (the "error" event fires when the stream
 *     is dropped and the browser starts reconnecting). A healthy heartbeated
 *     stream never errors; a stream idle-killed at 10s does. Counting drops is
 *     immune to the "the event happened to arrive after a reconnect" masking
 *     that a bare event-crossing assertion suffers.
 *   - It idles PAST the 25s heartbeat, so any idleTimeout shorter than the
 *     heartbeat kills the stream before the heartbeat can keep it alive.
 * (Returning users so the onboarding tour doesn't fire.)
 */
async function prep(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    try {
      localStorage.setItem("st.coach.initials", "1");
      localStorage.setItem("st.coach.lists", "1");
      localStorage.setItem("st.coach.detail", "1");
    } catch {
      /* localStorage unavailable — ignore */
    }
    // Count SSE drops. "error" fires when the connection closes and the browser
    // begins reconnecting; a continuously-alive stream never fires it.
    (window as unknown as { __sseErrors: number }).__sseErrors = 0;
    const Orig = window.EventSource;
    class Counting extends Orig {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        this.addEventListener("error", () => {
          (window as unknown as { __sseErrors: number }).__sseErrors++;
        });
      }
    }
    window.EventSource = Counting;
  });
}

const errs = (): number =>
  (window as unknown as { __sseErrors: number }).__sseErrors;

test.describe("SSE keepalive (#115)", () => {
  // Deliberately idles 28s (past the 25s heartbeat), plus setup/teardown.
  test.setTimeout(55_000);

  test("stream survives past the heartbeat window with no reconnect; events still cross", async ({
    browser,
    baseURL,
  }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    await ctxA.addCookies([{ name: "st_initials", value: "AA", url: baseURL! }]);
    await ctxB.addCookies([{ name: "st_initials", value: "BB", url: baseURL! }]);
    await prep(ctxA);
    await prep(ctxB);

    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    // A creates a list (auto-navigates to detail); B opens the same list. Both
    // pages' EventSource connect at app bootstrap (app.ts) and persist across the
    // SPA hash navigation.
    await pageA.goto("/");
    await pageA.fill(".lists__new-input", "KeepAlive");
    await pageA.click(".lists__new-button");
    await expect(
      pageA.locator(".squawk-row--new .squawk-row__text"),
    ).toBeFocused();

    await pageB.goto("/");
    await pageB.click('.list-row__open:has-text("KeepAlive")');
    await expect(
      pageB.locator(".squawk-row--new .squawk-row__text"),
    ).toBeVisible();

    // Reset drop counters now that both streams are up, so only drops DURING the
    // idle window count (ignores any transient hiccup during initial connect).
    await pageA.evaluate(errs); // ensure page is ready
    await pageA.evaluate(() => {
      (window as unknown as { __sseErrors: number }).__sseErrors = 0;
    });
    await pageB.evaluate(() => {
      (window as unknown as { __sseErrors: number }).__sseErrors = 0;
    });

    // Idle 28s — past the 25s heartbeat. A too-short idleTimeout (the #115 bug)
    // kills the stream before the heartbeat resets the timer, firing "error".
    await pageA.waitForTimeout(28_000);

    // The load-bearing assertion: neither idle stream dropped/reconnected.
    expect(await pageA.evaluate(errs)).toBe(0);
    expect(await pageB.evaluate(errs)).toBe(0);

    // And an event created after the long idle still crosses live.
    const entryA = pageA.locator(".squawk-row--new .squawk-row__text");
    await entryA.fill("alive past the heartbeat");
    await entryA.press("Enter");
    const rowB = pageB.locator("[data-squawk-id] input").first();
    await expect(rowB).toHaveValue("alive past the heartbeat", { timeout: 5000 });

    await ctxA.close();
    await ctxB.close();
  });
});
