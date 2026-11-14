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
 * the account side panel OVER Settings (BACKLOG-4174, founder 2026-11-13): Settings stays shown,
 * and closing the panel returns to it with the same scroll and tab.
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

  test('toast and "?" are above Settings; initials open the account panel over Settings', async () => {
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

    // BACKLOG-4174 S1: put Settings somewhere other than the top, and note where it is.
    const SCROLLER = '[data-testid="settings-page"] .overflow-y-auto';
    await page.evaluate((sel) => document.querySelector(sel)?.scrollTo({ top: 400, behavior: 'instant' }), SCROLLER);
    await page.waitForTimeout(500); // let the scroll spy settle on a tab
    const settingsAt = () =>
      page.evaluate((sel) => ({
        scrollTop: Math.round(document.querySelector(sel)?.scrollTop ?? -1),
        tab: document.querySelector('[data-testid="settings-tabs"] [aria-selected="true"]')?.getAttribute('data-testid') ?? 'none',
      }), SCROLLER);
    const before = await settingsAt();
    expect(before.scrollTop, 'Settings must have scrolled, or S1 proves nothing').toBeGreaterThan(0);

    // Title-bar initials while Settings shows: the account panel opens OVER Settings.
    await page.getByTestId('nav-profile').click();
    await expect(page.getByTestId('account-panel')).toBeVisible();
    await expect(page.getByTestId('nav-settings')).toBeVisible(); // the panel's Account row
    await expect(page.getByTestId('settings-page')).toBeVisible();
    // Z2: the panel is topmost at its centre.
    expect(await isTopmostAtCentre(page, '[data-testid="account-panel"]'), 'panel must be topmost').toBe(true);
    // Settings is what shows left of the panel: the scrim there is see-through, Settings is drawn
    // (not hidden, invisible or transparent), and it is the first thing under the scrim at one of three heights. Inert and
    // the scrim are lifted for the one hit-test only, then put back in the same task.
    const left = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="account-panel"]')!.getBoundingClientRect();
      const scrim = document.querySelector<HTMLElement>('[data-testid="account-panel-scrim"]')!;
      const layer = document.querySelector<HTMLElement>('[data-testid="settings-layer"]')!;
      const settingsPage = document.querySelector('[data-testid="settings-page"]')!;
      const x = Math.max(20, panel.left - 200);
      // Three heights, so a strip drawn over Settings (e.g. the support-access banner, z-106)
      // cannot fail the check on its own.
      const ys = [0.25, 0.5, 0.75].map((f) => Math.round(panel.top + panel.height * f));
      const wasInert = layer.hasAttribute('inert');
      const scrimBg = getComputedStyle(scrim).backgroundColor;
      const ls = getComputedStyle(layer);
      scrim.style.pointerEvents = 'none';
      layer.removeAttribute('inert');
      const hits = ys.map((y) => document.elementFromPoint(x, y));
      scrim.style.pointerEvents = '';
      if (wasInert) layer.setAttribute('inert', '');
      return {
        wasInert,
        scrimBg,
        layerShown: ls.display !== 'none' && ls.visibility === 'visible' && ls.opacity !== '0',
        settingsUnderScrim: hits.some((hit) => !!hit && settingsPage.contains(hit)),
      };
    });
    expect(left.wasInert, 'Settings must be inert under the panel').toBe(true);
    expect(left.scrimBg, 'the scrim must be see-through').toBe('rgba(0, 0, 0, 0)');
    expect(left.layerShown, 'Settings must be drawn under the panel').toBe(true);
    expect(left.settingsUnderScrim, 'Settings must be what shows left of the panel').toBe(true);
    await driver.screenshot('panel-over-settings');

    // S1: closing the panel returns to Settings unchanged (same scroll, same tab).
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('account-panel')).toBeHidden();
    await expect(page.getByTestId('settings-page')).toBeVisible();
    expect(await settingsAt(), 'Settings must keep its scroll and tab').toEqual(before);

    // A panel row over Settings: the panel closes, Settings goes to that tab, focus lands on Back
    // (real inert is lifted before the focus trap returns focus; jsdom cannot model this).
    await page.getByTestId('nav-profile').click();
    await expect(page.getByTestId('nav-settings')).toBeVisible();
    await page.getByTestId('account-panel-row-settings-security').click();
    await expect(page.getByTestId('account-panel')).toBeHidden();
    await expect(page.getByTestId('settings-page')).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid ?? 'none'))
      .toBe('settings-close');

    // The panel cells below assume Settings is closed.
    await page.getByTestId('settings-close').click();
    await expect(page.getByTestId('settings-page')).toBeHidden();

    // BACKLOG-3964 slice 3a: the account side panel cells.
    const results = await runAccountPanelCells(page, {
      app: driver.app!,
      shot: (name) => driver!.screenshot(`panel-${name}`),
    });
    for (const r of results) expect(r.ok, `${r.id}: ${r.detail}`).toBe(true);
  });
});
