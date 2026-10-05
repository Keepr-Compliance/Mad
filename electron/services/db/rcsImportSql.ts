/**
 * SQL for the RCS (Google Messages) import — BACKLOG-3620, -3658.
 * (The per-transaction Sync and its contacts query were removed, 2026-10-05.)
 */

import { sql } from "./core/sqlText";
import { LIVE_TRANSACTION_SQL_PREDICATE } from "./core/transactionEligibilitySql";

/** One bound parameter: message id. */
export const RCS_MARK_MESSAGE_HAS_ATTACHMENTS_SQL = sql`
    UPDATE messages SET has_attachments = 1 WHERE id = ? AND COALESCE(has_attachments, 0) = 0
  `;

/**
 * A reaction row. Parameters, in order: id, user_id, external_id, direction,
 * body_text, participants, participants_flat, thread_id, sent_at, metadata,
 * associated_message_type, associated_message_guid.
 */
export const RCS_INSERT_REACTION_SQL = sql`
    INSERT OR IGNORE INTO messages (
      id, user_id, channel, external_id, direction,
      body_text, participants, participants_flat, thread_id, sent_at,
      has_attachments, message_type, metadata,
      associated_message_type, associated_message_guid, created_at
    ) VALUES (?, ?, 'sms', ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, CURRENT_TIMESTAMP)
  `;

/**
 * BACKLOG-3630: the content guard's CANDIDATES. gmweb2 rows of the user, under
 * a DIFFERENT key, with the same sent_at + direction + exact (non-empty) body.
 * sent_at has minute precision, so a candidate is only a duplicate when it is
 * also about the same people — checked in code (rcsImportStore.samePeople).
 * Parameters: user id, external id, sent_at, direction, body.
 */
export const RCS_CONTENT_DUPLICATE_SQL = sql`
    SELECT id, participants, participants_flat AS participantsFlat FROM messages
    WHERE user_id = ?
      AND external_id LIKE 'gmweb2:%'
      AND external_id != ?
      AND sent_at = ?
      AND direction = ?
      AND body_text = ?
  `;

// ============================================
// BACKLOG-3657: Force re-import clears Google Messages for Web texts.
// Every statement is scoped to ONE user (user_id = ?). Delete order, as
// reviewed for the one-off purge: attachments -> communications (per message,
// then gmweb thread-level) -> messages -> transactions.message_count.
// ignored_communications (the user's removals) are NOT touched.
// ============================================

/** Parameters: user id. Attachment files of the user's gmweb messages. */
export const RCS_CLEAR_ATTACHMENT_PATHS_SQL = sql`
    SELECT a.storage_path AS storagePath
    FROM attachments a
    WHERE a.message_id IN (
      SELECT m.id FROM messages m
      WHERE m.user_id = ? AND (m.external_id LIKE 'gmweb:%' OR m.external_id LIKE 'gmweb2:%')
    )
  `;

/**
 * Parameters: user id, user id. Per transaction, the gmweb links that were
 * COUNTED into message_count — non-reaction messages; reactions are linked
 * without counting (rcsImportHandlers.linkWithoutCount).
 */
export const RCS_CLEAR_COUNTED_LINKS_SQL = sql`
    SELECT c.transaction_id AS transactionId, COUNT(*) AS counted
    FROM communications c
    JOIN messages m ON m.id = c.message_id
    WHERE m.user_id = ?
      AND c.user_id = ?
      AND (m.external_id LIKE 'gmweb:%' OR m.external_id LIKE 'gmweb2:%')
      AND c.transaction_id IS NOT NULL
      AND (m.associated_message_type IS NULL OR m.associated_message_type = 0)
    GROUP BY c.transaction_id
  `;

/**
 * Parameters: user id, user id, user id. Transactions with any gmweb link of
 * the user: per message (legacy gmweb: and gmweb2: rows) or thread-level
 * (gmweb-chat-* / gmweb2-* threads, message_id NULL — what auto-link writes).
 */
