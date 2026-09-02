/**
 * SQL for Apple's iOS Messages database (`sms.db`) — BACKLOG-2990 chunk 2.
 *
 * Moved out of `electron/services/iosMessagesParser.ts`. The rule and its CI
 * gate are BACKLOG-2959.
 *
 * ## Apple's schema, and which driver reads it
 *
 * `sms.db` is Apple's — this app reads it and never writes or migrates it. The
 * module is named for the schema so nobody mistakes `chat` or `handle` for a
 * Keepr table.
 *
 * This parser opens it with **better-sqlite3**, NOT the node-sqlite3 path
 * BACKLOG-3059 taught the gate. Worth stating because the file name invites the
 * opposite assumption: of the three importer files, only
 * `macOSMessagesImportService` uses node-sqlite3 — and it uses BOTH drivers.
 *
 * ## Why three of these are functions
 *
 * `audio_transcript` exists only in newer backups, so the message projection is
 * assembled per-database from `AUDIO_TRANSCRIPT_COLUMN_PROBE_SQL`. The text
 * genuinely is not knowable until the database is open, so those three cannot
 * be constants a caller passes to `.prepare()`.
 */

import type { Database as DatabaseType, Statement } from "better-sqlite3";

/**
 * Whether this backup's `message` table has `audio_transcript`.
 * 
 * Read through `pragma_table_info` as a TABLE rather than `PRAGMA table_info(...)`
 * so it can carry a WHERE clause. Older iOS backups predate the column, and
 * selecting it unconditionally makes every message query fail rather than degrade.
 */
export const AUDIO_TRANSCRIPT_COLUMN_PROBE_SQL = "SELECT name FROM pragma_table_info('message') WHERE name = 'audio_transcript'";

/**
 * One handle — a phone number or Apple ID — by its ROWID.
 */
export const HANDLE_ID_BY_ROWID_SQL = `
        SELECT id FROM handle WHERE ROWID = ?
      `;

/**
 * Every chat, lowest ROWID first.
 * 
 * Ordered so an import is deterministic across runs. `chat.ROWID` is the only
 * stable key here: `chat_identifier` repeats across services for the same person.
 */
export const ALL_CHATS_SQL = `
        SELECT
          chat.ROWID,
          chat.guid,
          chat.chat_identifier,
          chat.display_name
        FROM chat
        ORDER BY chat.ROWID
      `;

/**
 * The most recent message date in a chat — how a conversation list sorts.
 */
export const CHAT_LAST_MESSAGE_DATE_SQL = `
            SELECT MAX(message.date) as last_date
            FROM message
            JOIN chat_message_join ON message.ROWID = chat_message_join.message_id
            WHERE chat_message_join.chat_id = ?
          `;

/**
 * The handles participating in a chat.
 * 
 * `DISTINCT` because the join table can carry the same handle more than once for
 * a chat that changed service (SMS to iMessage), which would otherwise duplicate
 * a participant.
 */
export const CHAT_PARTICIPANT_HANDLES_SQL = `
        SELECT DISTINCT handle.id
        FROM chat_handle_join
        JOIN handle ON chat_handle_join.handle_id = handle.ROWID
        WHERE chat_handle_join.chat_id = ?
      `;

/**
 * Attachments on one message.
 */
export const MESSAGE_ATTACHMENTS_SQL = `
        SELECT
          attachment.ROWID,
          attachment.guid,
          attachment.filename,
          attachment.mime_type,
          attachment.transfer_name
        FROM attachment
        JOIN message_attachment_join ON attachment.ROWID = message_attachment_join.attachment_id
        WHERE message_attachment_join.message_id = ?
      `;

/**
 * How many messages a chat holds.
 */
export const CHAT_MESSAGE_COUNT_SQL = `
        SELECT COUNT(*) as count
        FROM message
        JOIN chat_message_join ON message.ROWID = chat_message_join.message_id
        WHERE chat_message_join.chat_id = ?
      `;

/**
 * One chat by ROWID.
 * 
 * Same projection as `ALL_CHATS_SQL` deliberately: both feed the same mapper, so
 * a column added to one and not the other yields a half-populated chat object.
 */
export const CHAT_BY_ROWID_SQL = `
        SELECT
          chat.ROWID,
          chat.guid,
          chat.chat_identifier,
          chat.display_name
        FROM chat
        WHERE chat.ROWID = ?
      `;

// ---------------------------------------------------------------------------
// The message projection, and the three statements built from it
// ---------------------------------------------------------------------------

