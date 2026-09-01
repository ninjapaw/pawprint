import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/portal",
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4324",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run portal:build && node scripts/pawprint-portal.mjs",
    url: "http://127.0.0.1:4324/",
    reuseExistingServer: false,
    timeout: 120000,
    env: {
      ...process.env,
      PAWPRINT_NO_BROWSER: "1",
      PAWPRINT_PORT: "4324",
    },
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 5"] } },
  ],
});
