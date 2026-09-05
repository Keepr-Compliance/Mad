/**
 * Sync Database Service
 * Handles iPhone sync-related database operations (message/attachment/contact batch ops)
 */

import { ensureDb } from "./core/dbConnection";
import logService from "../logService";

// ============================================
// iPHONE SYNC QUERIES (TASK-2100)
// ============================================

/**
 * Get existing message external_ids for a user (for deduplication).
 */
export function getExistingMessageExternalIds(userId: string): Set<string> {
  const db = ensureDb();
  const rows = db
    .prepare(
      `SELECT external_id FROM messages WHERE user_id = ? AND external_id IS NOT NULL`
    )
    .all(userId) as { external_id: string }[];
  const ids = new Set<string>();
  for (const row of rows) {
    ids.add(row.external_id);
  }
  return ids;
}

/**
 * Batch insert messages using a prepared statement within a transaction.
 * Returns count of inserted and skipped messages.
 */
export function batchInsertMessages(
  messages: {
    id: string;
    userId: string;
    channel: string;
    externalId: string;
    direction: string;
    bodyText: string | null;
    participants: string;
    participantsFlat: string;
    threadId: string | null;
    sentAt: string;
    hasAttachments: number;
    messageType: string | null;
    metadata: string | null;
  }[],
  batchSize: number,
  sessionId?: string,
  cancelSignal?: { cancelled: boolean }
): { stored: number; skipped: number } {
  const db = ensureDb();
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO messages (
      id, user_id, channel, external_id, direction,
      body_text, participants, participants_flat, thread_id, sent_at,
      has_attachments, message_type, metadata, sync_session_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);

  let stored = 0;
  let skipped = 0;
  const totalBatches = Math.ceil(messages.length / batchSize);

  for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
    // TASK-2110: Check cancel signal between batches
    if (cancelSignal?.cancelled) {
      logService.info(
        `Batch insert cancelled after ${batchNum}/${totalBatches} batches (${stored} stored)`,
        "syncDbService"
      );
      break;
    }

    const start = batchNum * batchSize;
    const end = Math.min(start + batchSize, messages.length);
    const batch = messages.slice(start, end);

    const runBatch = db.transaction(() => {
      for (const msg of batch) {
        const result = insertStmt.run(
          msg.id,
          msg.userId,
          msg.channel,
          msg.externalId,
          msg.direction,
          msg.bodyText,
          msg.participants,
          msg.participantsFlat,
          msg.threadId,
          msg.sentAt,
          msg.hasAttachments,
          msg.messageType,
          msg.metadata,
          sessionId || null
        );
        if (result.changes > 0) {
          stored++;
        } else {
          skipped++;
        }
      }
    });
    runBatch();
  }

  return { stored, skipped };
}

/**
 * Get message id/external_id map for a user (for attachment linking).
 */
export function getMessageIdMap(userId: string): Map<string, string> {
  const db = ensureDb();
  const rows = db
    .prepare(
      `SELECT id, external_id FROM messages WHERE user_id = ? AND external_id IS NOT NULL`
    )
    .all(userId) as { id: string; external_id: string }[];
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.external_id, row.id);
  }
  return map;
}

/**
 * Get existing attachment records for deduplication (message_id + filename pairs).
 */
export function getExistingAttachmentRecords(): Set<string> {
  const db = ensureDb();
  const rows = db
    .prepare(
      `SELECT message_id, filename FROM attachments WHERE message_id IS NOT NULL`
    )
    .all() as { message_id: string; filename: string }[];
  const records = new Set<string>();
  for (const row of rows) {
    records.add(`${row.message_id}:${row.filename}`);
  }
  return records;
}

/**
 * Insert a single attachment record.
 *
 * Written for iPhone sync (TASK-2100) but nothing in it is iPhone-specific;
 * BACKLOG-2977 reuses it for the Android companion's attachment MARKERS.
 *
 * ## `fileSizeBytes` and `storagePath` are nullable (BACKLOG-2977)
 *
 * Both columns have always been nullable in `electron/database/schema.sql`
 * (`:40-41`) — only these parameter types were stricter than the table. A
 * marker row records THAT a photo existed without transferring its bytes, so it
 * has neither a size nor a path until BACKLOG-3071 fills `storage_path` on the
 * same row. This is the shape the email path already uses
 * (`upsertEmailAttachmentMetadata` writes a NULL `storage_path`,
 * `attachmentDbService.ts:85`; `setEmailAttachmentStorage` fills it later).
 *
 * Widening a parameter is compatible with every existing caller, and every
 * consumer of `storage_path` already null-guards before touching the
 * filesystem (`folderExport/attachmentHelpers.ts:319`,
 * `folderExport/folderExportService.ts:770`,
 * `folderExport/textExportHelpers.ts:725` and `:753`).
 *
 * ## This function does NOT de-duplicate — the caller must
 *
 * `INSERT OR IGNORE` here keys on `id TEXT PRIMARY KEY` only, and every caller
 * mints a fresh `crypto.randomUUID()`, so the IGNORE never fires. There is
 * also no unique index on `attachments` (all five in `schema.sql:1146-1154` are
 * plain). A re-synced message would therefore write a SECOND row for the same
 * attachment. Callers guard with {@link getExistingAttachmentRecords} and add
 * to that set in-loop; see `iPhoneSyncStorageService.ts:809` and
 * `localSyncService.storeMessages`.
 */
