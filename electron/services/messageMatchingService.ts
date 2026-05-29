/**
 * Message Matching Service
 * Auto-links text messages to transactions based on contact phone numbers.
 *
 * Logic:
 * 1. Get all contacts linked to a transaction (via transaction_contacts)
 * 2. For each contact, get their phone numbers (via contact_phones)
 * 3. Find all messages where channel = 'sms' OR 'imessage' AND participants match
 * 4. Link messages to transaction via communications table
 *
 * @see TASK-977
 */

import crypto from "crypto";
import { dbAll, dbRun, dbGet } from "./db/core/dbConnection";
import logService from "./logService";
import { normalizeAddress, contentContainsAddress, type NormalizedAddress } from "../utils/addressNormalization";
import {
  getIgnoredEmailIdsForTransaction,
  getIgnoredThreadIdsForTransaction,
  getIgnoredCommunicationIdsForTransaction,
} from "./db/communicationDbService";
import { toE164 } from "../utils/phoneNormalization";

/**
 * Result of matching a message to a contact
 */
export interface MessageMatch {
  messageId: string;
  contactId: string;
  matchedPhone: string;
  direction: "inbound" | "outbound";
}

/**
 * Result of auto-linking texts to a transaction
 */
export interface AutoLinkResult {
  linked: number;
  skipped: number;
  errors: string[];
}

/**
 * Options for auto-linking texts
 */
export interface AutoLinkOptions {
  /** Only link messages within this date range */
  dateBuffer?: number; // Days before/after transaction to include
  /** Include archived/closed transaction messages */
  includeArchived?: boolean;
  /** Start date for message filtering (ISO8601 string) */
  startDate?: string;
  /** End date for message filtering (ISO8601 string, optional) */
  endDate?: string;
}

/**
 * Normalize a phone number to E.164 format for comparison.
 * Handles various input formats: (415) 555-0000, 415-555-0000, +14155550000, etc.
 *
 * BACKLOG-1729: Delegates to the canonical `toE164` from `phoneNormalization`,
 * wrapped to preserve the historical `string | null` signature. The legacy
 * implementation returned `null` for inputs with <10 digits; toE164 returns
 * `"+digits"` for any positive digit count. Audit (see PR description) shows
 * no consumer feeds <10-digit input to this function on a path where the
 * non-null result would produce a different observable outcome.
 *
 * @param phone - The phone number to normalize
 * @returns Normalized E.164 format (+14155550000) or null if invalid/empty
 */
export function normalizePhone(phone: string | null | undefined): string | null {
  const r = toE164(phone);
  return r ? r : null;
}

/**
 * Check if two phone numbers match (handles various formats).
 *
 * @param phone1 - First phone number
 * @param phone2 - Second phone number
 * @returns true if the phones match
 */
export function phonesMatch(
  phone1: string | null | undefined,
  phone2: string | null | undefined
): boolean {
  const normalized1 = normalizePhone(phone1);
  const normalized2 = normalizePhone(phone2);

  if (!normalized1 || !normalized2) return false;

  return normalized1 === normalized2;
}

/**
 * Get all phone numbers for contacts linked to a transaction.
 *
 * @param transactionId - The transaction ID
 * @returns Array of { contactId, phone } pairs
 */
export async function getTransactionContactPhones(
  transactionId: string
): Promise<Array<{ contactId: string; phone: string }>> {
  const sql = `
    SELECT
      tc.contact_id as contactId,
      cp.phone_e164 as phone
    FROM transaction_contacts tc
    JOIN contact_phones cp ON tc.contact_id = cp.contact_id
    WHERE tc.transaction_id = ?
  `;

  const results = dbAll<{ contactId: string; phone: string }>(sql, [transactionId]);
  return results;
}

/**
 * Find text messages that match any of the given phone numbers.
 * Only returns messages not already linked to a transaction.
 *
 * @param userId - The user ID to scope the search
 * @param phoneNumbers - Array of E.164 phone numbers to match
 * @param transactionId - The transaction to check for existing links
 * @param options - Optional date filtering options
 * @returns Array of matching messages with contact attribution
 */
