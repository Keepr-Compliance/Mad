/**
 * SQL for automatic linking — BACKLOG-3044 PR 5, the last of the five.
 *
 * Moved out of `electron/services/autoLinkService.ts` (17 sites), the largest single
 * block that was left outside `electron/services/db/**`.
 *
 * ## Three of these were BLOCKED until BACKLOG-3103 landed
 *
 * `liveTransactionCountForContactSql`, `otherCandidateTransactionAddressesSql` and
 * `LIVE_TRANSACTION_CONTACT_PAIRS_SQL` splice the shared eligibility predicate. Until
 * BACKLOG-3103 that predicate was `` `t.status != '${REJECTED_TRANSACTION_STATUS}'` `` —
 * a status VALUE hand-quoted into SQL text — so the tag correctly refused it and these
 * statements could not move. 3103 made it `` sql`t.status != ?` `` with
 * `withLiveTransactionParam` supplying the bound value, and they compose now.
 *
 * **The contract is LAST PLACEHOLDER, not last conjunct.** Two of the three carry
 * `AND tc.removed_at IS NULL` *after* the predicate, which is fine because that clause
 * binds nothing. The caller calls `withLiveTransactionParam(params)` so the value lands
 * in the final slot; that call stays with the CALLER, because the params array does.
 *
 * ## The three-way exclusion on the candidate reads
 *
 * `candidateMessageThreadsSql` refuses a thread that is already linked to this
 * transaction, or already rejected for it. Both arms are `NOT IN` subqueries; both are
 * guarded upstream by `m.transaction_id IS NULL OR m.transaction_id != ?`, which is the
 * "not already on THIS deal" half. Auto-linking is the path that runs without a person
 * watching, so re-offering something already decided is the failure that matters most
 * here.
 *
 * `reactionExclusion("m")` appears on three statements. A tapback is not a message, and
 * an auto-linker that counted them would attach conversations on the strength of a
 * thumbs-up.
 *
 * ## Separators
 *
 * This module's callers built placeholder lists with `.join(", ")` — comma **and
 * space** — so the lists here take `placeholderList`'s default. `messageMatchingSql` and
 * `exportHandleSql` pass `sql`,`` instead, because their callers used `.join(",")`. One
 * character per placeholder, and the difference between byte-identical and not.
 *
 * Text is byte-identical to what it replaced, verified by
 * `scripts/ci/sql-move-identity.mjs`; the one statement whose text a test file also
 * authors is additionally pinned by `__tests__/autolinkTransactionSql.movedText.test.ts`,
 * because for a duplicated text the comparator reports "consolidated" rather than
 * failing.
 */

import { sql } from "./core/sqlText";
import type { SafeSql } from "./core/sqlText";
import { joinFragments, placeholderList } from "./core/sqlFragments";
import { reactionExclusion } from "./reactionExclusion";
import { LIVE_TRANSACTION_SQL_PREDICATE } from "./core/transactionEligibilitySql";

/** Does this contact exist? One bound parameter: contact id. */
export const CONTACT_BY_ID_EXISTS_SQL = sql`SELECT id FROM contacts WHERE id = ?`;

/**
 * A contact's email addresses. One bound parameter: contact id.
 *
 * Deliberately NOT merged with `contactIdentityEvidenceSql.CONTACT_EMAILS_SQL`, which
 * asks the same question: that one is a single line, this one is three. Different text,
 * and collapsing them would change a statement to save a constant.
 */
export const AUTOLINK_CONTACT_EMAILS_SQL = sql`
    SELECT email FROM contact_emails
    WHERE contact_id = ?
  `;

/** A contact's phone numbers, in E.164. One bound parameter: contact id. */
export const AUTOLINK_CONTACT_PHONES_SQL = sql`
    SELECT phone_e164 FROM contact_phones
    WHERE contact_id = ?
  `;

/**
 * The transaction fields the auto-linker needs: its window, its addresses, and whether
 * address filtering is switched off for it. One bound parameter: transaction id.
 */
export const TRANSACTION_AUTOLINK_WINDOW_SQL = sql`
    SELECT
      user_id,
      started_at,
      created_at,
      closed_at,
      property_address,
      property_street,
      skip_address_filter
    FROM transactions
    WHERE id = ?
  `;

/** The local user's email. One bound parameter: user id. */
export const LOCAL_USER_EMAIL_SQL = sql`SELECT email FROM users_local WHERE id = ?`;