export const RCS_CLEAR_LINKED_TRANSACTIONS_SQL = sql`
    SELECT DISTINCT c.transaction_id AS transactionId
    FROM communications c
    WHERE c.user_id = ?
      AND c.transaction_id IS NOT NULL
      AND (
        c.message_id IN (
          SELECT m.id FROM messages m
          WHERE m.user_id = ? AND (m.external_id LIKE 'gmweb:%' OR m.external_id LIKE 'gmweb2:%')
        )
        OR (c.message_id IS NULL AND (c.thread_id LIKE 'gmweb-chat-%' OR c.thread_id LIKE 'gmweb2-%'))
      )
      AND c.transaction_id IN (SELECT t.id FROM transactions t WHERE t.user_id = ?)
  `;

/**
 * BACKLOG-3667: is a file still used by ANY attachments row (any user, any
 * source)? Files are content-addressed, so they can be shared. Parameters:
 * the stored path, then its file name twice (a path may be stored absolute or
 * relative, with / or \).
 */
export const RCS_CLEAR_FILE_REFERENCED_SQL = sql`
    SELECT 1 AS hit FROM attachments
    WHERE storage_path = ?
       OR substr(storage_path, -length('/' || ?)) = '/' || ?
       OR substr(storage_path, -length('\\' || ?)) = '\\' || ?
    LIMIT 1
  `;

/** Parameters: transaction id, user id. */
export const RCS_CLEAR_GET_MESSAGE_COUNT_SQL = sql`
    SELECT message_count AS messageCount FROM transactions WHERE id = ? AND user_id = ?
  `;

/** Parameters: user id. */
export const RCS_CLEAR_DELETE_ATTACHMENTS_SQL = sql`
    DELETE FROM attachments
    WHERE message_id IN (
      SELECT m.id FROM messages m
      WHERE m.user_id = ? AND (m.external_id LIKE 'gmweb:%' OR m.external_id LIKE 'gmweb2:%')
    )
  `;

/** Parameters: user id, user id. Per-message links, then gmweb thread-level links. */
export const RCS_CLEAR_DELETE_MESSAGE_LINKS_SQL = sql`
    DELETE FROM communications
    WHERE user_id = ?
      AND message_id IN (
        SELECT m.id FROM messages m
        WHERE m.user_id = ? AND (m.external_id LIKE 'gmweb:%' OR m.external_id LIKE 'gmweb2:%')
      )
  `;

/** Parameters: user id. */
export const RCS_CLEAR_DELETE_THREAD_LINKS_SQL = sql`
    DELETE FROM communications
    WHERE user_id = ? AND message_id IS NULL AND (thread_id LIKE 'gmweb-chat-%' OR thread_id LIKE 'gmweb2-%')
  `;

/** Parameters: user id. Text and reaction rows. */
export const RCS_CLEAR_DELETE_MESSAGES_SQL = sql`
    DELETE FROM messages WHERE user_id = ? AND (external_id LIKE 'gmweb:%' OR external_id LIKE 'gmweb2:%')
  `;

/** Parameters: message count, transaction id, user id. */
export const RCS_CLEAR_SET_MESSAGE_COUNT_SQL = sql`
    UPDATE transactions SET message_count = ? WHERE id = ? AND user_id = ?
  `;

// ============================================
// BACKLOG-3658: the cache job
// ============================================

/** Parameters: user id. */
export const RCS_CACHE_STATE_GET_SQL = sql`
    SELECT opted_in_at AS optedInAt, last_cache_finished_at AS lastCacheFinishedAt, own_number AS ownNumber,
           extension_version AS extensionVersion, extension_seen_at AS extensionSeenAt, paired_at AS pairedAt
    FROM rcs_cache_state WHERE user_id = ?
  `;

/** Parameters: user id. Creates the user's row if missing. */
export const RCS_CACHE_STATE_ENSURE_SQL = sql`
    INSERT OR IGNORE INTO rcs_cache_state (user_id) VALUES (?)
  `;

/** Parameters: opted_in_at (NULL = opted out), user id. */
export const RCS_CACHE_STATE_SET_OPT_IN_SQL = sql`
    UPDATE rcs_cache_state SET opted_in_at = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?
  `;

/** Parameters: finished at, user id. */
export const RCS_CACHE_STATE_SET_FINISHED_SQL = sql`
    UPDATE rcs_cache_state SET last_cache_finished_at = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?
  `;

