/**
 * REMOVE-CONTACT-FROM-TRANSACTION cell — shared core (BACKLOG-1978, P2-C2).
 *
 * EXTENDS the add-users-with-roles cell (BACKLOG-1949). Where that cell drives the "Edit Contacts" UI to
 * ADD contacts (and asserts the exact role triple lands in `transaction_contacts`), THIS cell starts from
 * the DEFAULT seeded state — the 3 fixture contacts ALREADY assigned to the transaction — drives the UI to
 * REMOVE one via its per-chip remove control, and proves the removed contact's junction row is GONE while
 * the other two REMAIN.
 *
 * SCOPE (SR-reviewed): the assertion is on the `transaction_contacts` JUNCTION DELTA ONLY — exactly which
 * contact_ids remain assigned after the remove-and-save. Removing a contact may ALSO auto-unlink that
 * contact's communications (a downstream side effect); that is EXPLICITLY OUT OF SCOPE here and this cell
 * makes NO assertion on `communications`. Keeping the oracle to the junction keeps the cell deterministic
 * and focused on the one behaviour it exists to prove (the remove→delete-junction-row path).
 *
 * Reuses BACKLOG-1949's building blocks:
 *   - QA_SEED_CONTACT_IDS / the seeded fixture (seed-fixture.js) — the SAME 3 fixed UUIDs, here in the
 *     DEFAULT (assigned) seed path (NOT KEEPR_QA_UNASSIGN_CONTACTS), so the junction starts with 3 rows.
 *   - readContactRoles — the cipher-open reader (count-contact-roles.js) that OBSERVES the junction rows
 *     (verify-by-observing, BACKLOG-1875).
 *   - FIXTURE_DB_KEY / applyFixtureDbKey — the fixed, keychain-free DB key.
 *
 * PURE-NODE: no Playwright/Electron/DOM import here, so diffRemoval is unit-testable and type-checked by
 * the harness tsconfig (scripts/qa/harness/tsconfig.json), exactly like users-roles-core.ts.
 */
import { QA_SEED_CONTACT_IDS, type ObservedContactRole } from './users-roles-core';

/** The FIXED, keychain-free DB key path (BACKLOG-1971) — cell-agnostic shared helper. Re-exported for callers. */
export { FIXTURE_DB_KEY, applyFixtureDbKey } from './db-key-fixture';
export { QA_SEED_CONTACT_IDS, readContactRoles, type ObservedContactRole } from './users-roles-core';

/**
 * The default seeded state assigns all three QA_SEED_CONTACT_IDS to the fixture transaction (see
 * seed-fixture.js `transactionContacts` — the DEFAULT, non-unassigned path). This cell REMOVES the
 * SECOND contact (index 2, "Bob Seller") and asserts the OTHER TWO survive. Choosing a MIDDLE contact
 * (not the first/last) makes an off-by-one or "removed the wrong row" bug maximally visible.
 */
export const SEEDED_ASSIGNED_CONTACT_IDS: readonly string[] = [
  QA_SEED_CONTACT_IDS[1],
  QA_SEED_CONTACT_IDS[2],
  QA_SEED_CONTACT_IDS[3],
] as const;

/** The contact this cell removes (the middle of the three seeded assignments). */
export const CONTACT_TO_REMOVE: string = QA_SEED_CONTACT_IDS[2];

/** The contacts that MUST remain assigned after the remove-and-save (everything except CONTACT_TO_REMOVE). */
export const EXPECTED_REMAINING_CONTACT_IDS: readonly string[] = SEEDED_ASSIGNED_CONTACT_IDS.filter(
  (id) => id !== CONTACT_TO_REMOVE,
);

/**
 * A single deviation between the expected post-remove junction and what was OBSERVED. An empty list means
 * the junction is EXACTLY {the two survivors}: the removed row is gone AND both survivors are still there
 * (PASS). Any entry is a FAIL (a real remove-persistence bug).
 */
export interface RemovalDeviation {
  contactId: string;
  /**
   * - `not-removed`   : CONTACT_TO_REMOVE is still in the junction (the remove op didn't delete its row).
   * - `wrongly-removed`: an expected survivor is MISSING from the junction (removed the wrong contact / too many).
   * - `unexpected`     : a contact_id in the junction that is neither an expected survivor (a spurious row).
   */
  kind: 'not-removed' | 'wrongly-removed' | 'unexpected';
}

/**
 * PURE classifier: compare the expected-remaining contact set against the OBSERVED junction rows and
 * return the deviations. This asserts the JUNCTION DELTA ONLY (which contact_ids remain) — it deliberately
 * does NOT compare role/role_category/specific_role (the survivors keep whatever the seed assigned; this
 * cell tests removal MECHANICS, not role fidelity — that is BACKLOG-1949's job). Communications are OUT OF
 * SCOPE and never looked at.
 *
 * An empty result == the junction is exactly the expected survivors (removed one gone, both others kept).
 * A non-empty result is a FAIL:
 *   - the removed contact still present -> 'not-removed'
 *   - an expected survivor absent       -> 'wrongly-removed'
 *   - any other contact present         -> 'unexpected'
 */
export function diffRemoval(
  expectedRemaining: readonly string[],
  removedId: string,
  observed: readonly ObservedContactRole[],
): RemovalDeviation[] {
  const devs: RemovalDeviation[] = [];
  const observedIds = new Set(observed.map((r) => r.contact_id));
  const expectedSet = new Set(expectedRemaining);

  // 1. The removed contact must be ABSENT.
  if (observedIds.has(removedId)) {
    devs.push({ contactId: removedId, kind: 'not-removed' });
  }

  // 2. Every expected survivor must be PRESENT.
  for (const id of expectedRemaining) {
    if (!observedIds.has(id)) {
      devs.push({ contactId: id, kind: 'wrongly-removed' });
    }
  }

  // 3. No OTHER contact may be present (a survivor that isn't expected, or a spurious row). Note the
  //    removed id is handled by (1) with its own precise kind, so exclude it here to avoid a duplicate.
  for (const row of observed) {
    if (!expectedSet.has(row.contact_id) && row.contact_id !== removedId) {
      devs.push({ contactId: row.contact_id, kind: 'unexpected' });
    }
  }

  return devs;
}
