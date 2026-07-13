import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { KeeprAppDriver } from '../driver/appDriver';
import { resolveBuiltMainEntry, resolveElectronBinary } from '../driver/paths';
import { seedIsolatedProfile, type SeededIdentity } from '../driver/seed/seedProfile';
import {
  applyFixtureDbKey,
  buildExpectedCreate,
  countCreatedTransactions,
  FIXTURE_DB_KEY,
  KNOWN_CREATE_ADDRESS,
  KNOWN_CREATE_CONTACT_NAME,
  KNOWN_CREATE_ROLE,
  KNOWN_CREATE_START_DATE,
} from '../../scripts/qa/harness/create-audit-core';

/**
 * BACKLOG-1948 — the CREATE-AUDIT UI-flow cell.
 *
 * Proves, offline and deterministically (isolated profile, stub auth, NO real M365/OAuth/network),
 * that driving the New Audit wizard actually CREATES a transaction. It:
 *   1. seeds a FRESH isolated profile (fixed DB key, no keychain, single instance — all inherited from
 *      the 1971 driver core) that lands logged-in with 3 seeded, imported contacts;
 *   2. drives the New Audit CREATE flow via the logged driver:
 *        nav-new-audit → (create-manually-button, if the AI-add-on modal appears) → step 1 (enter a
 *        KNOWN, unique address + a FIXED start date) → step 2 (select the seeded contact) → step 3
 *        (assign it the Client role) → Create Transaction;
 *   3. ASSERTS the transaction was created TWO ways (verify by OBSERVING — BACKLOG-1875):
 *        (a) UI: a transactions-list row shows the entered address;
 *        (b) DB: the cipher-open count-transactions.js reader finds EXACTLY ONE transactions row with
 *            that address + started_at (the ground truth).
 *
 * OUTCOME DISCIPLINE (e2e/driver/outcome.ts): a missing testid / driver / setup failure is a
 * HARNESS_ERROR (a thrown Playwright error → the run is untrustworthy, NOT a false FAIL); a WRONG /
 * MISSING row is a FAIL (a real app bug); the correct single row is PASS. We NEVER fake the create.
 *
 * OFFLINE / NO-NETWORK: the address field is FREE-TEXT — the driver types the known address and never
 * selects a Google-Places suggestion (and dismisses the autocomplete dropdown), so there is no network
 * dependency. The known address is UNIQUE (not the seeded fixture address) so "exactly one row" is
 * unambiguous, and the start date is a FIXED past date so the DB match never depends on the clock.
 *
 * Lives in e2e/tests/ (under playwright.electron.config testDir ./tests), NOT e2e/driver/__tests__/
 * (the Node-jest CI run) — per the SR CI hard rule.
 *
 * Requires the app BUILT (dist-electron/main.js + dist/). If not built, SKIPPED with an actionable
 * message rather than false-failing — run `npm run build`.
 */

const REPO_ROOT = join(__dirname, '..', '..');
const SCRATCH = process.env.KEEPR_QA_SCRATCH ?? join(REPO_ROOT, '.qa-scratch');
const ARTIFACTS_DIR = join(REPO_ROOT, 'e2e', '.artifacts', 'create-audit');

let isBuilt = true;
try {
  resolveBuiltMainEntry(REPO_ROOT);
  if (!existsSync(join(REPO_ROOT, 'dist', 'index.html'))) isBuilt = false;
} catch {
  isBuilt = false;
}

const electronBin = (() => {
  try {
    return resolveElectronBinary(REPO_ROOT);
  } catch {
    return '';
  }
})();

/** Seed a FRESH isolated profile at a unique path (fixed DB key) and return its paths. */
async function freshSeed(tag: string): Promise<{ identity: SeededIdentity; profileDir: string; dbPath: string }> {
  const profileDir = join(SCRATCH, `create-audit-${tag}-profile`);
  if (existsSync(profileDir)) rmSync(profileDir, { recursive: true, force: true });
  mkdirSync(profileDir, { recursive: true });
  // SINGLE-INSTANCE / NO-KEYCHAIN (BACKLOG-1971): pin the FIXED DB key BEFORE seeding so the seeder
  // provisions the DB with it and the reader uses the same known key via --key. The app launch
  // inherits this env too, so it opens the DB with the fixed key (no keychain, no second instance).
  applyFixtureDbKey();
  const identity = await seedIsolatedProfile(REPO_ROOT, profileDir);
  return { identity, profileDir, dbPath: join(profileDir, 'mad.db') };
}

