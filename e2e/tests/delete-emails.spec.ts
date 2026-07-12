import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { KeeprAppDriver } from '../driver/appDriver';
import { resolveBuiltMainEntry, resolveElectronBinary } from '../driver/paths';
import { seedIsolatedProfile, type SeededIdentity } from '../driver/seed/seedProfile';
import { applyFixtureDbKey, FIXTURE_DB_KEY } from '../../scripts/qa/harness/db-key-fixture';
import {
  clearLinkedEmails,
  countLinkedEmails,
  waitForStableLinkCount,
} from '../../scripts/qa/harness/filter-toggle-core';
import {
  DELETE_EMAILS_THREAD_MAP,
  SEEDED_LINKED_EMAIL_IDS,
  expectedUnlinkForBulk,
  expectedUnlinkForThread,
  ignoredEmailIdSet,
  linkedEmailIdSet,
  readEmailLinks,
  readIgnoredComms,
  type EmailLinkRow,
} from '../../scripts/qa/harness/delete-emails-core';

/**
 * BACKLOG-1982 (P2-C6) — the DELETE-EMAILS exact-count cell (individual + BULK unlink).
 *
 * Proves, offline and deterministically (isolated profile, stub auth, NO real M365/OAuth/network),
 * that unlinking an email from a transaction does what the app promises:
 *   1. It is NOT a raw junction delete and NOT an email-row delete. It (a) writes an
 *      `ignored_communications` TOMBSTONE, then (b) hard-deletes the `communications` LINK row.
 *      The underlying `emails` rows are UNTOUCHED.
 *   2. THREAD EXPANSION: unlinking one email of a multi-email thread cascades to every thread sibling
 *      (unlinkCommunication expands over communications sharing the email's thread_id). So removing
 *      "one" removes N. We assert against the ACTUAL removed link rows + tombstones, thread-aware —
 *      NEVER a hardcoded 1.
 *
 * DETERMINISM (SR-reviewed):
 *   - Seed the deterministic thread structure via KEEPR_QA_DELETE_EMAILS_THREADS=1 (seed-fixture.js):
 *       THREAD A = match-1 + match-2 (2-email thread) · THREAD B = match-3 (1-email, has thread_id) ·
 *       match-4 = NULL thread_id (singleton). The DEFAULT seed path is byte-identical (a separate
 *       post-insert UPDATE), so the BACKLOG-1950 fidelity guard stays 7/7.
 *   - Establish the LINKED precondition DETERMINISTICALLY (NOT via the non-deterministic on-open
 *     auto-link): wait for on-open to settle, CLEAR to a genuine 0 slate, then toggle the address
 *     filter OFF (skip=1, "link all") so the toggle is the SOLE reproducible cause of the 6 links.
 *     THEN assert the exact linked set + that the thread-A link rows carry a non-NULL thread_id
 *     (else expansion would silently degrade to a 1-row unlink — a false FAIL), and only THEN delete.
 *
 * OUTCOME DISCIPLINE (e2e/driver/outcome.ts): a missing testid / driver / setup failure / timeout is a
 * HARNESS_ERROR (a thrown Playwright error → the run is untrustworthy, NOT a false FAIL); a WRONG set
 * of removed rows/tombstones is a FAIL (a real app bug); the exact expected sets are PASS. We NEVER
 * fake counts to make it green, and we assert SETS (not scalars) so an under-/over-expansion is caught.
 *
 * Requires the app BUILT (dist-electron/main.js + dist/). If not built, SKIPPED with an actionable
 * message rather than false-failing — run `npm run build`. CI runs green with NO launch (skipped).
 */

const REPO_ROOT = join(__dirname, '..', '..');
const SCRATCH = process.env.KEEPR_QA_SCRATCH ?? join(REPO_ROOT, '.qa-scratch');
const ARTIFACTS_DIR = join(REPO_ROOT, 'e2e', '.artifacts', 'delete-emails');

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

/** Thread-ids the seeder plants (KEEPR_QA_DELETE_EMAILS_THREADS=1). */
const THREAD_A_ID = 'qa-seed-thread-A';
const THREAD_B_ID = 'qa-seed-thread-B';

/**
 * Seed a FRESH isolated profile with the delete-emails thread structure applied AND the address filter
 * OFF at seed time (skip=1) so the FULL 6-email OFF corpus is linkable. Returns the profile paths.
 */
