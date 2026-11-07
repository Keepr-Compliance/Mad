/**
 * SQL for the contact source linker — BACKLOG-3044 PR 3.
 *
 * Moved out of `electron/services/contactSourceLinker.ts` (4 sites). The linker
 * resolves a contact to the address-book records it came from, through the crosswalk
 * (`user_id`, `source`, `external_record_id`) rather than by name — a rename changes
 * `name`, never `external_record_id`, which is what makes a link survive an
 * address-book edit.
 *
 * The service keeps its own `dbGet` / `dbAll` calls. Only the TEXT moved.
 *
 * Text is byte-identical to what it replaced, verified by
 * `scripts/ci/sql-move-identity.mjs`. The hanging indentation inside these templates
 * is the original's — the control hashes cooked text and fails on one changed space.
 *
 * ## Three of the four statements are here; the fourth is a reference
 *
 * `contactSourceLinker.ts:520` reads a contact's display name — the same sentence
 * BACKLOG-3044 PR 2 had already exported as `CONTACT_DISPLAY_NAME_SQL` from
 * `db/contactLinkEvidenceSql.ts`. The first version of this module defined a
 * byte-identical copy under the same name. The caller now imports the existing one.
 */

import { sql, type SafeSql } from "./core/sqlText";

/**
 * One external record's value blobs. Three bound parameters: user id, source,
 * external record id.
 *
 * ## Named `_ONE_` because a same-named twin exists and they are NOT the same statement
 *
 * `contactSourceValuesSql.EXTERNAL_RECORD_VALUES_SQL` selects the same columns from the
 * same table under the same predicate and **ends without `LIMIT 1`**. Two different
 * texts. This module first exported them under the identical name, which is a reader
 * trap rather than a duplication: an import list shows one name, and which statement
 * you get depends on the module path.
 *
 * They are not merged, because merging would change one of the two statements — the
 * thing this move must not do. They are distinguished by name instead, which changes
 * no text at all.
 */
export const EXTERNAL_RECORD_VALUES_ONE_SQL = sql`SELECT emails_json, phones_json FROM external_contacts
      WHERE user_id = ? AND source = ? AND external_record_id = ? LIMIT 1`;

/**
 * Is this external record from the CURRENT sync of its source? Three bound
 * parameters: user id, source, external record id.
 *
 * The correlated `MAX(w.synced_at)` scoped to the same `(user_id, source)` is the
 * whole point: it asks "is this row from the newest sweep of this address book",
 * without needing a stored flag that could go stale. A row from an older sweep is a
 * record the source no longer returns, so treating it as live would resurrect a
 * contact the user deleted upstream.
 *
 * `ec.synced_at IS NULL` is admitted deliberately — a record that predates the
 * `synced_at` column cannot be shown to be stale, and the linker's rule is that
 * absence of evidence is not evidence of removal.
 */
export const EXTERNAL_RECORD_IS_CURRENT_SQL = sql`SELECT 1 AS hit FROM external_contacts ec
      WHERE ec.user_id = ? AND ec.source = ? AND ec.external_record_id = ?
        AND (
          ec.synced_at IS NULL
          OR ec.synced_at = (
            SELECT MAX(w.synced_at) FROM external_contacts w
             WHERE w.user_id = ec.user_id AND w.source = ec.source
          )
        )
      LIMIT 1`;

/**
 * Every external record for a user that has a crosswalk key. One bound parameter.
 *
 * `external_record_id IS NOT NULL` excludes rows with nothing stable to link to.
 * `ORDER BY source, external_record_id` is total, so the linker's output is
 * reproducible run to run rather than dependent on storage order.
 */
export const ALL_KEYED_EXTERNAL_RECORDS_SQL = sql`SELECT external_record_id, source, name, emails_json, phones_json, external_uuid
       FROM external_contacts
      WHERE user_id = ? AND external_record_id IS NOT NULL
      ORDER BY source, external_record_id`;

/**
 * BACKLOG-4180 — the identifier keys of a set of saved contacts, as the match
 * index compares them. Phones: the stored `phone_normalized`. Emails:
 * `LOWER(TRIM(email))` — the index lowercases the stored side and trims the
 * probe side, so trimming both here can only widen the candidate set, never
 * narrow it. The linker still decides every match.
 */
export const scopedContactPhoneKeysSql = (marks: SafeSql): SafeSql =>
  sql`SELECT DISTINCT phone_normalized AS k FROM contact_phones
       WHERE contact_id IN (${marks}) AND phone_normalized IS NOT NULL AND phone_normalized <> ''`;

export const scopedContactEmailKeysSql = (marks: SafeSql): SafeSql =>
  sql`SELECT DISTINCT LOWER(TRIM(email)) AS k FROM contact_emails
       WHERE contact_id IN (${marks}) AND TRIM(email) <> ''`;

/**
 * BACKLOG-4180 — the keyed source records that share a phone key or an email
 * with the given keys. Same columns and same total order as
 * ALL_KEYED_EXTERNAL_RECORDS_SQL, so a scoped pass sees its records in the
 * order the full pass would.
 *
 * Phones compare on the STORED lookup keys (`phones_normalized_json`), not on
 * libphonenumber at read time. The linker's own probe is `toMatchingKey`, which
 * is `toLookupKey` above a digit floor, so a stored key is a superset of what
 * the linker can match on. `json_valid` guards both arrays: one bad row must not
 * fail the whole selection.
 *
 * Bind order: userId, then the phone keys, then the email keys. Either arm may
 * be omitted by passing `null` for its marks.
 */
export const scopedKeyedExternalRecordsSql = (
  phoneMarks: SafeSql | null,
  emailMarks: SafeSql | null,
): SafeSql => {
  const phoneArm = phoneMarks
    ? sql`EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(ec.phones_normalized_json)
                                               THEN ec.phones_normalized_json ELSE '[]' END) p
                    WHERE p.value IN (${phoneMarks}))`
    : sql`0`;
  const emailArm = emailMarks
    ? sql`EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(ec.emails_json)
                                               THEN ec.emails_json ELSE '[]' END) e
                    WHERE e.type = 'text' AND LOWER(TRIM(e.value)) IN (${emailMarks}))`
    : sql`0`;
  return sql`SELECT ec.external_record_id, ec.source, ec.name, ec.emails_json, ec.phones_json, ec.external_uuid
       FROM external_contacts ec
      WHERE ec.user_id = ? AND ec.external_record_id IS NOT NULL
        AND (${phoneArm} OR ${emailArm})
      ORDER BY ec.source, ec.external_record_id`;
};