export async function findTextMessagesByPhones(
  userId: string,
  phoneNumbers: Array<{ contactId: string; phone: string }>,
  transactionId: string,
  options?: { startDate?: string; endDate?: string }
): Promise<MessageMatch[]> {
  if (phoneNumbers.length === 0) {
    return [];
  }

  // Build a map of normalized phone -> contactId for efficient lookup
  const phoneToContact = new Map<string, string>();
  for (const { contactId, phone } of phoneNumbers) {
    const normalized = normalizePhone(phone);
    if (normalized) {
      phoneToContact.set(normalized, contactId);
    }
  }

  if (phoneToContact.size === 0) {
    return [];
  }

  // Build date filter clause if dates are provided
  let dateFilter = "";
  // BACKLOG-1560: Extra params for ignored_communications SQL-level suppression
  const params: (string | null)[] = [userId, transactionId, transactionId, transactionId, transactionId];

  if (options?.startDate) {
    dateFilter += " AND m.sent_at >= ?";
    params.push(options.startDate);
  }
  if (options?.endDate) {
    dateFilter += " AND m.sent_at <= ?";
    // Add time component to include the full end date
    params.push(options.endDate + "T23:59:59.999Z");
  }

  // Query all text messages for this user that aren't already linked to this transaction
  // We use participants_flat which contains all participants in a searchable format
  // BACKLOG-1560: SQL-level suppression against ignored_communications (belt-and-suspenders).
  // Checks both thread_id suppression and per-message original_communication_id suppression.
  // The JS-level filter after this query is the backup layer.
  const sql = `
    SELECT
      m.id,
      m.participants,
      m.participants_flat,
      m.direction,
      m.channel
    FROM messages m
    WHERE m.user_id = ?
      AND m.channel IN ('sms', 'imessage')
      AND m.duplicate_of IS NULL
      AND (
        m.transaction_id IS NULL
        OR m.transaction_id != ?
      )
      AND m.id NOT IN (
        SELECT message_id FROM communications
        WHERE transaction_id = ? AND message_id IS NOT NULL
      )
      AND m.id NOT IN (
        SELECT ic.original_communication_id FROM ignored_communications ic
        WHERE ic.transaction_id = ? AND ic.original_communication_id IS NOT NULL
      )
      AND (m.thread_id IS NULL OR m.thread_id = '' OR m.thread_id NOT IN (
        SELECT ic.thread_id FROM ignored_communications ic
        WHERE ic.transaction_id = ? AND ic.thread_id IS NOT NULL
      ))${dateFilter}
  `;

  const messages = dbAll<{
    id: string;
    participants: string | null;
    participants_flat: string | null;
    direction: string | null;
    channel: string;
  }>(sql, params);

  const matches: MessageMatch[] = [];

  for (const msg of messages) {
    // Try to find a matching phone in the participants
    let matchedPhone: string | null = null;
    let matchedContactId: string | null = null;

    // First try participants_flat (denormalized search string)
    if (msg.participants_flat) {
      for (const [phone, contactId] of phoneToContact) {
        // Extract just digits from both for comparison
        const phoneDigits = phone.replace(/\D/g, "");
        if (msg.participants_flat.includes(phoneDigits)) {
          matchedPhone = phone;
          matchedContactId = contactId;
          break;
        }
      }
    }

    // If not found in flat, try parsing participants JSON
    if (!matchedPhone && msg.participants) {
      try {
        const participants = JSON.parse(msg.participants);
        const allParticipants: string[] = [];

        if (participants.from) allParticipants.push(participants.from);
        if (Array.isArray(participants.to)) {
          allParticipants.push(...participants.to);
        }
        // IMPORTANT: For group chats, also check chat_members
        // This is where all group participants are stored for inbound messages
        if (Array.isArray(participants.chat_members)) {
          allParticipants.push(...participants.chat_members);
        }

        for (const participant of allParticipants) {
          const normalizedParticipant = normalizePhone(participant);
          if (normalizedParticipant && phoneToContact.has(normalizedParticipant)) {
            matchedPhone = normalizedParticipant;
            matchedContactId = phoneToContact.get(normalizedParticipant) || null;
            break;
          }
        }
      } catch {
        // JSON parse error - skip this message
        logService.warn(
          `Failed to parse participants JSON for message ${msg.id}`,
          "MessageMatchingService"
        );
      }
    }

    if (matchedPhone && matchedContactId) {
      matches.push({
        messageId: msg.id,
        contactId: matchedContactId,
        matchedPhone,
        direction: (msg.direction as "inbound" | "outbound") || "inbound",
      });
    }
  }

  return matches;
}

