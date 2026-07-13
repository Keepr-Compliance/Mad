import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { KeeprAppDriver } from '../driver/appDriver';
import { resolveBuiltMainEntry, resolveElectronBinary } from '../driver/paths';
import { seedIsolatedProfile, type SeededIdentity } from '../driver/seed/seedProfile';
import { applyFixtureDbKey, FIXTURE_DB_KEY } from '../../scripts/qa/harness/db-key-fixture';
import { countLinkedEmailsBySource } from '../../scripts/qa/harness/manual-attach-core';

/**
 * BACKLOG-1979 (P2-C3) — the MANUAL-ATTACH-EMAIL exact-count harness cell.
 *
 * Proves, offline and deterministically (isolated profile, stub auth, NO real M365/OAuth/network),
 * that MANUALLY attaching an unlinked email through the AttachEmailsModal writes EXACTLY ONE
 * communications row for that email with link_source='manual' — the fixture analog of a real analyst
 * hand-linking a stray email to a transaction.
 *
 * THE TARGET EMAIL (env-gated seed variant KEEPR_QA_MANUAL_ATTACH=1 — see seed-fixture.js): one extra
 * email (`qa-seed-email-manual-attach-1`) that is a LEGITIMATE participant+address match for the
 * transaction but is sent BEFORE the transaction date window. The on-open auto-link (BACKLOG-1802)
 * enforces that window, so it NEVER links this email — it starts genuinely UNLINKED, and the MANUAL
 * attach flow is the ONLY path to a communications row for it. That makes the assertion unambiguous:
 * a manual link appearing for this email can ONLY have come from the flow we drove. The DEFAULT seed
 * path stays byte-identical (the fidelity guard fixture-filter-counts.fidelity.test.ts remains 7/7;
 * proven count-neutral by manual-attach-seed.test.ts).
 *
 * THE FLOW: open the Emails tab → `attach-emails-button` → AttachEmailsModal → type the target's
 * unique subject token into the server-side search (500ms debounce → getUnlinkedEmails, served from
 * the local cache offline via getCachedEmails) → the sole result thread → confirm (`attach-button` →
 * transactions:link-emails → createCommunication({ link_source: 'manual' })).
 *
 * TRUST DISCIPLINE (e2e/driver/outcome.ts): a missing testid / launch / setup failure is a
 * HARNESS_ERROR (thrown → the run is untrustworthy, NOT a false FAIL). A wrong link_source or count is
 * a FAIL (a real app bug). Correct counts are PASS. We NEVER fake counts to go green. As a HARNESS_ERROR
 * PRECHECK we assert the target starts UNLINKED (0 manual links) before driving the flow — if it were
 * already linked, the +1 delta would be meaningless, so a non-zero precount is a thrown setup error.
 *
 * Lives in e2e/tests/ (under playwright.electron.config testDir ./tests), NOT e2e/driver/__tests__/
 * (the Node-jest CI run) — per the SR CI hard rule. Requires the app BUILT (dist-electron/main.js +
 * dist/); if not built, SKIPPED with an actionable message so CI stays green without a launch.
 */

const REPO_ROOT = join(__dirname, '..', '..');
const SCRATCH = process.env.KEEPR_QA_SCRATCH ?? join(REPO_ROOT, '.qa-scratch');
const ARTIFACTS_DIR = join(REPO_ROOT, 'e2e', '.artifacts', 'manual-attach');

/** The env-gated target email id + its unique, corpus-isolating search token (from seed-fixture.js). */
const TARGET_EMAIL_ID = 'qa-seed-email-manual-attach-1';
const TARGET_SEARCH_TOKEN = 'manualattachtarget';

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

/** Seed a FRESH isolated profile with the manual-attach target email present, returning its paths. */
async function freshSeedWithManualAttachTarget(
  tag: string,
): Promise<{ identity: SeededIdentity; profileDir: string; dbPath: string }> {
  const profileDir = join(SCRATCH, `manual-attach-${tag}-profile`);
  if (existsSync(profileDir)) rmSync(profileDir, { recursive: true, force: true });
  mkdirSync(profileDir, { recursive: true });
  // Fixed keychain-free DB key for the seeder AND every reader (BACKLOG-1950/1971 contract).
  applyFixtureDbKey();
  const saved = process.env.KEEPR_QA_MANUAL_ATTACH;
  process.env.KEEPR_QA_MANUAL_ATTACH = '1';
  try {
    const identity = await seedIsolatedProfile(REPO_ROOT, profileDir);
    return { identity, profileDir, dbPath: join(profileDir, 'mad.db') };
  } finally {
    if (saved === undefined) delete process.env.KEEPR_QA_MANUAL_ATTACH;
    else process.env.KEEPR_QA_MANUAL_ATTACH = saved;
  }
}

