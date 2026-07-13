/**
 * DELETE-TRANSACTIONS exact-identity cell — shared core (BACKLOG-1981).
 *
 * Reusable helpers shared by the Playwright spec (e2e/tests/delete-transactions.spec.ts). Mirrors the
 * BACKLOG-1982 delete-emails-core / BACKLOG-1948 create-audit-core pattern:
 *
 *   1. FIXTURE_DB_KEY / applyFixtureDbKey — the FIXED, keychain-free DB key (re-exported from the
 *      cell-agnostic db-key-fixture, BACKLOG-1971).
 *   2. QA_DELETE_TX_IDS / QA_DELETE_TXC_IDS / QA_DELETE_COMM_IDS — the deterministic ground truth of the
 *      env-gated (KEEPR_QA_DELETE_TX==='1') extra transactions + their FK-child rows (mirrored from
 *      seed-fixture.js; a qa:test cross-check asserts they agree, matching the delete-emails/users-roles
 *      precedent). The base fixture transaction id is BASE_FIXTURE_TX_ID.
 *   3. expectedRemainingTxIds — a PURE function: given the full seeded tx-id set and the deleted ids,
 *      returns the EXACT set that must remain. Unit-tested without any app launch.
 *   4. readTransactionIds / readTransactionContactIds / readCommunicationIds / readEmailIds /
 *      readContactIds — OBSERVE the actual rows from the encrypted DB (verify-by-observing, BACKLOG-1875)
 *      via cipher-open readers. IDENTITY (id sets), not scalar counts — the cell asserts EXACT SETS so a
 *      cascade that removes too much / too little surfaces as a FAIL (SR note).
 *
 * WHY IDENTITY, not counts: the app's deleteTransaction is a bare `DELETE FROM transactions WHERE id = ?`
 * that relies on the schema's ON DELETE CASCADE (transaction_contacts.transaction_id +
 * communications.transaction_id → transactions). The underlying emails.user_id / contacts.user_id
 * reference users_local (NOT transactions), so those ROWS must SURVIVE. A count could hide the wrong row
 * being removed; the cell pins the exact id sets on both sides of the cascade.
 *
 * PURE-NODE: no Playwright/Electron/DOM import here (the reader spawn is Node child_process), so the
 * expected/reader logic is unit-testable and type-checked by the harness tsconfig.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/** The FIXED, keychain-free DB key path (BACKLOG-1971) — cell-agnostic shared helper. */
export { FIXTURE_DB_KEY, applyFixtureDbKey } from './db-key-fixture';

/**
 * The base fixture transaction id (defaultFixture().transaction.id). Left UNTOUCHED by the cell (it is
 * the 4th transaction that must SURVIVE both delete paths). Mirrored from seed-fixture.js; the qa:test
 * cross-check asserts it matches.
 */
export const BASE_FIXTURE_TX_ID = 'b0000000-0000-4000-8000-00000000d100';

/**
 * The 3 EXTRA transaction ids seeded when KEEPR_QA_DELETE_TX==='1'. MUST be byte-identical to
 * QA_DELETE_TX_IDS in scripts/qa/harness/seed-fixture.js (the writer runs in a separate Electron-main
 * process, so the value is duplicated here and a qa:test cross-check asserts they agree).
 *   A = individual-delete target (has 2 transaction_contacts + 2 communications link rows)
 *   B = bulk target (has 1 transaction_contacts + 1 communications link row)
 *   C = bulk target (a bare tx — no FK children)
 */
export const QA_DELETE_TX_IDS = Object.freeze({
  A: 'd0000000-0000-4000-8000-000000001981',
  B: 'd0000000-0000-4000-8000-000000001982',
  C: 'd0000000-0000-4000-8000-000000001983',
});

/** transaction_contacts junction ids for the extra txs (mirrored from seed-fixture.js). */
export const QA_DELETE_TXC_IDS = Object.freeze({
  A1: 'e0000000-0000-4000-8000-000000001981',
  A2: 'e0000000-0000-4000-8000-000000001982',
  B1: 'e0000000-0000-4000-8000-000000001983',
});