/** Parameters: own number, user id. */
export const RCS_CACHE_STATE_SET_OWN_NUMBER_SQL = sql`
    UPDATE rcs_cache_state SET own_number = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?
  `;

/** Parameters: version (NULL keeps), seen at (NULL keeps), paired at (NULL keeps), user id. */
export const RCS_CACHE_STATE_SET_EXTENSION_SQL = sql`
    UPDATE rcs_cache_state
    SET extension_version = COALESCE(?, extension_version),
        extension_seen_at = COALESCE(?, extension_seen_at),
        paired_at = COALESCE(?, paired_at),
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
  `;

/** Parameters: user id. Force re-import (3657) forgets the cache position and the own number. */
export const RCS_CACHE_STATE_RESET_SQL = sql`
    UPDATE rcs_cache_state SET last_cache_finished_at = NULL, own_number = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
  `;

// ============================================
// BACKLOG-3658: the cache Sync's staging area (rcsCacheStaging.ts). Every
// statement is scoped to one job id.
// ============================================

/** Parameters: job id, user id, chat hash, conversation id, title, people json. */
export const RCS_STAGING_PUT_CHAT_SQL = sql`
    INSERT OR REPLACE INTO rcs_cache_staging_chats (job_id, user_id, chat_hash, conversation_id, title, people_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `;

/** Parameters: job id, chat hash, msg id, sent_at, seq, message json. */
export const RCS_STAGING_PUT_MESSAGE_SQL = sql`
    INSERT OR REPLACE INTO rcs_cache_staging_messages (job_id, chat_hash, msg_id, sent_at, seq, message_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `;

/** Parameters: job id, chat hash, msg id. */
export const RCS_STAGING_HAS_MESSAGE_SQL = sql`
    SELECT 1 AS hit FROM rcs_cache_staging_messages WHERE job_id = ? AND chat_hash = ? AND msg_id = ?
  `;

/** Parameters: job id, chat hash, msg id, idx, mime type, byte size, sha256, temp path. */
export const RCS_STAGING_PUT_IMAGE_SQL = sql`
    INSERT OR REPLACE INTO rcs_cache_staging_images (job_id, chat_hash, msg_id, idx, mime_type, byte_size, sha256, temp_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `;

/** Parameters: job id. */
export const RCS_STAGING_IMAGE_BYTES_SQL = sql`
    SELECT COALESCE(SUM(byte_size), 0) AS bytes FROM rcs_cache_staging_images WHERE job_id = ?
  `;

/** Parameters: job id. Every staged message's key and time (no bodies): the commit's selection. */
export const RCS_STAGING_MESSAGE_KEYS_SQL = sql`
    SELECT chat_hash AS chatHash, msg_id AS msgId, sent_at AS sentAt FROM rcs_cache_staging_messages WHERE job_id = ?
  `;

/** Parameters: job id. */
export const RCS_STAGING_CHATS_SQL = sql`
    SELECT chat_hash AS chatHash, user_id AS userId, conversation_id AS conversationId, title, people_json AS peopleJson
    FROM rcs_cache_staging_chats WHERE job_id = ? ORDER BY staged_at, chat_hash
  `;

/** Parameters: job id, chat hash. In the order the page sent them. */
/**
 * Ordered by the message's own time, then its id (numeric ids: shorter first),
 * NOT by staging order: a retried chat is staged twice, so its seq values mix
 * (SR optional, 2026-10-02).
 */
export const RCS_STAGING_CHAT_MESSAGES_SQL = sql`
    SELECT msg_id AS msgId, message_json AS messageJson FROM rcs_cache_staging_messages
    WHERE job_id = ? AND chat_hash = ? ORDER BY sent_at, length(msg_id), msg_id
  `;

/** Parameters: job id. */
export const RCS_STAGING_IMAGES_SQL = sql`
    SELECT chat_hash AS chatHash, msg_id AS msgId, idx, mime_type AS mimeType, byte_size AS byteSize, sha256, temp_path AS tempPath
    FROM rcs_cache_staging_images WHERE job_id = ?
  `;

