import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/smoke",
  timeout: 120_000,
  workers: 1,
  use: { baseURL: "http://localhost:3317", browserName: "chromium", viewport: { width: 1440, height: 1000 }, trace: { mode: "retain-on-failure", screenshots: false, snapshots: false }, screenshot: "only-on-failure" },
  webServer: {
    command: "node scripts/smoke-server.mjs",
    url: "http://localhost:3317",
    timeout: 180_000,
    reuseExistingServer: false,
  },
});
