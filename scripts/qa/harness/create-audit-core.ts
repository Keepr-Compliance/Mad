/**
 * CREATE-AUDIT UI-flow cell — shared core (BACKLOG-1948).
 *
 * Reusable helpers shared by the Playwright spec (e2e/tests/create-audit.spec.ts) — and any future
 * headless CLI — for the New Audit CREATE flow:
 *
 *   1. FIXTURE_DB_KEY / applyFixtureDbKey — the FIXED, keychain-free DB key for the whole cell
 *      (re-exported from db-key-fixture so this cell inherits the same single-instance / no-keychain
 *      isolation as the filter-toggle cell, BACKLOG-1971).
 *   2. KNOWN_CREATE_* — the deterministic address + dates the wizard enters, and the seeded contact
 *      it assigns. Kept HERE (one place) so the driver, the spec, and the unit tests never drift.
 *   3. buildExpectedCreate — the expected DB shape (address + started_at prefix) the assertion checks.
 *   4. countCreatedTransactions — OBSERVE the actual transactions rows the app REALLY created, via the
 *      cipher-open count-transactions.js reader (verify-by-observing, BACKLOG-1875).
 *
 * WHY A DISTINCT KNOWN ADDRESS: the seeded fixture already contains ONE transaction (the filter-toggle
 * fixture's "742 Birchwood Lane NE"). The create cell enters a DIFFERENT, unique address so the
 * assertion ("exactly one transactions row with THIS address") is unambiguous and independent of the
 * seed. The started_at is a FIXED past date (not "today") so the DB match never depends on the clock.
 *
 * ABI NOTE (see filter-toggle-core): better-sqlite3-multiple-ciphers is built against ELECTRON's ABI,
 * so the reader runs under `ELECTRON_RUN_AS_NODE=1 electron` (headless) with --key (no keychain).
 */
import { spawnSync } from 'node:child_process';

/** FIXED, keychain-free DB key — the same one every cell uses (promoted in BACKLOG-1971). */
export { FIXTURE_DB_KEY, applyFixtureDbKey } from './db-key-fixture';

/** The seeded, imported contact the create wizard selects + assigns (see seed-fixture.js). */
export const KNOWN_CREATE_CONTACT_ID = 'qa-seed-contact-1';

/** The step-3 role value that satisfies the wizard's Client gate (useAuditSteps: contactAssignments.client). */
export const KNOWN_CREATE_ROLE = 'client';

/**
 * The unique property address the wizard enters — deliberately NOT the seeded fixture's address, so
 * "exactly one transactions row with this address" is unambiguous. A stable, distinctive string.
 */
export const KNOWN_CREATE_ADDRESS = '1948 Harness Way, Auditville, QA 00019';

/** A FIXED past representation-start date (ISO, YYYY-MM-DD) — clock-independent so the DB match is stable. */
export const KNOWN_CREATE_START_DATE = '2024-03-15';

/** The expected DB shape the assertion verifies after the wizard runs. */
export interface ExpectedCreate {
  address: string;
  startedAtPrefix: string;
  /** Exactly one row is expected on a clean profile. */
  expectedCount: number;
}

export function buildExpectedCreate(
  overrides: Partial<ExpectedCreate> = {},
): ExpectedCreate {
  return {
    address: KNOWN_CREATE_ADDRESS,
    startedAtPrefix: KNOWN_CREATE_START_DATE,
    expectedCount: 1,
    ...overrides,
  };
}

const TX_SENTINEL = '__QA_TX_COUNT__ ';

/** A sampled transactions row returned by the reader (for diagnostics + the exactly-one assertion). */
export interface TransactionSampleRow {
  id: string;
  property_address: string;
  started_at: string | null;
  closed_at: string | null;
  status: string | null;
}

export interface CreatedTransactionsResult {
  n: number;
  sample: TransactionSampleRow[];
}

/**
 * OBSERVE the transactions rows the app actually created for a given address (+ optional started_at
 * prefix), via the cipher-open count-transactions.js reader. Throws on a launch/decrypt/parse failure
 * (→ HARNESS_ERROR upstream). This is the DB ground truth for the create assertion.
 */
export function countCreatedTransactions(
  repoRoot: string,
  electronBin: string,
  dbKey: string,
  dbPath: string,
  address: string,
  startedAtPrefix?: string,
): CreatedTransactionsResult {
  const script = `${repoRoot}/scripts/qa/harness/count-transactions.js`;
  const args = [script, '--db', dbPath, '--key', dbKey, '--address', address];
  if (startedAtPrefix) args.push('--started-at', startedAtPrefix);
  const run = spawnSync(electronBin, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_ENABLE_LOGGING: '0' },
    timeout: 30_000,
    killSignal: 'SIGKILL',
  });
  if (run.error) throw new Error(`count-transactions failed to launch: ${run.error.message}`);
  const line = (run.stdout || '').split('\n').find((l) => l.includes(TX_SENTINEL));
  if (!line) {
    throw new Error(`count-transactions produced no result (exit ${run.status ?? 'null'}).\n${run.stderr ?? ''}`);
  }
  const parsed = JSON.parse(line.slice(line.indexOf(TX_SENTINEL) + TX_SENTINEL.length)) as {
    n?: number;
    sample?: TransactionSampleRow[];
    error?: string;
  };
  if (parsed.error) throw new Error(`count-transactions error: ${parsed.error}`);
  return { n: parsed.n ?? 0, sample: parsed.sample ?? [] };
}
