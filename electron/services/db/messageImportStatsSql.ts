/**
 * SQL for the message-import summary — BACKLOG-2989 chunk 3.
 *
 * Moved out of `electron/handlers/messageImportHandlers.ts`. The rule and its
 * CI gate are BACKLOG-2959.
 *
 * Byte-identical to the text it replaced (`480871c2d2ec`).
 */

/**
 * How many texts have been imported for a user, and when the most recent
 * import wrote a row. One bound parameter: the user id.
 *
 * `channel IN ('sms', 'imessage')` is the definition of "a text" here, and it
 * is a filter rather than a full-table count on purpose: `messages` also holds
 * rows from other channels, and counting those would report an import as more
 * complete than it is.
 *
 * `MAX(created_at)` is the row's WRITE time, not the message's send time — the
 * question this answers is "when did we last import", not "when was the last
 * text sent". An aggregate over zero rows still returns one row, so the caller
 * gets `{ count: 0, last_import_at: null }` rather than nothing.
 */
export const MESSAGE_IMPORT_SUMMARY_SQL = `
        SELECT
          COUNT(*) as count,
          MAX(created_at) as last_import_at
        FROM messages
        WHERE user_id = ?
          AND channel IN ('sms', 'imessage')
      `;
