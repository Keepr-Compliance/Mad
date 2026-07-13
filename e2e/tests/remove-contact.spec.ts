import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { KeeprAppDriver } from '../driver/appDriver';
import { resolveBuiltMainEntry, resolveElectronBinary } from '../driver/paths';
import { seedIsolatedProfile, type SeededIdentity } from '../driver/seed/seedProfile';
import { FIXTURE_DB_KEY, applyFixtureDbKey } from '../../scripts/qa/harness/db-key-fixture';
import { readContactRoles } from '../../scripts/qa/harness/users-roles-core';
import {
  CONTACT_TO_REMOVE,
  EXPECTED_REMAINING_CONTACT_IDS,
  SEEDED_ASSIGNED_CONTACT_IDS,
  diffRemoval,
} from '../../scripts/qa/harness/remove-contact-core';

/**
 * BACKLOG-1978 (P2-C2) — the FIXTURE-BASED remove-contact-from-transaction cell.
 *
 * EXTENDS the add-users-with-roles cell (BACKLOG-1949). That cell drove the "Edit Contacts" UI to ADD
 * contacts and asserted the exact role triple landed in `transaction_contacts`. THIS cell starts from the
 * DEFAULT seeded state — the 3 fixture contacts ALREADY assigned — drives the UI to REMOVE the MIDDLE one
 * via its per-chip remove control, Saves, and proves the removed contact's junction row is GONE while the
 * other two REMAIN.
 *
 * SETUP (mirrors the 1949 cell, but the DEFAULT assigned seed): a FRESH isolated profile is seeded per run
 * with the FIXED DB key (no keychain / no safeStorage / single Electron instance). Unlike 1949 we do NOT
 * set KEEPR_QA_UNASSIGN_CONTACTS — so the 3 fixture contacts are assigned to the transaction (the junction
 * starts with 3 rows). A fresh --user-data-dir per run makes the cell deterministically RE-RUNNABLE: each
 * run starts from the same 3-assigned junction, so the remove flow is the SOLE cause of the delta we read.
 *
 * FLOW: open the seeded transaction (overview tab) → "Edit Contacts" (BACKLOG-1949 testid) → Screen 1
 * shows the 3 assigned contacts → click the per-chip remove button (remove-contact-<id>) on the MIDDLE
 * contact → Save → the diff sends `action:"remove"` for that contact via batchUpdateContacts.
 *
 * ORACLE — JUNCTION DELTA ONLY (verify-by-OBSERVING, BACKLOG-1875): after Save, the fixed-key reader reads
 * `transaction_contacts` and diffRemoval confirms the junction is EXACTLY the two survivors — the removed
 * row is gone AND both others remain. We assert ONLY which contact_ids remain; role triples are NOT
 * compared (that is BACKLOG-1949's job), and communications are EXPLICITLY OUT OF SCOPE (removing a contact
 * may auto-unlink its communications — this cell makes NO assertion on `communications`).
 *
 * OUTCOME DISCIPLINE (e2e/driver/outcome.ts): a missing testid / driver / setup failure is a HARNESS_ERROR
 * (a thrown Playwright error → the run is untrustworthy, NOT a false FAIL). A precheck asserts the 3
 * contacts are assigned at start; if they are not, we THROW (setup/env problem), never a false PASS/FAIL.
 * A wrongly-removed / not-removed row is a FAIL (a real app bug). Correct delta is PASS. We NEVER fake the
 * junction to make it green.
 *
 * Lives in e2e/tests/ (under playwright.electron.config testDir ./tests), NOT e2e/driver/__tests__/ (the
 * Node-jest CI run) — per the SR CI hard rule.
 *
 * Requires the app BUILT (dist-electron/main.js + dist/). If not built, SKIPPED with an actionable message
 * rather than false-failing — run `npm run build` (a headful/live run is founder-gated).
 */

const REPO_ROOT = join(__dirname, '..', '..');
const SCRATCH = process.env.KEEPR_QA_SCRATCH ?? join(REPO_ROOT, '.qa-scratch');
const ARTIFACTS_DIR = join(REPO_ROOT, 'e2e', '.artifacts', 'remove-contact');

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

