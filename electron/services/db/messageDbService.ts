/**
 * Message Database Service
 * Handles all message-related database operations (SMS/iMessage/email messages)
 */

import type { Message, Communication } from "../../types";
import { ensureDb } from "./core/dbConnection";
import logService from "../logService";
import { normalizePhoneLookupKey } from "../../utils/phoneLookupKey";

// ============================================
// LLM ANALYSIS OPERATIONS
// ============================================

/**
 * Get messages that need LLM analysis (not yet classified)
 */
export function getMessagesForLLMAnalysis(userId: string, limit = 100): Message[] {
  const db = ensureDb();
  const sql = `
    SELECT * FROM messages
    WHERE user_id = ?
      AND is_transaction_related IS NULL
      AND duplicate_of IS NULL
    ORDER BY received_at DESC
    LIMIT ?
  `;
  return db.prepare(sql).all(userId, limit) as Message[];
}

/**
 * Get count of messages pending LLM analysis
 */
export function getPendingLLMAnalysisCount(userId: string): number {
  const db = ensureDb();
  const sql = `
    SELECT COUNT(*) as count FROM messages
    WHERE user_id = ?
      AND is_transaction_related IS NULL
      AND duplicate_of IS NULL
  `;
  const result = db.prepare(sql).get(userId) as { count: number } | undefined;
  return result?.count ?? 0;
}

// ============================================
// UNLINKED MESSAGE OPERATIONS
// ============================================

/**
 * Get unlinked text messages (SMS/iMessage) from the messages table
 * These are messages not yet attached to any transaction
 * Limited to 1000 most recent messages to prevent UI freeze
 */
export function getUnlinkedTextMessages(userId: string, limit = 1000): Message[] {
  const db = ensureDb();
  const sql = `
    SELECT * FROM messages
    WHERE user_id = ?
      AND transaction_id IS NULL
      AND channel IN ('sms', 'imessage')
    ORDER BY sent_at DESC
    LIMIT ?
  `;
  return db.prepare(sql).all(userId, limit) as Message[];
}

/**
 * Get unlinked emails - emails not attached to any transaction
 * BACKLOG-506: Now queries emails table directly since communications is a junction table
 */
export function getUnlinkedEmails(userId: string, limit = 500): Communication[] {
  const db = ensureDb();
  const sql = `
    SELECT
      e.id,
      e.user_id,
      NULL as transaction_id,
      e.subject,
      e.sender,
      e.sent_at,
      SUBSTR(e.body_plain, 1, 200) as body_preview
    FROM emails e
    WHERE e.user_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM communications c
        WHERE c.email_id = e.id
          AND c.transaction_id IS NOT NULL
      )
    ORDER BY e.sent_at DESC
    LIMIT ?
  `;
  return db.prepare(sql).all(userId, limit) as Communication[];
}

/**
 * Search locally cached emails by text query (subject, sender, body).
 * Used as fallback when provider $search fails (e.g., pure numeric queries).
 */
export function searchLocalEmailCache(userId: string, query: string, limit = 500): Array<{
  id: string;
  subject: string | null;
  sender: string | null;
  sent_at: string | null;
  body_preview: string | null;
  thread_id: string | null;
  has_attachments: boolean;
}> {
  const db = ensureDb();
  const pattern = `%${query}%`;
  // BACKLOG-1579 Phase 2: Return native UUID from the emails table.
  // linkEmails now accepts UUIDs directly, so no provider-prefix needed.
  const sql = `
    SELECT
      e.id,
      e.subject,
      e.sender,
      e.sent_at,
      SUBSTR(e.body_plain, 1, 200) as body_preview,
      e.thread_id,
      e.has_attachments
    FROM emails e
    WHERE e.user_id = ?
      AND (LOWER(e.subject) LIKE LOWER(?) OR LOWER(e.sender) LIKE LOWER(?) OR LOWER(e.body_plain) LIKE LOWER(?))
    ORDER BY e.sent_at DESC
    LIMIT ?
  `;
  return db.prepare(sql).all(userId, pattern, pattern, pattern, limit) as Array<{
    id: string;
    subject: string | null;
    sender: string | null;
    sent_at: string | null;
    body_preview: string | null;
    thread_id: string | null;
    has_attachments: boolean;
  }>;
}

/**
 * Get distinct contacts (phone numbers) with unlinked message counts
 * Used for contact-first message browsing
 */
