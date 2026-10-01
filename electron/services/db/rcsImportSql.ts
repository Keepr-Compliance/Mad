/**
 * SQL for the RCS import job — BACKLOG-3620.
 *
 * `TRANSACTION_CONTACT_PHONES_SQL` (`messageMatchingSql.ts`) INNER-joins
 * `contact_phones`, so a contact with no phone is missing from it and could not
 * be reported. This query LEFT-joins instead: one row per (contact, phone), and
 * one row with a NULL phone for a contact that has none.
 *
 * Contacts removed from the transaction (`tc.removed_at`) or deleted
 * (`c.removed_at`) are excluded.
 */

import { sql } from "./core/sqlText";
import { LIVE_TRANSACTION_SQL_PREDICATE } from "./core/transactionEligibilitySql";

/** One bound parameter: transaction id. */
export const RCS_IMPORT_TRANSACTION_CONTACTS_SQL = sql`
    SELECT
      c.id AS contactId,
      c.display_name AS displayName,
      cp.phone_e164 AS phoneE164
    FROM transaction_contacts tc
    JOIN contacts c ON c.id = tc.contact_id
    LEFT JOIN contact_phones cp ON cp.contact_id = c.id
    WHERE tc.transaction_id = ?
      AND tc.removed_at IS NULL
      AND c.removed_at IS NULL
    ORDER BY c.id
  `;

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
 * BACKLOG-3642: the user's removals from one transaction (one bound parameter:
 * transaction id). Thread ids and thread-less message ids; the caller keeps
 * gmweb threads only.
 */
export const RCS_REMOVALS_SQL = sql`
    SELECT ic.thread_id AS threadId, ic.original_communication_id AS messageId
    FROM ignored_communications ic
    WHERE ic.transaction_id = ?
  `;

/**
 * BACKLOG-3665: a legacy chat removal (thread `gmweb-chat-<conversation id>`)
 * moved onto the chat's gmweb2 thread, so "Show removed" (which joins the
 * removal's thread id to messages.thread_id) lists the chat and Restore works,
 * and the auto-link (which skips removed thread ids) never brings it back.
 *
 * Step 1 drops a legacy row whose transaction already has the gmweb2 removal
 * (the same removal twice would be listed twice). Step 2 moves the rest; the
 * audit fields (reason, ignored_at, match_reason, id) are untouched.
 * Parameters (both): user id, legacy thread id, transaction id or NULL (every
 * transaction of the user) twice, gmweb2 thread id — step 2 also takes the
 * legacy and gmweb2 ids first for email_thread_id (the row's mirror of
 * thread_id, see addIgnoredCommunicationSync).
 */
export const RCS_LEGACY_REMOVAL_DROP_DUPLICATE_SQL = sql`
    DELETE FROM ignored_communications
    WHERE user_id = ? AND thread_id = ? AND (? IS NULL OR transaction_id = ?)
      AND EXISTS (
        SELECT 1 FROM ignored_communications n
        WHERE n.transaction_id = ignored_communications.transaction_id AND n.thread_id = ?
      )
  `;

export const RCS_LEGACY_REMOVAL_REPOINT_SQL = sql`
    UPDATE ignored_communications
    SET email_thread_id = CASE WHEN email_thread_id = ? THEN ? ELSE email_thread_id END,
        thread_id = ?
    WHERE user_id = ? AND thread_id = ? AND (? IS NULL OR transaction_id = ?)
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
