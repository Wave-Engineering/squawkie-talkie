import { test, expect, type BrowserContext } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Connection-status indicator (#116): the header pill reflects SSE liveness, and
 * a reconnect resyncs anything missed while offline (SSE has no replay).
 *
 * Disconnect is emulated by actually killing the server — context.setOffline
 * doesn't affect loopback connections, so it can't drop a localhost SSE. This
 * spec therefore runs its OWN server on a dedicated port (not the shared test
 * server) so it can kill and restart it. Returning users (coach pre-seen).
 */
const PORT = 7799;
const BASE = `http://localhost:${PORT}`;
const DB = join(tmpdir(), "squawkie-e2e-connstatus.db");

let server: ChildProcess | null = null;

function startServer(): ChildProcess {
  return spawn("bun", ["run", "src/server/index.ts"], {
    env: { ...process.env, SQUAWK_DB: DB, PORT: String(PORT) },
    stdio: "ignore",
  });
}

async function waitReady(tries = 120): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${BASE}/api/lists`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error("dedicated server did not become ready");
}

function stopServer(): void {
  if (server) {
    server.kill("SIGKILL");
    server = null;
  }
}

async function prep(context: BrowserContext): Promise<void> {
  await context.addCookies([{ name: "st_initials", value: "AA", url: BASE }]);
  await context.addInitScript(() => {
    try {
      localStorage.setItem("st.coach.initials", "1");
      localStorage.setItem("st.coach.lists", "1");
      localStorage.setItem("st.coach.detail", "1");
    } catch {
      /* ignore */
    }
  });
}

test.describe("Connection status (#116)", () => {
  test.setTimeout(50_000);

  test.beforeEach(async () => {
    rmSync(DB, { force: true });
    server = startServer();
    await waitReady();
  });

  test.afterEach(() => {
    stopServer();
    rmSync(DB, { force: true });
  });

  test("pill goes OFF AIR when the server dies and BACK ON AIR on reconnect", async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ baseURL: BASE });
    await prep(ctx);
    const page = await ctx.newPage();
    await ctx.request.post("/api/lists", { data: { name: "ConnSeed" } });
    await page.goto("/");

    await expect(page.locator('.conn-status[data-state="online"]')).toBeVisible({
      timeout: 8000,
    });

    // Kill the server → after the ~2s grace the amber pill appears.
    stopServer();
    await expect(
      page.locator('.conn-status[data-state="offline"]'),
    ).toBeVisible({ timeout: 12000 });
    await expect(page.locator(".conn-status__label")).toContainText("off air");

    // Bring it back → the EventSource reconnects and the pill returns to on-air
    // (through the brief "back on air" flash).
    server = startServer();
    await waitReady();
    await expect(
      page.locator(
        '.conn-status[data-state="recovered"], .conn-status[data-state="online"]',
      ),
    ).toBeVisible({ timeout: 15000 });

    await ctx.close();
  });

  test("reconnect resyncs a list created while the viewer was offline", async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ baseURL: BASE });
    await prep(ctx);
    const page = await ctx.newPage();
    await ctx.request.post("/api/lists", { data: { name: "ResyncSeed" } });
    await page.goto("/");
    await expect(page.locator('.conn-status[data-state="online"]')).toBeVisible({
      timeout: 8000,
    });

    // Viewer goes dark.
    stopServer();
    await expect(
      page.locator('.conn-status[data-state="offline"]'),
    ).toBeVisible({ timeout: 12000 });

    // Server comes back and a list is created before the viewer reconnects — so
    // its live broadcast is missed; only a resync can surface it.
    server = startServer();
    await waitReady();
    await fetch(`${BASE}/api/lists`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "MadeWhileOffline" }),
    });

    // On reconnect the resync re-fetches and the missed list appears (no reload).
    await expect(
      page.locator('.list-row__open:has-text("MadeWhileOffline")'),
    ).toBeVisible({ timeout: 15000 });

    await ctx.close();
  });

  test("detail resync backfills missed squawks newest-first (not reversed)", async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ baseURL: BASE });
    await prep(ctx);
    const page = await ctx.newPage();
    const list = await (
      await ctx.request.post("/api/lists", { data: { name: "OrderList" } })
    ).json();
    await page.goto(`/#/list/${list.id}`);
    await expect(page.locator('.conn-status[data-state="online"]')).toBeVisible({
      timeout: 8000,
    });

    // Go dark.
    stopServer();
    await expect(
      page.locator('.conn-status[data-state="offline"]'),
    ).toBeVisible({ timeout: 12000 });

    // Server back; create three squawks (oldest → newest) before the viewer
    // reconnects, so the whole batch is missed and only resync surfaces it.
    server = startServer();
    await waitReady();
    for (const text of ["oldest", "middle", "newest"]) {
      await fetch(`${BASE}/api/lists/${list.id}/squawks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, initials: "ZZ" }),
      });
    }

    // On reconnect the resync backfills them — newest on top (matching seq DESC),
    // NOT reversed by the prepend-each insert path.
    await expect(page.locator("[data-squawk-id]")).toHaveCount(3, {
      timeout: 15000,
    });
    const texts = await page
      .locator("[data-squawk-id] input")
      .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    expect(texts).toEqual(["newest", "middle", "oldest"]);

    await ctx.close();
  });
});