/**
 * Create a communication reference linking a message to a transaction.
 * Uses INSERT OR IGNORE to handle duplicates gracefully.
 *
 * @param messageId - The message ID
 * @param transactionId - The transaction ID
 * @param userId - The user ID
 * @param linkSource - How the link was created ('auto' for auto-linking)
 * @param linkConfidence - Confidence score (0.0 - 1.0)
 * @returns The created communication ID, or null if already exists
 */
export async function createCommunicationReference(
  messageId: string,
  transactionId: string,
  userId: string,
  linkSource: "auto" | "manual" | "scan" = "auto",
  linkConfidence: number = 0.9
): Promise<string | null> {
  const id = crypto.randomUUID();

  // First check if this link already exists
  const existingCheck = `
    SELECT id FROM communications
    WHERE message_id = ? AND transaction_id = ?
  `;
  const existing = dbGet<{ id: string }>(existingCheck, [messageId, transactionId]);

  if (existing) {
    return null; // Already linked
  }

  // Verify message exists before linking
  const msgExists = dbGet<{ id: string }>(
    "SELECT id FROM messages WHERE id = ?",
    [messageId]
  );

  if (!msgExists) {
    logService.warn(
      `Message ${messageId} not found when creating communication reference`,
      "MessageMatchingService"
    );
    return null;
  }

  // BACKLOG-506: Communications is now a pure junction table
  // Content data (sender, recipients, body, etc.) lives in the messages table
  // and is joined via message_id foreign key
  const sql = `
    INSERT INTO communications (
      id, user_id, transaction_id, message_id,
      link_source, link_confidence, linked_at
    ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `;

  const params = [
    id,
    userId,
    transactionId,
    messageId,
    linkSource,
    linkConfidence,
  ];

  try {
    dbRun(sql, params);
    return id;
  } catch (error) {
    // Handle unique constraint violation gracefully
    if (error instanceof Error && error.message.includes("UNIQUE constraint")) {
      return null;
    }
    throw error;
  }
}

/**
 * TASK-2087: Filter a set of email message IDs by checking if their content mentions the address.
 * Queries the messages table (channel='email') for subject/body_text fields and checks for address match.
 *
 * NOTE: This only applies to emails, NOT text messages. People don't put property addresses in texts.
 *
 * @param messageIds - Array of message IDs to check
 * @param normalizedAddress - The NormalizedAddress to search for (parts checked independently)
 * @returns Set of message IDs whose content contains the address
 */
async function filterEmailMatchesByAddress(
  messageIds: string[],
  normalizedAddress: NormalizedAddress
): Promise<Set<string>> {
  const result = new Set<string>();
  if (messageIds.length === 0) return result;

  // Query messages in batches to avoid SQLite parameter limits
  const batchSize = 100;
  for (let i = 0; i < messageIds.length; i += batchSize) {
    const batch = messageIds.slice(i, i + batchSize);
    const placeholders = batch.map(() => '?').join(',');
    const sql = `
      SELECT id, subject, body_text
      FROM messages
      WHERE id IN (${placeholders})
    `;
    const rows = dbAll<{ id: string; subject: string | null; body_text: string | null }>(sql, batch);

    for (const row of rows) {
      // Combine subject and body for matching; contentContainsAddress checks
      // each part of the address independently with word boundaries
      if (
        contentContainsAddress(row.subject, normalizedAddress) ||
        contentContainsAddress(row.body_text, normalizedAddress)
      ) {
        result.add(row.id);
      }
    }
  }

  return result;
}

/**
 * Auto-link text messages to a transaction based on assigned contacts.
 * This is the main entry point for the auto-linking feature.
 *
 * @param transactionId - The transaction to link messages to
 * @param options - Optional configuration including date range
 * @returns Result with counts of linked/skipped messages
 */