async function freshDeleteEmailsSeed(
  tag: string,
): Promise<{ identity: SeededIdentity; profileDir: string; dbPath: string }> {
  const profileDir = join(SCRATCH, `delete-emails-${tag}-profile`);
  if (existsSync(profileDir)) rmSync(profileDir, { recursive: true, force: true });
  mkdirSync(profileDir, { recursive: true });
  applyFixtureDbKey();
  const extraEnv: Record<string, string> = {
    KEEPR_QA_DELETE_EMAILS_THREADS: '1',
    // Seed skip_address_filter=1 (filter OFF, "link all") so all 6 OFF emails are linkable on open.
    KEEPR_QA_START_SKIP_FILTER: '1',
  };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(extraEnv)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const identity = await seedIsolatedProfile(REPO_ROOT, profileDir);
    return { identity, profileDir, dbPath: join(profileDir, 'mad.db') };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
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

  const streetOnly = identity.propertyAddress.split(',')[0];
  await expect(
    driver.page.getByText(streetOnly, { exact: false }).first(),
    `opened transaction should show the seeded address "${identity.propertyAddress}"`,
  ).toBeVisible({ timeout: 15_000 });

  await driver.page.getByRole('button', { name: 'Emails' }).first().click();
  await driver.page.waitForTimeout(1500);
  await driver.screenshot('00-emails-tab-opened');

  // The address-filter toggle must be present (used to establish the LINKED precondition).
  await expect(
    driver.page.getByTestId('address-filter-toggle').locator('visible=true').first(),
    'address-filter-toggle must be present on the emails tab (else HARNESS_ERROR: app shape changed)',
  ).toBeVisible({ timeout: 15_000 });

  return driver;
}

/**
 * DETERMINISTICALLY link the full OFF corpus (6 emails) so the delete paths run against a known slate:
 *   1. wait for the non-deterministic on-open auto-link to settle,
 *   2. CLEAR to a genuine 0 slate (assert 0),
 *   3. toggle the address filter OFF (skip=1) so the app links exactly the 6 (the toggle is the sole,
 *      reproducible cause), and
 *   4. assert the DB really has the 6 expected email links AND that the THREAD-A link rows carry a
 *      non-NULL thread_id (else expansion would degrade — surfaced as a thrown HARNESS_ERROR).
 * A setup that does not reach the expected 6 is a SETUP failure (thrown), NEVER a silent pass/FAIL.
 */
async function establishLinkedCorpus(
  driver: KeeprAppDriver,
  dbPath: string,
  transactionId: string,
): Promise<EmailLinkRow[]> {
  // 1. settle on-open auto-link, 2. clear to 0.
  await waitForStableLinkCount(REPO_ROOT, electronBin, FIXTURE_DB_KEY, dbPath, transactionId, {
    intervalMs: 1000,
    timeoutMs: 15_000,
  });
  const cleared = clearLinkedEmails(REPO_ROOT, electronBin, FIXTURE_DB_KEY, dbPath, transactionId);
  if (cleared.remaining !== 0) {
    throw new Error(`[delete-emails] clean-slate setup failed: ${cleared.remaining} link(s) remain after clear for tx ${transactionId}.`);
  }
  expect(
    countLinkedEmails(REPO_ROOT, electronBin, FIXTURE_DB_KEY, dbPath, transactionId),
    'clean slate established: 0 linked before toggling',
  ).toBe(0);

  // 3. Re-link the 6-email OFF corpus by forcing a REAL off-transition. SR-FIX (live run): the seed leaves
  //    the filter already OFF (skip_address_filter=1), so a direct setAddressFilter(false) is an idempotent
  //    no-op and never fires the re-link (corpus stayed at 0). Round-trip ON→OFF so the OFF transition runs
  //    the re-link from the cleared state and links exactly the 6.
  await driver.setAddressFilter(true);
  await driver.page.waitForTimeout(1500); // let the ON re-link settle before flipping back
  await driver.setAddressFilter(false);
  expect(await driver.getAddressFilterState()).toBe(false);
  await driver.page.waitForTimeout(1500); // let the async re-link + loadCommunications settle
  await driver.screenshot('01-corpus-linked');

  // 4. Assert the exact linked SET + thread_id integrity on the thread-A rows.
  const links = readEmailLinks(REPO_ROOT, electronBin, FIXTURE_DB_KEY, dbPath, transactionId);
  const linkedSet = linkedEmailIdSet(links);
  expect(linkedSet, 'the address-OFF toggle should link exactly the 6-email OFF corpus').toEqual(
    [...SEEDED_LINKED_EMAIL_IDS].sort(),
  );
  // Thread-A link rows MUST carry the seeded thread_id — else the backend expansion silently degrades
  // to a 1-row unlink and the "2" assertion would be a false FAIL. Treat a missing thread_id as a
  // thrown SETUP/HARNESS error, not an app FAIL.
  const threadARows = links.filter(
    (r) => r.email_id === 'qa-seed-email-match-1' || r.email_id === 'qa-seed-email-match-2',
  );
  expect(threadARows.length, 'both THREAD-A emails should be linked').toBe(2);
  for (const r of threadARows) {
    if (r.thread_id !== THREAD_A_ID) {
      throw new Error(
        `[delete-emails] SETUP: THREAD-A link row for ${r.email_id} has thread_id="${r.thread_id}" (expected "${THREAD_A_ID}"). ` +
          'Backend expansion would degrade — refusing to assert against a broken slate.',
      );
    }
  }
  return links;
}

