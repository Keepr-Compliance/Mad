/**
 * Communication Database Service
 * Handles all communication-related database operations (emails, etc.)
 */

import crypto from "crypto";
import type {
  Communication,
  NewCommunication,
  CommunicationFilters,
  IgnoredCommunication,
  NewIgnoredCommunication,
} from "../../types";
import { DatabaseError } from "../../types";
import { dbGet, dbAll, dbRun } from "./core/dbConnection";
import { validateFields } from "../../utils/sqlFieldWhitelist";
import { isTextMessage } from "../../utils/channelHelpers";
import logService from "../logService";

/**
 * Create a new communication (junction table entry linking content to transaction)
 *
 * BACKLOG-506 Phase 5 (TASK-1307): Communications is now a PURE junction table.
 * - NO content columns (subject, body, sender, etc.)
 * - Content lives in: messages table (texts) or emails table (emails)
 * - Must set one of: message_id, email_id, or thread_id
 *
 * For email linking, the caller should:
 * 1. Create email in emails table via emailDbService.createEmail()
 * 2. Call this function with email_id set
 *
 * For text message linking, the caller should:
 * 1. Messages already exist in messages table (imported from device)
 * 2. Call this function with message_id or thread_id set
 */
export async function createCommunication(
  communicationData: NewCommunication,
): Promise<Communication> {
  const id = crypto.randomUUID();

  // BACKLOG-506: Pure junction table.
  // BACKLOG-2319: + match_reason (why the email is attached).
  const sql = `
    INSERT INTO communications (
      id, user_id, transaction_id, message_id, email_id, thread_id,
      link_source, link_confidence, match_reason, linked_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `;

  const params = [
    id,
    communicationData.user_id,
    communicationData.transaction_id || null,
    communicationData.message_id || null,
    communicationData.email_id || null,
    communicationData.thread_id || null,
    communicationData.link_source || null,
    communicationData.link_confidence || null,
    communicationData.match_reason || null,
    communicationData.linked_at || null,
  ];

  dbRun(sql, params);

  // BACKLOG-1107: Return data from memory instead of INSERT-then-SELECT.
  const communication = {
    id,
    user_id: communicationData.user_id,
    transaction_id: communicationData.transaction_id || null,
    message_id: communicationData.message_id || null,
    email_id: communicationData.email_id || null,
    thread_id: communicationData.thread_id || null,
    link_source: communicationData.link_source || null,
    link_confidence: communicationData.link_confidence || null,
    match_reason: communicationData.match_reason || null,
    linked_at: communicationData.linked_at || null,
    has_attachments: false,
    is_false_positive: false,
    created_at: new Date().toISOString(),
  } as unknown as Communication;

  // BACKLOG-396: Update thread count if this is a text message linked to a transaction
  // Check if linked message is a text type
  if (communicationData.transaction_id && communicationData.message_id) {
    const message = dbGet<{ channel: string | null }>(
      "SELECT channel FROM messages WHERE id = ?",
      [communicationData.message_id]
    );
    if (message?.channel && isTextMessage({ channel: message.channel })) {
      updateTransactionThreadCount(communicationData.transaction_id);
    }
  }
  // Thread-based linking is always for text messages
  if (communicationData.transaction_id && communicationData.thread_id) {
    updateTransactionThreadCount(communicationData.transaction_id);
  }

  return communication;
}

/**
 * Get communication by ID
 */
export async function getCommunicationById(
  communicationId: string,
): Promise<Communication | null> {
  // BACKLOG-1107: Explicit column list instead of SELECT *
  // BACKLOG-2319: include match_reason so unlink can carry it onto the ignored row.
  const sql = `SELECT id, user_id, transaction_id, message_id, email_id, thread_id,
    link_source, link_confidence, match_reason, linked_at, created_at
    FROM communications WHERE id = ?`;
  const communication = dbGet<Communication>(sql, [communicationId]);
  return communication || null;
}

/**
 * Get communications with filters
 *
 * BACKLOG-506 Phase 5 (TASK-1307): Communications is now a pure junction table.
 * Filters like communication_type, sent_at, has_attachments are no longer supported
 * since those columns don't exist. Use getCommunicationsWithMessages() instead for
 * queries that need content/metadata filtering.
 */
