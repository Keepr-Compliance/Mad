/**
 * SQL for migration v76 — BACKLOG-4018 (one-time repair of texts with an
 * empty deal column that still hold a per-message link).
 *
 * Same SQL boundary rule as migrationV71Sql.ts: SQL text is DEFINED under
 * `electron/services/db/` and imported, never inlined in the migration body.
 * Plain strings, like v71-v75.
 *
 * Before BACKLOG-3908, removing a conversation from one deal wrote
 * `messages.transaction_id = NULL` even when the text was still attached to
 * another deal. Those texts show up again in that other deal's attach picker,
 * and the deal-lock check (`dealLockState.ts`, `MESSAGE_TRANSACTION_ID_SQL`)
 * answers "no deal" for them. v76 re-points them once, at upgrade.
 *
 * WHICH ROWS: column empty AND at least one per-message communications link.
 * Thread-only links never qualify: an auto-linked thread with an empty column
 * is shown in the picker by design, and setting its column would hide it.
 * A non-empty column is never touched. The qualifier does not filter
 * `channel`, so a legacy `channel = 'email'` row in `messages` with a
 * per-message link is re-pointed too. That changes nothing visible: the only
 * email-channel read (`EMAIL_CHANNEL_CANDIDATES_SQL`, messageMatchingSql.ts)
 * already excludes rows linked to the asked deal through `communications`.
 * CROSS JOIN pins the loop to `communications` (covering index
 * `idx_comm_msg_txn`, then `messages` by primary key); the messages-driven
 * forms walk every NULL-column message and were 9-10x slower.
 *
 * WHAT IT SETS: the 3908 rule, not redefined. `V76_REPOINT_SQL` is a FROZEN
 * copy of `REPOINT_MESSAGE_TRANSACTION_SQL` (messageDbService.ts) at
 * bdc077644: most recent remaining link, own per-message rows or text thread
 * rows (email_id IS NULL, same user), linked_at DESC, rowid DESC. A merged
 * migration never changes (MIGRATION-GUIDE rule 2), so this copy NEVER
 * changes, even if the live constant does.
 *
 * NO DANGLING DEAL ID: the runner turns foreign_keys OFF for the loop and skips
 * foreign_key_check, so a legacy communications row whose deal row is gone
 * would let the setter write a deal id with no `transactions` row (hidden from
 * every picker, lock check on a deal that does not exist). `V76_CLEAR_DANGLING_SQL`
 * runs on the same id right after the setter and puts the column back to NULL,
 * which is exactly what it was before (the qualifier only selects NULL columns).
 * Consequence: a text whose NEWEST link is such an orphan stays unrepaired,
 * as it is today, even if it also has a real older link.
 *
 * COST, cold first run on a 671,105-message / 44,710-link store with 5,040
 * broken texts (SR plan review pm_comments 84417e37 on BACKLOG-4018):
 * qualifying SELECT 104 ms unencrypted, 288 ms with SQLCipher; full body for
 * 5,040 broken texts 92 ms encrypted. That store was in the OS page cache; a
 * store read cold from disk is slower. Runs once, at startup, behind the
 * "Updating database..." screen.
 *
 * Every statement here is fully static; nothing is built by interpolating a
 * caller's value.
 */

/** Ids of texts whose column is empty but which still hold a per-message link. */
export const V76_BROKEN_TEXT_IDS_SQL =
  "SELECT DISTINCT c.message_id AS id FROM communications c CROSS JOIN messages m ON m.id = c.message_id WHERE c.message_id IS NOT NULL AND c.transaction_id IS NOT NULL AND m.transaction_id IS NULL";

/** Verbatim copy of REPOINT_MESSAGE_TRANSACTION_SQL at bdc077644. FROZEN: never edit. */
export const V76_REPOINT_SQL = `UPDATE messages SET transaction_id = (
      SELECT c.transaction_id FROM communications c
      WHERE c.transaction_id IS NOT NULL
        AND (
          c.message_id = messages.id
          OR (
            c.message_id IS NULL
            AND c.email_id IS NULL
            AND c.thread_id IS NOT NULL
            AND c.thread_id = messages.thread_id
            AND +c.user_id = messages.user_id
          )
        )
      ORDER BY c.linked_at DESC, c.rowid DESC
      LIMIT 1
    ) WHERE id = ?`;

/** After the setter: if it chose a deal with no `transactions` row, put the column back to NULL. */
export const V76_CLEAR_DANGLING_SQL =
  "UPDATE messages SET transaction_id = NULL WHERE id = ? AND transaction_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.id = messages.transaction_id)";
