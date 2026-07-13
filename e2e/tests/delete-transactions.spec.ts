import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { KeeprAppDriver } from '../driver/appDriver';
import { resolveBuiltMainEntry, resolveElectronBinary } from '../driver/paths';
import { seedIsolatedProfile, type SeededIdentity } from '../driver/seed/seedProfile';
import { applyFixtureDbKey, FIXTURE_DB_KEY } from '../../scripts/qa/harness/db-key-fixture';
import {
  ALL_SEEDED_TX_IDS,
  BASE_FIXTURE_TX_ID,
  QA_DELETE_TX_IDS,
  QA_DELETE_TXC_IDS,
  QA_DELETE_COMM_IDS,
  QA_DELETE_LINKED_CONTACT_IDS,
  QA_DELETE_LINKED_EMAIL_IDS,
  expectedRemainingTxIds,
  isSubset,
  readTransactionIds,
  readTransactionContactIds,
  readCommunicationIds,
  readEmailIds,
  readContactIds,
} from '../../scripts/qa/harness/delete-transactions-core';

/**
 * BACKLOG-1981 (P2-C5) — the DELETE-TRANSACTIONS exact-identity cell (individual + BULK).
 *
 * Proves, offline and deterministically (isolated profile, stub auth, NO real M365/OAuth/network),
 * that deleting a transaction does what the app promises:
 *   1. The app's deleteTransaction is a BARE `DELETE FROM transactions WHERE id = ?` that relies on the
 *      schema's ON DELETE CASCADE (transaction_contacts.transaction_id + communications.transaction_id →
 *      transactions). So deleting a tx must remove EXACTLY that tx's junction + link rows…
 *   2. …while the UNDERLYING emails + contacts ROWS SURVIVE (emails.user_id / contacts.user_id reference
 *      users_local, NOT transactions). That asymmetry — cascade the links, keep the content — is the
 *      whole point, and we assert IDENTITY (exact id SETS) on both sides so a cascade that removes too
 *      much or too little surfaces as a FAIL (never a count that could hide the wrong row).
 *
 * DETERMINISM (SR-reviewed):
 *   - Seed 4 transactions via KEEPR_QA_DELETE_TX=1 (seed-fixture.js): the base fixture tx (Birchwood,
 *     untouched) + TX_A (2 transaction_contacts + 2 communications) + TX_B (1 + 1) + TX_C (bare). The
 *     DEFAULT seed path is byte-identical (a separate env-gated block), so the BACKLOG-1950 fidelity
 *     guard stays 7/7.
 *   - INDIVIDUAL: open TX_A, delete it, assert the remaining tx set == {base, B, C}, TX_A's junction +
 *     link rows are GONE (exact ids), and the emails/contacts they pointed at are UNTOUCHED.
 *   - BULK: select TX_B + TX_C, delete, assert the remaining tx set == {base}, their junction/link rows
 *     gone, emails/contacts still present.
 *
 * OUTCOME DISCIPLINE (e2e/driver/outcome.ts): a missing testid / driver / setup failure / timeout is a
 * HARNESS_ERROR (a thrown Playwright error → the run is untrustworthy, NOT a false FAIL); a WRONG set of
 * remaining/removed rows is a FAIL (a real app bug); the exact expected sets are PASS. We NEVER fake the
 * delete, and we assert SETS (not scalars) so an over-/under-cascade is caught. The N==4 start precheck
 * (thrown on mismatch) refuses to assert against a broken seed.
 *
 * Requires the app BUILT (dist-electron/main.js + dist/). If not built, SKIPPED with an actionable
 * message rather than false-failing — run `npm run build`. CI runs green with NO launch (skipped).
 */

const REPO_ROOT = join(__dirname, '..', '..');
const SCRATCH = process.env.KEEPR_QA_SCRATCH ?? join(REPO_ROOT, '.qa-scratch');
const ARTIFACTS_DIR = join(REPO_ROOT, 'e2e', '.artifacts', 'delete-transactions');

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

