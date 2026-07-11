/**
 * CONTACTS CATEGORY-FILTER cell — shared core (BACKLOG-1977, P2-C1).
 *
 * Reusable helpers shared by the Playwright spec (e2e/tests/contacts-filter.spec.ts) and the
 * pure-Node unit test (scripts/qa/harness/__tests__/contacts-filter-core.test.ts). Mirrors the
 * BACKLOG-1950 filter-toggle-core / BACKLOG-1949 users-roles-core patterns:
 *
 *   1. FIXTURE_DB_KEY / applyFixtureDbKey — the FIXED, keychain-free DB key (re-exported from the
 *      cell-agnostic db-key-fixture, BACKLOG-1971).
 *   2. EXPECTED_FILTER_CONTACTS — the deterministic ground truth: the KNOWN {source, default_role}
 *      corpus the seeder plants under KEEPR_QA_SEED_CONTACT_FILTER=1. Cross-checked against
 *      seed-fixture.js (single source of truth) by the unit test.
 *   3. readImportedContacts — OBSERVE the actual imported-contact category rows from the encrypted DB
 *      (verify-by-observing, BACKLOG-1875) via the count-contacts.js cipher-open reader.
 *
 * The ORACLE (apply the REAL production predicate matchesContactFilters over the observed rows) and the
 * driven filter SCENARIOS live in e2e/driver/contactsFilterOracle.ts, NOT here: the harness tsconfig
 * (scripts/qa/harness/tsconfig.json, rootDir=scripts/qa/harness) rejects a cross-tree import from src/,
 * so the src-dependent oracle is compiled by e2e/tsconfig (qa:e2e:typecheck) instead. THIS module stays
 * pure-Node (reader spawn + corpus constants only), so it type-checks under BOTH qa:typecheck and the
 * e2e tsconfig, and is unit-testable with no app launch.
 *
 * TRUST MODEL (e2e/driver/outcome.ts): a missing testid / driver / setup failure is a HARNESS_ERROR
 * (thrown → the run is untrustworthy, NOT a false FAIL); a WRONG rendered count is a FAIL (a real app
 * bug in the filter); a matching count is a PASS. We NEVER fake counts to make it green.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/** The FIXED, keychain-free DB key path (BACKLOG-1971) — cell-agnostic shared helper. */
export { FIXTURE_DB_KEY, applyFixtureDbKey } from './db-key-fixture';

/** Env var the seeder honours to plant the BACKLOG-1977 known source×role contact corpus. */
export const SEED_CONTACT_FILTER_ENV = 'KEEPR_QA_SEED_CONTACT_FILTER';

/**
 * One expected seeded contact's category inputs. `default_role: null` = Unassigned. These MUST be
 * byte-identical to QA_FILTER_CONTACTS in scripts/qa/harness/seed-fixture.js (the writer); because the
 * seeder runs in a separate Electron-main process from this Node cell, the corpus is duplicated here and
 * a qa:test cross-check (contacts-filter-core.test.ts) asserts the two agree.
 */
export interface ExpectedFilterContact {
  id: string;
  source: string;
  default_role: string | null;
}

/**
 * The deterministic contact corpus (source × default_role mix) seeded under
 * KEEPR_QA_SEED_CONTACT_FILTER=1. Per-source-leaf counts: manual=2 · contacts_app=1 · outlook=2 ·
 * google_contacts=1 · iphone=2. Per-role-leaf: buyers(buyer/client)=2 · sellers(seller)=2 ·
 * agents(seller_agent)=2 · unassigned(NULL)=2. Ids/tails echo BACKLOG-1977.
 */
export const EXPECTED_FILTER_CONTACTS: readonly ExpectedFilterContact[] = [
  { id: '00000000-0000-4000-8000-000000001971', source: 'manual', default_role: 'buyer' },
  { id: '00000000-0000-4000-8000-000000001972', source: 'manual', default_role: 'seller' },
  { id: '00000000-0000-4000-8000-000000001973', source: 'contacts_app', default_role: 'seller_agent' },
  { id: '00000000-0000-4000-8000-000000001974', source: 'outlook', default_role: 'client' },
  { id: '00000000-0000-4000-8000-000000001975', source: 'outlook', default_role: null },
  { id: '00000000-0000-4000-8000-000000001976', source: 'google_contacts', default_role: 'seller' },
  { id: '00000000-0000-4000-8000-000000001977', source: 'iphone', default_role: 'seller_agent' },
  { id: '00000000-0000-4000-8000-000000001978', source: 'iphone', default_role: null },
] as const;

/**
 * The 3 ALWAYS-seeded default contacts (Alice/Bob/Carol) carry source='email' + default_role=NULL. The
 * source 'email' matches NO source leaf, so under any source selection they are filtered OUT — but the
 * oracle reads EVERY imported contact and applies the predicate, so they are accounted for (they simply
 * never contribute to a category count). Documented here so the corpus math is explicit.
 */
export const DEFAULT_EMAIL_SOURCE_CONTACT_COUNT = 3;

/** A row as OBSERVED from the encrypted DB by count-contacts.js. */
export interface ObservedContactRow {
  id: string;
  source: string | null;
  default_role: string | null;
  is_message_derived?: number | null;
}

const CONTACTS_ROWS_SENTINEL = '__QA_CONTACTS_ROWS__ ';

/**
 * OBSERVE the imported-contact category rows for a user from the encrypted DB (the ground truth the
 * grouped Source/Role filter runs over). Runs the cipher-open in count-contacts.js under
 * `ELECTRON_RUN_AS_NODE=1 electron` (headless) with `--key` — no keychain, no GUI, no app launch.
 * Throws (→ HARNESS_ERROR upstream) on a launch/decrypt/parse failure. Args via argv (no shell).
 */
export function readImportedContacts(
  repoRoot: string,
  electronBin: string,
  dbKey: string,
  dbPath: string,
  userId: string,
): ObservedContactRow[] {
  const script = join(repoRoot, 'scripts', 'qa', 'harness', 'count-contacts.js');
  const run = spawnSync(electronBin, [script, '--db', dbPath, '--key', dbKey, '--user-id', userId], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_ENABLE_LOGGING: '0' },
    timeout: 30_000,
    killSignal: 'SIGKILL',
  });
  if (run.error) throw new Error(`count-contacts failed to launch: ${run.error.message}`);
  const line = (run.stdout || '').split('\n').find((l) => l.includes(CONTACTS_ROWS_SENTINEL));
  if (!line) {
    throw new Error(`count-contacts produced no result (exit ${run.status ?? 'null'}).\n${run.stderr ?? ''}`);
  }
  const parsed = JSON.parse(
    line.slice(line.indexOf(CONTACTS_ROWS_SENTINEL) + CONTACTS_ROWS_SENTINEL.length),
  ) as { rows?: ObservedContactRow[]; error?: string };
  if (parsed.error) throw new Error(`count-contacts error: ${parsed.error}`);
  return parsed.rows ?? [];
}
