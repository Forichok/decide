import { defineConfig, devices } from "@playwright/test";

// Browser tests live in e2e/, outside what `node --test test/*.test.mjs` picks up.
// Each spec file starts its own decide server in its own scratch home (e2e/helpers.mjs).
export default defineConfig({
  testDir: "e2e",
  testMatch: "*.spec.mjs",
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 2,
  retries: 0,
  reporter: "list",
  outputDir: "test-results",
  use: {
    ...devices["Desktop Chrome"],
    headless: true,
    viewport: { width: 1280, height: 900 },
    launchOptions: { args: ["--mute-audio"] },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