/**
 * Seed a FRESH isolated profile with the delete-transactions extra-tx structure (KEEPR_QA_DELETE_TX=1)
 * so there are 4 transactions (base + A/B/C) with the deterministic FK-child rows. Returns the profile
 * paths + identity. Mirrors the delete-emails freshSeed env-gating pattern.
 */
async function freshDeleteTxSeed(
  tag: string,
): Promise<{ identity: SeededIdentity; profileDir: string; dbPath: string }> {
  const profileDir = join(SCRATCH, `delete-transactions-${tag}-profile`);
  if (existsSync(profileDir)) rmSync(profileDir, { recursive: true, force: true });
  mkdirSync(profileDir, { recursive: true });
  applyFixtureDbKey();
  const saved = process.env.KEEPR_QA_DELETE_TX;
  process.env.KEEPR_QA_DELETE_TX = '1';
  try {
    const identity = await seedIsolatedProfile(REPO_ROOT, profileDir);
    return { identity, profileDir, dbPath: join(profileDir, 'mad.db') };
  } finally {
    if (saved === undefined) delete process.env.KEEPR_QA_DELETE_TX;
    else process.env.KEEPR_QA_DELETE_TX = saved;
  }
}

/** Launch unpackaged, land logged-in, dismiss the tour, land on the transactions LIST. */
async function launchToTxList(profileDir: string): Promise<KeeprAppDriver> {
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
  return driver;
}

/** HARNESS_ERROR precheck: EXACTLY the 4 seeded transactions must exist before we assert any delete. */
function assertFourSeededTransactions(dbPath: string, userId: string): void {
  const txIds = readTransactionIds(REPO_ROOT, electronBin, FIXTURE_DB_KEY, dbPath, userId);
  if (txIds.length !== 4 || txIds.join(',') !== [...ALL_SEEDED_TX_IDS].sort().join(',')) {
    throw new Error(
      `[delete-transactions] setup: expected the 4 seeded transactions ${JSON.stringify([...ALL_SEEDED_TX_IDS].sort())}, ` +
        `observed ${JSON.stringify(txIds)} (seed did not apply KEEPR_QA_DELETE_TX or the DB is wrong — refusing to assert).`,
    );
  }
}