/**
 * Emails to or from a set of addresses, inside a window, not yet linked to this
 * transaction.
 *
 * Bound, in order: the transaction id (for the `LEFT JOIN`), one address per
 * placeholder, the user id, then the window start and end.
 *
 * `LEFT JOIN communications … AND c.transaction_id = ?` with `c.id IS NULL` is an
 * anti-join: it keeps only emails that have NO link row for this deal. Written this way
 * rather than as `NOT IN` because the join predicate carries the transaction id, so the
 * exclusion is scoped to this deal rather than to every deal.
 */
export function candidateEmailsSql(addressCount: number): SafeSql {
  const placeholders = placeholderList(addressCount);
  return sql`
    SELECT DISTINCT e.id, e.subject, e.body_plain
    FROM email_participants ep
    JOIN emails e ON e.id = ep.email_id
    LEFT JOIN communications c ON c.email_id = e.id AND c.transaction_id = ?
    WHERE ep.email_address IN (${placeholders})
      AND e.user_id = ?
      AND c.id IS NULL
      AND e.sent_at >= ?
      AND e.sent_at <= ?
    ORDER BY e.sent_at DESC
  `;
}

/**
 * How many LIVE transactions this contact is on. Bound: contact id, user id, then the
 * eligibility value **last** via `withLiveTransactionParam`.
 *
 * `AND tc.removed_at IS NULL` sits after the predicate and binds nothing, so the
 * eligibility placeholder is still the last one. That is the contract — last
 * placeholder, not last conjunct.
 */
export const LIVE_TRANSACTION_COUNT_FOR_CONTACT_SQL = sql`
    SELECT COUNT(DISTINCT tc.transaction_id) AS cnt
    FROM transaction_contacts tc
    JOIN transactions t ON t.id = tc.transaction_id
    WHERE tc.contact_id = ?
      AND t.user_id = ?
      AND ${LIVE_TRANSACTION_SQL_PREDICATE}
      AND tc.removed_at IS NULL
  `;

/**
 * The addresses of the OTHER live deals this contact is on — the signal that an address
 * seen in a message might belong to a different transaction.
 *
 * Bound: contact id, user id, the transaction to exclude, then the eligibility value
 * last. BACKLOG-3103 reordered this statement so the predicate is the final conjunct;
 * `AND` is commutative over these terms and the reorder is covered by that item's
 * exact-row-id control.
 */
export const OTHER_CANDIDATE_TRANSACTION_ADDRESSES_SQL = sql`
    SELECT DISTINCT COALESCE(t.property_address, t.property_street) AS address
    FROM transaction_contacts tc
    JOIN transactions t ON t.id = tc.transaction_id
    WHERE tc.contact_id = ?
      AND t.user_id = ?
      AND t.id != ?
      AND tc.removed_at IS NULL
      AND COALESCE(t.property_address, t.property_street) IS NOT NULL
      AND ${LIVE_TRANSACTION_SQL_PREDICATE}
  `;

/** One `LIKE` arm of the phone predicate. The number is BOUND, not spliced. */
const PHONE_LIKE = sql`m.participants_flat LIKE ?`;

/**
 * Candidate message threads for a transaction: one row per thread, keyed on its
 * earliest message.
 *
 * Bound, in order: user id, transaction id (the "not already on this deal" arm),
 * transaction id (linked-thread exclusion), transaction id (rejected-thread exclusion),
 * one phone per `LIKE` arm, then the window start and end.
 *
 * `GROUP BY m.thread_id` with `MIN(m.id)` picks a stable representative per thread, and
 * `ORDER BY MAX(m.sent_at) DESC` puts the most recently active thread first — the order
 * a person reviewing the results expects.
 */
export function candidateMessageThreadsSql(phoneCount: number): SafeSql {
  const phoneConditions = joinFragments(
    Array.from({ length: phoneCount }, () => PHONE_LIKE),
    sql` OR `,
  );
  return sql`
    SELECT DISTINCT m.thread_id, MIN(m.id) as id
    FROM messages m
    WHERE m.user_id = ?
      AND m.channel IN ('sms', 'imessage')
      AND m.duplicate_of IS NULL
      AND ${reactionExclusion("m")}
      AND (
        m.transaction_id IS NULL
        OR m.transaction_id != ?
      )
      AND m.thread_id NOT IN (
        SELECT thread_id FROM communications
        WHERE transaction_id = ? AND thread_id IS NOT NULL
      )
      AND m.thread_id NOT IN (
        SELECT ic.thread_id FROM ignored_communications ic
        WHERE ic.transaction_id = ? AND ic.thread_id IS NOT NULL
      )
      AND (${phoneConditions})
      AND m.sent_at >= ?
      AND m.sent_at <= ?
    GROUP BY m.thread_id
    ORDER BY MAX(m.sent_at) DESC
  `;
}

