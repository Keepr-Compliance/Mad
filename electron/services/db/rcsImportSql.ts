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
 * BACKLOG-3642: participant keys (`metadata.participantKey`, written by Sync) of
 * gmweb rows the user removed from the transaction — by thread or by message.
 * Parameters: user id, transaction id, transaction id. Starts from the (small)
 * removal set with IN (...) subqueries, so SQLite looks rows up by thread id /
 * primary key instead of scanning every message. `json_valid` guards rows whose
 * metadata is not JSON.
 */
export const RCS_REMOVED_PARTICIPANT_KEYS_SQL = sql`
    SELECT DISTINCT
      CASE WHEN json_valid(m.metadata) THEN json_extract(m.metadata, '$.participantKey') END AS participantKey
    FROM messages m
    WHERE m.user_id = ?
      AND m.thread_id LIKE 'gmweb-chat-%'
      AND (
        m.thread_id IN (
          SELECT ic.thread_id FROM ignored_communications ic
          WHERE ic.transaction_id = ? AND ic.thread_id LIKE 'gmweb-chat-%'
        )
        OR m.id IN (
          SELECT ic.original_communication_id FROM ignored_communications ic
          WHERE ic.transaction_id = ? AND ic.original_communication_id IS NOT NULL
        )
      )
  `;

/**
 * BACKLOG-3642 (SR O1): backfill the participant key into a thread's existing
 * rows (stored before pass 1c, or by a manual Send), so they get re-pair
 * protection too. Parameters: key, user id, thread id, key.
 */
export const RCS_BACKFILL_PARTICIPANT_KEY_SQL = sql`
    UPDATE messages
    SET metadata = json_set(metadata, '$.participantKey', ?)
    WHERE user_id = ?
      AND thread_id = ?
      AND json_valid(metadata)
      AND COALESCE(json_extract(metadata, '$.participantKey'), '') != ?
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
      SELECT m.id FROM messages m WHERE m.user_id = ? AND m.external_id LIKE 'gmweb:%'
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
      AND m.external_id LIKE 'gmweb:%'
      AND c.transaction_id IS NOT NULL
      AND (m.associated_message_type IS NULL OR m.associated_message_type = 0)
    GROUP BY c.transaction_id
  `;

/** Parameters: transaction id, user id. */
export const RCS_CLEAR_GET_MESSAGE_COUNT_SQL = sql`
    SELECT message_count AS messageCount FROM transactions WHERE id = ? AND user_id = ?
  `;

/** Parameters: user id. */
export const RCS_CLEAR_DELETE_ATTACHMENTS_SQL = sql`
    DELETE FROM attachments
    WHERE message_id IN (
      SELECT m.id FROM messages m WHERE m.user_id = ? AND m.external_id LIKE 'gmweb:%'
    )
  `;

/** Parameters: user id, user id. Per-message links, then gmweb thread-level links. */
export const RCS_CLEAR_DELETE_MESSAGE_LINKS_SQL = sql`
    DELETE FROM communications
    WHERE user_id = ?
      AND message_id IN (
        SELECT m.id FROM messages m WHERE m.user_id = ? AND m.external_id LIKE 'gmweb:%'
      )
  `;

/** Parameters: user id. */
export const RCS_CLEAR_DELETE_THREAD_LINKS_SQL = sql`
    DELETE FROM communications
    WHERE user_id = ? AND message_id IS NULL AND thread_id LIKE 'gmweb-chat-%'
  `;

/** Parameters: user id. Text and reaction rows. */
export const RCS_CLEAR_DELETE_MESSAGES_SQL = sql`
    DELETE FROM messages WHERE user_id = ? AND external_id LIKE 'gmweb:%'
  `;

/** Parameters: message count, transaction id, user id. */
export const RCS_CLEAR_SET_MESSAGE_COUNT_SQL = sql`
    UPDATE transactions SET message_count = ? WHERE id = ? AND user_id = ?
  `;