test.describe('delete-transactions exact-identity cell (BACKLOG-1981)', () => {
  test.skip(!isBuilt, 'App is not built. Run `npm run build` first.');
  test.skip(!electronBin, 'Local electron binary missing — run `npm install`.');
  // Full app launch + seed + DB measure; give it room (single worker, no retries — see the config).
  test.setTimeout(240_000);

  test('INDIVIDUAL: deleting a transaction removes EXACTLY its junction + link rows (cascade); the tx set shrinks by one; underlying emails/contacts survive', async () => {
    const { identity, profileDir, dbPath } = await freshDeleteTxSeed('single');
    const userId = identity.userId;

    // ---- Precondition (HARNESS_ERROR on mismatch): exactly the 4 seeded transactions exist. ----
    assertFourSeededTransactions(dbPath, userId);

    // Capture the PRE-delete ground truth: TX_A's junction + link rows, and the underlying content ids.
    const txAContactsBefore = readTransactionContactIds(REPO_ROOT, electronBin, FIXTURE_DB_KEY, dbPath, QA_DELETE_TX_IDS.A);
    const txACommsBefore = readCommunicationIds(REPO_ROOT, electronBin, FIXTURE_DB_KEY, dbPath, QA_DELETE_TX_IDS.A);
    expect(txAContactsBefore, 'TX_A starts with its 2 seeded transaction_contacts').toEqual(
      [QA_DELETE_TXC_IDS.A1, QA_DELETE_TXC_IDS.A2].sort(),
    );
    expect(txACommsBefore, 'TX_A starts with its 2 seeded communications link rows').toEqual(
      [QA_DELETE_COMM_IDS.A1, QA_DELETE_COMM_IDS.A2].sort(),
    );
    const emailsBefore = readEmailIds(REPO_ROOT, electronBin, FIXTURE_DB_KEY, dbPath, userId);
    const contactsBefore = readContactIds(REPO_ROOT, electronBin, FIXTURE_DB_KEY, dbPath, userId);
    expect(isSubset(QA_DELETE_LINKED_EMAIL_IDS, emailsBefore), 'the linked emails exist before delete').toBe(true);
    expect(isSubset(QA_DELETE_LINKED_CONTACT_IDS, contactsBefore), 'the linked contacts exist before delete').toBe(true);

    const driver = await launchToTxList(profileDir);
    try {
      await driver.screenshot('single-00-tx-list');

      // DRIVE: open TX_A (by its stable data-tx-id), then delete via the Overview-tab trigger + confirm.
      await driver.selectTxRow(QA_DELETE_TX_IDS.A);
      await driver.page.waitForTimeout(1000);
      await driver.deleteOpenTransaction();
      await driver.page.waitForTimeout(1200);
      await driver.screenshot('single-01-after-delete');

      // ---- ASSERT IDENTITY (exact id sets, NOT counts). ----
      // (a) the remaining transactions == {base, B, C} (TX_A GONE, the others present).
      const remaining = readTransactionIds(REPO_ROOT, electronBin, FIXTURE_DB_KEY, dbPath, userId);
      expect(remaining, 'only TX_A is removed from the transactions set').toEqual(
        expectedRemainingTxIds(ALL_SEEDED_TX_IDS, [QA_DELETE_TX_IDS.A]),
      );

      // (b) FK CASCADE: TX_A's transaction_contacts + communications link rows are GONE (exact sets).
      expect(
        readTransactionContactIds(REPO_ROOT, electronBin, FIXTURE_DB_KEY, dbPath, QA_DELETE_TX_IDS.A),
        'the deleted transaction cascade-removed its transaction_contacts',
      ).toEqual([]);
      expect(
        readCommunicationIds(REPO_ROOT, electronBin, FIXTURE_DB_KEY, dbPath, QA_DELETE_TX_IDS.A),
        'the deleted transaction cascade-removed its communications link rows',
      ).toEqual([]);
      // TX_B's junction + link rows are UNTOUCHED (the cascade is scoped to TX_A).
      expect(
        readTransactionContactIds(REPO_ROOT, electronBin, FIXTURE_DB_KEY, dbPath, QA_DELETE_TX_IDS.B),
        'TX_B junction rows are untouched by TX_A delete',
      ).toEqual([QA_DELETE_TXC_IDS.B1]);
      expect(
        readCommunicationIds(REPO_ROOT, electronBin, FIXTURE_DB_KEY, dbPath, QA_DELETE_TX_IDS.B),
        'TX_B link rows are untouched by TX_A delete',
      ).toEqual([QA_DELETE_COMM_IDS.B1]);

      // (c) the underlying emails + contacts ROWS SURVIVE (cascade hits the links, not the content).
      const emailsAfter = readEmailIds(REPO_ROOT, electronBin, FIXTURE_DB_KEY, dbPath, userId);
      const contactsAfter = readContactIds(REPO_ROOT, electronBin, FIXTURE_DB_KEY, dbPath, userId);
      expect(emailsAfter, 'no emails row is deleted by a transaction delete').toEqual(emailsBefore);
      expect(contactsAfter, 'no contacts row is deleted by a transaction delete').toEqual(contactsBefore);
      expect(isSubset(QA_DELETE_LINKED_EMAIL_IDS, emailsAfter), 'the previously-linked emails still exist').toBe(true);
      expect(isSubset(QA_DELETE_LINKED_CONTACT_IDS, contactsAfter), 'the previously-linked contacts still exist').toBe(true);
    } finally {
      await driver.closeAndWait().catch(() => undefined);
    }
  });

  test('BULK: selecting 2 transactions and confirming bulk-delete removes EXACTLY that set (each cascade); base survives; emails/contacts untouched', async () => {
    const { identity, profileDir, dbPath } = await freshDeleteTxSeed('bulk');
    const userId = identity.userId;

    assertFourSeededTransactions(dbPath, userId);
    const emailsBefore = readEmailIds(REPO_ROOT, electronBin, FIXTURE_DB_KEY, dbPath, userId);
    const contactsBefore = readContactIds(REPO_ROOT, electronBin, FIXTURE_DB_KEY, dbPath, userId);

    const driver = await launchToTxList(profileDir);
    try {
      await driver.screenshot('bulk-00-tx-list');

      // DRIVE: enter selection mode, select TX_B + TX_C (>=2 rows), bulk-delete + confirm.
      await driver.enterSelectionMode();
      await driver.selectTxRow(QA_DELETE_TX_IDS.B);
      await driver.selectTxRow(QA_DELETE_TX_IDS.C);
      await driver.screenshot('bulk-01-selected');
      await driver.bulkDeleteSelected();
      await driver.page.waitForTimeout(1500);
      await driver.screenshot('bulk-02-after-delete');

      // ---- ASSERT IDENTITY. ----
      // (a) remaining transactions == {base, TX_A} (B + C GONE; TX_A was not selected, so it remains).
      const remaining = readTransactionIds(REPO_ROOT, electronBin, FIXTURE_DB_KEY, dbPath, userId);
      expect(remaining, 'exactly TX_B + TX_C are removed; base + TX_A remain').toEqual(
        expectedRemainingTxIds(ALL_SEEDED_TX_IDS, [QA_DELETE_TX_IDS.B, QA_DELETE_TX_IDS.C]),
      );
      expect(remaining, 'the base fixture transaction survives the bulk delete').toContain(BASE_FIXTURE_TX_ID);

      // (b) FK CASCADE for both deleted txs: their junction + link rows are gone (exact sets).
      expect(
        readTransactionContactIds(REPO_ROOT, electronBin, FIXTURE_DB_KEY, dbPath, QA_DELETE_TX_IDS.B),
        'TX_B cascade-removed its junction row',
      ).toEqual([]);
      expect(
        readCommunicationIds(REPO_ROOT, electronBin, FIXTURE_DB_KEY, dbPath, QA_DELETE_TX_IDS.B),
        'TX_B cascade-removed its link row',
      ).toEqual([]);
      // TX_A (NOT deleted) keeps its junction + link rows.
      expect(
        readTransactionContactIds(REPO_ROOT, electronBin, FIXTURE_DB_KEY, dbPath, QA_DELETE_TX_IDS.A),
        'the surviving TX_A keeps its junction rows',
      ).toEqual([QA_DELETE_TXC_IDS.A1, QA_DELETE_TXC_IDS.A2].sort());
      expect(
        readCommunicationIds(REPO_ROOT, electronBin, FIXTURE_DB_KEY, dbPath, QA_DELETE_TX_IDS.A),
        'the surviving TX_A keeps its link rows',
      ).toEqual([QA_DELETE_COMM_IDS.A1, QA_DELETE_COMM_IDS.A2].sort());

      // (c) the underlying emails + contacts ROWS SURVIVE.
      expect(
        readEmailIds(REPO_ROOT, electronBin, FIXTURE_DB_KEY, dbPath, userId),
        'no emails row is deleted by a bulk transaction delete',
      ).toEqual(emailsBefore);
      expect(
        readContactIds(REPO_ROOT, electronBin, FIXTURE_DB_KEY, dbPath, userId),
        'no contacts row is deleted by a bulk transaction delete',
      ).toEqual(contactsBefore);
    } finally {
      await driver.closeAndWait().catch(() => undefined);
    }
  });
});