/** Is this email already linked to this transaction? Bound: email id, transaction id. */
export const EXISTING_EMAIL_COMMUNICATION_SQL = sql`
    SELECT id, transaction_id FROM communications
    WHERE email_id = ? AND transaction_id = ?
  `;

/** An email's owner and thread. One bound parameter: email id. */
export const EMAIL_USER_AND_THREAD_SQL = sql`SELECT user_id, thread_id FROM emails WHERE id = ?`;

/**
 * Link an email to a transaction. Bound, in order: id, user id, transaction id, email
 * id, thread id, link source, link confidence, match reason. `linked_at` is the
 * database clock.
 */
export const INSERT_EMAIL_COMMUNICATION_SQL = sql`
    INSERT INTO communications (id, user_id, transaction_id, email_id, thread_id, link_source, link_confidence, match_reason, linked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `;

/**
 * Every (contact, transaction) pair on a user's LIVE deals. Bound: user id, then the
 * eligibility value last via `withLiveTransactionParam`.
 *
 * As with the count above, `AND tc.removed_at IS NULL` follows the predicate and binds
 * nothing, so the eligibility placeholder remains last.
 */
export const LIVE_TRANSACTION_CONTACT_PAIRS_SQL = sql`
      SELECT DISTINCT
        tc.contact_id,
        tc.transaction_id
      FROM transaction_contacts tc
      JOIN transactions t ON t.id = tc.transaction_id
      WHERE t.user_id = ?
        AND ${LIVE_TRANSACTION_SQL_PREDICATE}
        AND tc.removed_at IS NULL
      ORDER BY tc.transaction_id
    `;

/**
 * Every (transaction, thread) pair already established by a linked message. One bound
 * parameter: user id.
 *
 * `m.thread_id != ''` beside `IS NOT NULL` because the column carries an empty string
 * for a one-to-one message rather than NULL, and an empty thread is not a thread.
 */
export const LINKED_THREAD_PAIRS_SQL = sql`
      SELECT DISTINCT
        c.transaction_id AS transaction_id,
        m.thread_id AS thread_id
      FROM communications c
      JOIN messages m ON m.id = c.message_id
      WHERE c.user_id = ?
        AND c.transaction_id IS NOT NULL
        AND c.message_id IS NOT NULL
        AND m.thread_id IS NOT NULL
        AND m.thread_id != ''
    `;

/** Thread, direction and participants for every threaded local message. Bound: user id. */
export const THREAD_DIRECTION_PARTICIPANTS_SQL = sql`SELECT thread_id, direction, participants
         FROM messages
        WHERE user_id = ?
          AND channel IN ('sms', 'imessage')
          AND duplicate_of IS NULL
          AND thread_id IS NOT NULL
          AND thread_id != ''`;

/**
 * Unlinked messages in one thread — the siblings that should follow when one message in
 * the thread is linked. Bound: user id, thread id.
 */
export const UNLINKED_SIBLINGS_IN_THREAD_SQL = sql`
          SELECT m.id AS id, m.thread_id AS thread_id
          FROM messages m
          WHERE m.user_id = ?
            AND m.thread_id = ?
            AND m.transaction_id IS NULL
            AND m.channel IN ('sms', 'imessage')
            AND m.duplicate_of IS NULL
            AND ${reactionExclusion("m")}
        `;

/**
 * The same, across several threads at once. Bound: user id, then one thread id per
 * placeholder.
 */
export function unlinkedMessagesInThreadsSql(threadCount: number): SafeSql {
  const placeholders = placeholderList(threadCount);
  return sql`
            SELECT m.id AS id, m.thread_id AS thread_id
            FROM messages m
            WHERE m.user_id = ?
              AND m.thread_id IN (${placeholders})
              AND m.transaction_id IS NULL
              AND m.channel IN ('sms', 'imessage')
              AND m.duplicate_of IS NULL
              AND ${reactionExclusion("m")}
          `;
}