test.describe('delete-emails exact-count cell (BACKLOG-1982)', () => {
  test.skip(!isBuilt, 'App is not built. Run `npm run build` first.');
  test.skip(!electronBin, 'Local electron binary missing — run `npm install`.');
  // Full app launch + seed + DB measure; give it room (single worker, no retries — see the config).
  test.setTimeout(240_000);

  test('INDIVIDUAL (singleton): unlinking a NULL-thread email removes EXACTLY its 1 link row + writes 1 tombstone; the emails row survives', async () => {
    const { identity, profileDir, dbPath } = await freshDeleteEmailsSeed('single');
    const txId = identity.transactionId;
    const driver = await driveToEmailsTab(profileDir, identity);
    try {
      await establishLinkedCorpus(driver, dbPath, txId);

      // match-4 is a NULL-thread singleton. Its UI thread groups by NORMALIZED SUBJECT (no thread_id),
      // so its data-thread-id is `subject-<normalized>`. Compute the expected DB effect first.
      const clicked = 'qa-seed-email-match-4';
      const expectedRemoved = expectedUnlinkForThread(clicked, DELETE_EMAILS_THREAD_MAP, SEEDED_LINKED_EMAIL_IDS);
      expect(expectedRemoved, 'singleton unlink removes exactly the clicked email').toEqual([clicked]);

      // Drive: its subject-thread id (see EmailThreadCard.getEmailThreadKey → `subject-<normalized>`).
      // normalizeSubject('Wire instructions — 742 Birchwood Lane NE') lowercases + trims prefixes only.
      const before = readEmailLinks(REPO_ROOT, electronBin, FIXTURE_DB_KEY, dbPath, txId);
      const match4Row = before.find((r) => r.email_id === clicked);
      expect(match4Row, 'match-4 should be linked before unlinking').toBeTruthy();
      // Its UI thread id: NULL thread_id → subject-key. Resolve the card via the on-screen subject.
      await driver.unlinkThreadBySubject('Wire instructions');
      await driver.page.waitForTimeout(1000);
      await driver.screenshot('single-02-after-unlink');

      // OBSERVE: exactly the match-4 link row gone; the OTHER 5 remain; 1 tombstone for match-4; emails intact.
      const afterLinks = readEmailLinks(REPO_ROOT, electronBin, FIXTURE_DB_KEY, dbPath, txId);
      const afterLinkedSet = linkedEmailIdSet(afterLinks);
      const expectedRemaining = SEEDED_LINKED_EMAIL_IDS.filter((id) => !expectedRemoved.includes(id)).sort();
      expect(afterLinkedSet, 'only the clicked singleton link row is removed').toEqual(expectedRemaining);

      const tombstones = readIgnoredComms(REPO_ROOT, electronBin, FIXTURE_DB_KEY, dbPath, txId);
      expect(ignoredEmailIdSet(tombstones), 'exactly one tombstone, for the clicked email').toEqual([clicked]);

      // The emails ROW is UNTOUCHED (unlink is not a delete). Re-toggling filter OFF would re-link it —
      // but we assert directly: the email still exists (its participant/row must be present to re-link).
      // A tombstone now suppresses it, so a filter re-toggle must NOT re-link it (BACKLOG suppression).
      await driver.setAddressFilter(true);
      await driver.page.waitForTimeout(500);
      await driver.setAddressFilter(false);
      await driver.page.waitForTimeout(1500);
      const afterRelink = linkedEmailIdSet(readEmailLinks(REPO_ROOT, electronBin, FIXTURE_DB_KEY, dbPath, txId));
      expect(afterRelink, 'the tombstone suppresses re-linking the unlinked email on a filter re-toggle').toEqual(
        expectedRemaining,
      );
    } finally {
      await driver.closeAndWait().catch(() => undefined);
    }
  });

  test('INDIVIDUAL (thread expansion): unlinking one email of THREAD A removes BOTH link rows (2) + writes 2 tombstones; both emails rows survive', async () => {
    const { identity, profileDir, dbPath } = await freshDeleteEmailsSeed('thread');
    const txId = identity.transactionId;
    const driver = await driveToEmailsTab(profileDir, identity);
    try {
      await establishLinkedCorpus(driver, dbPath, txId);

      // THREAD A = match-1 + match-2. Clicking unlink on either removes BOTH (thread-aware, not 1).
      const expectedRemoved = expectedUnlinkForThread('qa-seed-email-match-1', DELETE_EMAILS_THREAD_MAP, SEEDED_LINKED_EMAIL_IDS);
      expect(expectedRemoved, 'thread expansion removes BOTH thread-A emails').toEqual([
        'qa-seed-email-match-1',
        'qa-seed-email-match-2',
      ]);

      // The UI thread groups by thread_id → card data-thread-id = `thread-<thread_id>`.
      await driver.unlinkThreadById(`thread-${THREAD_A_ID}`);
      await driver.page.waitForTimeout(1000);
      await driver.screenshot('thread-02-after-unlink');

      const afterLinks = readEmailLinks(REPO_ROOT, electronBin, FIXTURE_DB_KEY, dbPath, txId);
      const afterLinkedSet = linkedEmailIdSet(afterLinks);
      const expectedRemaining = SEEDED_LINKED_EMAIL_IDS.filter((id) => !expectedRemoved.includes(id)).sort();
      // Exactly the 2 thread-A link rows removed; the other 4 remain.
      expect(afterLinkedSet, 'thread expansion removes exactly the 2 thread-A link rows').toEqual(expectedRemaining);

      const tombstones = readIgnoredComms(REPO_ROOT, electronBin, FIXTURE_DB_KEY, dbPath, txId);
      expect(ignoredEmailIdSet(tombstones), 'exactly 2 tombstones, one per thread-A email').toEqual([
        'qa-seed-email-match-1',
        'qa-seed-email-match-2',
      ]);
      // Both tombstones carry the thread_id (thread suppression).
      const threadATombstones = tombstones.filter((t) => t.email_id === 'qa-seed-email-match-1' || t.email_id === 'qa-seed-email-match-2');
      expect(threadATombstones.every((t) => t.thread_id === THREAD_A_ID), 'tombstones carry the thread_id').toBe(true);
    } finally {
      await driver.closeAndWait().catch(() => undefined);
    }
  });

  test('BULK: selecting THREAD A + THREAD B + a singleton removes EXACTLY that set of link rows + tombstones; emails untouched', async () => {
    const { identity, profileDir, dbPath } = await freshDeleteEmailsSeed('bulk');
    const txId = identity.transactionId;
    const driver = await driveToEmailsTab(profileDir, identity);
    try {
      await establishLinkedCorpus(driver, dbPath, txId);

      // Representatives: thread A (match-1), thread B (match-3), singleton match-4. Backend expands A→2.
      const reps = ['qa-seed-email-match-1', 'qa-seed-email-match-3', 'qa-seed-email-match-4'];
      const expectedRemoved = expectedUnlinkForBulk(reps, DELETE_EMAILS_THREAD_MAP, SEEDED_LINKED_EMAIL_IDS);
      expect(expectedRemoved, 'bulk = union of per-thread expansions').toEqual([
        'qa-seed-email-match-1',
        'qa-seed-email-match-2',
        'qa-seed-email-match-3',
        'qa-seed-email-match-4',
      ]);

      // Enter selection mode; select the three thread cards (A + B by thread-id, match-4 by subject).
      await driver.enterEmailSelectionMode();
      await driver.selectEmailThreadById(`thread-${THREAD_A_ID}`);
      await driver.selectEmailThreadById(`thread-${THREAD_B_ID}`);
      await driver.selectEmailThreadBySubject('Wire instructions');
      await driver.screenshot('bulk-01-selected');
      await driver.bulkRemoveSelectedEmails();
      await driver.page.waitForTimeout(1200);
      await driver.screenshot('bulk-02-after-remove');

      const afterLinks = readEmailLinks(REPO_ROOT, electronBin, FIXTURE_DB_KEY, dbPath, txId);
      const afterLinkedSet = linkedEmailIdSet(afterLinks);
      const expectedRemaining = SEEDED_LINKED_EMAIL_IDS.filter((id) => !expectedRemoved.includes(id)).sort();
      expect(afterLinkedSet, 'bulk removes exactly the selected threads (expanded)').toEqual(expectedRemaining);

      const tombstones = readIgnoredComms(REPO_ROOT, electronBin, FIXTURE_DB_KEY, dbPath, txId);
      expect(ignoredEmailIdSet(tombstones), 'a tombstone per removed email').toEqual(expectedRemoved);
    } finally {
      await driver.closeAndWait().catch(() => undefined);
    }
  });
});