/** Parameters: job id. One statement per table (run together, in one transaction). */
export const RCS_STAGING_DELETE_JOB_SQL = [
  sql`DELETE FROM rcs_cache_staging_images WHERE job_id = ?`,
  sql`DELETE FROM rcs_cache_staging_messages WHERE job_id = ?`,
  sql`DELETE FROM rcs_cache_staging_chats WHERE job_id = ?`,
  sql`DELETE FROM rcs_cache_staging_chat_meta WHERE job_id = ?`,
  sql`DELETE FROM rcs_cache_staging_jobs WHERE job_id = ?`,
] as const;

/** 3671 P3. Parameters: job id, user id, started at, limits JSON, read JSON. */
export const RCS_STAGING_PUT_JOB_SQL = sql`
    INSERT OR REPLACE INTO rcs_cache_staging_jobs (job_id, user_id, started_at, limits_json, read_json)
    VALUES (?, ?, ?, ?, ?)
  `;

/** SR F2. Parameters: job id. A stop: the job's record goes first, synchronously. */
export const RCS_STAGING_DELETE_JOB_RECORD_SQL = sql`DELETE FROM rcs_cache_staging_jobs WHERE job_id = ?`;

/** 3671 P3. No parameters: every job's own record. */
export const RCS_STAGING_JOBS_SQL = sql`
    SELECT job_id AS jobId, user_id AS userId, started_at AS startedAt, limits_json AS limitsJson, read_json AS readJson
    FROM rcs_cache_staging_jobs
  `;

/**
 * 3671 P3. Parameters: job id, chat hash, chat floor ms, read floor ms,
 * reached (0/1), read at. A chat staged again (the retry pass) keeps
 * "reached" once it got there and takes the later read time.
 */
export const RCS_STAGING_PUT_CHAT_META_SQL = sql`
    INSERT INTO rcs_cache_staging_chat_meta (job_id, chat_hash, chat_floor_ms, read_floor_ms, reached_floor, read_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id, chat_hash) DO UPDATE SET
      chat_floor_ms = COALESCE(excluded.chat_floor_ms, rcs_cache_staging_chat_meta.chat_floor_ms),
      read_floor_ms = COALESCE(excluded.read_floor_ms, rcs_cache_staging_chat_meta.read_floor_ms),
      reached_floor = MAX(rcs_cache_staging_chat_meta.reached_floor, excluded.reached_floor),
      read_at = MAX(rcs_cache_staging_chat_meta.read_at, excluded.read_at)
  `;

/** 3671 P3. Parameters: job id. */
export const RCS_STAGING_CHAT_META_SQL = sql`
    SELECT chat_hash AS chatHash, chat_floor_ms AS chatFloorMs, read_floor_ms AS readFloorMs,
           reached_floor AS reachedFloor, read_at AS readAt
    FROM rcs_cache_staging_chat_meta WHERE job_id = ?
  `;

/** No parameters: every job id with staging rows or journaled files. */
export const RCS_STAGING_JOB_IDS_SQL = sql`
    SELECT job_id AS jobId FROM rcs_cache_staging_jobs
    UNION SELECT job_id FROM rcs_cache_staging_chat_meta
    UNION SELECT job_id FROM rcs_cache_staging_chats
    UNION SELECT job_id FROM rcs_cache_staging_messages
    UNION SELECT job_id FROM rcs_cache_staging_images
    UNION SELECT job_id FROM rcs_cache_placed_files
  `;

/** Parameters: path, job id. SR S2: journal a file before the commit moves it into place. */
export const RCS_PLACED_FILE_PUT_SQL = sql`
    INSERT OR REPLACE INTO rcs_cache_placed_files (path, job_id) VALUES (?, ?)
  `;

/** Parameters: job id. */
export const RCS_PLACED_FILE_CLEAR_JOB_SQL = sql`DELETE FROM rcs_cache_placed_files WHERE job_id = ?`;

/** No parameters. */
export const RCS_PLACED_FILE_ROWS_SQL = sql`SELECT job_id AS jobId, path FROM rcs_cache_placed_files`;

/** Parameters: path. */
export const RCS_PLACED_FILE_DELETE_SQL = sql`DELETE FROM rcs_cache_placed_files WHERE path = ?`;

