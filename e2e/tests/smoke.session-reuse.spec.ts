import { REPO_ROOT, expect, test } from '../fixtures/electron.fixture';
import { resolveExecutable } from '../driver/paths';

/**
 * Packaged-app smoke test — REALIZES BACKLOG-1789.
 *
 * Hard contract: the packaged app boots and Playwright reaches its main window.
 * Session-reuse contract (opt-in): with a valid persisted profile + a notarized QA build,
 * the app lands on the ready main app with NO re-login. Set KEEPR_E2E_EXPECT_SESSION=1 to
 * assert this (the notarized-QA-build validation run); otherwise it is reported, not asserted,
 * so the test does not false-fail in environments without a logged-in session.
 */

let hasPackagedApp = true;
try {
  resolveExecutable(REPO_ROOT, process.env.KEEPR_APP_PATH);
} catch {
  hasPackagedApp = false;
}

test.describe('packaged-app smoke (BACKLOG-1789)', () => {
  test.skip(!hasPackagedApp, 'No packaged Keepr app found. Build with `npm run package:qa:dir` or set KEEPR_APP_PATH.');

  test('boots, reaches main window, and reuses the persisted session', async ({ driver }) => {
    // Hard: the main window exists and painted.
    await driver.waitForFirstPaint();
    expect(driver.page, 'main window page should exist').toBeTruthy();

    const state = await driver.detectState();
    const reused = await driver.isSessionReused();
    await driver.screenshot('smoke-boot');

    // eslint-disable-next-line no-console
    console.log(`[smoke] strategy=${driver.strategy} state=${state} sessionReused=${reused} userData=${driver.userDataDir()}`);

    if (process.env.KEEPR_E2E_EXPECT_SESSION === '1') {
      expect(reused, 'expected persisted session to be reused with no re-login').toBe(true);
      expect(state).toBe('ready');
    }
  });
});
