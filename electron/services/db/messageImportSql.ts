/**
 * Keepr's own `messages` and `attachments` tables, as the macOS Messages
 * importer reads and repairs them — BACKLOG-2990 chunk 3a.
 *
 * Moved out of `services/macOSMessagesImportService/macOSMessagesImportService.ts`
 * under BACKLOG-2959's rule. Apple's `chat.db` statements from the same file live
 * in `appleChatDbSql.ts`; these speak to Keepr's schema, so they are kept apart
 * and each module is named for the schema it addresses.
 *
 * ## Two shapes, and why the second one exists
 *
 * Most exports are CONSTANTS: the caller keeps its own verb, so every execution
 * stays an enumerated call site. That is the shape `db/emailForceSetSql.ts`
 * describes as allowed.
 *
 * Three exports are FUNCTIONS, because their statement has an `IN (...)` list
 * whose width is the length of the caller's id array. The width is derived HERE,
 * from the array that is about to be bound, so the placeholder count and the
 * bound values are computed from one input and cannot drift into a
 * `SQLITE_RANGE` at runtime. They execute, but they take an array of ids — never
 * SQL text — so they avoid the forbidden combination the layer rule names.
 *
 * ## Not moved by this chunk
 *
 * Nine statements in the importer splice in view text from `forceStaging.ts`
 * (`forceReadView`, `SURVIVING_ATTACHMENTS`, staging table names). They move when
 * that builder collapses onto the `emailForceReadView` shape and the force set
 * becomes data — chunk 5b, so the collapse is done once rather than twice.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import { sql } from "./core/sqlText";

// ---------------------------------------------------------------------------
// Attachment reads
// ---------------------------------------------------------------------------

/**
 * Every attachment this user has already stored, keyed by the pair the importer
 * deduplicates on.
 *
 * BACKLOG-2743: read BEFORE the copy loop, because the disk-space pre-flight has
 * to size only the attachments that would actually be written. Sizing the whole
 * source set would refuse imports that need no space at all.
 */
export const ATTACHMENT_STORED_KEYS_SQL = `SELECT external_message_id, filename FROM attachments WHERE external_message_id IS NOT NULL`;

/** Attachments belonging to one message, by Keepr's internal message id. */
export const ATTACHMENTS_BY_MESSAGE_ID_SQL = `
        SELECT id, message_id, filename, mime_type, file_size_bytes, storage_path
        FROM attachments
        WHERE message_id = ?
      `;

/**
 * Attachments belonging to one message by its EXTERNAL id — TASK-1110's fallback.
 *
 * A re-sync can give a message a new internal primary key while its Apple GUID
 * stays constant, so a `message_id` lookup misses rows that are really there.
 * The external id is the stable identity.
 */
export const ATTACHMENTS_BY_EXTERNAL_MESSAGE_ID_SQL = `
            SELECT id, message_id, filename, mime_type, file_size_bytes, storage_path
            FROM attachments
            WHERE external_message_id = ?
          `;

/** Every stored attachment's path, for the repair pass's orphan scan. */
export const ALL_ATTACHMENT_STORAGE_PATHS_SQL = `SELECT id, message_id, storage_path FROM attachments`;

/** One attachment's filename, by id. */
export const ATTACHMENT_FILENAME_BY_ID_SQL = `SELECT filename FROM attachments WHERE id = ?`;

/** How many attachments exist, for progress reporting and diagnostics. */
export const ATTACHMENT_COUNT_SQL = `SELECT COUNT(*) as count FROM attachments`;

// ---------------------------------------------------------------------------
// Message reads
// ---------------------------------------------------------------------------

/**
 * One message's external (Apple GUID) id, by internal id.
 *
 * ## This sentence is authored THREE times at base, not two
 *
 * Enumerated by grep over the exact text at `1ba6557ff`, and stated here because
 * BACKLOG-3044 PR 4's own account of it said "a pair" and was wrong:
 *
 *   electron/services/db/messageImportSql.ts:82          this constant
 *   electron/services/db/attachmentDbService.ts:267      inline `db.prepare(...)`, inside
 *                                                        `getAttachmentsForMessageWithFallback`
 *   electron/services/messageMatchingService.ts:811      BACKLOG-3044 PR 4 pointed this
 *                                                        one HERE, so it is no longer
 *                                                        authored — two copies remain
 *
 * The `attachmentDbService` one is a near-line-for-line twin of the importer's own
 * attachment fallback: both ask "I have no rows for this message id — what is its
 * external id, so I can try again by that." Same question, same sentence, two
 * implementations.
 *
 * **Not consolidated.** Same disposition as the six-fold `default_role` UPDATE and the
 * phone/email family in `contactBackfillPlanSql.ts`: a consolidation waits for the next
 * real edit to one of these, so it rides with a change that has a reason and a test.
 * This register exists so that edit finds all of them.
 *
 * ## Why PR 4's duplicate scan missed it — twice over
 *
 * That scan collected only the `sql` tag and `unsafeSql`, so this ENTIRE MODULE was
 * invisible to it (nothing here was tagged before PR 4 branded this one constant). It
 * was corrected to read exported module-level bare literals as well — and it would
 * STILL miss `attachmentDbService.ts:267`, because that is an inline literal handed
 * straight to `db.prepare(...)` and never bound to a name at all.
 *
 * Both limits are properties of a name-and-declaration corpus, not oversights to patch
 * one at a time. A scan that cannot see a form reports "none", never "cannot see" —
 * which is why this register is written down rather than left to the next scan.
 */
