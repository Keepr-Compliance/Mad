/**
 * DELETE-EMAILS exact-count cell — shared core (BACKLOG-1982).
 *
 * Reusable helpers shared by the Playwright spec (e2e/tests/delete-emails.spec.ts). Mirrors the
 * BACKLOG-1950 filter-toggle-core / BACKLOG-1949 users-roles-core pattern:
 *
 *   1. FIXTURE_DB_KEY / applyFixtureDbKey — the FIXED, keychain-free DB key (re-exported from the
 *      cell-agnostic db-key-fixture, BACKLOG-1971).
 *   2. DELETE_EMAILS_THREAD_MAP / SEEDED_LINKED_EMAIL_IDS — the deterministic ground truth of the
 *      seeded thread structure (mirrored from seed-fixture.js; a qa:test cross-check asserts they
 *      agree, matching the users-roles-core precedent).
 *   3. expectedUnlinkForThread — a PURE function: given the seeded thread structure and the email a
 *      user clicks "unlink" on, returns the EXACT set of email_ids the backend must unlink (thread-
 *      aware: a shared thread_id expands to every sibling; a NULL thread_id is a singleton). Unit-
 *      tested without any app launch (scripts/qa/harness/__tests__/delete-emails-core.test.ts).
 *   4. readEmailLinks / readIgnoredComms — OBSERVE the actual communications LINK rows and the
 *      ignored_communications TOMBSTONE rows from the encrypted DB (verify-by-observing) via the
 *      read-links.js / count-ignored.js cipher-open readers. ROWS, not scalar counts — the cell
 *      asserts EXACT SETS so an under-/over-expansion surfaces as a FAIL (SR note).
 *
 * WHY thread_id, not subject: the UI groups threads by thread_id ELSE normalized subject, but the
 * BACKEND unlinkCommunication expands ONLY on thread_id (its sibling SQL keys on communications.thread_id).
 * autoLink copies emails.thread_id → communications.thread_id, so the seeded emails.thread_id is the
 * single deterministic driver of expansion. See the fidelity guard + spec for the full contract.
 *
 * PURE-NODE: no Playwright/Electron/DOM import here (the reader spawn is Node child_process), so the
 * expected/reader logic is unit-testable and type-checked by the harness tsconfig.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/** The FIXED, keychain-free DB key path (BACKLOG-1971) — cell-agnostic shared helper. */
export { FIXTURE_DB_KEY, applyFixtureDbKey } from './db-key-fixture';

/**
 * The seeded thread structure applied when KEEPR_QA_DELETE_EMAILS_THREADS==='1'. MUST be byte-identical
 * to DELETE_EMAILS_THREAD_MAP in scripts/qa/harness/seed-fixture.js (the writer). Because the seeder
 * runs in a separate Electron-main process from this Node cell, the value is duplicated here and a
 * qa:test cross-check (delete-emails-core.test.ts) asserts the two agree — matching the users-roles
 * QA_SEED_CONTACT_IDS precedent.
 *
 *   THREAD A = match-1 + match-2  (a 2-email thread → unlinking one expands to BOTH)
 *   THREAD B = match-3            (a 1-email thread that STILL carries a thread_id)
 *   match-4  = (absent) NULL thread_id → a singleton with no backend expansion
 */
export const DELETE_EMAILS_THREAD_MAP: Readonly<Record<string, string>> = Object.freeze({
  'qa-seed-email-match-1': 'qa-seed-thread-A',
  'qa-seed-email-match-2': 'qa-seed-thread-A',
  'qa-seed-email-match-3': 'qa-seed-thread-B',
});

/**
 * The 6 emails that LINK under the address filter OFF (skip=1, "link all") — the 4 MATCH + 2 NO-MATCH
 * participant-contact emails (mirrors the BACKLOG-1950 fixture OFF=6 set). match-4 carries a NULL
 * thread_id; the nomatch emails carry NULL thread_id (own subject-threads). This is the full set the
 * cell links (via clear-to-0 + toggle-OFF) before exercising the delete paths.
 */
export const SEEDED_LINKED_EMAIL_IDS: readonly string[] = Object.freeze([
  'qa-seed-email-match-1',
  'qa-seed-email-match-2',
  'qa-seed-email-match-3',
  'qa-seed-email-match-4',
  'qa-seed-email-nomatch-1',
  'qa-seed-email-nomatch-2',
]);

/**
 * PURE: the EXACT set of email_ids the backend unlinkCommunication must remove when the user clicks
 * "unlink" on `clickedEmailId`, given the seeded thread map. Thread-aware:
 *   - if the clicked email has a thread_id, EVERY seeded linked email sharing that thread_id is
 *     unlinked (the backend's sibling expansion);
 *   - otherwise (NULL thread_id) ONLY the clicked email is unlinked (singleton).
 * Only emails in `linkedIds` (currently linked) are considered — an email that isn't linked cannot be
 * unlinked. Returns a SORTED, de-duplicated array so callers can compare sets directly.
 *
 * This is the deterministic oracle the spec compares the OBSERVED unlinkedIds / removed link rows /
 * tombstones against. It is intentionally independent of the app code (a faithful mirror of the
 * expansion rule), so a divergence between it and the app is a real FAIL, not a tautology.
 */
export function expectedUnlinkForThread(
  clickedEmailId: string,
  threadMap: Readonly<Record<string, string>>,
  linkedIds: readonly string[],
): string[] {
  const linked = new Set(linkedIds);
  if (!linked.has(clickedEmailId)) return [];
  const threadId = threadMap[clickedEmailId];
  if (!threadId) {
    // No thread_id → singleton unlink (no backend expansion).
    return [clickedEmailId];
  }
  // Thread_id set → expand to every LINKED sibling sharing the same thread_id.
  const siblings = new Set<string>([clickedEmailId]);
  for (const [emailId, tid] of Object.entries(threadMap)) {
    if (tid === threadId && linked.has(emailId)) siblings.add(emailId);
  }
  return [...siblings].sort();
}