export async function getCommunications(
  filters?: CommunicationFilters,
): Promise<Communication[]> {
  // BACKLOG-1107: Explicit column list
  let sql = "SELECT id, user_id, transaction_id, message_id, email_id, thread_id, link_source, link_confidence, linked_at, created_at FROM communications WHERE 1=1";
  const params: unknown[] = [];

  if (filters?.user_id) {
    sql += " AND user_id = ?";
    params.push(filters.user_id);
  }

  if (filters?.transaction_id) {
    sql += " AND transaction_id = ?";
    params.push(filters.transaction_id);
  }

  // BACKLOG-506: communication_type, sent_at, has_attachments filters are no longer
  // supported since those columns don't exist in the pure junction table.
  // These filters are intentionally ignored - use getCommunicationsWithMessages()
  // if you need to filter by content/metadata.

  sql += " ORDER BY created_at DESC";

  return dbAll<Communication>(sql, params);
}

/**
 * Get communications for a transaction (junction records only)
 *
 * BACKLOG-506 Phase 5 (TASK-1307): Returns raw junction records.
 * For communications with content, use getCommunicationsWithMessages() instead.
 */
export async function getCommunicationsByTransaction(
  transactionId: string,
): Promise<Communication[]> {
  // BACKLOG-1107: Explicit column list
  const sql = `
    SELECT id, user_id, transaction_id, message_id, email_id, thread_id,
           link_source, link_confidence, linked_at, created_at
    FROM communications
    WHERE transaction_id = ?
    ORDER BY created_at DESC
  `;
  return dbAll<Communication>(sql, [transactionId]);
}

/**
 * Update communication
 *
 * BACKLOG-506 Phase 5 (TASK-1307): Only junction table fields are allowed.
 * Content fields (subject, body, sender, etc.) no longer exist in this table.
 */
export async function updateCommunication(
  communicationId: string,
  updates: Partial<Communication>,
): Promise<void> {
  // BACKLOG-506: Pure junction table - only these fields exist
  const allowedFields = [
    "transaction_id",
    "message_id",
    "email_id",
    "thread_id",
    "link_source",
    "link_confidence",
    "match_reason",
    "linked_at",
  ];

  const fields: string[] = [];
  const values: unknown[] = [];

  Object.keys(updates).forEach((key) => {
    if (allowedFields.includes(key)) {
      const value = (updates as Record<string, unknown>)[key];
      fields.push(`${key} = ?`);
      values.push(value);
    }
  });

  if (fields.length === 0) {
    throw new DatabaseError("No valid fields to update");
  }

  // Validate fields against whitelist before SQL construction
  validateFields("communications", fields);

  values.push(communicationId);

  const sql = `UPDATE communications SET ${fields.join(", ")} WHERE id = ?`;
  dbRun(sql, values);
}

/**
 * BACKLOG-2319: Confirm a set of "Needs review" email links.
 *
 * Promotes every communications row for these emails on this transaction to
 * match_reason='user_confirmed', which moves them out of the Needs-review
 * section and into Linked. Thread-aware: the caller passes every email id in
 * the confirmed conversation. Idempotent — re-confirming is a harmless no-op.
 *
 * @returns the number of link rows updated
 */
export function confirmEmailLinksByEmailIds(
  emailIds: string[],
  transactionId: string,
): number {
  const ids = emailIds.filter((id): id is string => typeof id === "string" && id.length > 0);
  if (ids.length === 0) return 0;

  const placeholders = ids.map(() => "?").join(", ");
  const sql = `
    UPDATE communications
       SET match_reason = 'user_confirmed'
     WHERE transaction_id = ?
       AND email_id IN (${placeholders})
  `;
  return dbRun(sql, [transactionId, ...ids]).changes ?? 0;
}

/**
 * Delete communication
 */
export async function deleteCommunication(communicationId: string): Promise<void> {
  // BACKLOG-506 (TASK-1307): Get the transaction ID and message_id before deleting.
  // We need to check if the linked message is a text type to update thread count.
  const comm = dbGet<{ transaction_id: string | null; message_id: string | null; thread_id: string | null }>(
    "SELECT transaction_id, message_id, thread_id FROM communications WHERE id = ?",
    [communicationId]
  );

  const sql = "DELETE FROM communications WHERE id = ?";
  dbRun(sql, [communicationId]);

  // BACKLOG-396: Update thread count if this was a text message linked to a transaction
  if (comm?.transaction_id) {
    // Thread-based link is always for text messages
    if (comm.thread_id) {
      updateTransactionThreadCount(comm.transaction_id);
    }
    // Message-based link - check if the message is a text type
    else if (comm.message_id) {
      const message = dbGet<{ channel: string | null }>(
        "SELECT channel FROM messages WHERE id = ?",
        [comm.message_id]
      );
      if (message?.channel && isTextMessage({ channel: message.channel })) {
        updateTransactionThreadCount(comm.transaction_id);
      }
    }
  }
}