export async function autoLinkTextsToTransaction(
  transactionId: string,
  options?: AutoLinkOptions
): Promise<AutoLinkResult> {
  const result: AutoLinkResult = {
    linked: 0,
    skipped: 0,
    errors: [],
  };

  try {
    // 1. Get the transaction to verify it exists, get user_id and date range
    // TASK-2087: Address filtering removed from text messages — only applies to emails.
    const txnSql = "SELECT user_id, started_at, closed_at FROM transactions WHERE id = ?";
    const transaction = dbGet<{ user_id: string; started_at: string | null; closed_at: string | null }>(txnSql, [transactionId]);

    if (!transaction) {
      result.errors.push(`Transaction ${transactionId} not found`);
      return result;
    }

    const userId = transaction.user_id;

    // Use dates from options if provided, otherwise fall back to transaction dates
    const startDate = options?.startDate || transaction.started_at || undefined;
    const endDate = options?.endDate || transaction.closed_at || undefined;

    // Log date range for performance tracking
    if (startDate || endDate) {
      logService.info(
        `Date filter applied for transaction ${transactionId}: ${startDate || "no start"} to ${endDate || "ongoing"}`,
        "MessageMatchingService"
      );
    }

    // 2. Get all phone numbers for contacts linked to this transaction
    const contactPhones = await getTransactionContactPhones(transactionId);

    if (contactPhones.length === 0) {
      logService.debug(
        `No contact phones found for transaction ${transactionId}`,
        "MessageMatchingService"
      );
      return result;
    }

    logService.info(
      `Found ${contactPhones.length} phone numbers for transaction ${transactionId}`,
      "MessageMatchingService"
    );

    // 3. Find matching text messages with date filtering
    // TASK-2087: No address filtering for text messages — only emails get filtered.
    const matches = await findTextMessagesByPhones(
      userId,
      contactPhones,
      transactionId,
      { startDate, endDate }
    );

    // BACKLOG-1560: Filter out messages whose threads were previously unlinked by user
    // Also handles per-message suppression for messages with no/empty thread_id
    const ignoredThreadIds = getIgnoredThreadIdsForTransaction(transactionId);
    const ignoredCommIds = getIgnoredCommunicationIdsForTransaction(transactionId);
    let filteredMatches = matches;
    if (ignoredThreadIds.size > 0 || ignoredCommIds.size > 0) {
      // Look up thread_id for each matched message to check suppression
      filteredMatches = matches.filter((match) => {
        // BACKLOG-1560: Check per-message suppression first (for messages with no/empty thread_id)
        if (ignoredCommIds.has(match.messageId)) return false;
        const msg = dbGet<{ thread_id: string | null }>(
          "SELECT thread_id FROM messages WHERE id = ?",
          [match.messageId]
        );
        // BACKLOG-1560: Treat empty string thread_id as no thread_id
        if (msg?.thread_id && msg.thread_id !== "" && ignoredThreadIds.has(msg.thread_id)) {
          return false; // Suppress this message
        }
        return true;
      });

      const suppressed = matches.length - filteredMatches.length;
      if (suppressed > 0) {
        logService.debug(
          `BACKLOG-1560: Suppressed ${suppressed} text messages from ${ignoredThreadIds.size} ignored threads and ${ignoredCommIds.size} ignored messages`,
          "MessageMatchingService"
        );
      }
    }

    logService.info(
      `Found ${filteredMatches.length} text messages to link for transaction ${transactionId}`,
      "MessageMatchingService"
    );

    // 4. Create communication references for each match
    for (const match of filteredMatches) {
      try {
        const refId = await createCommunicationReference(
          match.messageId,
          transactionId,
          userId,
          "auto",
          0.9 // High confidence for phone-based matching
        );

        if (refId) {
          result.linked++;
        } else {
          result.skipped++; // Already linked or message not found
        }
      } catch (error) {
        const errorMsg =
          error instanceof Error ? error.message : "Unknown error";
        result.errors.push(
          `Failed to link message ${match.messageId}: ${errorMsg}`
        );
        logService.warn(
          `Failed to link message ${match.messageId} to transaction ${transactionId}: ${errorMsg}`,
          "MessageMatchingService"
        );
      }
    }

    // 5. Also update the message's transaction_id directly for consistency
    if (result.linked > 0) {
      const linkedMessageIds = filteredMatches
        .slice(0, result.linked)
        .map((m) => m.messageId);

      // Update messages table to set transaction_id
      const placeholders = linkedMessageIds.map(() => "?").join(",");
      const updateSql = `
        UPDATE messages
        SET transaction_id = ?, transaction_link_source = 'pattern', transaction_link_confidence = 0.9
        WHERE id IN (${placeholders}) AND transaction_id IS NULL
      `;
      dbRun(updateSql, [transactionId, ...linkedMessageIds]);
    }

    logService.info(
      `Auto-link complete for transaction ${transactionId}: ${result.linked} linked, ${result.skipped} skipped`,
      "MessageMatchingService"
    );

    return result;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    result.errors.push(`Auto-link failed: ${errorMsg}`);
    logService.error(
      `Auto-link failed for transaction ${transactionId}: ${errorMsg}`,
      "MessageMatchingService"
    );
    return result;
  }
}

