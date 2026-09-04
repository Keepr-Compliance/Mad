/**
 * SQL for the identity-evidence gatherer — BACKLOG-3044 PR 2.
 *
 * Moved out of `electron/services/contactIdentityEvidence.ts` (5 sites). The gatherer
 * assembles the facts shown beside a proposed link so a person can answer "same human
 * or not"; it renders no sentence of its own.
 *
 * Three of the five splice a fragment that ALREADY lived inside `db/` and is imported
 * here unchanged — `ACTIVE_CONTACTS_CLAUSE_UNALIASED`,
 * `IMPORTED_CONTACT_LAST_COMMUNICATION_SQL`, `EXTERNAL_CONTACT_LAST_MESSAGE_EXPR`.
 * That is why this file's move is a relocation and not a rewrite: the fragments were
 * already `SafeSql`, so the tag accepts them and no statement changed.
 *
 * Text is byte-identical to what it replaced, verified by
 * `scripts/ci/sql-move-identity.mjs`.
 */

import { sql } from "./core/sqlText";
import { ACTIVE_CONTACTS_CLAUSE_UNALIASED } from "./contactTombstoneSql";
import {
  EXTERNAL_CONTACT_LAST_MESSAGE_EXPR,
  IMPORTED_CONTACT_LAST_COMMUNICATION_SQL,
} from "./contactRecencySql";

/**
 * A contact's display name, plus whether it is still active. Named parameters `@id`
 * and `@userId`.
 *
 * The `EXISTS` subquery re-asks for the same row under the tombstone clause rather
 * than selecting `removed_at` and letting the caller compare. That is deliberate: the
 * gatherer reports `is_active` as a FACT, and one predicate — the shared
 * `ACTIVE_CONTACTS_CLAUSE_UNALIASED` — decides what active means everywhere. A local
 * `removed_at IS NULL` here would be a second definition able to drift from it.
 *
 * `user_id = @userId` on the outer read is the authorisation check; the inner `EXISTS`
 * is scoped by id alone because the outer read has already established ownership.
 */
export const CONTACT_NAME_AND_ACTIVE_SQL = sql`SELECT display_name,
            CASE WHEN EXISTS (
              SELECT 1 FROM contacts WHERE id = @id${ACTIVE_CONTACTS_CLAUSE_UNALIASED}
            ) THEN 1 ELSE 0 END AS is_active
       FROM contacts WHERE id = @id AND user_id = @userId`;

/** A contact's email addresses. One bound parameter: contact id. */
export const CONTACT_EMAILS_SQL = sql`SELECT email FROM contact_emails WHERE contact_id = ?`;

/** A contact's phone numbers, in E.164. One bound parameter: contact id. */
export const CONTACT_PHONES_SQL = sql`SELECT phone_e164 FROM contact_phones WHERE contact_id = ?`;

/**
 * When an imported contact was last in touch, across all four channels. One bound
 * parameter: contact id.
 *
 * The expression is `IMPORTED_CONTACT_LAST_COMMUNICATION_SQL` from
 * `contactRecencySql.ts`, shared with the Clients & Contacts list so the evidence
 * panel and the list cannot disagree about recency. It references the outer query's
 * `c` alias, which is why the `FROM` clause here must alias `contacts` as `c`.
 */
export const IMPORTED_CONTACT_RECENCY_SQL = sql`SELECT ${IMPORTED_CONTACT_LAST_COMMUNICATION_SQL} FROM contacts c WHERE c.id = ?`;

/**
 * One external record with its own last-message timestamp. Three bound parameters:
 * user id, source, external record id.
 *
 * `LIMIT 1` is total rather than defensive — the three-column crosswalk key is unique.
 */
export const EXTERNAL_RECORD_WITH_RECENCY_SQL = sql`SELECT name, emails_json, phones_json,
            ${EXTERNAL_CONTACT_LAST_MESSAGE_EXPR} AS last_message_at
       FROM external_contacts
      WHERE user_id = ? AND source = ? AND external_record_id = ?
      LIMIT 1`;