/** communications link-row ids for the extra txs (mirrored from seed-fixture.js). */
export const QA_DELETE_COMM_IDS = Object.freeze({
  A1: 'c0000000-0000-4000-8000-000000001981',
  A2: 'c0000000-0000-4000-8000-000000001982',
  B1: 'c0000000-0000-4000-8000-000000001983',
});

/**
 * The seeded email ids that the extra txs' communications link rows POINT AT (reused seeded emails).
 * These `emails` ROWS must SURVIVE a transaction delete (emails.user_id → users_local, not transactions).
 */
export const QA_DELETE_LINKED_EMAIL_IDS: readonly string[] = Object.freeze([
  'qa-seed-email-match-1', // TX_A comm A1
  'qa-seed-email-match-2', // TX_A comm A2
  'qa-seed-email-match-3', // TX_B comm B1
]);

/**
 * The seeded contact ids that the extra txs' transaction_contacts rows POINT AT (reused seeded contacts).
 * These `contacts` ROWS must SURVIVE a transaction delete (contacts.user_id → users_local).
 * Mirrors seed-fixture.js QA_SEED_CONTACT_IDS 1 + 2.
 */
export const QA_DELETE_LINKED_CONTACT_IDS: readonly string[] = Object.freeze([
  '00000000-0000-4000-8000-000000001941', // seeded contact 1
  '00000000-0000-4000-8000-000000001942', // seeded contact 2
]);

/** The FULL set of transaction ids present on a KEEPR_QA_DELETE_TX seed (base + A/B/C), sorted. */
export const ALL_SEEDED_TX_IDS: readonly string[] = Object.freeze(
  [BASE_FIXTURE_TX_ID, QA_DELETE_TX_IDS.A, QA_DELETE_TX_IDS.B, QA_DELETE_TX_IDS.C].sort(),
);

/**
 * PURE: the EXACT set of transaction ids that must REMAIN after deleting `deletedIds` from `allIds`.
 * Sorted + de-duplicated so callers can compare sets directly. This is the deterministic oracle the spec
 * compares the OBSERVED remaining-tx set against (deleted ones GONE, the rest present). Independent of
 * app code (a faithful set difference), so a divergence is a real FAIL, not a tautology.
 */
export function expectedRemainingTxIds(allIds: readonly string[], deletedIds: readonly string[]): string[] {
  const deleted = new Set(deletedIds);
  return [...new Set(allIds.filter((id) => !deleted.has(id)))].sort();
}

// -----------------------------------------------------------------------------
// Cipher-open readers (spawn the dedicated Electron-ABI scripts with --key). IDENTITY (id sets).
// -----------------------------------------------------------------------------

const TX_IDS_SENTINEL = '__QA_TX_IDS__ ';
const TXC_IDS_SENTINEL = '__QA_TXC_IDS__ ';
const COMM_IDS_SENTINEL = '__QA_COMM_IDS__ ';
const EMAIL_IDS_SENTINEL = '__QA_EMAIL_IDS__ ';
const CONTACT_IDS_SENTINEL = '__QA_CONTACT_IDS__ ';

function spawnReader(script: string, repoRoot: string, dbKey: string, dbPath: string, electronBin: string, extraArgs: string[] = []): {
  stdout: string;
  status: number | null;
  stderr: string;
  error?: Error;
} {
  const run = spawnSync(electronBin, [script, '--db', dbPath, '--key', dbKey, ...extraArgs], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_ENABLE_LOGGING: '0' },
    timeout: 30_000,
    killSignal: 'SIGKILL',
  });
  return { stdout: run.stdout || '', status: run.status, stderr: run.stderr || '', error: run.error ?? undefined };
}

function parseIdRows(stdout: string, sentinel: string, status: number | null, stderr: string, label: string): string[] {
  const line = stdout.split('\n').find((l) => l.includes(sentinel));
  if (!line) {
    throw new Error(`${label} produced no result (exit ${status ?? 'null'}).\n${stderr}`);
  }
  const parsed = JSON.parse(line.slice(line.indexOf(sentinel) + sentinel.length)) as {
    rows?: Array<{ id: string }>;
    error?: string;
  };
  if (parsed.error) throw new Error(`${label} error: ${parsed.error}`);
  return [...new Set((parsed.rows ?? []).map((r) => r.id))].sort();
}