export function insertAttachment(params: {
  id: string;
  messageId: string;
  externalMessageId: string;
  filename: string;
  mimeType: string;
  fileSizeBytes: number | null;
  storagePath: string | null;
  sessionId?: string;
}): void {
  const db = ensureDb();
  db.prepare(
    `INSERT OR IGNORE INTO attachments (
      id, message_id, external_message_id, filename, mime_type, file_size_bytes, storage_path, sync_session_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
  ).run(
    params.id,
    params.messageId,
    params.externalMessageId,
    params.filename,
    params.mimeType,
    params.fileSizeBytes,
    params.storagePath,
    params.sessionId || null
  );
}

// ============================================
// SYNC SESSION ROLLBACK (TASK-2110)
// ============================================

/**
 * Delete all messages inserted during a specific sync session.
 * Used for ACID rollback when user cancels iPhone sync.
 */
export function deleteMessagesBySessionId(userId: string, sessionId: string): number {
  const db = ensureDb();
  const result = db.prepare(
    `DELETE FROM messages WHERE user_id = ? AND sync_session_id = ?`
  ).run(userId, sessionId);
  logService.info(
    `Deleted ${result.changes} messages for session ${sessionId}`,
    "syncDbService"
  );
  return result.changes;
}

/**
 * Delete all attachments inserted during a specific sync session.
 * Returns the storage_path values so callers can clean up orphaned files.
 *
 * TASK-2110: Content-addressed files are only deleted if no other
 * attachment record references the same storage_path.
 */
export function deleteAttachmentsBySessionId(sessionId: string): { deleted: number; orphanedFiles: string[] } {
  const db = ensureDb();

  // Step 1: Get storage paths for attachments in this session
  const sessionAttachments = db.prepare(
    `SELECT id, storage_path FROM attachments WHERE sync_session_id = ?`
  ).all(sessionId) as { id: string; storage_path: string | null }[];

  if (sessionAttachments.length === 0) {
    return { deleted: 0, orphanedFiles: [] };
  }

  // Step 2: Delete the attachment records
  const deleteResult = db.prepare(
    `DELETE FROM attachments WHERE sync_session_id = ?`
  ).run(sessionId);

  // Step 3: Find orphaned files (no other attachment references the same storage_path)
  const orphanedFiles: string[] = [];
  const checkStmt = db.prepare(
    `SELECT COUNT(*) as cnt FROM attachments WHERE storage_path = ?`
  );

  for (const att of sessionAttachments) {
    if (!att.storage_path) continue;
    const row = checkStmt.get(att.storage_path) as { cnt: number };
    if (row.cnt === 0) {
      orphanedFiles.push(att.storage_path);
    }
  }

  logService.info(
    `Deleted ${deleteResult.changes} attachments for session ${sessionId}, ${orphanedFiles.length} orphaned files`,
    "syncDbService"
  );

  return { deleted: deleteResult.changes, orphanedFiles };
}

/**
 * Delete all messages whose metadata JSON contains a specific source value.
 * Used for Android force re-import to clear all android_wifi_sync messages.
 *
 * BACKLOG-1468: Android Force Re-import clears synced data
 *
 * @param userId - User ID for message ownership
 * @param metadataSource - The source value to match in metadata JSON (e.g., 'android_wifi_sync')
 * @returns Number of messages deleted
 */
export function deleteMessagesByMetadataSource(userId: string, metadataSource: string): number {
  const db = ensureDb();
  const result = db.prepare(
    `DELETE FROM messages WHERE user_id = ? AND json_extract(metadata, '$.source') = ?`
  ).run(userId, metadataSource);
  logService.info(
    `Deleted ${result.changes} messages with metadata source '${metadataSource}'`,
    "syncDbService"
  );
  return result.changes;
}

/**
 * Delete all external contacts inserted during a specific sync session.
 */
export function deleteContactsBySessionId(userId: string, sessionId: string): number {
  const db = ensureDb();
  const result = db.prepare(
    `DELETE FROM external_contacts WHERE user_id = ? AND sync_session_id = ?`
  ).run(userId, sessionId);
  logService.info(
    `Deleted ${result.changes} contacts for session ${sessionId}`,
    "syncDbService"
  );
  return result.changes;
}