export function getMessageContacts(userId: string): { contact: string; messageCount: number; lastMessageAt: string }[] {
  const db = ensureDb();
  const sql = `
    SELECT
      COALESCE(
        CASE
          WHEN direction = 'inbound' THEN json_extract(participants, '$.from')
          ELSE json_extract(participants, '$.to[0]')
        END,
        thread_id
      ) as contact,
      COUNT(*) as messageCount,
      MAX(sent_at) as lastMessageAt
    FROM messages
    WHERE user_id = ?
      AND transaction_id IS NULL
      AND channel IN ('sms', 'imessage')
      AND participants IS NOT NULL
    GROUP BY contact
    HAVING contact IS NOT NULL AND contact != 'me' AND contact != 'unknown' AND contact != ''
    ORDER BY lastMessageAt DESC
  `;
  return db.prepare(sql).all(userId) as { contact: string; messageCount: number; lastMessageAt: string }[];
}

/**
 * Get unlinked messages for a specific contact (phone number)
 * Used after user selects a contact in the contact-first UI
 *
 * Strategy: First find all thread_ids where the contact appears, then fetch
 * ALL messages from those threads. This ensures group chats are fully captured
 * even when individual messages have different handles.
 */
export function getMessagesByContact(userId: string, contact: string): Message[] {
  const db = ensureDb();

  // Step 1: Find all thread_ids where the contact appears in any message
  const threadIdsSql = `
    SELECT DISTINCT thread_id FROM messages
    WHERE user_id = ?
      AND transaction_id IS NULL
      AND channel IN ('sms', 'imessage')
      AND thread_id IS NOT NULL
      AND (
        json_extract(participants, '$.from') = ?
        OR json_extract(participants, '$.to[0]') = ?
      )
  `;
  const threadRows = db.prepare(threadIdsSql).all(userId, contact, contact) as { thread_id: string }[];
  const threadIds = threadRows.map(r => r.thread_id);

  if (threadIds.length === 0) {
    const fallbackSql = `
      SELECT * FROM messages
      WHERE user_id = ?
        AND transaction_id IS NULL
        AND channel IN ('sms', 'imessage')
        AND (
          json_extract(participants, '$.from') = ?
          OR json_extract(participants, '$.to[0]') = ?
        )
      ORDER BY sent_at DESC
    `;
    return db.prepare(fallbackSql).all(userId, contact, contact) as Message[];
  }

  const placeholders = threadIds.map(() => '?').join(', ');
  const messagesSql = `
    SELECT * FROM messages
    WHERE user_id = ?
      AND transaction_id IS NULL
      AND channel IN ('sms', 'imessage')
      AND thread_id IN (${placeholders})
    ORDER BY sent_at DESC
  `;
  return db.prepare(messagesSql).all(userId, ...threadIds) as Message[];
}

// ============================================
// MESSAGE CRUD OPERATIONS
// ============================================

/**
 * Update a message in the messages table
 */
export function updateMessage(messageId: string, updates: Partial<Message>): void {
  const db = ensureDb();
  const allowedFields = [
    "transaction_id",
    "transaction_link_confidence",
    "transaction_link_source",
    "is_transaction_related",
    "classification_confidence",
    "classification_method",
    "classified_at",
    "is_false_positive",
    "false_positive_reason",
    "stage_hint",
    "stage_hint_source",
    "stage_hint_confidence",
    "llm_analysis",
  ];

  const entries = Object.entries(updates).filter(([key]) =>
    allowedFields.includes(key)
  );

  if (entries.length === 0) return;

  const setClause = entries.map(([key]) => `${key} = ?`).join(", ");
  const values = entries.map(([, value]) => value);
  values.push(messageId);

  db.prepare(`UPDATE messages SET ${setClause} WHERE id = ?`).run(...values);
}

/**
 * Link a message to a transaction
 */
export function linkMessageToTransaction(messageId: string, transactionId: string): void {
  const db = ensureDb();
  db.prepare(`UPDATE messages SET transaction_id = ? WHERE id = ?`).run(
    transactionId,
    messageId
  );
}

/**
 * Unlink a message from a transaction
 */
export function unlinkMessageFromTransaction(messageId: string): void {
  const db = ensureDb();
  db.prepare(`UPDATE messages SET transaction_id = NULL WHERE id = ?`).run(messageId);
}

/**
 * Get messages linked to a transaction
 */
export function getMessagesByTransaction(transactionId: string): Message[] {
  const db = ensureDb();
  const sql = `
    SELECT * FROM messages
    WHERE transaction_id = ?
    ORDER BY sent_at DESC
  `;
  return db.prepare(sql).all(transactionId) as Message[];
}

