/**
 * Sync Database Service
 * Handles iPhone sync-related database operations (message/attachment/contact batch ops)
 */

import * as crypto from "crypto";
import * as path from "path";
import { ensureDb } from "./core/dbConnection";
import { updateTransactionThreadCountSync } from "./communicationDbService";
import { samePeople } from "../rcsImportStore";
import { withLiveTransactionParam } from "./core/transactionEligibilitySql";
import logService from "../logService";
import { clearRcsChatPeople, clearRcsChatPeopleForChats, clearRcsThreadNames, clearRcsThreadNamesForThreads } from "./rcsChatPeopleDbService";
import { exclusionKeysFor, markPendingFullRead } from "./rcsPendingFullSyncDbService";
import {
  RCS_INSERT_REACTION_SQL,
  RCS_MARK_MESSAGE_HAS_ATTACHMENTS_SQL,
  RCS_CLEAR_ATTACHMENT_PATHS_SQL,
  RCS_CLEAR_COUNTED_LINKS_SQL,
  RCS_CLEAR_LINKED_TRANSACTIONS_SQL,
  RCS_CLEAR_FILE_REFERENCED_SQL,
  RCS_STAGING_PUT_CHAT_SQL,
  RCS_EXCLUSIONS_CONV_IDS_SQL,
  RCS_EXCLUSION_ADD_SQL,
  RCS_EXCLUSION_REMOVE_SQL,
  RCS_EXCLUSION_MATCH_SQL,
  RCS_EXCLUSION_SET_HASH_SQL,
  RCS_EXCLUSION_ADD_FULL_SQL,
  RCS_EXCLUSIONS_FOR_SETTINGS_SQL,
  RCS_EXCLUSION_HASHES_SQL,
  RCS_CONSENT_GET_SQL,
  RCS_CONSENT_ENSURE_SQL,
  RCS_CONSENT_SET_SQL,
  RCS_CONSENT_SET_CONTACTS_ONLY_SQL,
  RCS_CONSENT_SET_AUTO_DELETE_SQL,
  RCS_UNLINKED_OLD_THREADS_SQL,
  RCS_THREADS_ATTACHMENT_PATHS_SQL,
  RCS_THREADS_DELETE_ATTACHMENTS_SQL,
  RCS_THREADS_DELETE_MESSAGES_SQL,
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
  RCS_PLACED_FILE_DELETE_ALL_SQL,
  RCS_STAGING_PUT_JOB_SQL,
  RCS_STAGING_JOBS_SQL,
  RCS_STAGING_DELETE_JOB_RECORD_SQL,
  RCS_STAGING_PUT_CHAT_META_SQL,
  RCS_STAGING_CHAT_META_SQL,
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
} from "./rcsImportSql";

// ============================================
// iPHONE SYNC QUERIES (TASK-2100)
// ============================================

/**
 * BACKLOG-3868: one page of the user's stored message external_ids, in
 * external_id order, strictly after `after` (null = from the start). The iPhone
 * sync's duplicate check reads every page and yields between them; this replaces
 * one synchronous read of every id. Keyset paging over the covering
 * idx_messages_user_external_id, so each page is a range read, and the pages
 * together are exactly `WHERE user_id = ? AND external_id IS NOT NULL`.
 */
export const MESSAGE_EXTERNAL_IDS_FIRST_PAGE_SQL =
  `SELECT external_id FROM messages WHERE user_id = ? AND external_id IS NOT NULL ORDER BY external_id LIMIT ?`;
export const MESSAGE_EXTERNAL_IDS_NEXT_PAGE_SQL =
  `SELECT external_id FROM messages WHERE user_id = ? AND external_id IS NOT NULL AND external_id > ? ORDER BY external_id LIMIT ?`;

