/**
 * SQL for a transaction's thread-level link and removal bookkeeping — BACKLOG-3044 PR 5.
 *
 * Moved out of `electron/services/transactionService/transactionService.ts` (8 sites).
 *
 * ## The two big statements are the same question asked of two tables
 *
 * `COMMUNICATIONS_IN_THREAD_SQL` and `IGNORED_IN_THREAD_SQL` both resolve "everything on
 * this transaction belonging to this email thread", once over approvals and once over
 * rejections. Each has to reach a row by EITHER route, because the thread is recorded in
 * two different places depending on when and how the row was written:
 *
 *   `c.thread_id = ?`                        the thread was known at link time
 *   `c.thread_id IS NULL AND EXISTS (…)`     it was not, so resolve through the email
 *
 * Dropping the second arm makes older rows invisible to a thread-level operation —
 * "remove this whole conversation" would silently leave some of it attached, and
 * nothing would error. The `EXISTS` subquery is what makes the fallback exact rather
 * than approximate.
 *
 * `AND (c.message_id IS NULL OR c.message_id = '')` on the approvals read confines it to
 * EMAIL-backed rows: a communication carrying a message id belongs to the text path and
 * is handled elsewhere. The empty-string arm is not defensive padding — the column
 * carries `''` rather than NULL on some rows, and testing only `IS NULL` would miss
 * them.
 *
 * Text is byte-identical to what it replaced. `EMAIL_THREAD_ID_SQL` is additionally
 * pinned by `__tests__/autolinkTransactionSql.movedText.test.ts`: its text is authored
 * by a test file too, so the byte-identity comparator would report "consolidated" rather
 * than failing if it drifted.
 */

import { sql } from "./core/sqlText";

/** When a transaction was first exported. One bound parameter: transaction id. */
export const TRANSACTION_FIRST_EXPORTED_SQL = sql`SELECT first_exported_at FROM transactions WHERE id = ?`;

/**
 * One email's thread. One bound parameter: email id.
 *
 * The base authored this text at TWO call sites (`transactionService.ts:1558` and
 * `:1724`) — the approve path and the reject path each asked it separately. One constant
 * now serves both; the two texts were byte-identical, checked before collapsing them.
 */
export const EMAIL_THREAD_ID_SQL = sql`SELECT thread_id FROM emails WHERE id = ?`;

/**
 * Every email-backed communication on this transaction belonging to a thread. Bound, in
 * order: transaction id, thread id, thread id (for the `EXISTS` fallback).
 *
 * The thread id is bound twice on purpose — once for the direct arm and once inside the
 * subquery. See the header on why both arms exist.
 */
export const COMMUNICATIONS_IN_THREAD_SQL = sql`SELECT c.id FROM communications c
            WHERE c.transaction_id = ?
              AND (
                c.thread_id = ?
                OR (
                  c.thread_id IS NULL
                  AND c.email_id IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM emails e
                    WHERE e.id = c.email_id AND e.thread_id = ?
                  )
                )
              )
              AND (c.message_id IS NULL OR c.message_id = '')`;

/**
 * The newest email in a thread — the representative shown for the conversation. Bound:
 * thread id.
 */
export const LATEST_EMAIL_IN_THREAD_SQL = sql`SELECT id FROM emails WHERE thread_id = ? ORDER BY sent_at DESC LIMIT 1`;

/**
 * One rejection's thread and reason. Bound: the `ignored_communications` row id.
 *
 * `match_reason` travels with it because a Restore routes on it — the reason a thing was
 * removed decides where putting it back sends it.
 */
export const IGNORED_THREAD_AND_REASON_SQL = sql`SELECT thread_id, match_reason FROM ignored_communications WHERE id = ?`;

/**
 * Every email-backed rejection on this transaction belonging to a thread. Bound, in
 * order: transaction id, thread id, thread id.
 *
 * The mirror of `COMMUNICATIONS_IN_THREAD_SQL` over `ignored_communications`, with the
 * same two-route reach for the same reason.
 */
export const IGNORED_IN_THREAD_SQL = sql`SELECT ic.id, ic.email_id, ic.match_reason FROM ignored_communications ic
            WHERE ic.transaction_id = ?
              AND (
                ic.thread_id = ?
                OR (
                  ic.thread_id IS NULL
                  AND ic.email_id IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM emails e
                    WHERE e.id = ic.email_id AND e.thread_id = ?
                  )
                )
              )
              AND ic.email_id IS NOT NULL`;

/** Is this email already linked to this transaction? Bound: email id, transaction id. */
export const EMAIL_COMMUNICATION_EXISTS_SQL = sql`SELECT id FROM communications WHERE email_id = ? AND transaction_id = ?`;