/** Launch unpackaged, land logged-in, dismiss the tour, and land on the ready dashboard. */
async function launchReady(profileDir: string): Promise<KeeprAppDriver> {
  const driver = await KeeprAppDriver.launch(REPO_ROOT, {
    strategy: 'unpackaged',
    reuseProfile: false,
    userDataDir: profileDir,
    repoRoot: REPO_ROOT,
    artifactsDir: ARTIFACTS_DIR,
    launchTimeoutMs: 60_000,
  });
  await driver.waitForFirstPaint(60_000);
  await driver.bringToFront();
  const ready = await driver.waitForReady(30_000);
  expect(ready, 'seeded session should authenticate with no login wall (else HARNESS_ERROR)').toBe(true);
  await driver.dismissTour();
  return driver;
}

test.describe('create-audit UI flow cell (BACKLOG-1948)', () => {
  test.skip(!isBuilt, 'App is not built. Run `npm run build`.');
  test.skip(!electronBin, 'Local electron binary missing — run `npm install`.');
  // Full app launch + seed + wizard + DB read; give it room (single worker, no retries — see config).
  test.setTimeout(240_000);

  test('driving the New Audit wizard creates EXACTLY ONE transaction with the entered address + window', async () => {
    const expected = buildExpectedCreate();
    const { profileDir, dbPath } = await freshSeed('create');
    const dbKey = FIXTURE_DB_KEY;

    // Precondition: on the clean seeded profile there is NO transaction with our unique address yet.
    // (A pre-existing match would be a SETUP problem — surface it as a thrown HARNESS_ERROR.)
    const before = countCreatedTransactions(REPO_ROOT, electronBin, dbKey, dbPath, expected.address, expected.startedAtPrefix);
    if (before.n !== 0) {
      throw new Error(`[create-audit] setup: expected 0 pre-existing rows for "${expected.address}", found ${before.n}.`);
    }

    const driver = await launchReady(profileDir);
    try {
      await driver.screenshot('01-dashboard');

      // DRIVE the create flow. Any missing testid / step throws → HARNESS_ERROR (never a false FAIL).
      await driver.createTransactionViaWizard({
        address: KNOWN_CREATE_ADDRESS,
        startDate: KNOWN_CREATE_START_DATE,
        // ID-AGNOSTIC (BACKLOG-1948/1949): select the seeded contact by its VISIBLE NAME, not a seed id.
        contactName: KNOWN_CREATE_CONTACT_NAME,
        role: KNOWN_CREATE_ROLE,
        transactionType: 'purchase',
      });
      await driver.screenshot('02-after-create');

      // On success the app auto-opens the Transaction Details modal over the (already-open)
      // transactions list; its `fixed inset-0 z-[60]` overlay intercepts pointer events on the list
      // and the dashboard nav. Dismiss it before navigating so the list assertion is reachable. This
      // is a no-op if (unexpectedly) no modal is open.
      await driver.dismissTransactionDetailsIfOpen();

      // ---- ASSERTION (a): the new transaction appears in the transactions LIST with our address. ----
      // gotoTransactions() is now a no-op when the list is already open (BACKLOG-1948 guard): it just
      // confirms tx-list is present rather than re-clicking the (covered) dashboard nav.
      await driver.gotoTransactions();
      const streetOnly = KNOWN_CREATE_ADDRESS.split(',')[0];
      await expect(
        driver.page.getByText(streetOnly, { exact: false }).first(),
        `the created transaction should appear in the list with address "${KNOWN_CREATE_ADDRESS}"`,
      ).toBeVisible({ timeout: 15_000 });
      await driver.screenshot('03-transactions-list');

      // ---- ASSERTION (b): the DB has EXACTLY ONE transactions row with that address + started_at. ----
      const after = countCreatedTransactions(REPO_ROOT, electronBin, dbKey, dbPath, expected.address, expected.startedAtPrefix);
      // eslint-disable-next-line no-console
      console.log(`[create-audit] DB rows for "${expected.address}": ${after.n} (expected ${expected.expectedCount}); sample=${JSON.stringify(after.sample)}`);
      // IDENTITY assertion (not count-only): the set of matching rows must be EXACTLY the one row whose
      // property_address is the entered address. A count of 1 alone could be the WRONG row; we pin the
      // identifying field. n is asserted too as a redundant guard, but the identity is the real gate.
      const matchedAddresses = after.sample.map((r) => r.property_address);
      expect(
        matchedAddresses,
        `the reader should return EXACTLY the one created row for "${expected.address}"`,
      ).toEqual([expected.address]);
      expect(after.n, 'exactly one transactions row should be created for the entered address').toBe(expected.expectedCount);
      const row = after.sample[0];
      expect(row?.property_address, 'the created row stores the entered property_address').toBe(expected.address);
      expect(row?.started_at ?? '', 'the created row stores the entered start date').toContain(expected.startedAtPrefix);
    } finally {
      await driver.closeAndWait().catch(() => undefined);
    }
  });
});
