/**
 * SQL for contact source values — BACKLOG-3044 PR 3.
 *
 * Moved out of `electron/services/contactSourceValues.ts` (4 sites): two reads that
 * gather the emails and phones a contact inherited from its source records, and two
 * deletes that withdraw them again.
 *
 * ## `source = 'import'` is the safety rail on both deletes, not a filter
 *
 * A value on a contact is either something a PERSON typed or something an IMPORT
 * copied in. The two deletes below withdraw values whose source record no longer
 * offers them — and they must never touch a hand-entered value, because that would be
 * silent data loss the user cannot undo. `source = 'import'` in the text is what makes
 * that structural rather than a caller's responsibility.
 *
 * The literal `'import'` is a value in SQL text, and it stays that way deliberately:
 * moving it to a bound parameter would change the statement, which is what this move
 * must not do. It is a fixed marker rather than data, so it is not BACKLOG-3103's
 * class — nothing reaches it from user input, and it is the same constant on every
 * execution.
 *
 * ## Why the phone delete normalises and the email delete lowercases
 *
 * They match the shape of the values as stored. `COALESCE(NULLIF(phone_normalized,
 * ''), phone_e164)` prefers the normalised form and falls back to E.164 when
 * normalisation produced nothing — an empty string, not NULL, which is why `NULLIF`
 * is there. `LOWER(TRIM(email))` mirrors how email keys are compared everywhere else.
 * A delete that failed to match its own stored form would leave the withdrawn value
 * on the contact forever, which is the failure these two shapes prevent.
 *
 * Text is byte-identical to what it replaced, verified by
 * `scripts/ci/sql-move-identity.mjs`.
 */

import { sql } from "./core/sqlText";

/**
 * Every source record linked to a contact, with its value blobs. Two bound
 * parameters: user id, contact id.
 *
 * Inner `JOIN`: this read answers "what do the sources currently say", so a link whose
 * external record has vanished contributes nothing and must not appear as a row of
 * nulls. That is the opposite of `contactProvenanceSql.ts`, which LEFT JOINs the same
 * tables because it is reporting an audit trail rather than gathering live values.
 */
export const CONTACT_SOURCE_VALUES_SQL = sql`SELECT ec.source, ec.external_record_id, ec.emails_json, ec.phones_json
       FROM contact_source_links csl
       JOIN external_contacts ec
         ON ec.user_id = csl.user_id
        AND ec.source = csl.source_type
        AND ec.external_record_id = csl.source_record_id
      WHERE csl.user_id = ? AND csl.contact_id = ?
      ORDER BY ec.source, ec.external_record_id`;

/**
 * One external record's value blobs. Three bound parameters: user id, source,
 * external record id.
 *
 * Deliberately NOT merged with `contactSourceLinkerSql.EXTERNAL_RECORD_VALUES_SQL`,
 * which reads the same columns from the same table: that one ends `LIMIT 1` and this
 * one does not. Two different texts, and collapsing them would change one statement to
 * save a constant — the tidy-up this move exists to refuse.
 */
export const EXTERNAL_RECORD_VALUES_SQL = sql`SELECT emails_json, phones_json FROM external_contacts
      WHERE user_id = ? AND source = ? AND external_record_id = ?`;

/**
 * Withdraw one imported email from a contact. Two bound parameters: contact id, and
 * the lowercased/trimmed address.
 *
 * `source = 'import'` protects hand-entered values — see this file's header.
 */
export const DELETE_IMPORTED_EMAIL_SQL = sql`DELETE FROM contact_emails
          WHERE contact_id = ? AND LOWER(TRIM(email)) = ? AND source = 'import'`;

/**
 * Withdraw one imported phone from a contact. Two bound parameters: contact id, and
 * the normalised number.
 *
 * `source = 'import'` protects hand-entered values — see this file's header.
 */
export const DELETE_IMPORTED_PHONE_SQL = sql`DELETE FROM contact_phones
          WHERE contact_id = ?
            AND COALESCE(NULLIF(phone_normalized, ''), phone_e164) = ?
            AND source = 'import'`;