/**
 * OBSERVE the sorted set of `transactions` ids for a user (ground truth of what exists). Throws
 * (→ HARNESS_ERROR upstream) on a launch/decrypt/parse failure. IDENTITY (ids), not a scalar count.
 */
export function readTransactionIds(repoRoot: string, electronBin: string, dbKey: string, dbPath: string, userId: string): string[] {
  const script = join(repoRoot, 'scripts', 'qa', 'harness', 'read-transactions.js');
  const run = spawnReader(script, repoRoot, dbKey, dbPath, electronBin, ['--table', 'transactions', '--user-id', userId]);
  if (run.error) throw new Error(`read-transactions failed to launch: ${run.error.message}`);
  return parseIdRows(run.stdout, TX_IDS_SENTINEL, run.status, run.stderr, 'read-transactions[transactions]');
}

/** OBSERVE the sorted set of `transaction_contacts` ids (optionally scoped to a transaction). */
export function readTransactionContactIds(
  repoRoot: string,
  electronBin: string,
  dbKey: string,
  dbPath: string,
  transactionId?: string,
): string[] {
  const script = join(repoRoot, 'scripts', 'qa', 'harness', 'read-transactions.js');
  const args = ['--table', 'transaction_contacts'];
  if (transactionId) args.push('--transaction-id', transactionId);
  const run = spawnReader(script, repoRoot, dbKey, dbPath, electronBin, args);
  if (run.error) throw new Error(`read-transactions[transaction_contacts] failed to launch: ${run.error.message}`);
  return parseIdRows(run.stdout, TXC_IDS_SENTINEL, run.status, run.stderr, 'read-transactions[transaction_contacts]');
}

/** OBSERVE the sorted set of `communications` ids (optionally scoped to a transaction). */
export function readCommunicationIds(
  repoRoot: string,
  electronBin: string,
  dbKey: string,
  dbPath: string,
  transactionId?: string,
): string[] {
  const script = join(repoRoot, 'scripts', 'qa', 'harness', 'read-transactions.js');
  const args = ['--table', 'communications'];
  if (transactionId) args.push('--transaction-id', transactionId);
  const run = spawnReader(script, repoRoot, dbKey, dbPath, electronBin, args);
  if (run.error) throw new Error(`read-transactions[communications] failed to launch: ${run.error.message}`);
  return parseIdRows(run.stdout, COMM_IDS_SENTINEL, run.status, run.stderr, 'read-transactions[communications]');
}

/** OBSERVE the sorted set of `emails` ids for a user (to prove the underlying email rows SURVIVE). */
export function readEmailIds(repoRoot: string, electronBin: string, dbKey: string, dbPath: string, userId: string): string[] {
  const script = join(repoRoot, 'scripts', 'qa', 'harness', 'read-transactions.js');
  const run = spawnReader(script, repoRoot, dbKey, dbPath, electronBin, ['--table', 'emails', '--user-id', userId]);
  if (run.error) throw new Error(`read-transactions[emails] failed to launch: ${run.error.message}`);
  return parseIdRows(run.stdout, EMAIL_IDS_SENTINEL, run.status, run.stderr, 'read-transactions[emails]');
}

/** OBSERVE the sorted set of `contacts` ids for a user (to prove the underlying contact rows SURVIVE). */
export function readContactIds(repoRoot: string, electronBin: string, dbKey: string, dbPath: string, userId: string): string[] {
  const script = join(repoRoot, 'scripts', 'qa', 'harness', 'read-transactions.js');
  const run = spawnReader(script, repoRoot, dbKey, dbPath, electronBin, ['--table', 'contacts', '--user-id', userId]);
  if (run.error) throw new Error(`read-transactions[contacts] failed to launch: ${run.error.message}`);
  return parseIdRows(run.stdout, CONTACT_IDS_SENTINEL, run.status, run.stderr, 'read-transactions[contacts]');
}

/** Convenience: does `subset` ⊆ `superset`? Used to assert the underlying emails/contacts survived. */
export function isSubset(subset: readonly string[], superset: readonly string[]): boolean {
  const s = new Set(superset);
  return subset.every((x) => s.has(x));
}