/** Seed a FRESH isolated profile with the 3 contacts ASSIGNED (default seed path) and return paths. */
async function freshSeedAssigned(
  tag: string,
): Promise<{ identity: SeededIdentity; profileDir: string; dbPath: string }> {
  const profileDir = join(SCRATCH, `remove-contact-${tag}-profile`);
  if (existsSync(profileDir)) rmSync(profileDir, { recursive: true, force: true });
  mkdirSync(profileDir, { recursive: true });
  // FIXED DB key BEFORE seeding (no safeStorage; the app launch inherits it → single instance, no
  // keychain). We do NOT set KEEPR_QA_UNASSIGN_CONTACTS, so the 3 contacts ARE assigned to the tx (the
  // default seed path) — the junction starts with 3 rows and the cell drives a removal from there.
  applyFixtureDbKey();
  const identity = await seedIsolatedProfile(REPO_ROOT, profileDir);
  return { identity, profileDir, dbPath: join(profileDir, 'mad.db') };
}

/** Launch unpackaged, land logged-in, open the seeded transaction, land on the overview tab. */
async function driveToTransactionOverview(
  profileDir: string,
  identity: SeededIdentity,
): Promise<KeeprAppDriver> {
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
  await driver.gotoTransactions();
  const clickResult = await driver.clickFirstTransaction();
  expect(clickResult.clicked, 'first (seeded) transaction should be clickable').toBe(true);

  const streetOnly = identity.propertyAddress.split(',')[0];
  await expect(
    driver.page.getByText(streetOnly, { exact: false }).first(),
    `opened transaction should show the seeded address "${identity.propertyAddress}"`,
  ).toBeVisible({ timeout: 15_000 });

  return driver;
}

test.describe('remove-contact-from-transaction cell (BACKLOG-1978)', () => {
  test.skip(!isBuilt, 'App is not built. Run `npm run build` (headful/live run is founder-gated).');
  test.skip(!electronBin, 'Local electron binary missing — run `npm install`.');
  // Full app launch + seed + UI drive + DB read; give it room (single worker, no retries — see config).
  test.setTimeout(240_000);

  test('removes one assigned contact; DB junction keeps exactly the other two', async () => {
    const { identity, profileDir, dbPath } = await freshSeedAssigned('main');
    const dbKey = FIXTURE_DB_KEY;

    // Precondition (setup, not app-behaviour): the junction starts with EXACTLY the 3 seeded contacts.
    // Anything else is a SETUP/HARNESS failure (default assigned seed didn't take effect), surfaced by
    // throwing here (→ HARNESS_ERROR), NEVER a false PASS/FAIL.
    const before = readContactRoles(REPO_ROOT, electronBin, dbKey, dbPath, identity.transactionId);
    const beforeIds = before.map((r) => r.contact_id).sort();
    const expectedStart = [...SEEDED_ASSIGNED_CONTACT_IDS].sort();
    if (beforeIds.length !== 3 || JSON.stringify(beforeIds) !== JSON.stringify(expectedStart)) {
      throw new Error(
        `[remove-contact] setup failed: expected the 3 seeded contacts assigned at start ` +
          `(${expectedStart.join(', ')}), found ${before.length}: [${beforeIds.join(', ')}]. ` +
          `The default assigned seed did not take effect.`,
      );
    }

    const driver = await driveToTransactionOverview(profileDir, identity);
    try {
      await driver.screenshot('01-transaction-overview');

      // Open the modal; Screen 1 shows the 3 assigned contacts (junction still has 3 rows at this point).
      await driver.openEditContacts();
      await driver.screenshot('02-edit-contacts-modal');

      // REMOVE the middle contact via its per-chip remove control, then Save (batchUpdateContacts remove).
      await driver.removeContact(CONTACT_TO_REMOVE);
      await driver.screenshot('03-contact-removed-pre-save');
      await driver.saveContacts();
      await driver.screenshot('04-saved');

      // ORACLE — JUNCTION DELTA: read the junction and confirm it is EXACTLY the two survivors.
      const observed = readContactRoles(REPO_ROOT, electronBin, dbKey, dbPath, identity.transactionId);
      // eslint-disable-next-line no-console
      console.log(`[remove-contact] DB junction rows after remove: ${JSON.stringify(observed)}`);
      const deviations = diffRemoval(EXPECTED_REMAINING_CONTACT_IDS, CONTACT_TO_REMOVE, observed);
      // A deviation here is a FAIL (removed the wrong row / didn't remove / spurious row) — the exact bug
      // class this cell exists to catch. We do NOT fake the junction to pass.
      expect(deviations, `removal deviations: ${JSON.stringify(deviations)}`).toEqual([]);
      expect(observed.length, 'exactly the 2 survivors remain (removed row gone, no extras)').toBe(2);
    } finally {
      await driver.closeAndWait().catch(() => undefined);
    }
  });
});
