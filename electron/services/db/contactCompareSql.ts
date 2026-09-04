/**
 * SQL for the contact compare screen — BACKLOG-3044 PR 2.
 *
 * Moved out of `electron/services/contactCompare.ts` (7 sites). The service answers
 * "are these two records the same person", and before this move it authored every one
 * of its reads itself and handed the text to the conduit as a plain string — which the
 * SQL boundary gate cannot see, because the conduit's own `.prepare()` is in-layer.
 *
 * The service keeps its own `dbAll` / `dbGet` calls. Only the TEXT moved.
 *
 * ## These reads are EVIDENCE GATHERING, and that is why they are deliberately wide
 *
 * A merge decision is irreversible in the way that matters — two people merged into
 * one is a data-loss bug the user cannot undo by hand. So the compare path reads
 * broadly and lets the caller weigh: `getContactRowForCompare` returns `removed_at`
 * rather than filtering on it, and `linkedRecordsForContact` LEFT JOINs
 * `external_contacts` so a link whose source record has vanished still appears as a
 * row with nulls instead of disappearing. Narrowing any of these to "only the live
 * ones" would DISCARD evidence and make a wrong merge more likely, which is the
 * under-reporting trap `contactLinkEvidence.ts` documents at length.
 *
 * Text is byte-identical to what it replaced, verified by
 * `scripts/ci/sql-move-identity.mjs`. The hanging `FROM` / `WHERE` alignment inside
 * these templates is the original's and is not to be tidied — the control hashes the
 * cooked text and fails on a single changed space.
 */

import { sql } from "./core/sqlText";
import { placeholderList } from "./core/sqlFragments";
import type { SafeSql } from "./core/sqlText";

/**
 * Emails addressed to or from any of a set of addresses, for the shared-correspondence
 * signal. Bound parameters: the user id, then one per address.
 *
 * The address list is a generated placeholder list, never spliced values —
 * `placeholderList(n)` emits `?, ?, ?`, byte-for-byte what
 * `keys.map(() => "?").join(", ")` produced at the old call site, and the addresses
 * themselves travel in the params array.
 *
 * `LOWER(TRIM(...))` is applied on BOTH sides — the stored column and the probe — so
 * the comparison is symmetric. It also makes `idx_email_participants_email_address`
 * unusable, which is a known cost recorded in `contactRecencySql.ts`; the index that
 * serves this shape is `idx_email_participants_lower_address`.
 */
export function emailsForAddressesSql(addressCount: number): SafeSql {
  const placeholders = placeholderList(addressCount);
  return sql`SELECT e.id, e.subject, e.sent_at, e.received_at,
              LOWER(TRIM(ep.email_address)) AS addr
         FROM email_participants ep
         JOIN emails e ON e.id = ep.email_id
        WHERE e.user_id = ?
          AND LOWER(TRIM(ep.email_address)) IN (${placeholders})`;
}

/**
 * Every local text message for a user, for the shared-correspondence signal.
 * One bound parameter: the user id.
 *
 * `duplicate_of IS NULL` drops re-imported copies. Reactions are NOT excluded here —
 * unlike the audit-floor read — because `associated_message_type` is SELECTed and the
 * caller classifies; the compare screen wants to know a tapback happened.
 */
export const LOCAL_MESSAGES_FOR_COMPARE_SQL = sql`SELECT m.id, m.subject, m.body_text, m.participants_flat, m.sent_at,
              m.received_at, m.associated_message_type
         FROM messages m
        WHERE m.user_id = ?
          AND m.channel IN ('sms', 'imessage')
          AND m.duplicate_of IS NULL`;

/**
 * One contact, with `removed_at` RETURNED rather than filtered. One bound parameter.
 *
 * The caller decides what a removed contact means for a comparison; this read does not
 * decide for it.
 */
export const CONTACT_ROW_FOR_COMPARE_SQL = sql`SELECT user_id, display_name, company, removed_at FROM contacts WHERE id = ?`;

/**
 * Every source record linked to a contact, with the external record's own fields.
 * Two bound parameters: user id, contact id.
 *
 * `LEFT JOIN`, not `JOIN`: a link whose source record has been deleted from the
 * address book must still appear — as a row with null external fields — or the compare
 * screen silently under-reports how many places a contact came from.
 */
export const LINKED_RECORDS_FOR_CONTACT_SQL = sql`SELECT l.id, l.source_type, l.source_record_id, l.match_method, l.matched_at,
            ec.id AS ec_id, ec.name AS ec_name, ec.emails_json AS ec_emails_json,
            ec.phones_json AS ec_phones_json, ec.company AS ec_company
       FROM contact_source_links l
       LEFT JOIN external_contacts ec
         ON ec.user_id = l.user_id
        AND ec.source = l.source_type
        AND ec.external_record_id = l.source_record_id
      WHERE l.user_id = ? AND l.contact_id = ?
      ORDER BY l.source_type, l.source_record_id`;

/**
 * One external record by its crosswalk key. Three bound parameters: user id, source,
 * external record id.
 *
 * The three-column key is the crosswalk's identity — a rename changes `name`, never
 * `external_record_id`, which is what makes the link survive an address-book edit.
 */
export const EXTERNAL_RECORD_FOR_COMPARE_SQL = sql`SELECT name, emails_json, phones_json, company
           FROM external_contacts
          WHERE user_id = ? AND source = ? AND external_record_id = ?`;

/** Ownership and removal state for one contact. One bound parameter: contact id. */
export const CONTACT_OWNER_AND_REMOVAL_SQL = sql`SELECT user_id, removed_at FROM contacts WHERE id = ?`;

/**
 * A contact's source links EXCLUDING one match method. Three bound parameters: user
 * id, contact id, the method to exclude.
 *
 * The excluded method is bound, not spliced, so this statement carries no value in its
 * text.
 */
export const LINKS_EXCLUDING_METHOD_SQL = sql`SELECT source_type, source_record_id, match_method
       FROM contact_source_links
      WHERE user_id = ? AND contact_id = ? AND match_method <> ?
      ORDER BY source_type, source_record_id`;
