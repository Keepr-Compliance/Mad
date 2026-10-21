/**
 * SQL for migration v77 — BACKLOG-3983 (one-time repair of texts whose deal
 * column names a deal they hold no link to).
 *
 * Same SQL boundary rule as migrationV71Sql.ts: SQL text is DEFINED under
 * `electron/services/db/` and imported, never inlined in the migration body.
 * Plain strings, like v71-v76.
 *
 * Before BACKLOG-2550, background expansion wrote `messages.transaction_id`
 * FIRST and the `communications` row second. When the deal was locked between
 * the two (the v2.41.0 race), the link was refused and the column stayed. Such a
 * text is hidden from every attach picker (they read `transaction_id IS NULL`),
 * the deal-lock check reads the wrong deal, and expansion skips it. v76 cannot
 * see it: v76 only selects an EMPTY column. v77 repairs it once, at upgrade.
 *
 * WHICH ROWS (`V77_ORPHAN_TEXT_IDS_SQL`): a text (channel sms, imessage or the
 * legacy text, the repo text set: isTextMessage in electron/utils/channelHelpers.ts)
 * whose column is non-empty AND either
 *   - no link to that deal: no per-message row, and no thread-only text row
 *     (message_id and email_id NULL, same thread, same user). A thread-only link
 *     counts, as it does for the live re-point; such a text is healthy; or
 *   - the deal has no `transactions` row (legacy, foreign keys off at write time),
 *     even when a link row names that same missing deal.
 * Emails linked through email_id are never touched (channel filter).
 *
 * PLAN, measured without sqlite_stat1 (production does not ANALYZE outside
 * maintenance; SR plan review pm_comments 12dae358 on BACKLOG-3983):
 * `m.transaction_id > ` gives SEARCH m USING INDEX idx_messages_transaction_id.
 * `IS NOT NULL` there gives SCAN m (2.3-7.7 s on a 671k-text store). The unary +
 * on `+m.channel` is load-bearing: a bare `m.channel IN (...)` takes
 * idx_messages_channel and walks every text. No INDEXED BY: a later index rename
 * would make it a startup failure. Pinned by the plan test in the v77 suite.
 *
 * WHAT IT SETS (`V77_REPOINT_SQL`): the live rule, not redefined. A FROZEN copy
 * of `REPOINT_MESSAGE_TRANSACTION_SQL` (messageDbService.ts) at b272c6c68,
 * verbatim, including its EXISTS line (a link to a deal with no row is skipped):
 * newest remaining link to a deal that exists, else NULL. A merged migration
 * never changes (MIGRATION-GUIDE rule 2), so this copy NEVER changes, even if the
 * live constant does. Because the setter never writes a missing deal, v77 needs
 * no dangling-id guard (v76 had to add one).
 *
 * ORDER AFTER v76: v76 writes only a deal the text holds a link to, or puts the
 * column back to NULL; neither qualifies here. One deliberate difference: a text
 * whose newest link names a missing deal is left NULL by v76 and is not selected
 * by v77 (NULL column); a text with a non-empty column in that shape gets the
 * older real link here.
 *
 * IDEMPOTENT: every row v77 writes either names an existing deal it holds a link
 * to (no longer qualifies) or is NULL (excluded by `> ''`).
 *
 * COST, 671,105 texts / 40,214 links / 5,544 broken, SQLCipher, WAL, reopened
 * (engineer plan pm_comments b2d6f2f2): qualifying SELECT 89 ms on this plan,
 * setter over 5,544 rows 46-128 ms. That store was in the OS page cache; a store
 * read cold from disk is slower. Runs once, at startup, behind the "Updating
 * database..." screen.
 *
 * Every statement here is fully static; nothing is built by interpolating a
 * caller's value.
 */

/** Ids of texts whose deal column names a deal they hold no link to, or a deal with no row. */
export const V77_ORPHAN_TEXT_IDS_SQL =
  "SELECT m.id FROM messages m WHERE m.transaction_id > '' AND +m.channel IN ('sms', 'imessage', 'text') AND (NOT EXISTS (SELECT 1 FROM communications c WHERE c.transaction_id = m.transaction_id AND (c.message_id = m.id OR (c.message_id IS NULL AND c.email_id IS NULL AND c.thread_id = m.thread_id AND +c.user_id = m.user_id))) OR NOT EXISTS (SELECT 1 FROM transactions t WHERE t.id = m.transaction_id))";

/** Verbatim copy of REPOINT_MESSAGE_TRANSACTION_SQL at b272c6c68. FROZEN: never edit. */
export const V77_REPOINT_SQL = `UPDATE messages SET transaction_id = (
      SELECT c.transaction_id FROM communications c
      WHERE c.transaction_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM transactions t WHERE t.id = c.transaction_id)
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

/** One text's deal column after the setter, for the counts-only log. */
export const V77_TEXT_DEAL_COLUMN_SQL = "SELECT transaction_id FROM messages WHERE id = ?";
