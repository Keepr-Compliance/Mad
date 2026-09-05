/**
 * Get Earliest Communication Date
 * Standalone utility function extracted from transactionService.ts.
 * Used by the audit wizard to auto-detect the start date for a transaction.
 */

import { dbGet, dbAll } from "../db/core/dbConnection";
import {
  contactEmailsForContactsSql,
  contactPhonesForContactsSql,
  earliestEmailSql,
  earliestMessageSql,
} from "../db/earliestCommunicationSql";

/**
 * Get the earliest communication date (email or message) for a set of contacts.
 * Used by the audit wizard to auto-detect the start date for a transaction.
 *
 * @param contactIds - Array of contact IDs to search communications for
 * @param userId - The user ID who owns the communications
 * @returns ISO date string of the earliest communication, or null if none found
 */
export function getEarliestCommunicationDate(
  contactIds: string[],
  userId: string,
): string | null {
  if (!contactIds || contactIds.length === 0) {
    return null;
  }

  // Get email addresses for the contacts
  const contactEmails = dbAll<{ email: string }>(
    contactEmailsForContactsSql(contactIds.length),
    contactIds,
  );

  // Get phone numbers for the contacts
  const contactPhones = dbAll<{ phone_e164: string }>(
    contactPhonesForContactsSql(contactIds.length),
    contactIds,
  );

  let earliestEmail: string | null = null;
  let earliestMessage: string | null = null;

  // Query 1: Find earliest email matching contact email addresses.
  //
  // BACKLOG-1722: indexed exact match against the email_participants junction.
  // The previous LIKE-based scan was unindexed AND missed BCC-only emails
  // (BCC was being dropped at INSERT time — fixed in Phase 2).
  if (contactEmails.length > 0) {
    const emailParams: unknown[] = [
      userId,
      ...contactEmails.map((ce) => ce.email.toLowerCase().trim()),
    ];

    const emailResult = dbGet<{ earliest: string | null }>(
      earliestEmailSql(contactEmails.length),
      emailParams,
    );

    if (emailResult?.earliest) {
      earliestEmail = emailResult.earliest;
    }
  }

  // Query 2: Find earliest message matching contact phone numbers
  if (contactPhones.length > 0) {
    // Normalize phone numbers (strip non-digits) for participants_flat matching
    const normalizedPhones = contactPhones
      .map((cp) => cp.phone_e164.replace(/\D/g, ""))
      .filter((p) => p.length > 0);

    if (normalizedPhones.length > 0) {
      const messageResult = dbGet<{ earliest: string | null }>(
        earliestMessageSql(normalizedPhones.length),
        [userId, ...normalizedPhones],
      );

      if (messageResult?.earliest) {
        earliestMessage = messageResult.earliest;
      }
    }
  }

  // Return the earlier of the two dates
  if (earliestEmail && earliestMessage) {
    return earliestEmail < earliestMessage ? earliestEmail : earliestMessage;
  }
  return earliestEmail || earliestMessage;
}
