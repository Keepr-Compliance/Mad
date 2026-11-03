import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type ElectronApplication } from '@playwright/test';
import { KeeprAppDriver } from '../driver/appDriver';
import { resolveBuiltMainEntry } from '../driver/paths';
import { seedIsolatedProfile } from '../driver/seed/seedProfile';

/**
 * BACKLOG-4115 PR-3 — the title-bar device sync pill, in the BUILT app (SR B4).
 *
 * The import source comes from `preferences:get` (electron/preload/settingsBridge.ts:14 →
 * electron/handlers/preferenceHandlers.ts:33-46, cloud preferences the token-less fixture cannot
 * seed); with nothing stored on macOS it is "macos-native" and no pill renders. Each cell therefore
 * re-registers that ONE main-process handler at runtime (precedent: appDriver.ts stubFolderDialog)
 * to return the handler's own response shape `{ success: true, preferences: {...} }` with
 * `messages.source` set, then reloads the page so IPhoneSyncProvider and useImportSource re-read.
 * No app code changes; nothing else is stubbed — the pill's state comes from the real producers.
 *
 * Caution: source "iphone-sync" starts REAL USB device detection on the machine running the cell
 * (read-only) for the cell's lifetime.
 *
 * Launch only with --user-data-dir isolation and the walkthrough safeguards, never a fake HOME.
 * Replayed by the walkthrough runner (cells4115pill); see the BUILD 4115 PR-3 hand-off.
 */

const REPO_ROOT = join(__dirname, '..', '..');
const PROFILE_DIR = process.env.QA_PROFILE_DIR ?? join(REPO_ROOT, '.qa-scratch', 'keepr-dashboard-4115-pill-profile');
const ARTIFACTS_DIR = join(REPO_ROOT, 'e2e', '.artifacts', 'dashboard-4115-pill');

let isBuilt = true;
try {
  resolveBuiltMainEntry(REPO_ROOT);
  if (!existsSync(join(REPO_ROOT, 'dist', 'index.html'))) isBuilt = false;
} catch {
  isBuilt = false;
}

/** Re-register `preferences:get` to report `source` (null = restore nothing stored: `{}`). */
async function overrideImportSource(app: ElectronApplication, source: string | null): Promise<void> {
  await app.evaluate(async ({ ipcMain }, src) => {
    ipcMain.removeHandler('preferences:get');
    ipcMain.handle('preferences:get', async () => ({
      success: true,
      preferences: src ? { messages: { source: src } } : {},
    }));
  }, source);
}

test.describe('Title-bar sync pill (BACKLOG-4115 PR-3)', () => {
  test.skip(!isBuilt, 'App is not built. Run `npm run build` first.');
  test.setTimeout(240_000);

  let driver: KeeprAppDriver | undefined;

  test.beforeAll(async () => {
    if (existsSync(PROFILE_DIR)) rmSync(PROFILE_DIR, { recursive: true, force: true });
    mkdirSync(PROFILE_DIR, { recursive: true });
    await seedIsolatedProfile(REPO_ROOT, PROFILE_DIR);
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
  });

  test.afterAll(async () => {
    await driver?.close().catch(() => undefined);
  });

  const pill = () => driver!.page.getByTestId('title-bar-sync-pill');

  async function withSource(source: string | null): Promise<void> {
    await overrideImportSource(driver!.app!, source);
    await driver!.page.reload();
    expect(await driver!.waitForReady(30_000)).toBe(true);
    await driver!.dismissTour();
    await driver!.page.setViewportSize({ width: 1280, height: 800 });
  }

  // Positive control: the fixture's own source (macos-native) shows no pill.
  test('P0 no override (macos-native): no pill', async () => {
    await expect(driver!.page.getByTestId('nav-new-audit')).toBeVisible();
    await driver!.page.waitForTimeout(2000);
    await expect(pill()).toHaveCount(0);
  });

  test('A source iphone-sync, no device: one pill, "iPhone", "Connect your iPhone by USB"', async () => {
    await withSource('iphone-sync');
    await expect(pill()).toHaveCount(1);
    await expect(pill()).toHaveText(/^iPhone$/);
    await expect(pill()).toHaveAttribute('title', 'Connect your iPhone by USB');
    await expect(pill()).toHaveAttribute('data-tour', 'sync-phone-card');
    await expect(pill()).toHaveClass(/no-drag-region/);
    await driver!.screenshot('4115-pill-iphone-not-connected');
  });

  test('B source android-messages-web: one Android pill from the real extension state', async () => {
    await withSource('android-messages-web');
    await expect(pill()).toHaveCount(1);
    await expect(pill()).toHaveAttribute('data-device', 'android');
    const title = await pill().getAttribute('title');
    // Record the real producer's state; expected A6, or A3 if another Keepr holds the bridge port.
    expect(['Install the Keepr extension', "Keepr can't listen for the extension (port in use)"]).toContain(title);
    await driver!.screenshot('4115-pill-android');
  });

  // H1 re-run under PR-3: no small row and no sync tiles on the dashboard.
  test('H1 (PR-3) no small row, no sync tiles; the action row still holds two tiles', async () => {
    await withSource('iphone-sync');
    await expect(driver!.page.getByTestId('dashboard-small-row')).toHaveCount(0);
    await expect(driver!.page.getByTestId('sync-android-card')).toHaveCount(0);
    await expect(driver!.page.getByTestId('dashboard-action-row').getByRole('button')).toHaveCount(2);
    await expect(driver!.page.locator('[data-tour="sync-phone-card"]')).toHaveCount(1);
  });
});