/**
 * PURE: the EXACT set of email_ids a BULK remove must unlink, given the set of thread cards the user
 * selected (each identified by a representative clicked email) and the seeded thread map. This is the
 * union of expectedUnlinkForThread over each representative — mirroring the UI's dedup-then-expand
 * (TransactionEmailsTab.handleBulkRemoveConfirm sends one representative per distinct thread_id and the
 * backend expands each). Returns a SORTED, de-duplicated array.
 */
export function expectedUnlinkForBulk(
  clickedEmailIds: readonly string[],
  threadMap: Readonly<Record<string, string>>,
  linkedIds: readonly string[],
): string[] {
  const out = new Set<string>();
  for (const id of clickedEmailIds) {
    for (const e of expectedUnlinkForThread(id, threadMap, linkedIds)) out.add(e);
  }
  return [...out].sort();
}

// -----------------------------------------------------------------------------
// Cipher-open readers (spawn the dedicated Electron-ABI scripts with --key). ROWS, not scalars.
// -----------------------------------------------------------------------------

/** One email communications LINK row as OBSERVED from the encrypted DB by read-links.js. */
export interface EmailLinkRow {
  id: string;
  email_id: string | null;
  thread_id: string | null;
}

/** One ignored_communications TOMBSTONE row as OBSERVED from the encrypted DB by count-ignored.js. */
export interface IgnoredCommRow {
  id: string;
  email_id: string | null;
  thread_id: string | null;
  original_communication_id: string | null;
  email_subject: string | null;
}

const EMAIL_LINKS_SENTINEL = '__QA_EMAIL_LINKS__ ';
const IGNORED_COMMS_SENTINEL = '__QA_IGNORED_COMMS__ ';

function spawnReader(
  script: string,
  repoRoot: string,
  electronBin: string,
  dbKey: string,
  dbPath: string,
  transactionId: string,
): { stdout: string; status: number | null; stderr: string; error?: Error } {
  const run = spawnSync(electronBin, [script, '--db', dbPath, '--key', dbKey, '--transaction-id', transactionId], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_ENABLE_LOGGING: '0' },
    timeout: 30_000,
    killSignal: 'SIGKILL',
  });
  return { stdout: run.stdout || '', status: run.status, stderr: run.stderr || '', error: run.error ?? undefined };
}

function parseSentinel<T>(stdout: string, sentinel: string, status: number | null, stderr: string, label: string): T {
  const line = stdout.split('\n').find((l) => l.includes(sentinel));
  if (!line) {
    throw new Error(`${label} produced no result (exit ${status ?? 'null'}).\n${stderr}`);
  }
  const parsed = JSON.parse(line.slice(line.indexOf(sentinel) + sentinel.length)) as T & { error?: string };
  if (parsed.error) throw new Error(`${label} error: ${parsed.error}`);
  return parsed;
}

/**
 * OBSERVE the email communications LINK ROWS for a transaction (ground truth of what is linked). Throws
 * (→ HARNESS_ERROR upstream) on a launch/decrypt/parse failure. ROWS, not a scalar — the cell asserts
 * exact sets and checks each row's thread_id.
 */
export function readEmailLinks(
  repoRoot: string,
  electronBin: string,
  dbKey: string,
  dbPath: string,
  transactionId: string,
): EmailLinkRow[] {
  const script = join(repoRoot, 'scripts', 'qa', 'harness', 'read-links.js');
  const run = spawnReader(script, repoRoot, electronBin, dbKey, dbPath, transactionId);
  if (run.error) throw new Error(`read-links failed to launch: ${run.error.message}`);
  const parsed = parseSentinel<{ rows?: EmailLinkRow[] }>(run.stdout, EMAIL_LINKS_SENTINEL, run.status, run.stderr, 'read-links');
  return parsed.rows ?? [];
}

/**
 * OBSERVE the ignored_communications TOMBSTONE ROWS for a transaction (ground truth of what unlink
 * suppressed). Throws (→ HARNESS_ERROR upstream) on failure. ROWS, not a scalar.
 */
export function readIgnoredComms(
  repoRoot: string,
  electronBin: string,
  dbKey: string,
  dbPath: string,
  transactionId: string,
): IgnoredCommRow[] {
  const script = join(repoRoot, 'scripts', 'qa', 'harness', 'count-ignored.js');
  const run = spawnReader(script, repoRoot, electronBin, dbKey, dbPath, transactionId);
  if (run.error) throw new Error(`count-ignored failed to launch: ${run.error.message}`);
  const parsed = parseSentinel<{ rows?: IgnoredCommRow[] }>(run.stdout, IGNORED_COMMS_SENTINEL, run.status, run.stderr, 'count-ignored');
  return parsed.rows ?? [];
}

/** Convenience: the sorted set of email_ids among a set of link rows (NULLs dropped). */
export function linkedEmailIdSet(rows: readonly EmailLinkRow[]): string[] {
  return [...new Set(rows.map((r) => r.email_id).filter((x): x is string => !!x))].sort();
}

/** Convenience: the sorted set of email_ids among a set of tombstone rows (NULLs dropped). */
export function ignoredEmailIdSet(rows: readonly IgnoredCommRow[]): string[] {
  return [...new Set(rows.map((r) => r.email_id).filter((x): x is string => !!x))].sort();
}
