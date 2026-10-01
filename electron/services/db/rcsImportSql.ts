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
 * Parameters: transaction id, user id. `json_valid` guards rows whose metadata
 * is not JSON (only gmweb rows are read, but the guard keeps the query safe).
 */
export const RCS_REMOVED_PARTICIPANT_KEYS_SQL = sql`
    SELECT DISTINCT
      CASE WHEN json_valid(m.metadata) THEN json_extract(m.metadata, '$.participantKey') END AS participantKey
    FROM messages m
    JOIN ignored_communications ic
      ON ic.transaction_id = ?
     AND (ic.thread_id = m.thread_id OR ic.original_communication_id = m.id)
    WHERE m.user_id = ?
      AND m.thread_id LIKE 'gmweb-chat-%'
  `;
