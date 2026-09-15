/**
 * SQL for hiding individual texts from a transaction's export — BACKLOG-3366.
 *
 * A hidden text stays linked to the transaction and stays visible in the
 * conversation view (gray). Only the export plan drops it (BACKLOG-3367). So
 * nothing here touches `messages` or `communications`; the only table written
 * is `transaction_hidden_texts`.
 *
 * ## A hide is matched by TWO ids, and both arms are load-bearing
 *
 * - `message_id`: the `messages.id` the user clicked.
 * - `message_external_id`: that message's provider id, copied from the
 *   `messages` row at the moment of hiding (never taken from the renderer).
 *
 * A macOS force re-import deletes the live message rows and re-inserts them
 * under new random ids, while thread links survive. A hide matched on
 * `message_id` alone would stop matching and the text would silently return
 * to the export. The external-id arm keeps it hidden; the id arm covers texts
 * that have no external id. Every statement below that matches a hide uses both
 * arms, and so does the marker projected by `getCommunicationsWithMessages`.
 */

import { sql } from "./core/sqlText";
import { reactionExclusion } from "./reactionExclusion";

/**
 * Hide one text from one transaction's export. Three bound parameters, in
 * order: hidden_by (users_local.id), message id, transaction id.
 *
 * Inserts NOTHING unless the message:
 * - is a text (`sms` / `imessage`), not an email;
 * - is not a tapback reaction row;
 * - is linked to this transaction, per message or through its thread — the
 *   same join shape the shared conversation read uses;
 * - is not already hidden in this transaction by either arm, so a repeat hide
 *   reports no change and writes no second audit entry.
 *
 * `INSERT OR IGNORE` keeps the first `hidden_at` if the primary key already
 * exists. `changes` is 1 when a hide was recorded, 0 otherwise.
 */
export const HIDE_TEXT_FROM_EXPORT_SQL = sql`
  INSERT OR IGNORE INTO transaction_hidden_texts
    (transaction_id, message_id, message_external_id, hidden_by)
  SELECT t.id, m.id, m.external_id, ?
  FROM transactions t
  JOIN messages m ON m.id = ?
  WHERE t.id = ?
    AND m.channel IN ('sms', 'imessage')
    AND ${reactionExclusion("m")}
    AND EXISTS (
      SELECT 1 FROM communications c
      WHERE c.transaction_id = t.id
        AND (
          (c.message_id IS NOT NULL AND c.message_id = m.id)
          OR (c.message_id IS NULL AND c.email_id IS NULL
              AND c.thread_id IS NOT NULL AND c.thread_id = m.thread_id)
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM transaction_hidden_texts h
      WHERE h.transaction_id = t.id
        AND (h.message_id = m.id
             OR (h.message_external_id IS NOT NULL AND h.message_external_id = m.external_id))
    )
`;

/**
 * Unhide one text. Three bound parameters, in order: transaction id, message
 * id, message id.
 *
 * Deletes every hide in this transaction that matches the message by id OR by
 * its provider id. After a force re-import the bubble carries the NEW id while
 * the stored row carries the old one; deleting by `message_id` alone would
 * leave the text gray and make Unhide do nothing.
 */
export const UNHIDE_TEXT_FROM_EXPORT_SQL = sql`
  DELETE FROM transaction_hidden_texts
  WHERE transaction_id = ?
    AND (message_id = ?
         OR (message_external_id IS NOT NULL
             AND message_external_id = (SELECT m.external_id FROM messages m WHERE m.id = ?)))
`;

/**
 * Whether one text is hidden in one transaction, by either arm. Three bound
 * parameters, in order: transaction id, message id, message id. Returns one row
 * with `hidden` = 0 or 1.
 */
export const IS_TEXT_HIDDEN_FROM_EXPORT_SQL = sql`
  SELECT EXISTS (
    SELECT 1 FROM transaction_hidden_texts h
    WHERE h.transaction_id = ?
      AND (h.message_id = ?
           OR (h.message_external_id IS NOT NULL
               AND h.message_external_id = (SELECT m.external_id FROM messages m WHERE m.id = ?)))
  ) AS hidden
`;
