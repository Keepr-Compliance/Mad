/**
 * Sync Database Service
 * Handles iPhone sync-related database operations (message/attachment/contact batch ops)
 */

import * as path from "path";
import { ensureDb } from "./core/dbConnection";
import { updateTransactionThreadCountSync } from "./communicationDbService";
import { samePeople } from "../rcsImportStore";
import { withLiveTransactionParam } from "./core/transactionEligibilitySql";
import logService from "../logService";
import {
  RCS_IMPORT_TRANSACTION_CONTACTS_SQL,
  RCS_INSERT_REACTION_SQL,
  RCS_MARK_MESSAGE_HAS_ATTACHMENTS_SQL,
  RCS_CLEAR_ATTACHMENT_PATHS_SQL,
  RCS_CLEAR_COUNTED_LINKS_SQL,
  RCS_CLEAR_LINKED_TRANSACTIONS_SQL,
  RCS_CLEAR_FILE_REFERENCED_SQL,
  RCS_STAGING_PUT_CHAT_SQL,
  RCS_STAGING_PUT_MESSAGE_SQL,
  RCS_STAGING_HAS_MESSAGE_SQL,
  RCS_STAGING_PUT_IMAGE_SQL,
  RCS_STAGING_IMAGE_BYTES_SQL,
  RCS_STAGING_MESSAGE_KEYS_SQL,
  RCS_STAGING_CHATS_SQL,
  RCS_STAGING_CHAT_MESSAGES_SQL,
  RCS_STAGING_IMAGES_SQL,
  RCS_STAGING_DELETE_JOB_SQL,
  RCS_STAGING_DELETE_ALL_SQL,
  RCS_STAGING_JOB_IDS_SQL,
  RCS_PLACED_FILE_PUT_SQL,
  RCS_PLACED_FILE_CLEAR_JOB_SQL,
  RCS_PLACED_FILE_ROWS_SQL,
  RCS_PLACED_FILE_DELETE_SQL,
  RCS_CLEAR_DELETE_ATTACHMENTS_SQL,
  RCS_CLEAR_DELETE_MESSAGE_LINKS_SQL,
  RCS_CLEAR_DELETE_MESSAGES_SQL,
  RCS_CLEAR_DELETE_THREAD_LINKS_SQL,
  RCS_CLEAR_GET_MESSAGE_COUNT_SQL,
  RCS_CLEAR_SET_MESSAGE_COUNT_SQL,
  RCS_CONTENT_DUPLICATE_SQL,
  RCS_CACHE_STATE_ENSURE_SQL,
  RCS_CACHE_STATE_GET_SQL,
  RCS_CACHE_STATE_RESET_SQL,
  RCS_CACHE_STATE_SET_EXTENSION_SQL,
  RCS_CACHE_STATE_SET_FINISHED_SQL,
  RCS_CACHE_STATE_SET_OPT_IN_SQL,
  RCS_CACHE_STATE_SET_OWN_NUMBER_SQL,
  RCS_NUMBERS_MATCH_LIVE_CONTACT_SQL,
  RCS_REMOVALS_SQL,
  RCS_LEGACY_REMOVAL_DROP_DUPLICATE_SQL,
  RCS_LEGACY_REMOVAL_REPOINT_SQL,
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
/**
 * BACKLOG-3642: what the user removed from a transaction, for the RCS import.
 * gmweb thread ids only (an SMS phone-backup removal never blocks RCS), the
 * thread-less message ids, and the participant keys of removed gmweb rows.
 */
export function getRcsRemovals(
  transactionId: string,
  userId: string
): { threadIds: Set<string>; messageIds: Set<string> } {
  void userId; // removals are per transaction; kept for the caller's signature
  const db = ensureDb();
  const rows = db.prepare(RCS_REMOVALS_SQL).all(transactionId) as {
    threadId: string | null;
    messageId: string | null;
  }[];
  const threadIds = new Set<string>();
  const messageIds = new Set<string>();
  for (const r of rows) {
    // BACKLOG-3630: gmweb2-<hash> (stable across re-pairs) and legacy gmweb-chat-*.
    if (r.threadId && (r.threadId.startsWith("gmweb2-") || r.threadId.startsWith("gmweb-chat-"))) {
      threadIds.add(r.threadId);
    }
    if (r.messageId) messageIds.add(r.messageId);
  }
  return { threadIds, messageIds };
}

/**
 * BACKLOG-3665: move the user's legacy removal of one chat
 * (`gmweb-chat-<conversation id>`) onto its gmweb2 thread — on one
 * transaction, or on every transaction of the user (`transactionId` null:
 * the cache Sync, whose auto-link reads gmweb2 removals only). One SQLite
 * transaction. Returns the removals now on the gmweb2 thread because of this.
 */
export function repointLegacyRcsRemoval(
  userId: string,
  legacyThreadId: string,
  threadId: string,
  transactionId: string | null,
): number {
  if (!legacyThreadId.startsWith("gmweb-chat-") || !threadId.startsWith("gmweb2-")) return 0;
  const db = ensureDb();
  const run = db.transaction((): number => {
    const dropped = db
      .prepare(RCS_LEGACY_REMOVAL_DROP_DUPLICATE_SQL)
      .run(userId, legacyThreadId, transactionId, transactionId, threadId).changes;
    const moved = db
      .prepare(RCS_LEGACY_REMOVAL_REPOINT_SQL)
      .run(legacyThreadId, threadId, threadId, userId, legacyThreadId, transactionId, transactionId).changes;
    return dropped + moved;
  });
  return run();
}

/**
 * BACKLOG-3630: the content guard — for each row, an existing gmweb2 row of the
 * user under a different key with the same sent_at + direction + body.
 */
export function findRcsContentDuplicates(
  userId: string,
  rows: {
    externalId: string;
    sentAt: string;
    direction: string;
    bodyText: string | null;
    participants: string;
    participantsFlat: string;
  }[]
): Map<string, string> {
  const db = ensureDb();
  const stmt = db.prepare(RCS_CONTENT_DUPLICATE_SQL);
  const found = new Map<string, string>();
  for (const r of rows) {
    // Never for an empty body: image-only messages of the same minute collide.
    if (!r.bodyText || r.bodyText.trim() === "") continue;
    const candidates = stmt.all(userId, r.externalId, r.sentAt, r.direction, r.bodyText) as {
      id: string;
      participants: string | null;
      participantsFlat: string | null;
    }[];
    const hit = candidates.find((old) => samePeople(r, old));
    if (hit) found.set(r.externalId, hit.id);
  }
  return found;
}

/**
 * BACKLOG-3667: does any attachments row (any user, any source) point to this
 * content-addressed file? Matched on the stored path or its file name.
 */
export function attachmentFileReferenced(storagePath: string): boolean {
  const db = ensureDb();
  const name = path.basename(storagePath.replace(/\\/g, "/"));
  return !!db.prepare(RCS_CLEAR_FILE_REFERENCED_SQL).get(storagePath, name, name, name, name);
}

/**
 * BACKLOG-3657: the database side of clearing Google Messages for Web texts
 * (see rcsClearService.ts). Every statement is scoped to the user.
 */
export function rcsClearDbOps(): import("../rcsClearService").RcsClearDbOps {
  const db = ensureDb();
  return {
    inTransaction: <T>(fn: () => T): T => db.transaction(fn)(),
    attachmentPaths: (userId) =>
      (db.prepare(RCS_CLEAR_ATTACHMENT_PATHS_SQL).all(userId) as { storagePath: string | null }[])
        .map((r) => r.storagePath)
        .filter((p): p is string => typeof p === "string" && p.length > 0),
    countedLinks: (userId) =>
      db.prepare(RCS_CLEAR_COUNTED_LINKS_SQL).all(userId, userId) as { transactionId: string; counted: number }[],
    linkedTransactions: (userId) =>
      (db.prepare(RCS_CLEAR_LINKED_TRANSACTIONS_SQL).all(userId, userId, userId) as { transactionId: string }[])
        .map((r) => r.transactionId),
    messageCount: (userId, transactionId) => {
      const row = db.prepare(RCS_CLEAR_GET_MESSAGE_COUNT_SQL).get(transactionId, userId) as
        | { messageCount: number | null }
        | undefined;
      return row ? row.messageCount ?? 0 : null;
    },
    deleteAttachments: (userId) => db.prepare(RCS_CLEAR_DELETE_ATTACHMENTS_SQL).run(userId).changes,
    deleteMessageLinks: (userId) => db.prepare(RCS_CLEAR_DELETE_MESSAGE_LINKS_SQL).run(userId, userId).changes,
    deleteThreadLinks: (userId) => db.prepare(RCS_CLEAR_DELETE_THREAD_LINKS_SQL).run(userId).changes,
    deleteMessages: (userId) => db.prepare(RCS_CLEAR_DELETE_MESSAGES_SQL).run(userId).changes,
    setMessageCount: (userId, transactionId, count) => {
      db.prepare(RCS_CLEAR_SET_MESSAGE_COUNT_SQL).run(count, transactionId, userId);
    },
    fileStillReferenced: (storagePath) => attachmentFileReferenced(storagePath),
    // The same rule as every link/unlink (communicationDbService), on this connection.
    refreshTextThreadCount: (transactionId) => updateTransactionThreadCountSync(transactionId),
  };
}

/**
 * BACKLOG-3658: the database side of the cache Sync's staging area (see
 * rcsCacheStaging.ts). Every statement is scoped to one job id.
 */
export function rcsStagingDbOps(): import("../rcsCacheStaging").RcsStagingDbOps {
  const db = ensureDb();
  return {
    inTransaction: <T>(fn: () => T): T => db.transaction(fn)(),
    putChat: (jobId, r) => {
      db.prepare(RCS_STAGING_PUT_CHAT_SQL).run(jobId, r.userId, r.chatHash, r.conversationId, r.title, r.peopleJson);
    },
    putMessage: (jobId, chatHash, msgId, sentAt, seq, json) => {
      db.prepare(RCS_STAGING_PUT_MESSAGE_SQL).run(jobId, chatHash, msgId, sentAt, seq, json);
    },
    hasMessage: (jobId, chatHash, msgId) => !!db.prepare(RCS_STAGING_HAS_MESSAGE_SQL).get(jobId, chatHash, msgId),
    putImage: (jobId, r) => {
      db.prepare(RCS_STAGING_PUT_IMAGE_SQL).run(jobId, r.chatHash, r.msgId, r.idx, r.mimeType, r.byteSize, r.sha256, r.tempPath);
    },
    stagedImageBytes: (jobId) => (db.prepare(RCS_STAGING_IMAGE_BYTES_SQL).get(jobId) as { bytes: number }).bytes,
    messageKeys: (jobId) =>
      db.prepare(RCS_STAGING_MESSAGE_KEYS_SQL).all(jobId) as import("../rcsCacheStaging").StagedMessageKey[],
    chats: (jobId) => db.prepare(RCS_STAGING_CHATS_SQL).all(jobId) as import("../rcsCacheStaging").StagedChatRow[],
    chatMessages: (jobId, chatHash) =>
      db.prepare(RCS_STAGING_CHAT_MESSAGES_SQL).all(jobId, chatHash) as Array<{ msgId: string; messageJson: string }>,
    images: (jobId) => db.prepare(RCS_STAGING_IMAGES_SQL).all(jobId) as import("../rcsCacheStaging").StagedImageRow[],
    deleteJob: (jobId) => {
      db.transaction(() => {
        for (const q of RCS_STAGING_DELETE_JOB_SQL) db.prepare(q).run(jobId);
      })();
    },
    deleteAll: () => {
      db.transaction(() => {
        for (const q of RCS_STAGING_DELETE_ALL_SQL) db.prepare(q).run();
      })();
    },
    jobIds: () => (db.prepare(RCS_STAGING_JOB_IDS_SQL).all() as Array<{ jobId: string }>).map((r) => r.jobId),
    journalPlaced: (jobId, filePath) => {
      db.prepare(RCS_PLACED_FILE_PUT_SQL).run(filePath, jobId);
    },
    journalClear: (jobId) => {
      db.prepare(RCS_PLACED_FILE_CLEAR_JOB_SQL).run(jobId);
    },
    journalRows: () => db.prepare(RCS_PLACED_FILE_ROWS_SQL).all() as Array<{ jobId: string; path: string }>,
    journalDelete: (filePath) => {
      db.prepare(RCS_PLACED_FILE_DELETE_SQL).run(filePath);
    },
    fileStillReferenced: (filePath) => attachmentFileReferenced(filePath),
  };
}

/** BACKLOG-3642: write a thread's participant key into its existing rows. Returns rows changed. */
// ============================================
// BACKLOG-3658: the cache job's state and contact check
// ============================================

export interface RcsCacheState {
  optedInAt: string | null;
  lastCacheFinishedAt: string | null;
  ownNumber: string | null;
  extensionVersion: string | null;
  extensionSeenAt: string | null;
  pairedAt: string | null;
}

export function getRcsCacheState(userId: string): RcsCacheState | null {
  const db = ensureDb();
  return (db.prepare(RCS_CACHE_STATE_GET_SQL).get(userId) as RcsCacheState | undefined) ?? null;
}

/** Update one user's cache state (the row is created when missing). */
export function updateRcsCacheState(
  userId: string,
  patch: {
    optedIn?: boolean;
    lastCacheFinishedAt?: string;
    ownNumber?: string;
    extension?: { version?: string; seenAt?: string; pairedAt?: string };
  }
): void {
  const db = ensureDb();
  db.transaction(() => {
    db.prepare(RCS_CACHE_STATE_ENSURE_SQL).run(userId);
    if (patch.optedIn !== undefined) {
      db.prepare(RCS_CACHE_STATE_SET_OPT_IN_SQL).run(patch.optedIn ? new Date().toISOString() : null, userId);
    }
    if (patch.lastCacheFinishedAt) db.prepare(RCS_CACHE_STATE_SET_FINISHED_SQL).run(patch.lastCacheFinishedAt, userId);
    if (patch.ownNumber) db.prepare(RCS_CACHE_STATE_SET_OWN_NUMBER_SQL).run(patch.ownNumber, userId);
    if (patch.extension) {
      const e = patch.extension;
      db.prepare(RCS_CACHE_STATE_SET_EXTENSION_SQL).run(e.version ?? null, e.seenAt ?? null, e.pairedAt ?? null, userId);
    }
  })();
}

/** Force re-import (3657): forget the cache position and the own number. */
export function resetRcsCacheState(userId: string): void {
  const db = ensureDb();
  db.prepare(RCS_CACHE_STATE_RESET_SQL).run(userId);
}

/** BACKLOG-3658: does a number belong to a contact on a live transaction of the user? */
export function rcsNumbersMatchLiveContact(userId: string, numbers: readonly string[]): boolean {
  if (numbers.length === 0) return false;
  const db = ensureDb();
  const hit = db
    .prepare(RCS_NUMBERS_MATCH_LIVE_CONTACT_SQL)
    .get(...withLiveTransactionParam([userId, JSON.stringify(numbers.slice(0, 50))]));
  return !!hit;
}

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