/** No parameters: every job (stale rows when a new cache job starts, or at quit). */
export const RCS_STAGING_DELETE_ALL_SQL = [
  sql`DELETE FROM rcs_cache_staging_images`,
  sql`DELETE FROM rcs_cache_staging_messages`,
  sql`DELETE FROM rcs_cache_staging_chats`,
  sql`DELETE FROM rcs_cache_staging_chat_meta`,
  sql`DELETE FROM rcs_cache_staging_jobs`,
] as const;

/** 3671 P3 (SR): Force re-import drops the placed-files journal too. No parameters. */
export const RCS_PLACED_FILE_DELETE_ALL_SQL = sql`DELETE FROM rcs_cache_placed_files`;

// ============================================
// BACKLOG-3658 P3b: consent + cache options (rcs_consent), and the optional
// auto-delete of old chats linked to nothing.
// ============================================

/** Parameters: user id. */
export const RCS_CONSENT_GET_SQL = sql`
    SELECT consent_at AS consentAt, consent_version AS consentVersion,
           contacts_only AS contactsOnly, auto_delete_days AS autoDeleteDays
    FROM rcs_consent WHERE user_id = ?
  `;

/** Parameters: user id. */
export const RCS_CONSENT_ENSURE_SQL = sql`INSERT OR IGNORE INTO rcs_consent (user_id) VALUES (?)`;

/** Parameters: consent_at (NULL withdraws), version (NULL withdraws), user id. */
export const RCS_CONSENT_SET_SQL = sql`
    UPDATE rcs_consent SET consent_at = ?, consent_version = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?
  `;

/** Parameters: contacts_only (0/1), user id. */
export const RCS_CONSENT_SET_CONTACTS_ONLY_SQL = sql`
    UPDATE rcs_consent SET contacts_only = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?
  `;

/** Parameters: auto_delete_days (NULL = off), user id. */
export const RCS_CONSENT_SET_AUTO_DELETE_SQL = sql`
    UPDATE rcs_consent SET auto_delete_days = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?
  `;

/**
 * Parameters: user id (five times), cutoff ISO. The user's gmweb2 chats
 * (threads) linked to NOTHING — no thread-level link and no link on any of
 * its messages — whose LAST message is older than the cutoff. A chat the user
 * REMOVED from a transaction (a thread-level ignored_communications row) is
 * never auto-deleted: it must stay restorable from "Show removed" (SR S2).
 */
export const RCS_UNLINKED_OLD_THREADS_SQL = sql`
    SELECT m.thread_id AS threadId
    FROM messages m
    WHERE m.user_id = ? AND m.external_id LIKE 'gmweb2:%' AND m.thread_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM communications c
        WHERE c.user_id = ? AND c.message_id IS NULL AND c.thread_id = m.thread_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM communications c JOIN messages m2 ON m2.id = c.message_id
        WHERE c.user_id = ? AND m2.user_id = ? AND m2.thread_id = m.thread_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM ignored_communications ic
        WHERE ic.user_id = ? AND ic.thread_id = m.thread_id
      )
    GROUP BY m.thread_id
    HAVING MAX(m.sent_at) < ?
  `;

/** Parameters: user id, JSON array of thread ids. */
export const RCS_THREADS_ATTACHMENT_PATHS_SQL = sql`
    SELECT a.storage_path AS storagePath FROM attachments a
    WHERE a.message_id IN (
      SELECT m.id FROM messages m
      WHERE m.user_id = ? AND m.external_id LIKE 'gmweb2:%' AND m.thread_id IN (SELECT value FROM json_each(?))
    )
  `;

/** Parameters: user id, JSON array of thread ids. */
export const RCS_THREADS_DELETE_ATTACHMENTS_SQL = sql`
    DELETE FROM attachments
    WHERE message_id IN (
      SELECT m.id FROM messages m
      WHERE m.user_id = ? AND m.external_id LIKE 'gmweb2:%' AND m.thread_id IN (SELECT value FROM json_each(?))
    )
  `;

/** Parameters: user id, JSON array of thread ids. Texts and reactions. */
export const RCS_THREADS_DELETE_MESSAGES_SQL = sql`
    DELETE FROM messages
    WHERE user_id = ? AND external_id LIKE 'gmweb2:%' AND thread_id IN (SELECT value FROM json_each(?))
  `;

// ============================================
// BACKLOG-3658 P3c: per-chat exclusions ("Don't sync")
// ============================================