/**
 * Delete communication by message_id
 * Used when unlinking messages from a transaction - removes the communications table reference
 */
export async function deleteCommunicationByMessageId(messageId: string): Promise<void> {
  // BACKLOG-506 (TASK-1307): Get the transaction ID before deleting.
  // Check if the message is a text type to update thread count.
  const comm = dbGet<{ transaction_id: string | null }>(
    "SELECT transaction_id FROM communications WHERE message_id = ?",
    [messageId]
  );

  const sql = "DELETE FROM communications WHERE message_id = ?";
  dbRun(sql, [messageId]);

  // BACKLOG-396: Update thread count if this was a text message linked to a transaction
  if (comm?.transaction_id) {
    const message = dbGet<{ channel: string | null }>(
      "SELECT channel FROM messages WHERE id = ?",
      [messageId]
    );
    if (message?.channel && isTextMessage({ channel: message.channel })) {
      updateTransactionThreadCount(comm.transaction_id);
    }
  }
}

/**
 * Link communication to transaction
 */
export async function linkCommunicationToTransaction(
  communicationId: string,
  transactionId: string,
): Promise<void> {
  const sql = "UPDATE communications SET transaction_id = ? WHERE id = ?";
  dbRun(sql, [transactionId, communicationId]);
}

// ============================================
// IGNORED COMMUNICATION OPERATIONS
// ============================================

/**
 * Add a communication to the ignored list for a transaction
 * This prevents the email from being re-added during future scans
 */
