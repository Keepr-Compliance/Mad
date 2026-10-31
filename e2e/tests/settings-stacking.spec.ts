import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { KeeprAppDriver } from '../driver/appDriver';
import { resolveBuiltMainEntry } from '../driver/paths';
import { seedIsolatedProfile } from '../driver/seed/seedProfile';
import { isTopmostAtCentre, runAccountPanelCells } from './accountPanelCells';

/**
 * BACKLOG-3964 slice 2 fix-up — Settings page stacking, in the BUILT app.
 *
 * jsdom has no layout, so the unit tests can only compare z-index classes. This cell hit-tests
 * real pixels: with Settings open, Settings › General › "Test Notification" must put a toast on
 * screen that is the topmost element at its own centre, the "?" support button must be the
 * topmost element at ITS centre (and clickable), and the title-bar initials must bring up
 * the account side panel (Settings closes) instead of opening it hidden underneath.
 *
 * Slice 3a extends it with the account side panel cells H1-H8 (./accountPanelCells, shared with
 * the safeguarded walkthrough runner).
 *
 * Requires the app BUILT (`npm run build`); SKIPPED with an actionable message otherwise. Lives in
 * e2e/tests/ (Playwright config), not the jest run. Launch it only with --user-data-dir isolation
 * and the walkthrough safeguards (log redirect, Messages/AddressBook unreadable), never a fake HOME.
 */

const REPO_ROOT = join(__dirname, '..', '..');
const PROFILE_DIR = process.env.QA_PROFILE_DIR ?? join(REPO_ROOT, '.qa-scratch', 'keepr-settings-stacking-profile');
const ARTIFACTS_DIR = join(REPO_ROOT, 'e2e', '.artifacts', 'settings-stacking');

let isBuilt = true;
try {
  resolveBuiltMainEntry(REPO_ROOT);
  if (!existsSync(join(REPO_ROOT, 'dist', 'index.html'))) isBuilt = false;
} catch {
  isBuilt = false;
}

test.describe('Settings page stacking (BACKLOG-3964 S2 fix-up)', () => {
  test.skip(!isBuilt, 'App is not built. Run `npm run build` first.');
  test.setTimeout(180_000);

  let driver: KeeprAppDriver | undefined;

  test.beforeAll(async () => {
    if (existsSync(PROFILE_DIR)) rmSync(PROFILE_DIR, { recursive: true, force: true });
    mkdirSync(PROFILE_DIR, { recursive: true });
    await seedIsolatedProfile(REPO_ROOT, PROFILE_DIR);
  });

  test.afterAll(async () => {
    await driver?.close().catch(() => undefined);
  });

  test('toast and "?" are above Settings; initials close Settings and open the account panel', async () => {
    driver = await KeeprAppDriver.launch(REPO_ROOT, {
      strategy: 'unpackaged',
      reuseProfile: false,
      userDataDir: PROFILE_DIR,
      repoRoot: REPO_ROOT,
      artifactsDir: ARTIFACTS_DIR,
      launchTimeoutMs: 60_000,
    });
    await driver.waitForFirstPaint(60_000);
    await driver.bringToFront();
    expect(await driver.waitForReady(30_000), 'seeded session should authenticate').toBe(true);
    await driver.dismissTour();

    const page = driver.page;
    await driver.gotoSettings();
    await page.getByTestId('settings-tab-general').click();

    // "?" is visible, topmost at its centre, and clickable while Settings shows.
    const help = '[data-support-widget]';
    await expect(page.locator(help)).toBeVisible();
    expect(await isTopmostAtCentre(page, help), '"?" must not be covered by the Settings layer').toBe(true);

    // A toast fired from inside Settings is on screen and topmost at its centre.
    await page.getByRole('button', { name: 'Test Notification' }).click();
    const toasts = page.getByTestId('notification-container');
    await expect(toasts).toBeVisible({ timeout: 10_000 });
    expect(
      await isTopmostAtCentre(page, '[data-testid="notification-container"]'),
      'toast must not be covered by the Settings layer',
    ).toBe(true);
    await driver.screenshot('settings-toast-and-help');

    // Click "?" while Settings shows: the support form opens and is topmost at its centre.
    await page.locator(help).click();
    const form = page.getByTestId('support-ticket-dialog');
    await expect(form).toBeVisible({ timeout: 15_000 });
    expect(
      await isTopmostAtCentre(page, '[data-testid="support-ticket-dialog"]'),
      'support form must not be covered by the Settings layer',
    ).toBe(true);
    await driver.screenshot('settings-support-form');
    await page.keyboard.press('Escape');
    await expect(form).toBeHidden({ timeout: 5_000 });
    // Esc closed only the form: Settings must still be open, or the check below proves nothing.
    await expect(page.getByTestId('settings-page')).toBeVisible();

    // Title-bar initials while Settings shows: Settings closes, the account panel is what shows.
    await page.getByTestId('nav-profile').click();
    await expect(page.getByTestId('settings-page')).toBeHidden();
    await expect(page.getByTestId('account-panel')).toBeVisible();
    await expect(page.getByTestId('nav-settings')).toBeVisible(); // the panel's Account row
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('account-panel')).toBeHidden();

    // BACKLOG-3964 slice 3a: the account side panel cells.
    const results = await runAccountPanelCells(page, {
      app: driver.app!,
      shot: (name) => driver!.screenshot(`panel-${name}`),
    });
    for (const r of results) expect(r.ok, `${r.id}: ${r.detail}`).toBe(true);
  });
});
