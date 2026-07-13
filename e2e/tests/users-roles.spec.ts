import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { KeeprAppDriver } from '../driver/appDriver';
import { resolveBuiltMainEntry, resolveElectronBinary } from '../driver/paths';
import { seedIsolatedProfile, type SeededIdentity } from '../driver/seed/seedProfile';
import {
  applyFixtureDbKey,
  diffRoles,
  EXPECTED_ROLE_TRIPLES,
  FIXTURE_DB_KEY,
  readContactRoles,
} from '../../scripts/qa/harness/users-roles-core';

/**
 * BACKLOG-1949 — the FIXTURE-BASED add-users-with-roles EXACT-ROLE cell.
 *
 * Proves, offline and deterministically (isolated profile, stub auth, NO real M365/OAuth/network),
 * that driving the app's "Edit Contacts" UI to ADD contacts to a transaction WITH SPECIFIC ROLES
 * persists each contact into the `transaction_contacts` junction with the CORRECT role triple.
 *
 * SETUP (mirrors the 1950 cell): a FRESH isolated profile is seeded per run with the FIXED DB key
 * (no keychain / no safeStorage / single Electron instance). The seeder is run with
 * KEEPR_QA_UNASSIGN_CONTACTS=1 so the 3 fixture contacts exist but are NOT yet assigned to the
 * transaction (they appear in the "Add Contacts" Screen-2 list; the junction starts EMPTY). This makes
 * the cell deterministically RE-RUNNABLE against the UNIQUE(transaction_id, contact_id) constraint —
 * each run starts from a clean junction on a fresh --user-data-dir, so the add flow is the SOLE cause
 * of the rows we then read.
 *
 * FLOW: open the seeded transaction (overview tab) → "Edit Contacts" (LIVE trigger; BACKLOG-1949 added
 * its testid) → Screen 2, select the 3 seeded contacts by data-contact-id → "Add Selected" → Screen 1,
 * assign each an explicit PURCHASE-VALID role via its role <select> (by option VALUE) → Save.
 *
 * ROLES (SR-reviewed, purchase-valid — see users-roles-core.ts): the fixture tx is `purchase`, so the
 * role dropdown offers only seller / seller_agent (Client & Agents step, purchase-filtered) and
 * escrow_officer (unfiltered Professional Services step). Assigned (contact IDs are the fixture's fixed,
 * VALID UUIDs — QA_SEED_CONTACT_IDS in users-roles-core.ts / seed-fixture.js; BACKLOG-1949 replaced the
 * old non-UUID qa-seed-contact-N literals, which the app's Save-path UUID validator rejected):
 *   QA_SEED_CONTACT_IDS[1] (Alice Buyer)  → seller (category client)
 *   QA_SEED_CONTACT_IDS[2] (Bob Seller)   → seller_agent (category agent)
 *   QA_SEED_CONTACT_IDS[3] (Carol Escrow) → escrow_officer (category title_escrow)
 *
 * TWO independent assertions, both required (verify by OBSERVING — BACKLOG-1875):
 *   A) RENDERED UI STATE — each role <select> shows the value we set (before Save).
 *   B) ENCRYPTED-DB TRUTH — after Save, the fixed-key reader reads transaction_contacts and diffRoles
 *      confirms the FULL triple {role, role_category, specific_role} per contact (validates the
 *      ROLE_TO_CATEGORY derivation end-to-end).
 *
 * DETERMINISM GUARD (BACKLOG-1355): auto-role is OFF for a fresh seeded profile (no preference row),
 * so nothing pre-fills roles. The spec ASSERTS the empty "Select role..." state on each row BEFORE
 * setting it — a future default flip surfaces HERE, rather than as a silent flaky headful run.
 *
 * OUTCOME DISCIPLINE (e2e/driver/outcome.ts): a missing testid / driver / setup failure is a
 * HARNESS_ERROR (a thrown Playwright error → the run is untrustworthy, NOT a false FAIL); a WRONG or
 * MISSING role is a FAIL (a real app bug); correct roles are PASS. We NEVER fake roles to make it green.
 *
 * Lives in e2e/tests/ (under playwright.electron.config testDir ./tests), NOT e2e/driver/__tests__/
 * (the Node-jest CI run) — per the SR CI hard rule.
 *
 * Requires the app BUILT (dist-electron/main.js + dist/). If not built, SKIPPED with an actionable
 * message rather than false-failing — run `npm run build`.
 */

const REPO_ROOT = join(__dirname, '..', '..');
const SCRATCH = process.env.KEEPR_QA_SCRATCH ?? join(REPO_ROOT, '.qa-scratch');
const ARTIFACTS_DIR = join(REPO_ROOT, 'e2e', '.artifacts', 'users-roles');

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