/**
 * Get all email addresses for contacts linked to a transaction.
 *
 * @param transactionId - The transaction ID
 * @returns Array of { contactId, email } pairs
 */
export async function getTransactionContactEmails(
  transactionId: string
): Promise<Array<{ contactId: string; email: string }>> {
  const sql = `
    SELECT
      tc.contact_id as contactId,
      ce.email as email
    FROM transaction_contacts tc
    JOIN contact_emails ce ON tc.contact_id = ce.contact_id
    WHERE tc.transaction_id = ?
  `;

  const results = dbAll<{ contactId: string; email: string }>(sql, [transactionId]);
  return results;
}

/**
 * Find emails that match any of the given email addresses.
 * Only returns emails not already linked to a transaction.
 *
 * @param userId - The user ID to scope the search
 * @param emailAddresses - Array of email addresses to match
 * @param transactionId - The transaction to check for existing links
 * @returns Array of matching messages with contact attribution
 */
export async function findEmailsByAddresses(
  userId: string,
  emailAddresses: Array<{ contactId: string; email: string }>,
  transactionId: string
): Promise<MessageMatch[]> {
  if (emailAddresses.length === 0) {
    return [];
  }

  // Build a map of normalized email -> contactId for efficient lookup
  const emailToContact = new Map<string, string>();
  for (const { contactId, email } of emailAddresses) {
    if (email) {
      emailToContact.set(email.toLowerCase().trim(), contactId);
    }
  }

  if (emailToContact.size === 0) {
    return [];
  }

  // Query all email messages for this user that aren't already linked to this transaction
  const sql = `
    SELECT
      m.id,
      m.sender,
      m.recipients,
      m.direction,
      m.channel
    FROM messages m
    WHERE m.user_id = ?
      AND m.channel = 'email'
      AND m.duplicate_of IS NULL
      AND (
        m.transaction_id IS NULL
        OR m.transaction_id != ?
      )
      AND m.id NOT IN (
        SELECT message_id FROM communications
        WHERE transaction_id = ? AND message_id IS NOT NULL
      )
  `;

  const messages = dbAll<{
    id: string;
    sender: string | null;
    recipients: string | null;
    direction: string | null;
    channel: string;
  }>(sql, [userId, transactionId, transactionId]);

  const matches: MessageMatch[] = [];

  for (const msg of messages) {
    // Check sender and recipients for email matches
    let matchedEmail: string | null = null;
    let matchedContactId: string | null = null;

    // Check sender
    if (msg.sender) {
      const normalizedSender = msg.sender.toLowerCase().trim();
      // Extract email from "Name <email>" format if present
      const emailMatch = normalizedSender.match(/<([^>]+)>/);
      const emailToCheck = emailMatch ? emailMatch[1] : normalizedSender;

      if (emailToContact.has(emailToCheck)) {
        matchedEmail = emailToCheck;
        matchedContactId = emailToContact.get(emailToCheck) || null;
      }
    }

    // Check recipients if sender didn't match
    if (!matchedEmail && msg.recipients) {
      const recipientList = msg.recipients.split(/[,;]/).map(r => r.trim().toLowerCase());
      for (const recipient of recipientList) {
        // Extract email from "Name <email>" format if present
        const emailMatch = recipient.match(/<([^>]+)>/);
        const emailToCheck = emailMatch ? emailMatch[1] : recipient;

        if (emailToContact.has(emailToCheck)) {
          matchedEmail = emailToCheck;
          matchedContactId = emailToContact.get(emailToCheck) || null;
          break;
        }
      }
    }

    if (matchedEmail && matchedContactId) {
      matches.push({
        messageId: msg.id,
        contactId: matchedContactId,
        matchedPhone: matchedEmail, // Reusing field for email
        direction: (msg.direction as "inbound" | "outbound") || "inbound",
      });
    }
  }

  return matches;
}