/** Parameters: user id. Conversation ids the page shows as switched off. */
export const RCS_EXCLUSIONS_CONV_IDS_SQL = sql`
    SELECT conversation_id AS conversationId FROM rcs_chat_exclusions
    WHERE user_id = ? AND conversation_id IS NOT NULL
    ORDER BY created_at DESC LIMIT ?
  `;

/** Parameters: id, user id, conversation id. */
export const RCS_EXCLUSION_ADD_SQL = sql`
    INSERT OR IGNORE INTO rcs_chat_exclusions (id, user_id, conversation_id) VALUES (?, ?, ?)
  `;

/**
 * Parameters: user id, conversation id, user id, conversation id. Switching a
 * chat back on removes its row AND every row with the same hash (the same
 * chat under an older conversation id).
 */
export const RCS_EXCLUSION_REMOVE_SQL = sql`
    DELETE FROM rcs_chat_exclusions
    WHERE user_id = ? AND (
      conversation_id = ?
      OR (chat_hash IS NOT NULL AND chat_hash IN (
        SELECT chat_hash FROM rcs_chat_exclusions WHERE user_id = ? AND conversation_id = ? AND chat_hash IS NOT NULL
      ))
    )
  `;

/** Parameters: user id, chat hash, user id, conversation id. Is this chat switched off? */
export const RCS_EXCLUSION_MATCH_SQL = sql`
    SELECT id, chat_hash AS chatHash, conversation_id AS conversationId FROM rcs_chat_exclusions
    WHERE (user_id = ? AND chat_hash = ?) OR (user_id = ? AND conversation_id = ?)
  `;

/** Parameters: chat hash, id. Record the chat's hash on a pending exclusion. */
export const RCS_EXCLUSION_SET_HASH_SQL = sql`UPDATE rcs_chat_exclusions SET chat_hash = ? WHERE id = ?`;

/** Parameters: id, user id, chat hash, conversation id. The same chat under a new conversation id. */
export const RCS_EXCLUSION_ADD_FULL_SQL = sql`
    INSERT OR IGNORE INTO rcs_chat_exclusions (id, user_id, chat_hash, conversation_id) VALUES (?, ?, ?, ?)
  `;

/** Parameters: user id. Every switched-off chat for Settings, with the stored title when Keepr has the chat. */
export const RCS_EXCLUSIONS_FOR_SETTINGS_SQL = sql`
    SELECT e.id AS id, e.chat_hash AS chatHash, e.created_at AS createdAt,
      (SELECT json_extract(m.metadata, '$.conversationTitle') FROM messages m
        WHERE m.user_id = e.user_id AND e.chat_hash IS NOT NULL AND m.thread_id = 'gmweb2-' || e.chat_hash
        ORDER BY m.sent_at DESC LIMIT 1) AS title
    FROM rcs_chat_exclusions e
    WHERE e.user_id = ?
    ORDER BY e.created_at DESC
  `;

/** Parameters: user id. The hashes of switched-off chats. */
export const RCS_EXCLUSION_HASHES_SQL = sql`
    SELECT DISTINCT chat_hash AS chatHash FROM rcs_chat_exclusions WHERE user_id = ? AND chat_hash IS NOT NULL
  `;

/**
 * BACKLOG-3658: does any of these E.164 numbers belong to a contact on one of
 * the user's LIVE transactions (the shared live-transaction predicate;
 * contact not removed from the transaction or deleted)? Parameters, via
 * withLiveTransactionParam: user id, JSON array of E.164 numbers, then the
 * predicate's own parameter.
 */
export const RCS_NUMBERS_MATCH_LIVE_CONTACT_SQL = sql`
    SELECT 1 AS hit
    FROM transaction_contacts tc
    JOIN transactions t ON t.id = tc.transaction_id
    JOIN contacts c ON c.id = tc.contact_id
    JOIN contact_phones cp ON cp.contact_id = tc.contact_id
    WHERE t.user_id = ?
      AND tc.removed_at IS NULL
      AND c.removed_at IS NULL
      AND cp.phone_e164 IN (SELECT value FROM json_each(?))
      AND ${LIVE_TRANSACTION_SQL_PREDICATE}
    LIMIT 1
  `;
