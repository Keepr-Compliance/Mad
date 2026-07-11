import { defineConfig } from '@playwright/test';

/**
 * Playwright config for the Keepr packaged-app E2E driver (BACKLOG-1849).
 *
 * This is a SEPARATE project from admin-portal/playwright.config.ts (which targets the
 * Next.js web portal). It drives the packaged Electron desktop app and therefore:
 *   - runs headed on macOS against the notarized/QA-fused build,
 *   - never runs in parallel (single desktop app instance + single userData profile),
 *   - has no webServer (the driver launches the packaged app itself).
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // A single non-parallel project; Electron launch details live in the driver + fixtures.
  projects: [{ name: 'electron-desktop' }],
});