export async function addIgnoredCommunication(
  data: NewIgnoredCommunication,
): Promise<IgnoredCommunication> {
  const id = crypto.randomUUID();

  // BACKLOG-1560: Include email_id and thread_id columns for direct suppression
  // BACKLOG-2319: + match_reason, preserved so restore reclassifies correctly.
  const sql = `
    INSERT INTO ignored_communications (
      id, user_id, transaction_id, email_subject, email_sender,
      email_sent_at, email_thread_id, email_id, thread_id,
      original_communication_id, reason, match_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const params = [
    id,
    data.user_id,
    data.transaction_id,
    data.email_subject || null,
    data.email_sender || null,
    data.email_sent_at || null,
    data.thread_id || null,
    data.email_id || null,
    data.thread_id || null,
    data.original_communication_id || null,
    data.reason || null,
    data.match_reason || null,
  ];

  dbRun(sql, params);

  logService.debug("[BACKLOG-1560] addIgnoredCommunication SUCCESS", "CommunicationDbService", {
    id, transaction_id: data.transaction_id, thread_id: data.thread_id ?? 'NULL'
  });

  // BACKLOG-1107: Return data from memory instead of INSERT-then-SELECT.
  const ignoredComm: IgnoredCommunication = {
    id,
    user_id: data.user_id,
    transaction_id: data.transaction_id,
    email_subject: data.email_subject || null,
    email_sender: data.email_sender || null,
    email_sent_at: data.email_sent_at || null,
    email_id: data.email_id || null,
    thread_id: data.thread_id || null,
    original_communication_id: data.original_communication_id || null,
    reason: data.reason || null,
    match_reason: data.match_reason || null,
    ignored_at: new Date().toISOString(),
  } as IgnoredCommunication;

  return ignoredComm;
}

/**
 * Get all ignored communications for a transaction
 */
export async function getIgnoredCommunicationsByTransaction(
  transactionId: string,
): Promise<IgnoredCommunication[]> {
  const sql = `
    SELECT * FROM ignored_communications
    WHERE transaction_id = ?
    ORDER BY ignored_at DESC
  `;
  return dbAll<IgnoredCommunication>(sql, [transactionId]);
}

/**
 * Get all ignored communications for a user
 */
export async function getIgnoredCommunicationsByUser(
  userId: string,
): Promise<IgnoredCommunication[]> {
  const sql = `
    SELECT * FROM ignored_communications
    WHERE user_id = ?
    ORDER BY ignored_at DESC
  `;
  return dbAll<IgnoredCommunication>(sql, [userId]);
}

/**
 * Check if a communication is ignored for a transaction
 * Uses email sender, subject, and sent_at to identify the email
 */
export async function isEmailIgnoredForTransaction(
  transactionId: string,
  emailSender: string,
  emailSubject: string,
  emailSentAt: string,
): Promise<boolean> {
  const sql = `
    SELECT id FROM ignored_communications
    WHERE transaction_id = ?
      AND email_sender = ?
      AND email_subject = ?
      AND email_sent_at = ?
    LIMIT 1
  `;
  const result = dbGet(sql, [
    transactionId,
    emailSender,
    emailSubject,
    emailSentAt,
  ]);
  return !!result;
}

/**
 * Check if a communication is ignored for any transaction of a user
 * Used during email scanning to filter out previously ignored emails
 */
export async function isEmailIgnoredByUser(
  userId: string,
  emailSender: string,
  emailSubject: string,
  emailSentAt: string,
): Promise<boolean> {
  const sql = `
    SELECT id FROM ignored_communications
    WHERE user_id = ?
      AND email_sender = ?
      AND email_subject = ?
      AND email_sent_at = ?
    LIMIT 1
  `;
  const result = dbGet(sql, [userId, emailSender, emailSubject, emailSentAt]);
  return !!result;
}

/**
 * Remove an ignored communication (re-allow it to be linked)
 */
export async function removeIgnoredCommunication(ignoredCommId: string): Promise<void> {
  const sql = "DELETE FROM ignored_communications WHERE id = ?";
  dbRun(sql, [ignoredCommId]);
}

/**
 * BACKLOG-1560: Get set of email IDs that are ignored for a specific transaction.
 * Used by auto-link to skip previously unlinked emails.
 */
export function getIgnoredEmailIdsForTransaction(
  transactionId: string,
): Set<string> {
  const sql = `
    SELECT email_id FROM ignored_communications
    WHERE transaction_id = ? AND email_id IS NOT NULL
  `;
  const rows = dbAll<{ email_id: string }>(sql, [transactionId]);
  return new Set(rows.map((r) => r.email_id));
}

/**
 * BACKLOG-1560: Get set of thread IDs that are ignored for a specific transaction.
 * Used by auto-link to skip previously unlinked message threads.
 */
export function getIgnoredThreadIdsForTransaction(
  transactionId: string,
): Set<string> {
  const sql = `
    SELECT thread_id FROM ignored_communications
    WHERE transaction_id = ? AND thread_id IS NOT NULL
  `;
  const rows = dbAll<{ thread_id: string }>(sql, [transactionId]);
  const result = new Set(rows.map((r) => r.thread_id));

  logService.debug("[BACKLOG-1560] getIgnoredThreadIds", "CommunicationDbService", {
    transactionId, count: result.size, ids: Array.from(result)
  });

  return result;
}

/**
 * BACKLOG-1560: Get set of original_communication_ids (message IDs) that are ignored
 * for a specific transaction. Used for per-message suppression when messages have
 * no valid thread_id (null or empty string).
 */
export function getIgnoredCommunicationIdsForTransaction(
  transactionId: string,
): Set<string> {
  const sql = `
    SELECT original_communication_id FROM ignored_communications
    WHERE transaction_id = ? AND original_communication_id IS NOT NULL
  `;
  const rows = dbAll<{ original_communication_id: string }>(sql, [transactionId]);
  return new Set(rows.map((r) => r.original_communication_id));
}

// ============================================
// EXTRACTED DATA OPERATIONS
// ============================================

/**
 * Save extracted transaction data (audit trail)
 */
export async function saveExtractedData(
  transactionId: string,
  fieldName: string,
  fieldValue: string,
  sourceCommId?: string,
  confidence?: number,
): Promise<string> {
  const id = crypto.randomUUID();

  const sql = `
    INSERT INTO extracted_transaction_data (
      id, transaction_id, field_name, field_value,
      source_communication_id, extraction_method, confidence_score
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `;

  dbRun(sql, [
    id,
    transactionId,
    fieldName,
    fieldValue,
    sourceCommId || null,
    "pattern_matching",
    confidence || null,
  ]);

  return id;
}

// ============================================
// TASK-975: JUNCTION TABLE OPERATIONS
// ============================================

/**
 * Data required to create a communication reference (junction table pattern)
 */
export interface CreateCommunicationReferenceData {
  user_id: string;
  message_id: string;
  transaction_id: string;
  link_source?: 'auto' | 'manual' | 'scan';
  link_confidence?: number;
}

/**
 * Create a communication reference linking a message to a transaction.
 *
 * TASK-975: This is the new junction table pattern.
 * - message_id references the messages table (where content lives)
 * - transaction_id references the transactions table
 * - No content duplication - content stays in messages table
 *
 * @param data - The reference data
 * @returns The created communication reference
 */
export async function createCommunicationReference(
  data: CreateCommunicationReferenceData,
): Promise<Communication> {
  const id = crypto.randomUUID();

  const sql = `
    INSERT INTO communications (
      id, user_id, message_id, transaction_id,
      link_source, link_confidence, linked_at
    ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `;

  const params = [
    id,
    data.user_id,
    data.message_id,
    data.transaction_id,
    data.link_source || 'auto',
    data.link_confidence || null,
  ];

  dbRun(sql, params);

  // BACKLOG-1107: Return data from memory instead of INSERT-then-SELECT.
  const communication = {
    id,
    user_id: data.user_id,
    transaction_id: data.transaction_id,
    message_id: data.message_id,
    email_id: null,
    thread_id: null,
    link_source: data.link_source || 'auto',
    link_confidence: data.link_confidence || null,
    linked_at: new Date().toISOString(),
    has_attachments: false,
    is_false_positive: false,
    created_at: new Date().toISOString(),
  } as unknown as Communication;

  // BACKLOG-396: Check if the linked message is a text and update thread count
  const message = dbGet<{ channel: string | null }>(
    "SELECT channel FROM messages WHERE id = ?",
    [data.message_id]
  );
  if (message?.channel && isTextMessage({ channel: message.channel })) {
    updateTransactionThreadCount(data.transaction_id);
  }

  return communication;
}

/**
 * Get communications for a transaction, joining to messages table for content.
 *
 * TASK-975: This retrieves communications with full message content from the
 * messages table when message_id is set. Falls back to legacy content columns
 * for records without message_id.
 *
 * TASK-992: Added direction field from messages table for proper bubble display.
 *
 * TASK-1116: Updated to support thread-based linking. For records with thread_id
 * but no message_id, returns all messages in the thread.
 *
 * @param transactionId - The transaction ID
 * @returns Communications with content from messages table when available
 */
export async function getCommunicationsWithMessages(
  transactionId: string,
  channelFilter?: "email" | "text",
  limit?: number,
): Promise<Communication[]> {
  // BACKLOG-506: Three-way join - messages for texts, emails for emails
  // Query handles:
  //   1. Records with message_id (per-message text linking)
  //   2. Records with thread_id (per-thread text linking)
  //   3. Records with email_id (email linking - NEW)
  //
  // NOTE: The return type Communication is aliased to Message for backward compatibility.
  // The SELECT populates Message fields from JOINs to messages/emails tables.
  const sql = `
    SELECT
      -- Use content table ID when available, fall back to communication ID
      COALESCE(m.id, e.id, c.id) as id,
      c.id as communication_id,
      c.user_id,
      c.transaction_id,
      -- HOTFIX: For thread-linked messages, c.message_id is NULL but m.id has the actual message ID
      -- This is needed for attachment lookup which uses message_id
      COALESCE(c.message_id, m.id) as message_id,
      c.email_id,
      c.link_source,
      c.link_confidence,
      -- BACKLOG-2319: why the email is attached (drives the "Needs review" split)
      c.match_reason,
      c.linked_at,
      c.created_at,
      -- Type: prefer message channel, then 'email' if email_id set
      CASE
        WHEN m.id IS NOT NULL THEN m.channel
        WHEN e.id IS NOT NULL THEN 'email'
        ELSE 'unknown'
      END as channel,
      CASE
        WHEN m.id IS NOT NULL THEN m.channel
        WHEN e.id IS NOT NULL THEN 'email'
        ELSE 'unknown'
      END as communication_type,
      -- Content from messages or emails table (NO legacy column fallback)
      COALESCE(m.body_text, e.body_plain) as body_text,
      COALESCE(m.body_text, e.body_plain) as body_plain,
      COALESCE(m.body_html, e.body_html) as body,
      COALESCE(m.subject, e.subject) as subject,
      COALESCE(json_extract(m.participants, '$.from'), e.sender) as sender,
      COALESCE(
        (SELECT group_concat(value) FROM json_each(json_extract(m.participants, '$.to'))),
        e.recipients
      ) as recipients,
      COALESCE(m.sent_at, e.sent_at) as sent_at,
      COALESCE(m.received_at, e.received_at) as received_at,
      COALESCE(m.has_attachments, e.has_attachments) as has_attachments,
      -- Thread ID for grouping messages into conversations
      COALESCE(m.thread_id, e.thread_id) as thread_id,
      -- Participants JSON for group chat detection and sender identification
      m.participants as participants,
      -- Direction from messages table for bubble display
      COALESCE(m.direction, e.direction) as direction,
      -- External ID for attachment lookup fallback
      COALESCE(m.external_id, e.external_id) as external_id,
      -- Email-specific fields from emails table only
      e.source as source,
      e.cc as cc,
      e.bcc as bcc,
      e.attachment_count as attachment_count
      -- BACKLOG-506 (TASK-1307): Legacy metadata columns removed from communications table.
      -- Analysis fields (keywords, relevance, etc.) are now stored on messages/emails if needed.
    FROM communications c
    LEFT JOIN messages m ON (
      -- Per-message linking
      (c.message_id IS NOT NULL AND c.message_id = m.id)
      OR
      -- Thread-based linking
      (c.message_id IS NULL AND c.email_id IS NULL AND c.thread_id IS NOT NULL AND c.thread_id = m.thread_id)
    )
    LEFT JOIN emails e ON (
      -- BACKLOG-506: Email linking - join only when email_id is set and matches
      c.email_id IS NOT NULL AND c.email_id = e.id
    )
    WHERE c.transaction_id = ?
    ${channelFilter === "email" ? "AND c.email_id IS NOT NULL" : ""}
    ${channelFilter === "text" ? "AND c.email_id IS NULL" : ""}
    ORDER BY COALESCE(m.sent_at, e.sent_at) DESC
    ${limit ? `LIMIT ${Number(limit)}` : ""}
  `;

  const results = dbAll<Communication>(sql, [transactionId]);

  // Deduplicate by message ID first
  const seenIds = new Set<string>();
  const dedupedById = results.filter(r => {
    if (seenIds.has(r.id)) return false;
    seenIds.add(r.id);
    return true;
  });

  // Content-based deduplication for text messages
  // Catches cases where same content exists with different IDs
  const seenContent = new Set<string>();
  const deduped = dedupedById.filter(r => {
    const channel = (r as { channel?: string }).channel;
    const commType = (r as { communication_type?: string }).communication_type;
    const isTextMessage = channel === 'sms' || channel === 'imessage' ||
                          commType === 'sms' || commType === 'imessage';

    if (!isTextMessage) return true;

    const bodyText = (r as { body_text?: string }).body_text || '';
    const sentAt = (r as { sent_at?: string }).sent_at || '';
    const contentKey = `${bodyText}|${sentAt}`;

    if (seenContent.has(contentKey)) return false;
    seenContent.add(contentKey);
    return true;
  });

  return deduped;
}

/**
 * Check if a message is already linked to a transaction
 *
 * @param messageId - The message ID
 * @param transactionId - The transaction ID
 * @returns True if the link exists
 */
export async function isMessageLinkedToTransaction(
  messageId: string,
  transactionId: string,
): Promise<boolean> {
  const sql = `
    SELECT id FROM communications
    WHERE message_id = ? AND transaction_id = ?
    LIMIT 1
  `;
  const result = dbGet(sql, [messageId, transactionId]);
  return !!result;
}

/**
 * Get all transactions a message is linked to
 *
 * @param messageId - The message ID
 * @returns Array of transaction IDs
 */
export async function getTransactionsForMessage(
  messageId: string,
): Promise<string[]> {
  const sql = `
    SELECT transaction_id FROM communications
    WHERE message_id = ?
  `;
  const results = dbAll<{ transaction_id: string }>(sql, [messageId]);
  return results.map(r => r.transaction_id);
}

// ============================================
// TASK-1115: THREAD-LEVEL LINKING OPERATIONS
// ============================================

/**
 * Create a thread-level communication link (one record per thread per transaction).
 *
 * TASK-1115: This replaces message-by-message linking for thread-based communications.
 * Instead of creating one communication record per message, we create one per thread.
 * The messages table retains individual messages; this is just the linking junction.
 *
 * @param threadId - The thread identifier (from messages.thread_id)
 * @param transactionId - The transaction to link to
 * @param userId - The user ID
 * @param linkSource - How the link was created ('auto', 'manual', 'scan')
 * @param linkConfidence - Confidence score (0.0 - 1.0)
 * @returns The created communication ID
 */
export async function createThreadCommunicationReference(
  threadId: string,
  transactionId: string,
  userId: string,
  linkSource: 'auto' | 'manual' | 'scan' = 'auto',
  linkConfidence: number = 0.9,
): Promise<string> {
  const id = crypto.randomUUID();

  // BACKLOG-506 (TASK-1307): Pure junction table - no communication_type column.
  // The type is determined by JOINing to messages table (for thread_id-based links).
  const sql = `
    INSERT INTO communications (
      id, user_id, thread_id, transaction_id,
      link_source, link_confidence, linked_at
    ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `;

  const params = [
    id,
    userId,
    threadId,
    transactionId,
    linkSource,
    linkConfidence,
  ];

  dbRun(sql, params);

  // BACKLOG-396: Thread-based linking is always for text messages, update count
  updateTransactionThreadCount(transactionId);

  return id;
}

/**
 * Delete communication records by thread_id for a specific transaction.
 *
 * TASK-1115: Used when unlinking a thread from a transaction.
 * Removes the junction record so the thread is no longer associated.
 *
 * @param threadId - The thread identifier
 * @param transactionId - The transaction to unlink from
 */
export async function deleteCommunicationByThread(
  threadId: string,
  transactionId: string,
): Promise<void> {
  const sql = `
    DELETE FROM communications
    WHERE thread_id = ? AND transaction_id = ?
  `;
  dbRun(sql, [threadId, transactionId]);

  // BACKLOG-396: Thread-based unlinking is always for text messages, update count
  updateTransactionThreadCount(transactionId);
}

/**
 * Check if a thread is already linked to a transaction.
 *
 * TASK-1115: Used to avoid duplicate links when auto-linking.
 *
 * @param threadId - The thread identifier
 * @param transactionId - The transaction ID
 * @returns True if the thread is already linked to this transaction
 */
export async function isThreadLinkedToTransaction(
  threadId: string,
  transactionId: string,
): Promise<boolean> {
  const sql = `
    SELECT id FROM communications
    WHERE thread_id = ? AND transaction_id = ?
    LIMIT 1
  `;
  const result = dbGet(sql, [threadId, transactionId]);
  return !!result;
}

// ============================================
// BACKLOG-396: THREAD COUNT MANAGEMENT
// ============================================

/**
 * Normalize a participant identifier for consistent grouping.
 * Matches frontend logic in MessageThreadCard.tsx.
 */
function normalizeParticipant(participant: string): string {
  if (!participant) return '';

  // If it looks like a phone number, normalize to digits only
  const digits = participant.replace(/\D/g, '');
  if (digits.length >= 10) {
    // Use last 10 digits to normalize +1 prefix variations
    return digits.slice(-10);
  }

  // Otherwise return lowercase trimmed version
  return participant.toLowerCase().trim();
}

/**
 * Generate a key for grouping messages into threads.
 * Matches frontend logic in MessageThreadCard.tsx getThreadKey().
 */
function getThreadKey(msg: { thread_id?: string | null; participants?: string | null; id: string }): string {
  // FIRST: Use thread_id if available - this is the actual iMessage chat ID
  if (msg.thread_id) {
    return msg.thread_id;
  }

  // FALLBACK: Compute from participants if no thread_id
  try {
    if (msg.participants) {
      const parsed = typeof msg.participants === 'string'
        ? JSON.parse(msg.participants)
        : msg.participants;

      // Collect all participants
      const allParticipants = new Set<string>();

      if (parsed.from) {
        allParticipants.add(normalizeParticipant(parsed.from));
      }
      if (parsed.to) {
        const toList = Array.isArray(parsed.to) ? parsed.to : [parsed.to];
        toList.forEach((p: string) => allParticipants.add(normalizeParticipant(p)));
      }

      // Remove "me" - we only care about external participants for grouping
      allParticipants.delete('me');

      // Sort and join to create a consistent key
      if (allParticipants.size > 0) {
        return `participants-${Array.from(allParticipants).sort().join('|')}`;
      }
    }
  } catch {
    // Fall through to default
  }

  // Last resort: use message id (each message is its own "thread")
  return `msg-${msg.id}`;
}

/**
 * Count unique threads for text communications linked to a transaction.
 * Uses the same logic as frontend's groupMessagesByThread().
 *
 * BACKLOG-396: This is the source of truth for text thread counts.
 * BACKLOG-506 (TASK-1307): Updated for pure junction table (no communication_type column).
 */
export function countTextThreadsForTransaction(transactionId: string): number {
  // Get all text communications linked to this transaction
  // BACKLOG-506: Since communications is now a pure junction table, we ONLY check
  // m.channel from the messages table. Thread-based links (c.thread_id) are always
  // for text messages by design.
  const sql = `
    SELECT
      COALESCE(m.id, c.id) as id,
      m.thread_id as thread_id,
      m.participants as participants
    FROM communications c
    LEFT JOIN messages m ON (
      (c.message_id IS NOT NULL AND c.message_id = m.id)
      OR
      (c.message_id IS NULL AND c.thread_id IS NOT NULL AND c.thread_id = m.thread_id)
    )
    WHERE c.transaction_id = ?
      AND (m.channel IN ('text', 'sms', 'imessage') OR (m.id IS NULL AND c.thread_id IS NOT NULL))
  `;

  const messages = dbAll<{ id: string; thread_id: string | null; participants: string | null }>(
    sql,
    [transactionId]
  );

  // Group messages by thread using the same logic as frontend
  const threads = new Set<string>();
  for (const msg of messages) {
    const threadKey = getThreadKey(msg);
    threads.add(threadKey);
  }

  return threads.size;
}

/**
 * Update the text_thread_count on a transaction.
 * Call this after linking/unlinking messages to keep the count in sync.
 *
 * BACKLOG-396: Ensures TransactionCard displays the correct thread count.
 */
export function updateTransactionThreadCount(transactionId: string): void {
  const threadCount = countTextThreadsForTransaction(transactionId);

  const sql = `UPDATE transactions SET text_thread_count = ? WHERE id = ?`;
  dbRun(sql, [threadCount, transactionId]);
}

/**
 * Backfill text_thread_count for all transactions.
 * Run this once to populate existing data.
 *
 * BACKLOG-396: Migration helper for existing transactions.
 */
export function backfillAllTransactionThreadCounts(): { updated: number; errors: number } {
  // BACKLOG-1095: Single GROUP BY query replaces N+1 per-transaction queries.
  const threadCountsSql = `
    SELECT c.transaction_id, COUNT(DISTINCT COALESCE(m.thread_id, m.id)) as thread_count
    FROM communications c
    LEFT JOIN messages m ON (
      (c.message_id IS NOT NULL AND c.message_id = m.id)
      OR
      (c.message_id IS NULL AND c.thread_id IS NOT NULL AND c.thread_id = m.thread_id)
    )
    WHERE c.transaction_id IS NOT NULL
      AND (m.channel IN ('text', 'sms', 'imessage') OR (m.id IS NULL AND c.thread_id IS NOT NULL))
    GROUP BY c.transaction_id
  `;

  const threadCounts = dbAll<{ transaction_id: string; thread_count: number }>(threadCountsSql);

  const countMap = new Map<string, number>();
  for (const row of threadCounts) {
    countMap.set(row.transaction_id, row.thread_count);
  }

  const transactions = dbAll<{ id: string }>(`SELECT id FROM transactions`);

  let updated = 0;
  let errors = 0;

  for (const tx of transactions) {
    try {
      const count = countMap.get(tx.id) || 0;
      dbRun(`UPDATE transactions SET text_thread_count = ? WHERE id = ?`, [count, tx.id]);
      updated++;
    } catch {
      errors++;
    }
  }

  return { updated, errors };
}
