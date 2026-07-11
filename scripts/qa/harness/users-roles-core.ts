/**
 * ADD-USERS-WITH-ROLES cell — shared core (BACKLOG-1949).
 *
 * Reusable helpers shared by the Playwright spec (e2e/tests/users-roles.spec.ts) and any standalone
 * CLI. Mirrors the BACKLOG-1950 filter-toggle-core pattern:
 *
 *   1. FIXTURE_DB_KEY / applyFixtureDbKey — the FIXED, keychain-free DB key (re-exported from the
 *      cell-agnostic db-key-fixture, BACKLOG-1971).
 *   2. EXPECTED_ROLE_TRIPLES — the deterministic ground truth: which seeded contact gets which
 *      {role, role_category, specific_role} in this cell.
 *   3. readContactRoles — OBSERVE the actual `transaction_contacts` rows from the encrypted DB
 *      (verify-by-observing, BACKLOG-1875) via the count-contact-roles.js cipher-open reader.
 *   4. diffRoles — a PURE function that classifies observed vs expected into per-contact deviations,
 *      so a wrong/missing role is a FAIL and a well-formed match is a PASS. Unit-tested without any
 *      app launch (scripts/qa/harness/__tests__/users-roles-core.test.ts).
 *
 * ROLE CHOICE (BACKLOG-1949, SR-reviewed): the fixture transaction is `transaction_type:'purchase'`.
 * The role dropdown options are the INTERSECTION of AUDIT_WORKFLOW_STEPS roles AND the purchase filter
 * (filterRolesByTransactionType): the "Client & Agents" step offers only seller / seller_agent for
 * purchase (buyer/buyer_agent are excluded — the user IS the buyer), and escrow_officer comes from the
 * unfiltered "Professional Services" step. (listing_agent PASSES the filter but is not in any step's
 * role list, so it never renders — do NOT use it.) So the three assignable, deterministic roles are:
 *   seller (category client) · seller_agent (category agent) · escrow_officer (category title_escrow).
 * role_category values mirror ROLE_TO_CATEGORY in src/constants/contactRoles.ts.
 *
 * PURE-NODE: no Playwright/Electron/DOM import here (the reader spawn is Node child_process), so the
 * diff/expected logic is unit-testable and type-checked by the harness tsconfig.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/** The FIXED, keychain-free DB key path (BACKLOG-1971) — cell-agnostic shared helper. */
export { FIXTURE_DB_KEY, applyFixtureDbKey } from './db-key-fixture';

/** One assigned contact's role triple as it must land in `transaction_contacts`. */
export interface RoleTriple {
  contactId: string;
  role: string;
  roleCategory: string;
  specificRole: string;
}

/** A row as OBSERVED from the encrypted DB by count-contact-roles.js. */
export interface ObservedContactRole {
  contact_id: string;
  role: string | null;
  role_category: string | null;
  specific_role: string | null;
  is_primary?: number | null;
}

/**
 * The deterministic expected assignment for this cell. Contact IDs are the fixture's seeded ids
 * (scripts/qa/harness/seed-fixture.js). The display names are intentionally arbitrary vs. the assigned
 * roles — the cell tests role-assignment MECHANICS, not semantic name matching.
 */
export const EXPECTED_ROLE_TRIPLES: readonly RoleTriple[] = [
  { contactId: 'qa-seed-contact-1', role: 'seller', roleCategory: 'client', specificRole: 'seller' },
  { contactId: 'qa-seed-contact-2', role: 'seller_agent', roleCategory: 'agent', specificRole: 'seller_agent' },
  { contactId: 'qa-seed-contact-3', role: 'escrow_officer', roleCategory: 'title_escrow', specificRole: 'escrow_officer' },
] as const;

/** A single per-contact deviation between expected and observed. Empty list = every triple matched. */
export interface RoleDeviation {
  contactId: string;
  /** Why it deviated. `missing` = contact absent from the junction (not assigned at all). */
  kind: 'missing' | 'wrong-role' | 'wrong-category' | 'wrong-specific-role';
  expected: string;
  got: string | null;
}

