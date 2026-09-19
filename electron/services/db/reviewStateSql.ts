/**
 * SQL for the review queue — BACKLOG-3044.
 *
 * Moved out of `electron/services/reviewStateService.ts` (23 sites), the largest
 * single concentration of outside-layer SQL in the tree. The service decides which
 * communications are waiting for a person to approve or reject against a transaction,
 * and before this move it authored every one of those statements itself.
 *
 * ## The three tables, and why confusing them is the bug this file guards against
 *
 * A communication is in exactly one of three states, and each has its own table:
 *
 *   `pending_review_communications`  found, not yet decided
 *   `communications`                 approved — linked to the transaction
 *   `ignored_communications`         rejected — deliberately excluded
 *
 * A decision MOVES a row between them, so almost every statement below comes in a
 * matched pair: an insert into one table beside a delete from another. Reading them
 * as a set makes the pairing visible; spread across 1,131 lines of service code it was
 * not. `match_reason = 'address_missing'` recurs for the same reason — those are the
 * approvals made without a matching address, the ones a reversal has to find again.
 *
 * ## Whitespace inside these templates is load-bearing
 *
 * Every template carries the exact indentation it had at its old call site, including
 * the deliberately hanging `FROM` / `WHERE` alignment. Re-indenting to suit module
 * scope would change the bytes reaching SQLite. `scripts/ci/sql-move-identity.mjs`
 * hashes the cooked text of every statement before and after the move and fails on a
 * single changed space, so a tidy-up here is a build failure, not a style opinion.
 */

import { sql } from "./core/sqlText";

/** Everything still awaiting a decision on one transaction. One bound parameter. */
export const PENDING_REVIEW_BY_TRANSACTION_SQL = sql`SELECT id, transaction_id, email_id, thread_id, found_at
       FROM pending_review_communications
      WHERE transaction_id = ?`;

/**
 * Approved email links on one transaction that were matched WITHOUT an address.
 *
 * These are the reversible ones: `match_reason = 'address_missing'` marks a link the
 * matcher could not justify by address, so undoing a decision has to be able to find
 * them again. One bound parameter.
 */
export const ADDRESS_MISSING_COMMUNICATIONS_BY_TRANSACTION_SQL = sql`SELECT id, transaction_id, email_id, thread_id, linked_at
       FROM communications
      WHERE transaction_id = ?
        AND email_id IS NOT NULL
        AND match_reason = 'address_missing'`;

/** One email, enough of it to render a review card. One bound parameter: email id. */
export const EMAIL_PREVIEW_SQL = sql`SELECT subject, sender, recipients, cc, body_plain, body_html, sent_at, has_attachments, thread_id
       FROM emails WHERE id = ?`;

/**
 * A one-row summary of a message thread for the review card.
 *
 * The `MAX(...)` over non-aggregated columns is not picking a meaningful "largest" —
 * it is SQLite's idiom for "any one value from the group" beside the `COUNT(*)`. The
 * card shows a count and a representative snippet, so any row will do. One bound
 * parameter: thread id.
 */
export const THREAD_MESSAGE_SUMMARY_SQL = sql`SELECT COUNT(*) AS n,
            MAX(m.participants_flat) AS participants,
            MAX(m.body_text) AS body_text,
            MAX(m.sent_at) AS sent_at
       FROM messages m
      WHERE m.thread_id = ?`;

/**
 * Every message in a thread, oldest first, with the thread's display name.
 *
 * `duplicate_of IS NULL` keeps a re-imported copy from showing the conversation twice.
 * The join comment is the original's and is kept verbatim — it records that
 * `(user_id, thread_id)` is the primary key and that joining on `thread_id` alone
 * would cross users, which is a disclosure bug rather than a slow query. One bound
 * parameter: thread id.
 */
export const THREAD_MESSAGES_SQL = sql`SELECT m.id, m.thread_id, m.body_text, m.sent_at, m.direction,
            m.participants, m.participants_flat, m.channel,
            tn.display_name AS thread_display_name
       FROM messages m
       -- (user_id, thread_id) is the PK; thread_id alone would cross users.
       LEFT JOIN message_thread_names tn ON (
         tn.thread_id = m.thread_id AND tn.user_id = m.user_id
       )
      WHERE m.thread_id = ? AND m.duplicate_of IS NULL
      ORDER BY m.sent_at ASC`;

/**
 * The dates that bound a transaction's scan window, plus when it was last scanned.
 * One bound parameter: transaction id.
 */
export const TRANSACTION_SCAN_WINDOW_SQL = sql`SELECT id, user_id, started_at, created_at, closed_at, last_pending_scan_at
       FROM transactions WHERE id = ?`;

/**
 * Has this email already been rejected for this transaction? Two bound parameters:
 * transaction id, email id.
 *
 * Asked before queueing, so a scan does not re-offer something the user has already
 * turned down.
 */
export const IGNORED_COMMUNICATION_BY_EMAIL_SQL = sql`SELECT id FROM ignored_communications WHERE transaction_id = ? AND email_id = ?`;