export function getMessageExternalIdsPage(userId: string, after: string | null, limit: number): string[] {
  const db = ensureDb();
  const rows = (
    after === null
      ? db.prepare(MESSAGE_EXTERNAL_IDS_FIRST_PAGE_SQL).all(userId, limit)
      : db.prepare(MESSAGE_EXTERNAL_IDS_NEXT_PAGE_SQL).all(userId, after, limit)
  ) as { external_id: string }[];
  return rows.map((row) => row.external_id);
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
 * BACKLOG-3785: internal message id for each of the given external ids (one
 * chunk). Callers pass a bounded chunk (<= a few hundred ids) and yield between
 * chunks; this replaces loading every message row of the user just to resolve
 * the ids an iPhone sync's attachments point at. Uses
 * idx_messages_user_external_id. Ids not stored are simply absent from the map.
 */
export function getMessageIdsByExternalIds(userId: string, externalIds: readonly string[]): Map<string, string> {
  const map = new Map<string, string>();
  if (externalIds.length === 0) return map;
  const db = ensureDb();
  const placeholders = externalIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT id, external_id FROM messages WHERE user_id = ? AND external_id IN (${placeholders})`
    )
    .all(userId, ...externalIds) as { id: string; external_id: string }[];
  for (const row of rows) {
    map.set(row.external_id, row.id);
  }
  return map;
}

/**
 * BACKLOG-3785: existing attachment records (`message_id:filename`) for the given
 * message ids only (one chunk) — the scoped counterpart of
 * getExistingAttachmentRecords. Uses idx_attachments_message_id.
 */
export function getExistingAttachmentRecordsForMessages(messageIds: readonly string[]): Set<string> {
  const records = new Set<string>();
  if (messageIds.length === 0) return records;
  const db = ensureDb();
  const placeholders = messageIds.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT message_id, filename FROM attachments WHERE message_id IN (${placeholders})`)
    .all(...messageIds) as { message_id: string; filename: string }[];
  for (const row of rows) {
    records.add(`${row.message_id}:${row.filename}`);
  }
  return records;
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

/**
 * Set has_attachments = 1 on a message stored earlier without it.
 * `batchInsertMessages` is INSERT OR IGNORE, so a row first stored text-only
 * never gets the flag from a later insert. Returns rows changed.
 */
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
    transaction: <T>(fn: () => T): T => db.transaction(fn)(),
    // BACKLOG-3670: the people found in the cleared texts; their group names.
    deletePeople: (userId) => clearRcsChatPeople(userId) + clearRcsThreadNames(userId),
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
  // Resolved on every call: the handler keeps one staging object for the
  // app's life, while the database connection may be reopened.
  const db = { prepare: (q: string) => ensureDb().prepare(q), transaction: <F extends (...a: never[]) => unknown>(fn: F) => ensureDb().transaction(fn) };
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
    deleteJob: (jobId) =>
      db.transaction(() => {
        let rows = 0;
        for (const q of RCS_STAGING_DELETE_JOB_SQL) rows += db.prepare(q).run(jobId).changes;
        return rows;
      })(),
    deleteAll: () => {
      db.transaction(() => {
        for (const q of RCS_STAGING_DELETE_ALL_SQL) db.prepare(q).run();
      })();
    },
    jobIds: () => (db.prepare(RCS_STAGING_JOB_IDS_SQL).all() as Array<{ jobId: string }>).map((r) => r.jobId),
    putJob: (jobId, r) => {
      db.prepare(RCS_STAGING_PUT_JOB_SQL).run(jobId, r.userId, r.startedAt, r.limitsJson, r.readJson);
    },
    jobs: () => db.prepare(RCS_STAGING_JOBS_SQL).all() as import("../rcsCacheStaging").StagedJobRow[],
    deleteJobRecord: (jobId) => {
      db.prepare(RCS_STAGING_DELETE_JOB_RECORD_SQL).run(jobId);
    },
    putChatMeta: (jobId, r) => {
      db.prepare(RCS_STAGING_PUT_CHAT_META_SQL).run(jobId, r.chatHash, r.chatFloorMs, r.readFloorMs, r.reachedFloor ? 1 : 0, r.readAt);
    },
    chatMeta: (jobId) =>
      (db.prepare(RCS_STAGING_CHAT_META_SQL).all(jobId) as Array<Omit<import("../rcsCacheStaging").StagedChatMeta, "reachedFloor"> & { reachedFloor: number }>)
        .map((r) => ({ ...r, reachedFloor: r.reachedFloor === 1 })),
    // Nested in Force re-import's transaction: a savepoint, all or nothing.
    deleteAllWithJournal: () => {
      db.transaction(() => {
        for (const q of RCS_STAGING_DELETE_ALL_SQL) db.prepare(q).run();
        db.prepare(RCS_PLACED_FILE_DELETE_ALL_SQL).run();
      })();
    },
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

// ============================================
// BACKLOG-3658 P3b: consent + cache options
// ============================================

export interface RcsConsent {
  consentAt: string | null;
  consentVersion: number | null;
  contactsOnly: boolean;
  /** null = auto-delete off. */
  autoDeleteDays: number | null;
}

export function getRcsConsent(userId: string): RcsConsent | null {
  const db = ensureDb();
  const row = db.prepare(RCS_CONSENT_GET_SQL).get(userId) as
    | { consentAt: string | null; consentVersion: number | null; contactsOnly: number; autoDeleteDays: number | null }
    | undefined;
  if (!row) return null;
  return {
    consentAt: row.consentAt,
    consentVersion: row.consentVersion,
    contactsOnly: row.contactsOnly === 1,
    autoDeleteDays: row.autoDeleteDays,
  };
}

/** Record (version) or withdraw (null) the user's consent; options are kept. */
export function setRcsConsent(userId: string, version: number | null, nowIso: string): void {
  const db = ensureDb();
  db.transaction(() => {
    db.prepare(RCS_CONSENT_ENSURE_SQL).run(userId);
    db.prepare(RCS_CONSENT_SET_SQL).run(version === null ? null : nowIso, version, userId);
  })();
}

export function setRcsCacheOptions(userId: string, patch: { contactsOnly?: boolean; autoDeleteDays?: number | null }): void {
  const db = ensureDb();
  db.transaction(() => {
    db.prepare(RCS_CONSENT_ENSURE_SQL).run(userId);
    if (patch.contactsOnly !== undefined) db.prepare(RCS_CONSENT_SET_CONTACTS_ONLY_SQL).run(patch.contactsOnly ? 1 : 0, userId);
    if (patch.autoDeleteDays !== undefined) db.prepare(RCS_CONSENT_SET_AUTO_DELETE_SQL).run(patch.autoDeleteDays, userId);
  })();
}

/** BACKLOG-3658 P3b: the database side of the optional auto-delete (rcsClearService.clearUnlinkedOldChats). */
export function rcsAutoDeleteDbOps(): import("../rcsClearService").RcsAutoDeleteDbOps {
  const db = ensureDb();
  return {
    transaction: <T>(fn: () => T): T => db.transaction(fn)(),
    // BACKLOG-3670: gmweb2-<hash> thread → that chat's people.
    deletePeople: (userId, threadIds) =>
      clearRcsChatPeopleForChats(
        userId,
        threadIds.filter((t) => t.startsWith("gmweb2-")).map((t) => t.slice("gmweb2-".length)),
      ) + clearRcsThreadNamesForThreads(userId, threadIds),
    unlinkedOldThreads: (userId, cutoffIso) =>
      (db.prepare(RCS_UNLINKED_OLD_THREADS_SQL).all(userId, userId, userId, userId, userId, cutoffIso) as Array<{ threadId: string }>)
        .map((r) => r.threadId),
    attachmentPaths: (userId, threadIds) =>
      (db.prepare(RCS_THREADS_ATTACHMENT_PATHS_SQL).all(userId, JSON.stringify(threadIds)) as Array<{ storagePath: string | null }>)
        .map((r) => r.storagePath)
        .filter((p): p is string => typeof p === "string" && p.length > 0),
    deleteAttachments: (userId, threadIds) =>
      db.prepare(RCS_THREADS_DELETE_ATTACHMENTS_SQL).run(userId, JSON.stringify(threadIds)).changes,
    deleteMessages: (userId, threadIds) => db.prepare(RCS_THREADS_DELETE_MESSAGES_SQL).run(userId, JSON.stringify(threadIds)).changes,
    fileStillReferenced: (storagePath) => attachmentFileReferenced(storagePath),
  };
}

// ============================================
// BACKLOG-3658 P3c: per-chat exclusions
// ============================================

/** Conversation ids the page shows as switched off (most recent first, capped). */
export function listRcsExclusionConversationIds(userId: string, max: number): string[] {
  const db = ensureDb();
  return (db.prepare(RCS_EXCLUSIONS_CONV_IDS_SQL).all(userId, max) as Array<{ conversationId: string }>).map((r) => r.conversationId);
}

/** The eye: switch a chat off (pending by conversation id) or back on (this chat under every id). */
export function setRcsExclusion(userId: string, conversationId: string, excluded: boolean): void {
  const db = ensureDb();
  if (excluded) db.prepare(RCS_EXCLUSION_ADD_SQL).run(crypto.randomUUID(), userId, conversationId);
  else {
    // Switched back on: read it in full on the next Sync (no new message needed).
    db.transaction(() => {
      markPendingFullRead(userId, exclusionKeysFor(userId, { conversationId }));
      db.prepare(RCS_EXCLUSION_REMOVE_SQL).run(userId, conversationId, userId, conversationId);
    })();
  }
}

/**
 * At /match: is this chat switched off — by its hash or its conversation id?
 * When it is, the hash is recorded on a pending row and the current
 * conversation id is added for a hash-only match, so the row and the chat
 * stay paired across re-pairs.
 */
export function checkRcsExclusion(userId: string, chatHash: string, conversationId: string): boolean {
  const db = ensureDb();
  const rows = db.prepare(RCS_EXCLUSION_MATCH_SQL).all(userId, chatHash, userId, conversationId) as Array<{
    id: string;
    chatHash: string | null;
    conversationId: string | null;
  }>;
  if (rows.length === 0) return false;
  db.transaction(() => {
    for (const r of rows) if (!r.chatHash) db.prepare(RCS_EXCLUSION_SET_HASH_SQL).run(chatHash, r.id);
    if (!rows.some((r) => r.conversationId === conversationId)) {
      db.prepare(RCS_EXCLUSION_ADD_FULL_SQL).run(crypto.randomUUID(), userId, chatHash, conversationId);
    }
  })();
  return true;
}

/** Settings: every switched-off chat (stored title when Keepr has the chat; never sent to the page). */
export function listRcsExclusionsForSettings(userId: string): Array<{ id: string; title: string | null; createdAt: string }> {
  const db = ensureDb();
  const rows = db.prepare(RCS_EXCLUSIONS_FOR_SETTINGS_SQL).all(userId) as Array<{
    id: string;
    chatHash: string | null;
    createdAt: string;
    title: string | null;
  }>;
  // One entry per chat: rows of the same hash (old and new conversation ids) are one chat.
  const seen = new Set<string>();
  const out: Array<{ id: string; title: string | null; createdAt: string }> = [];
  for (const r of rows) {
    const key = r.chatHash ?? r.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: r.id, title: r.title && r.title.trim() ? r.title : null, createdAt: r.createdAt });
  }
  return out;
}

export function rcsExclusionHashes(userId: string): string[] {
  return (ensureDb().prepare(RCS_EXCLUSION_HASHES_SQL).all(userId) as Array<{ chatHash: string }>).map((r) => r.chatHash);
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
