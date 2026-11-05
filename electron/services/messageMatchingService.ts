/**
 * Message Matching Service
 * Phone normalization and matching, transaction contact lookups, and the
 * communication-reference writers used by the live link paths.
 *
 * BACKLOG-4039 / BACKLOG-3984: the deal-level auto-link entry points
 * (autoLinkAllToTransaction / autoLinkTextsToTransaction /
 * autoLinkEmailsToTransaction) were removed. They had no caller in the renderer,
 * and the email half read columns `messages` never had. Live auto-linking is
 * autoLinkService.
 *
 * @see TASK-977
 */

import crypto from "crypto";
import { dbAll, dbRun, dbGet } from "./db/core/dbConnection";
import {
  EXISTING_COMMUNICATION_SQL,
  INSERT_COMMUNICATION_SQL,
  MESSAGE_ID_EXISTS_SQL,
  TRANSACTION_CONTACT_EMAILS_SQL,
  TRANSACTION_CONTACT_PHONES_SQL,
  messagesForPhoneMatchingSql,
} from "./db/messageMatchingSql";
import logService from "./logService";
import { getDealLockReason } from "./dealLockState";
import { toE164 } from "../utils/phoneNormalization";
import { auditWindowEnd, auditWindowStartParam } from "./exportPlan";

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
 * Normalize a phone number to E.164 format for comparison.
 * Handles various input formats: (415) 555-0102, 415-555-0102, +14155550102, etc.
 *
 * BACKLOG-1729: Delegates to the canonical `toE164` from `phoneNormalization`,
 * wrapped to preserve the historical `string | null` signature. The legacy
 * implementation returned `null` for inputs with <10 digits; toE164 returns
 * `"+digits"` for any positive digit count. Audit (see PR description) shows
 * no consumer feeds <10-digit input to this function on a path where the
 * non-null result would produce a different observable outcome.
 *
 * @param phone - The phone number to normalize
 * @returns Normalized E.164 format (+14155550102) or null if invalid/empty
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

  const results = dbAll<{ contactId: string; phone: string }>(TRANSACTION_CONTACT_PHONES_SQL, [transactionId]);
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

  // BACKLOG-3044: the date clause TEXT lives in db/messageMatchingSql.ts; what stays
  // here is the params array, because the clause and its bound value are one contract
  // and the ORDER is the contract. `hasStart` and `hasEnd` select the clause; the
  // pushes below bind the values in the same order the builder emits them. Splitting
  // those two halves across files is the mistake BACKLOG-3103's body describes — a
  // fragment carrying its own parameter, composed at the wrong position, silently
  // shifts every later `?`.
  let hasStart = false;
  let hasEnd = false;
  // BACKLOG-1560: Extra params for ignored_communications SQL-level suppression
  const params: (string | null)[] = [userId, transactionId, transactionId, transactionId, transactionId];

  if (options?.startDate) {
    hasStart = true;
    // BACKLOG-3734: a date-only start is LOCAL 00:00 of that day, bound as ISO.
    params.push(auditWindowStartParam(options.startDate));
  }
  if (options?.endDate) {
    // BACKLOG-2788: the end date is a calendar DAY, and the day ends at the
    // user's LOCAL midnight — `auditWindowEnd()` in exportPlan.ts is the one
    // place that decides where. This used to concatenate a literal
    // "T23:59:59.999Z", i.e. the end of the UTC day, which cut the closing
    // EVENING out of the auto-link candidate window in every US timezone (the
    // same hours BACKLOG-2788 restores to the export and the submission) and
    // which produced a malformed comparison string for any time-bearing end
    // date — the `<=` below is lexicographic on ISO text, so that mis-filters
    // silently rather than failing.
    const end = auditWindowEnd(options.endDate);
    if (end) {
      hasEnd = true;
      params.push(end.toISOString());
    }
  }

  // Query all text messages for this user that aren't already linked to this transaction
  // We use participants_flat which contains all participants in a searchable format
  // BACKLOG-1560: SQL-level suppression against ignored_communications (belt-and-suspenders).
  // Checks both thread_id suppression and per-message original_communication_id suppression.
  // The JS-level filter after this query is the backup layer.

  const messages = dbAll<{
    id: string;
    participants: string | null;
    participants_flat: string | null;
    direction: string | null;
    channel: string;
  }>(messagesForPhoneMatchingSql({ hasStart, hasEnd }), params);

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
  return createCommunicationReferenceSync(
    messageId,
    transactionId,
    userId,
    linkSource,
    linkConfidence
  );
}

/**
 * BACKLOG-3785: the synchronous body of `createCommunicationReference`, so a
 * caller can run it inside a `dbTransaction` (whose body must be synchronous).
 * Same statements, same skips, same return values.
 */
export function createCommunicationReferenceSync(
  messageId: string,
  transactionId: string,
  userId: string,
  linkSource: "auto" | "manual" | "scan" = "auto",
  linkConfidence: number = 0.9
): string | null {
  // BACKLOG-3910: backstop. An AUTOMATIC link never lands on a locked deal (with
  // the broker, or sealed). "manual" is the user's own act and is allowed.
  if (linkSource !== "manual" && getDealLockReason(transactionId)) return null;

  const id = crypto.randomUUID();

  // First check if this link already exists
  const existing = dbGet<{ id: string }>(EXISTING_COMMUNICATION_SQL, [messageId, transactionId]);

  if (existing) {
    return null; // Already linked
  }

  // Verify message exists before linking
  const msgExists = dbGet<{ id: string }>(
    MESSAGE_ID_EXISTS_SQL,
    [messageId]
  );

  if (!msgExists) {
    void logService.warn(
      `Message ${messageId} not found when creating communication reference`,
      "MessageMatchingService"
    );
    return null;
  }

  // BACKLOG-506: Communications is now a pure junction table
  // Content data (sender, recipients, body, etc.) lives in the messages table
  // and is joined via message_id foreign key

  const params = [
    id,
    userId,
    transactionId,
    messageId,
    linkSource,
    linkConfidence,
  ];

  try {
    dbRun(INSERT_COMMUNICATION_SQL, params);
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
 * Get all email addresses for contacts linked to a transaction.
 *
 * @param transactionId - The transaction ID
 * @returns Array of { contactId, email } pairs
 */
export async function getTransactionContactEmails(
  transactionId: string
): Promise<Array<{ contactId: string; email: string }>> {

  const results = dbAll<{ contactId: string; email: string }>(TRANSACTION_CONTACT_EMAILS_SQL, [transactionId]);
  return results;
}

export default {
  normalizePhone,
  phonesMatch,
  getTransactionContactPhones,
  getTransactionContactEmails,
  findTextMessagesByPhones,
  createCommunicationReference,
};