/**
 * Auto-link emails to a transaction based on assigned contacts.
 *
 * @param transactionId - The transaction to link emails to
 * @returns Result with counts of linked/skipped emails
 */
export async function autoLinkEmailsToTransaction(
  transactionId: string
): Promise<AutoLinkResult> {
  const result: AutoLinkResult = {
    linked: 0,
    skipped: 0,
    errors: [],
  };

  try {
    // 1. Get the transaction to verify it exists, get user_id and address
    // TASK-2087: Also fetch property_address and property_street for address filtering
    // BACKLOG-1364: Also fetch skip_address_filter for per-transaction toggle
    const txnSql = "SELECT user_id, property_address, property_street, skip_address_filter FROM transactions WHERE id = ?";
    const transaction = dbGet<{ user_id: string; property_address: string | null; property_street: string | null; skip_address_filter: number | null }>(txnSql, [transactionId]);

    if (!transaction) {
      result.errors.push(`Transaction ${transactionId} not found`);
      return result;
    }

    const userId = transaction.user_id;

    // TASK-2087: Normalize transaction address for content filtering
    const txnNormalizedAddress = normalizeAddress(
      transaction.property_address || transaction.property_street || null
    );

    // 2. Get all email addresses for contacts linked to this transaction
    const contactEmails = await getTransactionContactEmails(transactionId);

    if (contactEmails.length === 0) {
      logService.debug(
        `No contact emails found for transaction ${transactionId}`,
        "MessageMatchingService"
      );
      return result;
    }

    logService.info(
      `Found ${contactEmails.length} email addresses for transaction ${transactionId}`,
      "MessageMatchingService"
    );

    // 3. Find matching emails
    // BACKLOG-1364: When skip_address_filter is ON, link ALL emails from contacts (no address filter).
    // When OFF (default), apply address filter WITHOUT silent fallback — if 0 emails match,
    // return 0 results with a log message suggesting the user turn off the filter.
    const skipAddressFilter = transaction.skip_address_filter === 1;
    let matches: MessageMatch[];

    if (skipAddressFilter) {
      // Skip address filtering — get all emails from contacts regardless of content
      matches = await findEmailsByAddresses(userId, contactEmails, transactionId);
      logService.debug(
        `Address filter SKIPPED (user toggle): ${matches.length} unfiltered emails found`,
        "MessageMatchingService"
      );
    } else {
      // Apply address filter (default behavior) — NO silent fallback (BACKLOG-1364)
      const allMatches = await findEmailsByAddresses(userId, contactEmails, transactionId);
      if (!txnNormalizedAddress || allMatches.length === 0) {
        matches = allMatches;
      } else {
        const filteredIds = await filterEmailMatchesByAddress(
          allMatches.map(m => m.messageId),
          txnNormalizedAddress
        );
        matches = filteredIds.size > 0
          ? allMatches.filter(m => filteredIds.has(m.messageId))
          : [];
      }

      // If filter is ON and 0 emails found, log a message instead of silently widening
      if (matches.length === 0 && txnNormalizedAddress && contactEmails.length > 0) {
        logService.debug(
          `Address filter ON, 0 emails matched "${txnNormalizedAddress.full}" — no silent fallback (BACKLOG-1364). User can turn off filter to widen search.`,
          "MessageMatchingService"
        );
      } else if (matches.length > 0 && txnNormalizedAddress) {
        logService.debug(
          `Address filter applied: ${matches.length} emails matched "${txnNormalizedAddress.full}"`,
          "MessageMatchingService"
        );
      }
    }

    // BACKLOG-1560: Filter out emails that the user previously unlinked.
    // The primary auto-link path (autoLinkService) uses email_id from the emails table.
    // This path uses message_id from the messages table, so we cross-reference via
    // the emails table to find ignored email_ids.
    const ignoredEmailIds = getIgnoredEmailIdsForTransaction(transactionId);
    let filteredEmailMatches = matches;
    if (ignoredEmailIds.size > 0) {
      filteredEmailMatches = matches.filter((match) => {
        // Look up the message's external_id and check if a corresponding email is ignored
        const msg = dbGet<{ external_id: string | null }>(
          "SELECT external_id FROM messages WHERE id = ?",
          [match.messageId]
        );
        if (msg?.external_id) {
          const email = dbGet<{ id: string }>(
            "SELECT id FROM emails WHERE external_id = ? AND id IN (" +
            Array.from(ignoredEmailIds).map(() => "?").join(",") + ")",
            [msg.external_id, ...Array.from(ignoredEmailIds)]
          );
          if (email) return false; // This email was previously ignored
        }
        return true;
      });

      const suppressed = matches.length - filteredEmailMatches.length;
      if (suppressed > 0) {
        logService.debug(
          `BACKLOG-1560: Suppressed ${suppressed} emails previously unlinked by user`,
          "MessageMatchingService"
        );
      }
    }

    logService.info(
      `Found ${filteredEmailMatches.length} emails to link for transaction ${transactionId}`,
      "MessageMatchingService"
    );

    // 4. Create communication references for each match
    for (const match of filteredEmailMatches) {
      try {
        const refId = await createCommunicationReference(
          match.messageId,
          transactionId,
          userId,
          "auto",
          0.85 // Slightly lower confidence for email matching
        );

        if (refId) {
          result.linked++;
        } else {
          result.skipped++; // Already linked or message not found
        }
      } catch (error) {
        const errorMsg =
          error instanceof Error ? error.message : "Unknown error";
        result.errors.push(
          `Failed to link email ${match.messageId}: ${errorMsg}`
        );
        logService.warn(
          `Failed to link email ${match.messageId} to transaction ${transactionId}: ${errorMsg}`,
          "MessageMatchingService"
        );
      }
    }

    // 5. Also update the message's transaction_id directly for consistency
    if (result.linked > 0) {
      const linkedMessageIds = filteredEmailMatches
        .slice(0, result.linked)
        .map((m) => m.messageId);

      // Update messages table to set transaction_id
      const placeholders = linkedMessageIds.map(() => "?").join(",");
      const updateSql = `
        UPDATE messages
        SET transaction_id = ?, transaction_link_source = 'pattern', transaction_link_confidence = 0.85
        WHERE id IN (${placeholders}) AND transaction_id IS NULL
      `;
      dbRun(updateSql, [transactionId, ...linkedMessageIds]);
    }

    logService.info(
      `Email auto-link complete for transaction ${transactionId}: ${result.linked} linked, ${result.skipped} skipped`,
      "MessageMatchingService"
    );

    return result;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    result.errors.push(`Email auto-link failed: ${errorMsg}`);
    logService.error(
      `Email auto-link failed for transaction ${transactionId}: ${errorMsg}`,
      "MessageMatchingService"
    );
    return result;
  }
}

/**
 * Auto-link both texts and emails to a transaction based on assigned contacts.
 *
 * @param transactionId - The transaction to link communications to
 * @returns Combined result with counts of linked/skipped messages
 */
export async function autoLinkAllToTransaction(
  transactionId: string
): Promise<AutoLinkResult> {
  const textResult = await autoLinkTextsToTransaction(transactionId);
  const emailResult = await autoLinkEmailsToTransaction(transactionId);

  return {
    linked: textResult.linked + emailResult.linked,
    skipped: textResult.skipped + emailResult.skipped,
    errors: [...textResult.errors, ...emailResult.errors],
  };
}

export default {
  normalizePhone,
  phonesMatch,
  getTransactionContactPhones,
  getTransactionContactEmails,
  findTextMessagesByPhones,
  findEmailsByAddresses,
  createCommunicationReference,
  autoLinkTextsToTransaction,
  autoLinkEmailsToTransaction,
  autoLinkAllToTransaction,
};
