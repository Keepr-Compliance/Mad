/**
 * Sync Database Service
 * Handles iPhone sync-related database operations (message/attachment/contact batch ops)
 */

import { ensureDb } from "./core/dbConnection";
import logService from "../logService";
import {
  RCS_IMPORT_TRANSACTION_CONTACTS_SQL,
  RCS_INSERT_REACTION_SQL,
  RCS_MARK_MESSAGE_HAS_ATTACHMENTS_SQL,
} from "./rcsImportSql";

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
      void logService.info(
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
 * Insert a single attachment record (for iPhone sync).
 */
export function insertAttachment(params: {
  id: string;
  messageId: string;
  externalMessageId: string;
  filename: string;
  mimeType: string;
  fileSizeBytes: number;
  storagePath: string;
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
// RCS IMPORT (BACKLOG-3620)
// ============================================

/** A transaction's contacts with every phone number, including contacts with none. */
export function getRcsImportContacts(
  transactionId: string
): { contactId: string; displayName: string; phoneE164: string | null }[] {
  const db = ensureDb();
  return db.prepare(RCS_IMPORT_TRANSACTION_CONTACTS_SQL).all(transactionId) as {
    contactId: string;
    displayName: string;
    phoneE164: string | null;
  }[];
}

/**
 * Set has_attachments = 1 on a message stored earlier without it.
 * `batchInsertMessages` is INSERT OR IGNORE, so a row first stored text-only
 * never gets the flag from a later insert. Returns rows changed.
 */
export function markMessageHasAttachments(messageId: string): number {
  const db = ensureDb();
  return db.prepare(RCS_MARK_MESSAGE_HAS_ATTACHMENTS_SQL).run(messageId).changes;
}

/**
 * Insert reaction rows (INSERT OR IGNORE on the (user_id, external_id) index).
 * `batchInsertMessages` does not write the two reaction columns, and the
 * Android/iPhone path shares it, so reactions get their own statement.
 */
export function insertReactionRows(
  rows: {
    id: string;
    userId: string;
    externalId: string;
    direction: string;
    bodyText: string;
    participants: string;
    participantsFlat: string;
    threadId: string | null;
    sentAt: string;
    metadata: string | null;
    associatedMessageType: number;
    associatedMessageGuid: string;
  }[]
): { stored: number; skipped: number } {
  const db = ensureDb();
  const stmt = db.prepare(RCS_INSERT_REACTION_SQL);
  let stored = 0;
  let skipped = 0;
  db.transaction(() => {
    for (const r of rows) {
      const result = stmt.run(
        r.id,
        r.userId,
        r.externalId,
        r.direction,
        r.bodyText,
        r.participants,
        r.participantsFlat,
        r.threadId,
        r.sentAt,
        r.metadata,
        r.associatedMessageType,
        r.associatedMessageGuid
      );
      if (result.changes > 0) stored++;
      else skipped++;
    }
  })();
  return { stored, skipped };
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
  void logService.info(
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

  void logService.info(
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
  void logService.info(
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
  void logService.info(
    `Deleted ${result.changes} contacts for session ${sessionId}`,
    "syncDbService"
  );
  return result.changes;
}
