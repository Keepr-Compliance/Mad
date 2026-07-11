import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { KeeprAppDriver } from '../driver/appDriver';
import { resolveBuiltMainEntry } from '../driver/paths';
import { seedIsolatedProfile, type SeededIdentity } from '../driver/seed/seedProfile';

/**
 * BACKLOG-1940 (pivot) — the reliable UNPACKAGED driver, as a Playwright spec.
 *
 * Mirrors the founder command (`npm run qa:drive`) under the Playwright runner so it is
 * repeatable and asserted: seed an isolated profile → launch UNPACKAGED (no packaging / codesign)
 * → land logged-in with NO OAuth → drive Settings + Transactions → open the first (real seeded)
 * transaction. It lives in e2e/tests/ (under the Playwright config), NOT e2e/driver/__tests__/,
 * so the Node-jest CI run never drags it in (per the SR CI directive).
 *
 * Requires the app to be BUILT (dist-electron/main.js + dist/). If it is not built, the spec is
 * SKIPPED with an actionable message rather than false-failing — run `npm run build` first, or use
 * `npm run qa:drive` which builds automatically.
 */

const REPO_ROOT = join(__dirname, '..', '..');
const PROFILE_DIR = process.env.QA_PROFILE_DIR ?? join(REPO_ROOT, '.qa-scratch', 'keepr-pivot-spec-profile');
const ARTIFACTS_DIR = join(REPO_ROOT, 'e2e', '.artifacts', 'driver-pivot');

let isBuilt = true;
try {
  resolveBuiltMainEntry(REPO_ROOT);
  if (!existsSync(join(REPO_ROOT, 'dist', 'index.html'))) isBuilt = false;
} catch {
  isBuilt = false;
}

test.describe('reliable unpackaged driver (BACKLOG-1940 pivot)', () => {
  test.skip(!isBuilt, 'App is not built. Run `npm run build` first, or use `npm run qa:drive` (builds automatically).');
  // This is a full app launch + seed; give it room (single worker, no retries — see the config).
  test.setTimeout(180_000);

  let driver: KeeprAppDriver | undefined;
  let identity: SeededIdentity;

  test.beforeAll(async () => {
    if (existsSync(PROFILE_DIR)) rmSync(PROFILE_DIR, { recursive: true, force: true });
    mkdirSync(PROFILE_DIR, { recursive: true });
    identity = await seedIsolatedProfile(REPO_ROOT, PROFILE_DIR);
  });

  test.afterAll(async () => {
    await driver?.close().catch(() => undefined);
  });

  test('lands logged-in (no OAuth), reaches Settings + Transactions, opens the seeded transaction', async () => {
    driver = await KeeprAppDriver.launch(REPO_ROOT, {
      strategy: 'unpackaged',
      reuseProfile: false,
      userDataDir: PROFILE_DIR,
      repoRoot: REPO_ROOT,
      artifactsDir: ARTIFACTS_DIR,
      launchTimeoutMs: 60_000,
    });
    expect(driver.strategy).toBe('unpackaged');

    await driver.waitForFirstPaint(60_000);
    await driver.bringToFront();

    // Logged-in with NO OAuth: the seeded session authenticates → dashboard nav renders.
    const ready = await driver.waitForReady(30_000);
    await driver.screenshot('logged-in');
    expect(ready, 'seeded session should authenticate with no login wall').toBe(true);
    expect(await driver.detectState()).toBe('ready');

    // Settings via testid.
    await driver.dismissTour();
    await driver.gotoSettings();
    await driver.screenshot('settings');
    await expect(driver.page.getByTestId('settings-page')).toBeVisible();
    await driver.closeSettings();

    // Transactions via testid — the seed guarantees >= 1 row.
    await driver.gotoTransactions();
    const listState = await driver.readTransactionsList();
    expect(listState.present, 'tx-list must be present (absence would be a harness/app-shape problem)').toBe(true);
    expect(listState.rowCount, 'seed guarantees at least one transaction').toBeGreaterThanOrEqual(1);
    await driver.screenshot('transactions');

    // Open the first row → it must be the REAL seeded transaction.
    const clickResult = await driver.clickFirstTransaction();
    expect(clickResult.clicked).toBe(true);
    const streetOnly = identity.propertyAddress.split(',')[0];
    await expect(
      driver.page.getByText(streetOnly, { exact: false }).first(),
      `opened transaction should show the seeded address "${identity.propertyAddress}"`,
    ).toBeVisible({ timeout: 15_000 });
    await driver.screenshot('transaction-open');
  });
});
