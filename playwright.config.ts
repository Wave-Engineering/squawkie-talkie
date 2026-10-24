import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: "http://localhost:7701",
    headless: true,
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    // Phone viewport + touch, for the specs where a tap must behave (#146).
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: /21-wrap-expand\.spec\.ts/ },
  ],
  webServer: {
    command: "SQUAWK_DB=:memory: PORT=7701 bun run src/server/index.ts",
    port: 7701,
    reuseExistingServer: !process.env.CI,
  },
});