/**
 * Get a single message by ID
 */
export function getMessageById(messageId: string): Message | null {
  const db = ensureDb();
  const sql = `SELECT * FROM messages WHERE id = ?`;
  const result = db.prepare(sql).get(messageId) as Message | undefined;
  return result || null;
}

// ============================================
// PHONE LOOKUP OPERATIONS (BACKLOG-567)
// ============================================

/**
 * Get the most recent message date for a phone number using lookup table
 * Falls back to direct query if lookup table is empty (BACKLOG-567)
 */
export function getLastMessageDateForPhone(userId: string, normalizedPhone: string): string | null {
  const db = ensureDb();

  const result = db.prepare(`
    SELECT last_message_at as last_date
    FROM phone_last_message
    WHERE user_id = ?
      AND phone_normalized = ?
  `).get(userId, normalizedPhone) as { last_date: string | null } | undefined;

  return result?.last_date || null;
}

/**
 * Batch lookup for multiple phones (much more efficient than N queries)
 * Returns a Map of normalized phone -> last_message_at (BACKLOG-567)
 */
export function getLastMessageDatesForPhones(userId: string, phones: string[]): Map<string, string> {
  const db = ensureDb();
  const result = new Map<string, string>();

  if (phones.length === 0) return result;

  const placeholders = phones.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT phone_normalized, last_message_at
    FROM phone_last_message
    WHERE user_id = ?
      AND phone_normalized IN (${placeholders})
  `).all(userId, ...phones) as { phone_normalized: string; last_message_at: string }[];

  for (const row of rows) {
    result.set(row.phone_normalized, row.last_message_at);
  }

  return result;
}

/**
 * Populate phone_last_message lookup table from messages (BACKLOG-567)
 * This aggregates all SMS/iMessage into a phone->lastDate lookup for O(1) queries
 */
export async function backfillPhoneLastMessageTable(userId: string): Promise<number> {
  const db = ensureDb();

  await logService.info("Backfilling phone_last_message table", "messageDbService", { userId });

  const messages = db.prepare(`
    SELECT participants_flat, MAX(sent_at) as last_date
    FROM messages
    WHERE user_id = ?
      AND (channel = 'sms' OR channel = 'imessage')
      AND participants_flat IS NOT NULL
      AND participants_flat != ''
    GROUP BY participants_flat
  `).all(userId) as { participants_flat: string; last_date: string }[];

  const phoneLastDates = new Map<string, string>();

  for (const msg of messages) {
    // BACKLOG-1493: Include short codes (< 7 digits) and alphanumeric senders
    // in the phone last message lookup. Previously filtered out by >= 7 requirement.
    const phones = msg.participants_flat.split(',').filter(p => p.trim().length > 0);

    for (const phone of phones) {
      // BACKLOG-1727: shared helper guarantees reader/writer agreement
      const normalized = normalizePhoneLookupKey(phone);
      if (normalized.length === 0) continue;

      const existing = phoneLastDates.get(normalized);
      if (!existing || msg.last_date > existing) {
        phoneLastDates.set(normalized, msg.last_date);
      }
    }
  }

  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO phone_last_message (phone_normalized, user_id, last_message_at)
    VALUES (?, ?, ?)
  `);

  const runInserts = db.transaction(() => {
    let count = 0;
    for (const [phone, lastDate] of phoneLastDates) {
      insertStmt.run(phone, userId, lastDate);
      count++;
    }
    return count;
  });

  const count = runInserts();

  await logService.info("Phone last message backfill complete", "messageDbService", {
    userId,
    phonesUpdated: count,
  });

  return count;
}

// ============================================
// CONVERSATION LIST FROM MESSAGES TABLE (BACKLOG-1470)
// ============================================

/**
 * Row shape returned by the SMS/iMessage conversation aggregation query.
 */
interface ConversationGroupRow {
  thread_id: string;
  participants_flat: string;
  messageCount: number;
  lastMessageTime: string;
  lastMessage: string | null;
  channel: string;
}

/**
 * A single conversation entry derived from the messages table.
 * Mirrors the shape expected by the renderer (ProcessedConversation).
 */
export interface MessagesConversation {
  id: string;
  name: string;
  contactId: string | null;
  phones: string[];
  emails: string[];
  showBothNameAndNumber: boolean;
  messageCount: number;
  lastMessageDate: string;
  directChatCount: number;
  directMessageCount: number;
  groupChatCount: number;
  groupMessageCount: number;
}