/**
 * PURE classifier: compare the expected role triples against the OBSERVED junction rows and return the
 * deviations. Missing contact -> 'missing'; a present contact whose role/category/specific_role differs
 * -> the matching wrong-* kind. An empty result means every contact was assigned with the exact
 * expected triple (PASS). A non-empty result is a FAIL (a real app bug in role persistence/derivation).
 * Extra unexpected contacts in the junction are also reported (kind 'wrong-role' with expected '').
 */
export function diffRoles(
  expected: readonly RoleTriple[],
  observed: readonly ObservedContactRole[],
): RoleDeviation[] {
  const devs: RoleDeviation[] = [];
  const byId = new Map<string, ObservedContactRole>();
  for (const row of observed) byId.set(row.contact_id, row);

  for (const exp of expected) {
    const row = byId.get(exp.contactId);
    if (!row) {
      devs.push({ contactId: exp.contactId, kind: 'missing', expected: exp.role, got: null });
      continue;
    }
    if (row.role !== exp.role) {
      devs.push({ contactId: exp.contactId, kind: 'wrong-role', expected: exp.role, got: row.role });
    }
    if (row.role_category !== exp.roleCategory) {
      devs.push({
        contactId: exp.contactId,
        kind: 'wrong-category',
        expected: exp.roleCategory,
        got: row.role_category,
      });
    }
    if (row.specific_role !== exp.specificRole) {
      devs.push({
        contactId: exp.contactId,
        kind: 'wrong-specific-role',
        expected: exp.specificRole,
        got: row.specific_role,
      });
    }
  }

  // Surface any UNEXPECTED assigned contact (the add flow linked someone it shouldn't have).
  const expectedIds = new Set(expected.map((e) => e.contactId));
  for (const row of observed) {
    if (!expectedIds.has(row.contact_id)) {
      devs.push({ contactId: row.contact_id, kind: 'wrong-role', expected: '', got: row.role });
    }
  }
  return devs;
}

const CONTACT_ROLES_SENTINEL = '__QA_CONTACT_ROLES__ ';

/**
 * OBSERVE the actual `transaction_contacts` rows for a transaction from the encrypted DB (the ground
 * truth of what the add-with-role UI persisted). Runs the cipher-open in the dedicated
 * count-contact-roles.js script under `ELECTRON_RUN_AS_NODE=1 electron` (headless) with `--key` — no
 * keychain, no GUI, no app launch. Throws (-> HARNESS_ERROR upstream) on a launch/decrypt/parse
 * failure. Args are passed via argv (no shell) so nothing is shell-interpolated.
 */
export function readContactRoles(
  repoRoot: string,
  electronBin: string,
  dbKey: string,
  dbPath: string,
  transactionId: string,
): ObservedContactRole[] {
  const script = join(repoRoot, 'scripts', 'qa', 'harness', 'count-contact-roles.js');
  const run = spawnSync(electronBin, [script, '--db', dbPath, '--key', dbKey, '--transaction-id', transactionId], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_ENABLE_LOGGING: '0' },
    timeout: 30_000,
    killSignal: 'SIGKILL',
  });
  if (run.error) throw new Error(`count-contact-roles failed to launch: ${run.error.message}`);
  const line = (run.stdout || '').split('\n').find((l) => l.includes(CONTACT_ROLES_SENTINEL));
  if (!line) {
    throw new Error(`count-contact-roles produced no result (exit ${run.status ?? 'null'}).\n${run.stderr ?? ''}`);
  }
  const parsed = JSON.parse(
    line.slice(line.indexOf(CONTACT_ROLES_SENTINEL) + CONTACT_ROLES_SENTINEL.length),
  ) as { rows?: ObservedContactRole[]; error?: string };
  if (parsed.error) throw new Error(`count-contact-roles error: ${parsed.error}`);
  return parsed.rows ?? [];
}