/**
 * The columns every message read selects.
 *
 * `audio_transcript` is included only when this backup has it — see
 * `AUDIO_TRANSCRIPT_COLUMN_PROBE_SQL`. Selecting it unconditionally makes the
 * query fail outright on an older backup rather than return messages without
 * a transcript.
 */
function messageSelectColumns(hasAudioTranscript: boolean): string {
  return [
    "message.ROWID",
    "message.guid",
    "message.text",
    "message.attributedBody",
    ...(hasAudioTranscript ? ["message.audio_transcript"] : []),
    "message.handle_id",
    "message.is_from_me",
    "message.date",
    "message.date_read",
    "message.date_delivered",
    "message.service",
  ].join(",\n      ");
}

/**
 * How many rows a message read returns, and where it starts.
 *
 * BACKLOG-2990 chunk 2: these used to be INTERPOLATED — `LIMIT ${Math.floor(n)}`
 * spliced straight into the SQL. `Math.floor` made that safe, so this is not a
 * live injection; it is a values-into-SQL pattern that would have survived into
 * `db/` as precedent, and integers bind perfectly well.
 *
 * **The CLAMPED value is what binds, not the raw one.** Binding `limit` raw
 * would change behaviour: `getMessages(chatId, 0)` currently yields `LIMIT 1`
 * because of `Math.max(1, …)`, and a raw bind would return zero rows instead.
 * The clamp and the bind are therefore computed in the same place, from the
 * same input, so they cannot drift.
 */
export interface MessagePage {
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * Messages in one chat, oldest first.
 *
 * Three statement shapes and no more — no page, a limit, or a limit with an
 * offset — because an offset without a limit was never expressible at the call
 * site and is not made expressible here.
 *
 * CLAMPING, preserved exactly as the caller had it: `Math.max(1, Math.floor(n))`.
 * A request for zero rows returns one, which is odd but is what shipped, and a
 * mechanical move is the wrong place to change it.
 */
export function selectChatMessages<T>(
  db: DatabaseType,
  hasAudioTranscript: boolean,
  chatId: number,
  page: MessagePage = {},
): T[] {
  const limit = page.limit === undefined ? undefined : Math.max(1, Math.floor(page.limit));
  const offset =
    limit === undefined || page.offset === undefined
      ? undefined
      : Math.max(0, Math.floor(page.offset));

  const clause =
    limit === undefined ? "" : offset === undefined ? " LIMIT ?" : " LIMIT ? OFFSET ?";
  const params: number[] = [chatId];
  if (limit !== undefined) params.push(limit);
  if (offset !== undefined) params.push(offset);

  return db
    .prepare(
      `
        SELECT
          ${messageSelectColumns(hasAudioTranscript)}
        FROM message
        JOIN chat_message_join ON message.ROWID = chat_message_join.message_id
        WHERE chat_message_join.chat_id = ?
        ORDER BY message.date ASC
      ` + clause,
    )
    .all(...params) as T[];
}

/**
 * Messages whose text matches a pattern, newest first.
 *
 * CLAMPING DIFFERS FROM `selectChatMessages`, deliberately, because it differed
 * at the two call sites and the difference is observable. Here the limit is
 * applied only when `limit > 0`, so `searchMessages(q, 0)` returns EVERYTHING —
 * where `selectChatMessages(chatId, 0)` returns one row. Two rules, preserved
 * separately rather than unified into a third that matches neither.
 *
 * The caller supplies the already-wrapped `%pattern%`; this does not build it,
 * so a caller that needs a prefix or exact match is not forced through a
 * contains search.
 */
export function searchMessagesByText<T>(
  db: DatabaseType,
  hasAudioTranscript: boolean,
  pattern: string,
  limit?: number,
): T[] {
  const applied = limit !== undefined && limit > 0 ? Math.floor(limit) : undefined;
  const params: (string | number)[] = [pattern];
  if (applied !== undefined) params.push(applied);

  return db
    .prepare(
      `
        SELECT
          ${messageSelectColumns(hasAudioTranscript)}
        FROM message
        WHERE message.text LIKE ?
        ORDER BY message.date DESC
      ` + (applied === undefined ? "" : " LIMIT ?"),
    )
    .all(...params) as T[];
}

/** Exported for the pin: the projection is what the row mapper reads. */
export function messageSelectColumnsForTest(hasAudioTranscript: boolean): string {
  return messageSelectColumns(hasAudioTranscript);
}

export type { Statement };