/** Launch unpackaged, land logged-in, open the seeded transaction, land on the Emails tab. */
async function driveToEmailsTab(profileDir: string, identity: SeededIdentity): Promise<KeeprAppDriver> {
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

  // Confirm the opened detail view is the seeded transaction.
  const streetOnly = identity.propertyAddress.split(',')[0];
  await expect(
    driver.page.getByText(streetOnly, { exact: false }).first(),
    `opened transaction should show the seeded address "${identity.propertyAddress}"`,
  ).toBeVisible({ timeout: 15_000 });

  // Open the Emails tab (a <button>Emails</button> — no testid on the tab itself).
  await driver.page.getByRole('button', { name: 'Emails' }).first().click();
  await driver.page.waitForTimeout(1500); // let the tab mount + loadCommunications settle
  await driver.screenshot('00-emails-tab-opened');
  return driver;
}

test.describe('manual attach-email exact-count cell (BACKLOG-1979)', () => {
  test.skip(!isBuilt, 'App is not built. Run `npm run build` (or `npm run qa:filter-toggle` builds the same app), then re-run.');
  test.skip(!electronBin, 'Local electron binary missing — run `npm install`.');
  test.setTimeout(240_000);

  test('manually attaching an unlinked email links EXACTLY that one email with link_source=manual (+1 delta)', async () => {
    const { identity, profileDir, dbPath } = await freshSeedWithManualAttachTarget('manual');
    const dbKey = FIXTURE_DB_KEY;
    const txId = identity.transactionId;

    const driver = await driveToEmailsTab(profileDir, identity);
    try {
      // ---- HARNESS_ERROR PRECHECK: the target email starts UNLINKED. The on-open auto-link enforces
      // the transaction date window, and the target is OUT of that window, so it must be 0. If it is
      // already linked, the +1 delta is meaningless — surface it as a thrown setup error, NOT a FAIL.
      const preManualForTarget = countLinkedEmailsBySource(REPO_ROOT, electronBin, dbKey, dbPath, txId, {
        linkSource: 'manual',
        emailId: TARGET_EMAIL_ID,
      });
      if (preManualForTarget !== 0) {
        throw new Error(
          `[manual-attach] precondition failed: the target email ${TARGET_EMAIL_ID} is ALREADY linked (manual=${preManualForTarget}) before the manual flow ran — setup problem, not an app FAIL.`,
        );
      }
      // Baseline of ALL manual links on the transaction (should also be 0 — nothing is manually linked
      // yet; the on-open auto-link, if any, is source='auto'). Used to assert the EXACT +1 delta below.
      const preManualTotal = countLinkedEmailsBySource(REPO_ROOT, electronBin, dbKey, dbPath, txId, {
        linkSource: 'manual',
      });
      // eslint-disable-next-line no-console
      console.log(`[manual-attach] pre-attach manual links: target=${preManualForTarget} total=${preManualTotal}`);
      expect(preManualForTarget, 'target starts with 0 manual links (clean precondition)').toBe(0);

      // ---- Drive the manual attach flow.
      await driver.openAttachEmailsModal();
      await driver.screenshot('01-attach-modal-open');

      // Search by the target's UNIQUE token so the result set is exactly the one target thread.
      await driver.searchAttachEmails(TARGET_SEARCH_TOKEN);
      await driver.screenshot('02-search-results');
      const visibleThreads = await driver.visibleAttachThreadCount();
      // Exactly one result is a SETUP invariant (the token is unique across the corpus). A different
      // count means the search did not isolate the target — a HARNESS_ERROR, surfaced by selectSole…().
      expect(
        visibleThreads,
        `search "${TARGET_SEARCH_TOKEN}" should surface exactly 1 unlinked thread (the manual-attach target)`,
      ).toBe(1);

      await driver.selectSoleAttachThread();
      await driver.screenshot('03-thread-selected');
      await driver.confirmAttachEmails();
      await driver.page.waitForTimeout(1000); // let the link write + modal close settle
      await driver.screenshot('04-after-attach');

      // ---- OBSERVE the DB: the target email now has EXACTLY ONE manual link, and the transaction's
      // total manual-link count incremented by EXACTLY ONE. A wrong link_source or count is a FAIL.
      const postManualForTarget = countLinkedEmailsBySource(REPO_ROOT, electronBin, dbKey, dbPath, txId, {
        linkSource: 'manual',
        emailId: TARGET_EMAIL_ID,
      });
      const postManualTotal = countLinkedEmailsBySource(REPO_ROOT, electronBin, dbKey, dbPath, txId, {
        linkSource: 'manual',
      });
      // eslint-disable-next-line no-console
      console.log(`[manual-attach] post-attach manual links: target=${postManualForTarget} total=${postManualTotal}`);

      expect(
        postManualForTarget,
        'the target email must have exactly one communications row with link_source=manual',
      ).toBe(1);
      expect(
        postManualTotal - preManualTotal,
        'the transaction manual-link count must increment by EXACTLY 1 (exactly the email we attached)',
      ).toBe(1);
    } finally {
      await driver.closeAndWait().catch(() => undefined);
    }
  });
});
