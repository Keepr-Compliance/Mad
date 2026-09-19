/**
 * SQL for manual contact linking — BACKLOG-3044 PR 2.
 *
 * Moved out of `electron/services/contactManualLink.ts` (3 sites). These are the
 * existence checks run before a person links a contact to a source record by hand.
 *
 * ## Two reads of `contacts` that differ by one clause, and the difference is the rule
 *
 * `ACTIVE_CONTACT_EXISTS_SQL` appends `ACTIVE_CONTACTS_CLAUSE_UNALIASED`;
 * `CONTACT_EXISTS_SQL` does not. They are not a near-duplicate to be collapsed — they
 * are the two halves of the founder's settled ruling that MANUAL linking is ungated
 * where AUTOMATIC linking is gated. The caller asks the first question when the answer
 * should exclude a tombstoned contact and the second when a person has explicitly
 * chosen that contact and a tombstone should not silently overrule them.
 *
 * Merging them behind a boolean would put that decision inside a parameter, where the
 * next reader cannot see it. They stay two statements.
 *
 * Text is byte-identical to what it replaced, verified by
 * `scripts/ci/sql-move-identity.mjs`.
 */

import { sql } from "./core/sqlText";
import { ACTIVE_CONTACTS_CLAUSE_UNALIASED } from "./contactTombstoneSql";

/**
 * Does this contact exist, belong to this user, and is it still active? Two bound
 * parameters: contact id, user id.
 *
 * The tombstone clause is the shared `ACTIVE_CONTACTS_CLAUSE_UNALIASED`, so "active"
 * means the same thing here as everywhere else rather than being restated.
 */
export const ACTIVE_CONTACT_EXISTS_SQL = sql`SELECT id FROM contacts WHERE id = ? AND user_id = ?${ACTIVE_CONTACTS_CLAUSE_UNALIASED}`;

/**
 * Does this contact exist and belong to this user, tombstone or not? Two bound
 * parameters: contact id, user id.
 *
 * The missing tombstone clause is the point — see this file's header.
 */
export const CONTACT_EXISTS_SQL = sql`SELECT id FROM contacts WHERE id = ? AND user_id = ?`;

/**
 * Does this external record exist? Three bound parameters: user id, source, external
 * record id.
 */
export const EXTERNAL_RECORD_EXISTS_SQL = sql`SELECT id FROM external_contacts
        WHERE user_id = ? AND source = ? AND external_record_id = ? LIMIT 1`;