/**
 * Build a conversation list from the local messages table.
 *
 * Groups SMS/iMessage rows by thread_id (preferred) or participants_flat,
 * then resolves display names via the contacts + contact_phones tables.
 *
 * Used when the import source is android-companion or iphone-sync,
 * where messages live in the local DB rather than macOS chat.db.
 */
export function getConversationsFromMessages(userId: string): MessagesConversation[] {
  const db = ensureDb();

  // Group messages by thread_id (preferred) falling back to participants_flat.
  // thread_id is always set for Android SMS (android-thread-{id}) and
  // usually set for iPhone sync data.
  const rows = db.prepare(`
    SELECT
      COALESCE(thread_id, participants_flat) as thread_id,
      participants_flat,
      COUNT(*) as messageCount,
      MAX(sent_at) as lastMessageTime,
      channel
    FROM messages
    WHERE user_id = ?
      AND channel IN ('sms', 'imessage')
      AND (thread_id IS NOT NULL OR participants_flat IS NOT NULL)
    GROUP BY COALESCE(thread_id, participants_flat)
    ORDER BY lastMessageTime DESC
  `).all(userId) as ConversationGroupRow[];

  if (rows.length === 0) {
    return [];
  }

  // Build a phone-to-contact lookup for name resolution.
  // Uses contact_phones joined with contacts to resolve display names.
  const contactLookup = db.prepare(`
    SELECT
      cp.phone_e164,
      c.display_name,
      c.id as contact_id
    FROM contact_phones cp
    JOIN contacts c ON cp.contact_id = c.id
    WHERE c.user_id = ?
  `).all(userId) as { phone_e164: string; display_name: string; contact_id: string }[];

  // Normalize phone -> contact info map (last 10 digits as key)
  const phoneToContact = new Map<string, { display_name: string; contact_id: string }>();
  for (const row of contactLookup) {
    const digits = row.phone_e164.replace(/\D/g, "");
    const normalized = digits.length >= 10 ? digits.slice(-10) : digits;
    if (normalized.length >= 7) {
      phoneToContact.set(normalized, {
        display_name: row.display_name,
        contact_id: row.contact_id,
      });
    }
  }

  const conversations: MessagesConversation[] = [];

  for (const row of rows) {
    // Resolve the phone number from participants_flat.
    // BACKLOG-1493: participants_flat may contain:
    //   - Standard digits (e.g., "5551234567") — for normal phone numbers
    //   - Short code digits (e.g., "72645") — for carrier/marketing SMS
    //   - Alphanumeric string (e.g., "T-Mobile") — for carrier alerts
    const phoneRaw = (row.participants_flat || "").split(",")[0].trim();
    const phoneDigits = phoneRaw.replace(/\D/g, "");

    // BACKLOG-1493: Determine if this is a numeric sender or alphanumeric.
    // Alphanumeric senders have no digits (or fewer digits than non-digit chars).
    const isAlphanumericSender = phoneDigits.length === 0;

    // For numeric senders, normalize to last 10 digits for contact lookup.
    // For short codes (< 7 digits), still attempt lookup but don't require >= 7.
    const normalizedPhone = isAlphanumericSender
      ? ""
      : (phoneDigits.length >= 10 ? phoneDigits.slice(-10) : phoneDigits);

    // BACKLOG-1493: Look up contact name. Removed the >= 7 digit requirement
    // so short codes (5-6 digits) can also match contacts if the user has saved them.
    // For alphanumeric senders, skip phone lookup — use the sender string as display name.
    const contactInfo = normalizedPhone.length > 0
      ? phoneToContact.get(normalizedPhone)
      : undefined;

    // BACKLOG-1493: Build display name.
    // Priority: contact name > formatted phone number > alphanumeric sender > thread_id
    // For conversations with no contact match, show the phone number or sender string
    // so the conversation is always visible (never hidden due to missing name).
    const displayName = contactInfo?.display_name || phoneRaw || row.thread_id;

    conversations.push({
      id: row.thread_id,
      name: displayName,
      contactId: contactInfo?.contact_id || phoneRaw || null,
      phones: phoneRaw ? [phoneRaw] : [],
      emails: [],
      showBothNameAndNumber: !!contactInfo && displayName !== phoneRaw,
      messageCount: row.messageCount,
      lastMessageDate: row.lastMessageTime,
      directChatCount: 1,
      directMessageCount: row.messageCount,
      groupChatCount: 0,
      groupMessageCount: 0,
    });
  }

  return conversations;
}