/**
 * Queue one email for review. Four bound parameters: id, user id, transaction id,
 * email id — `thread_id` is NULL and `found_at` is the server clock.
 *
 * `INSERT OR IGNORE` makes a repeated scan idempotent rather than a duplicate-key
 * error.
 */
export const INSERT_PENDING_REVIEW_EMAIL_SQL = sql`INSERT OR IGNORE INTO pending_review_communications
       (id, user_id, transaction_id, email_id, thread_id, found_at)
     VALUES (?, ?, ?, ?, NULL, CURRENT_TIMESTAMP)`;

/** Is this email already queued for this transaction? Two bound parameters. */
export const PENDING_REVIEW_BY_EMAIL_SQL = sql`SELECT id FROM pending_review_communications WHERE transaction_id = ? AND email_id = ?`;

/** The contacts attached to a transaction. One bound parameter. */
export const TRANSACTION_CONTACT_IDS_SQL = sql`SELECT contact_id FROM transaction_contacts WHERE transaction_id = ?`;

/**
 * How many items were queued for this transaction AFTER an instant — the "new since
 * you last looked" badge. Two bound parameters: transaction id, then the instant.
 */
export const PENDING_REVIEW_COUNT_SINCE_SQL = sql`SELECT COUNT(*) AS n FROM pending_review_communications WHERE transaction_id = ? AND found_at > ?`;

/** How many items are queued for this transaction in total. One bound parameter. */
export const PENDING_REVIEW_COUNT_SQL = sql`SELECT COUNT(*) AS n FROM pending_review_communications WHERE transaction_id = ?`;

/** Record that a scan just ran. One bound parameter: transaction id. */
export const TOUCH_LAST_PENDING_SCAN_SQL = sql`UPDATE transactions SET last_pending_scan_at = CURRENT_TIMESTAMP WHERE id = ?`;

/** One rejection, by its own id, with the reason it was rejected. One bound parameter. */
export const IGNORED_COMMUNICATION_BY_ID_SQL = sql`SELECT id, user_id, transaction_id, email_id, thread_id, match_reason, reason
       FROM ignored_communications WHERE id = ?`;

/**
 * Other rejections on the SAME email thread, for the same transaction and reason.
 *
 * Undoing one rejection has to undo its siblings, or the thread comes back half
 * rejected. The correlated subquery resolves the thread from the email being restored
 * rather than trusting a thread id passed in. Three bound parameters: transaction id,
 * reason, email id.
 */
export const IGNORED_SIBLINGS_IN_THREAD_SQL = sql`SELECT ic.id, ic.email_id, ic.thread_id
           FROM ignored_communications ic
           JOIN emails e ON e.id = ic.email_id
          WHERE ic.transaction_id = ?
            AND ic.reason = ?
            AND e.thread_id IS NOT NULL
            AND e.thread_id = (SELECT thread_id FROM emails WHERE id = ?)`;

/**
 * Queue an item for review carrying its thread. Five bound parameters: id, user id,
 * transaction id, email id, thread id.
 *
 * Distinct from `INSERT_PENDING_REVIEW_EMAIL_SQL`, which hard-codes `thread_id` NULL.
 * The two texts differ and both are byte-identical to what they replaced, so they stay
 * two constants rather than being merged behind a parameter — merging them would
 * change one of the statements, which is precisely what this move must not do.
 */
export const INSERT_PENDING_REVIEW_WITH_THREAD_SQL = sql`INSERT OR IGNORE INTO pending_review_communications
         (id, user_id, transaction_id, email_id, thread_id, found_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`;

/** Drop a rejection — the delete half of "undo a reject". One bound parameter. */
export const DELETE_IGNORED_COMMUNICATION_SQL = sql`DELETE FROM ignored_communications WHERE id = ?`;

/** One queued item by its own id. One bound parameter. */
export const PENDING_REVIEW_BY_ID_SQL = sql`SELECT id, transaction_id, email_id, thread_id, found_at
         FROM pending_review_communications WHERE id = ?`;

/** One address-missing approval by its own id. One bound parameter. */
export const ADDRESS_MISSING_COMMUNICATION_BY_ID_SQL = sql`SELECT id, transaction_id, email_id, thread_id, linked_at
       FROM communications WHERE id = ? AND match_reason = 'address_missing'`;

/**
 * Undo an address-missing approval, addressed by what it links rather than by row id.
 * Three bound parameters: transaction id, email id — and `match_reason` is fixed in
 * the text, so an approval made for a DIFFERENT reason is not swept up by an undo.
 */
export const DELETE_ADDRESS_MISSING_COMMUNICATION_SQL = sql`DELETE FROM communications
      WHERE transaction_id = ? AND email_id = ? AND match_reason = 'address_missing'`;

/**
 * Remove one item from the queue. One bound parameter.
 *
 * Used at both ends of a decision — approving and rejecting each dequeue — which is
 * why two call sites spelled out this identical text before the move.
 */
export const DELETE_PENDING_REVIEW_SQL = sql`DELETE FROM pending_review_communications WHERE id = ?`;

/** Remove one approved link. One bound parameter. */
export const DELETE_COMMUNICATION_SQL = sql`DELETE FROM communications WHERE id = ?`;
