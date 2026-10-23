import { defineConfig, devices } from "@playwright/test";

const channel = process.env.PAWPRINT_TEST_BROWSER_CHANNEL;
if (channel && !["msedge", "chrome"].includes(channel)) throw new Error("Use an installed msedge/chrome channel or Playwright's bundled Chromium.");

export default defineConfig({
  testDir: "./tests/portal",
  reporter: "list",
  use: {
    ...(channel ? { channel } : {}),
    baseURL: "http://127.0.0.1:4324",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run portal:build && npm run portal:preview -- --port 4324",
    url: "http://127.0.0.1:4324/",
    reuseExistingServer: false,
    timeout: 120000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 5"] } },
  ],
});