/** Seed a FRESH isolated profile with the contacts UNASSIGNED (empty junction) and return paths. */
async function freshSeedUnassigned(
  tag: string,
): Promise<{ identity: SeededIdentity; profileDir: string; dbPath: string }> {
  const profileDir = join(SCRATCH, `users-roles-${tag}-profile`);
  if (existsSync(profileDir)) rmSync(profileDir, { recursive: true, force: true });
  mkdirSync(profileDir, { recursive: true });
  // FIXED DB key BEFORE seeding (no safeStorage; the app launch inherits it → single instance, no
  // keychain). KEEPR_QA_UNASSIGN_CONTACTS=1 → the 3 contacts are seeded but assigned to 0 transactions.
  applyFixtureDbKey();
  const savedUnassign = process.env.KEEPR_QA_UNASSIGN_CONTACTS;
  process.env.KEEPR_QA_UNASSIGN_CONTACTS = '1';
  try {
    const identity = await seedIsolatedProfile(REPO_ROOT, profileDir);
    return { identity, profileDir, dbPath: join(profileDir, 'mad.db') };
  } finally {
    if (savedUnassign === undefined) delete process.env.KEEPR_QA_UNASSIGN_CONTACTS;
    else process.env.KEEPR_QA_UNASSIGN_CONTACTS = savedUnassign;
  }
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

  // Confirm the opened detail view is the seeded transaction (overview tab is the default).
  const streetOnly = identity.propertyAddress.split(',')[0];
  await expect(
    driver.page.getByText(streetOnly, { exact: false }).first(),
    `opened transaction should show the seeded address "${identity.propertyAddress}"`,
  ).toBeVisible({ timeout: 15_000 });

  return driver;
}

test.describe('add-users-with-roles exact-role cell (BACKLOG-1949)', () => {
  test.skip(!isBuilt, 'App is not built. Run `npm run build` (headful/live run is founder-gated).');
  test.skip(!electronBin, 'Local electron binary missing — run `npm install`.');
  // Full app launch + seed + UI drive + DB read; give it room (single worker, no retries — see config).
  test.setTimeout(240_000);

  test('adds 3 contacts each with the correct PURCHASE-valid role; DB junction carries the exact triple', async () => {
    const { identity, profileDir, dbPath } = await freshSeedUnassigned('main');
    const dbKey = FIXTURE_DB_KEY;
    const contactIds = EXPECTED_ROLE_TRIPLES.map((t) => t.contactId);

    // Precondition (setup, not app-behaviour): the junction starts EMPTY on the fresh unassigned seed.
    // A non-empty start is a SETUP/HARNESS failure (env-gate didn't apply), surfaced by throwing here.
    const before = readContactRoles(REPO_ROOT, electronBin, dbKey, dbPath, identity.transactionId);
    if (before.length !== 0) {
      throw new Error(
        `[users-roles] setup failed: expected 0 assigned contacts on the fresh unassigned seed, found ${before.length} (KEEPR_QA_UNASSIGN_CONTACTS did not take effect).`,
      );
    }

    const driver = await driveToTransactionOverview(profileDir, identity);
    try {
      await driver.screenshot('01-transaction-overview');

      // Open the modal and add the 3 seeded contacts (junction still empty at this point).
      await driver.openEditContacts();
      await driver.screenshot('02-edit-contacts-modal');
      await driver.addContactsById(contactIds);
      await driver.screenshot('03-contacts-added-unassigned');

      // DETERMINISM GUARD: each row starts with NO role ("Select role..." = empty value). If a future
      // auto-role default flip pre-fills these, this assertion catches it (deterministically) here.
      for (const id of contactIds) {
        expect(
          await driver.readAssignedRole(id),
          `contact "${id}" should start with no role assigned (auto-role must be OFF)`,
        ).toBe('');
      }

      // Assign each contact its explicit, purchase-valid role by OPTION VALUE.
      for (const t of EXPECTED_ROLE_TRIPLES) {
        await driver.assignRole(t.contactId, t.role);
      }
      await driver.screenshot('04-roles-assigned');

      // ASSERT A — RENDERED UI STATE: each <select> now shows the value we set (before Save).
      for (const t of EXPECTED_ROLE_TRIPLES) {
        expect(
          await driver.readAssignedRole(t.contactId),
          `UI role for "${t.contactId}" should read "${t.role}" before save`,
        ).toBe(t.role);
      }

      // Persist (batchUpdateContacts) and wait for the modal to close.
      await driver.saveContacts();
      await driver.screenshot('05-saved');

      // ASSERT B — ENCRYPTED-DB TRUTH: read the junction and diff the FULL triple per contact.
      const observed = readContactRoles(REPO_ROOT, electronBin, dbKey, dbPath, identity.transactionId);
      // eslint-disable-next-line no-console
      console.log(`[users-roles] DB junction rows: ${JSON.stringify(observed)}`);
      const deviations = diffRoles(EXPECTED_ROLE_TRIPLES, observed);
      // A deviation here is a FAIL (a real role-persistence / category-derivation bug) — exactly the bug
      // class this cell exists to catch. We do NOT fake roles to pass.
      expect(deviations, `role deviations: ${JSON.stringify(deviations)}`).toEqual([]);
      expect(observed.length, 'exactly the 3 driven contacts are assigned (no extras)').toBe(3);
    } finally {
      await driver.closeAndWait().catch(() => undefined);
    }
  });
});
