/**
 * Shared SQL: what a contact ROW contains, and the one statement that reads it.
 *
 * ===========================================================================
 * WHY THIS EXISTS — BACKLOG-2514
 * ===========================================================================
 * Three screens render through `ContactSearchList` and one shared pure matcher.
 * What differed was the PRODUCER that filled the list:
 *
 *   getImportedContactsByUserId       (sync)      every address
 *   getImportedContactsByUserIdAsync  (worker)    every address
 *   getContactsSortedByActivity       (activity)  THE PRIMARY ADDRESS ONLY
 *
 * So the matcher's `allEmails` / `allPhones` arms received EMPTY ARRAYS on the
 * new-transaction wizard and on add-to-existing. A contact with a work address
 * and a personal one was findable by both in Clients & Contacts and by only one
 * while the user was actually building a transaction — the moment it matters
 * most.
 *
 * ===========================================================================
 * AND WHY IT IS A SHARED CONSTANT RATHER THAN TWO CAREFUL EDITS
 * ===========================================================================
 * The imported-contacts statement existed as TWO copies required to stay
 * byte-identical — here in `contactDbService` and in the worker's
 * `runImportedQuery` — with a comment saying in as many words that "adding a
 * column to one is exactly how they drift."
 *
 * MEASURED, NOT ASSUMED: at the time of this change the two copies had NOT yet
 * drifted; they were diffed and were identical. So this extraction is
 * PREVENTIVE. It removes the hazard the comment marks rather than repairing
 * damage it already caused — and it means the fix for this item is one edit in
 * one place instead of the same edit made twice, correctly, forever.
 *
 * This EXTENDS a pattern already living inside the statement:
 * `IMPORTED_CONTACT_LAST_COMMUNICATION_SQL` (BACKLOG-2354) is already a shared
 * fragment imported by both copies. The projection now joins it.
 *
 * ===========================================================================
 * COST — MEASURED BEFORE WIDENING (BACKLOG-2514 §2)
 * ===========================================================================
 * The activity query omitted the two `json_group_array` aggregates and no
 * comment, backlog reference or test ever said the omission was deliberate.
 * Absence of a stated reason is not proof there was none, so it was measured at
 * the founder's real scale (1,136 contacts, 2 emails + 2 phones each,
 * `node:sqlite`, 40 runs):
 *
 *   without aggregates   median 1.99 ms   p90 2.24 ms
 *   with aggregates      median 3.59 ms   p90 3.77 ms
 *   delta                +1.60 ms median (+80% relative)
 *
 * Eighty percent of two milliseconds is one and a half milliseconds. On a
 * screen load that is not a cost worth keeping two divergent producers for, so
 * ONE shared projection wins over a parity test across two queries.
 *
 * ===========================================================================
 * A SECOND DIVERGENCE THIS FIXES, WHICH THE ITEM DID NOT NAME
 * ===========================================================================
 * The activity query read its primary address through
 * `LEFT JOIN contact_emails ce_primary ON ... AND ce_primary.is_primary = 1`.
 * The other two producers use `COALESCE(primary, any)`. Two consequences the
 * JOIN form has and the subquery form does not:
 *
 *   1. A contact whose addresses carry NO `is_primary` flag projected NULL on
 *      the transaction screens and its first address everywhere else.
 *   2. A contact carrying TWO rows flagged primary MULTIPLIED — a LEFT JOIN
 *      returns one row per match, so the contact appeared twice. `LIMIT 1`
 *      inside a correlated subquery cannot do that.
 *
 * Both are gone because there is now one expression rather than two spellings.
 */

import { IMPORTED_CONTACT_LAST_COMMUNICATION_SQL } from "./contactRecencySql";
import { ACTIVE_CONTACTS_CLAUSE_C } from "./contactTombstoneSql";

/**
 * Every address a contact has, plus the one that represents it.
 *
 * Correlates on the outer query's `c`, so the consuming SELECT MUST alias the
 * contacts table as `c` — the same contract `IMPORTED_CONTACT_LAST_COMMUNICATION_SQL`
 * already carries.
 *
 * `all_emails_json` / `all_phones_json` are what the picker's matcher searches:
 * they are parsed into `allEmails` / `allPhones` by every consumer. Drop them
 * and search silently narrows to the primary address on whichever screen lost
 * them — which is this item.
 *
 * NO imports of its own, so the worker thread can use it directly.
 */
export const IMPORTED_CONTACT_ADDRESSES_SQL = `
      COALESCE(
        (SELECT email FROM contact_emails WHERE contact_id = c.id AND is_primary = 1 LIMIT 1),
        (SELECT email FROM contact_emails WHERE contact_id = c.id LIMIT 1)
      ) as email,
      COALESCE(
        (SELECT phone_e164 FROM contact_phones WHERE contact_id = c.id AND is_primary = 1 LIMIT 1),
        (SELECT phone_e164 FROM contact_phones WHERE contact_id = c.id LIMIT 1)
      ) as phone,
      (SELECT json_group_array(email) FROM contact_emails WHERE contact_id = c.id) as all_emails_json,
      (SELECT json_group_array(phone_e164) FROM contact_phones WHERE contact_id = c.id) as all_phones_json`;

/**
 * THE imported-contacts statement. One string, two executors.
 *
 * `contactDbService.getImportedContactsByUserId` runs it on the main thread;
 * `contactQueryWorker.runImportedQuery` runs it in the worker. They are the same
 * statement because they are the same constant — that is the whole point, and it
 * is what the two-byte-identical-copies comment asked for.
 *
 * Takes one parameter: `user_id`.
 */
export const IMPORTED_CONTACTS_SELECT_SQL = `
    SELECT
      c.*,
      c.display_name as name,
${IMPORTED_CONTACT_ADDRESSES_SQL},
      0 as is_message_derived,
      -- BACKLOG-2354: populate recency so the Clients & Contacts screen's
      -- "Recent" sort has data instead of degenerating to the email tiebreaker.
      ${IMPORTED_CONTACT_LAST_COMMUNICATION_SQL}
    FROM contacts c
    WHERE c.user_id = ? AND c.is_imported = 1${ACTIVE_CONTACTS_CLAUSE_C}
    ORDER BY c.display_name ASC
  `;