export const MESSAGE_EXTERNAL_ID_BY_ID_SQL = sql`SELECT external_id FROM messages WHERE id = ?`;

/** Every message that carries an external id, for building the repair map. */
export const ALL_MESSAGE_EXTERNAL_IDS_SQL = `SELECT id, external_id FROM messages WHERE external_id IS NOT NULL`;

/**
 * Existence probe.
 *
 * `SELECT 1` rather than `SELECT *`: the caller asks only whether the row is
 * there, and the message body is the widest column in the schema.
 */
export const MESSAGE_EXISTS_SQL = `SELECT 1 FROM messages WHERE id = ?`;

// ---------------------------------------------------------------------------
// Attachment repair writes
// ---------------------------------------------------------------------------

/**
 * Point an attachment at the right message, by attachment id — TASK-1122.
 *
 * Executed on two paths (the import's stale-id fix and the standalone repair),
 * which is why one constant serves both: two spellings of this UPDATE could
 * drift into repairing different row sets.
 */
export const UPDATE_ATTACHMENT_MESSAGE_ID_SQL = `UPDATE attachments SET message_id = ? WHERE id = ?`;

/** The same repair addressed by external id, when the internal id is what changed. */
export const UPDATE_ATTACHMENT_MESSAGE_ID_BY_EXTERNAL_SQL = `UPDATE attachments SET message_id = ? WHERE external_message_id = ?`;

// ---------------------------------------------------------------------------
// Batched reads — the IN-list width is derived from the array that is bound
// ---------------------------------------------------------------------------

/**
 * Why these are functions and the statements above are constants.
 *
 * The width of an `IN (?, ?, ?)` list is data — `ids.length` — and the old code
 * built it at the call site, next to but separate from the spread that bound the
 * values. Two expressions over one array, and nothing tying them together: an
 * edit that filtered one and not the other produces `SQLITE_RANGE` at runtime,
 * on a path that only fires for a user whose messages happen to need the
 * fallback.
 *
 * Deriving the width here, from the same array the caller is about to bind,
 * makes that mismatch unrepresentable rather than merely unlikely.
 *
 * An EMPTY array yields `IN ()`, which SQLite accepts and which matches nothing
 * — the correct answer for "attachments belonging to none of these messages".
 * Every caller already guards for the empty case; this keeps the statement
 * honest if one ever stops.
 */
const widthOf = (ids: readonly string[]): string => ids.map(() => "?").join(", ");

/** Attachments for any of the given internal message ids. */
export function selectAttachmentsByMessageIds<T>(
  db: DatabaseType,
  messageIds: readonly string[],
): T[] {
  return db
    .prepare(
      `
        SELECT id, message_id, filename, mime_type, file_size_bytes, storage_path
        FROM attachments
        WHERE message_id IN (${widthOf(messageIds)})
      `,
    )
    .all(...messageIds) as T[];
}

/** External ids for any of the given internal message ids, skipping those without one. */
export function selectMessageExternalIds<T>(
  db: DatabaseType,
  messageIds: readonly string[],
): T[] {
  return db
    .prepare(
      `SELECT id, external_id FROM messages WHERE id IN (${widthOf(messageIds)}) AND external_id IS NOT NULL`,
    )
    .all(...messageIds) as T[];
}

/** Attachments for any of the given EXTERNAL message ids — the TASK-1110 fallback, batched. */
export function selectAttachmentsByExternalMessageIds<T>(
  db: DatabaseType,
  externalIds: readonly string[],
): T[] {
  return db
    .prepare(
      `
            SELECT id, message_id, external_message_id, filename, mime_type, file_size_bytes, storage_path
            FROM attachments
            WHERE external_message_id IN (${widthOf(externalIds)})
          `,
    )
    .all(...externalIds) as T[];
}
