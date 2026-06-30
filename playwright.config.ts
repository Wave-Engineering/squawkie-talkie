import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: "http://localhost:7701",
    headless: true,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: "SQUAWK_DB=:memory: PORT=7701 bun run src/server/index.ts",
    port: 7701,
    reuseExistingServer: !process.env.CI,
  },
});
