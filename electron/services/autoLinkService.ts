/**
 * Auto-Link Service
 *
 * Automatically links existing communications (emails and iMessages/SMS) when a
 * contact is added to a transaction. This eliminates the manual process of
 * attaching messages after adding a contact.
 *
 * @see TASK-1031
 */

import * as Sentry from "@sentry/electron/main";
import { dbAll, dbGet, dbRun } from "./db/core/dbConnection";
import logService from "./logService";
import { normalizePhone } from "./messageMatchingService";
import {
  createThreadCommunicationReference,
  isThreadLinkedToTransaction,
  getIgnoredEmailIdsForTransaction,
  getIgnoredThreadIdsForTransaction,
  getIgnoredCommunicationIdsForTransaction,
} from "./db/communicationDbService";
import { computeTransactionDateRange } from "../utils/emailDateRange";
import { normalizeAddress, type NormalizedAddress } from "../utils/addressNormalization";


// ============================================
// TYPES
// ============================================

/**
 * Options for auto-linking communications
 */
export interface AutoLinkOptions {
  /** Contact ID to link communications for */
  contactId: string;
  /** Transaction ID to link communications to */
  transactionId: string;
  /** Optional date range (if not provided, uses transaction dates or 6 months) */
  dateRange?: {
    start: Date;
    end: Date;
  };
}

/**
 * Result of auto-linking communications for a contact
 *
 * TASK-1115: Updated to track thread-level linking.
 * messagesLinked now represents threads linked, not individual messages.
 */
export interface AutoLinkResult {
  /** Number of emails successfully linked */
  emailsLinked: number;
  /** Number of message threads successfully linked (TASK-1115: thread-level) */
  messagesLinked: number;
  /** Number of communications that were already linked */
  alreadyLinked: number;
  /** Number of errors encountered */
  errors: number;
  /** BACKLOG-1364: User-facing message when address filter is ON and 0 emails found */
  addressFilterMessage?: string;
}

/**
 * Contact info needed for auto-linking
 */
interface ContactInfo {
  id: string;
  emails: string[];
  phoneNumbers: string[];
}

/**
 * Transaction info needed for auto-linking (dates + user ID + address)
 */
interface TransactionInfo {
  userId: string;
  started_at: string | null;
  created_at: string | null;
  closed_at: string | null;
  propertyAddress: string | null;
  /** BACKLOG-1364: When true, skip the address filter and link ALL emails from contacts */
  skipAddressFilter: boolean;
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Get a contact's email addresses and phone numbers
 */
async function getContactInfo(contactId: string): Promise<ContactInfo | null> {
  // Get contact to verify it exists
  const contactSql = "SELECT id FROM contacts WHERE id = ?";
  const contact = dbGet<{ id: string }>(contactSql, [contactId]);

  if (!contact) {
    return null;
  }

  // Get all email addresses for this contact
  const emailsSql = `
    SELECT email FROM contact_emails
    WHERE contact_id = ?
  `;
  const emailRows = dbAll<{ email: string }>(emailsSql, [contactId]);
  const emails = emailRows.map((r) => r.email.toLowerCase().trim());

  // Get all phone numbers for this contact
  const phonesSql = `
    SELECT phone_e164 FROM contact_phones
    WHERE contact_id = ?
  `;
  const phoneRows = dbAll<{ phone_e164: string }>(phonesSql, [contactId]);
  const phoneNumbers = phoneRows
    .map((r) => normalizePhone(r.phone_e164))
    .filter((p): p is string => p !== null);

  // BACKLOG-1340: Sentry breadcrumb for contact email resolution diagnostics
  Sentry.addBreadcrumb({
    category: "auto_link.contact_resolution",
    message: `Resolved contact info: ${emails.length} emails, ${phoneNumbers.length} phones`,
    level: "info",
    data: {
      contactId,
      emailCount: emails.length,
      phoneCount: phoneNumbers.length,
      hasEmails: emails.length > 0,
      hasPhones: phoneNumbers.length > 0,
    },
  });

  return {
    id: contactId,
    emails,
    phoneNumbers,
  };
}

/**
 * Get transaction info (dates + user ID) for auto-linking.
 * TASK-2068: Date-range computation is now delegated to computeTransactionDateRange().
 */
async function getTransactionInfo(
  transactionId: string
): Promise<TransactionInfo | null> {
  const sql = `
    SELECT
      user_id,
      started_at,
      created_at,
      closed_at,
      property_address,
      property_street,
      skip_address_filter
    FROM transactions
    WHERE id = ?
  `;

  const transaction = dbGet<{
    user_id: string;
    started_at: string | null;
    created_at: string | null;
    closed_at: string | null;
    property_address: string | null;
    property_street: string | null;
    skip_address_filter: number | null;
  }>(sql, [transactionId]);

  if (!transaction) {
    return null;
  }

  return {
    userId: transaction.user_id,
    started_at: transaction.started_at,
    created_at: transaction.created_at,
    closed_at: transaction.closed_at,
    propertyAddress: transaction.property_address || transaction.property_street || null,
    skipAddressFilter: transaction.skip_address_filter === 1,
  };
}

/**
 * Find unlinked emails matching the given email addresses.
 *
 * IMPORTANT: Emails are stored in the `communications` table (not `messages`).
 * The `messages` table is used for iMessages/SMS only.
 *
 * This function finds communications that:
 * 1. Belong to this user
 * 2. Are emails (have email_id set)
 * 3. Are NOT already linked to this transaction
 * 4. Match the contact's email addresses (sender or recipients)
 * 5. Fall within the date range
 * 6. EXCLUDES the user's own email (user shouldn't be treated as a contact)
 */
async function findEmailsByContactEmails(
  userId: string,
  emails: string[],
  transactionId: string,
  dateRange: { start: Date; end: Date },
  normalizedAddress?: NormalizedAddress | null
): Promise<string[]> {
  if (emails.length === 0) {
    return [];
  }

  // Get the user's email to exclude it from contact matching
  const userSql = "SELECT email FROM users_local WHERE id = ?";
  const userResult = dbGet<{ email: string | null }>(userSql, [userId]);
  const userEmail = userResult?.email?.toLowerCase().trim();

  // Filter out user's own email from contact emails
  // The user's email should never be treated as a contact
  const contactEmails = emails.filter((email) => {
    const normalizedEmail = email.toLowerCase().trim();
    return normalizedEmail !== userEmail;
  });

  if (contactEmails.length === 0) {
    await logService.debug(
      "No contact emails to match after filtering user's own email",
      "AutoLinkService",
      { userId, userEmail, originalEmails: emails }
    );
    return [];
  }

  // BACKLOG-1722: Use the email_participants junction for INDEXED exact
  // matching instead of LIKE scans across the denormalized columns.
  //
  // Why this fixes BACKLOG-1544 / 1549 / 1550 / 1708:
  //   - LIKE '%alice@x.com%' also matched alisa@x.com and Sender-Of-The-Day
  //     "Alice <alice@x.com>" but FAILED for some Outlook display-name forms
  //     where the address appeared only inside the structured To/Cc/Bcc fields
  //     and not in the flat columns. The junction stores one row per address
  //     in normalized lowercase form — exact match, indexed, BCC-aware.
  //   - Normalization to lowercase happens at INSERT time, so the WHERE
  //     clause is `ep.email_address IN (?, ?, ...)` against the index.
  const placeholders = contactEmails.map(() => "?").join(", ");
  const emailParams = contactEmails.map((e) => e.toLowerCase().trim());

  // TASK-2087: Optional address filter narrows results to emails mentioning
  // the property address. Uses separate LIKE conditions for street number
  // and each street name word so they can appear independently (different
  // fields, reversed order, extra spacing, etc.).
  // NOTE: address LIKE remains intentional — the property-address filter is
  // a free-text search across subject/body, not a structured participant
  // lookup, so the junction does not help here.
  let addressClause = "";
  const addressParams: string[] = [];
  if (normalizedAddress) {
    const nameWords = normalizedAddress.streetName.split(/\s+/);
    const likeParts = [
      `LOWER(e.subject || ' ' || COALESCE(e.body_plain, '')) LIKE ?`,
      ...nameWords.map(() => `LOWER(e.subject || ' ' || COALESCE(e.body_plain, '')) LIKE ?`),
    ];
    addressClause = "AND " + likeParts.join(" AND ");
    addressParams.push(`%${normalizedAddress.streetNumber}%`);
    for (const word of nameWords) addressParams.push(`%${word}%`);
  }

  // BACKLOG-1722 G5: EXPLAIN QUERY PLAN should show
  // `SEARCH email_participants USING INDEX idx_email_participants_email_address`.
  const sql = `
    SELECT DISTINCT e.id
    FROM email_participants ep
    JOIN emails e ON e.id = ep.email_id
    LEFT JOIN communications c ON c.email_id = e.id AND c.transaction_id = ?
    WHERE ep.email_address IN (${placeholders})
      AND e.user_id = ?
      AND c.id IS NULL
      AND e.sent_at >= ?
      AND e.sent_at <= ?
      ${addressClause}
    ORDER BY e.sent_at DESC
  `;

  const sqlParams: (string | number)[] = [
    transactionId,
    ...emailParams,
    userId,
    dateRange.start.toISOString(),
    dateRange.end.toISOString(),
    ...addressParams,
  ];

  const results = dbAll<{ id: string }>(sql, sqlParams);
  return results.map((r) => r.id);
}

/**
 * Message with thread information for thread-level linking
 *
 * TASK-1115: Now returns thread_id for grouping messages by conversation.
 */
interface MessageWithThread {
  id: string;
  thread_id: string | null;
}

/**
 * Find unlinked text messages matching the given phone numbers.
 *
 * TASK-1115: Now returns thread_id for thread-level linking.
 * Messages without thread_id will be linked individually (backward compat).
 */
async function findMessagesByContactPhones(
  userId: string,
  phoneNumbers: string[],
  transactionId: string,
  dateRange: { start: Date; end: Date }
): Promise<MessageWithThread[]> {
  if (phoneNumbers.length === 0) {
    return [];
  }

  // Build phone patterns for matching
  // Use participants_flat which contains normalized phone digits
  const phoneConditions = phoneNumbers
    .map(() => "m.participants_flat LIKE ?")
    .join(" OR ");

  // BACKLOG-1560: Extra param for ignored_communications SQL-level suppression
  const params: (string | number)[] = [userId, transactionId, transactionId, transactionId];

  // Add phone patterns — use last 10 digits for suffix matching.
  // participants_flat may store phones with or without country code
  // (e.g. "13609181693" vs "3609181693"), so matching on the last 10
  // digits ensures both formats are found.
  for (const phone of phoneNumbers) {
    const digits = phone.replace(/\D/g, "");
    const matchDigits = digits.length > 10 ? digits.slice(-10) : digits;
    params.push(`%${matchDigits}%`);
  }

  // Add date range
  params.push(dateRange.start.toISOString());
  params.push(dateRange.end.toISOString());

  // TASK-1115: Select DISTINCT threads to avoid missing threads due to LIMIT
  // No LIMIT — local SQLite queries are fast and we want to link all matching threads
  // TASK-2087: Address filtering removed from text messages — only applies to emails.
  // People don't put property addresses in texts.
  // BACKLOG-1560: SQL-level suppression check against ignored_communications (belt-and-suspenders).
  // This is the primary defense — prevents suppressed threads from even being returned.
  // The JS-level filter in autoLinkForContact is the backup layer.
  const sql = `
    SELECT DISTINCT m.thread_id, MIN(m.id) as id
    FROM messages m
    WHERE m.user_id = ?
      AND m.channel IN ('sms', 'imessage')
      AND m.duplicate_of IS NULL
      AND (
        m.transaction_id IS NULL
        OR m.transaction_id != ?
      )
      AND m.thread_id NOT IN (
        SELECT thread_id FROM communications
        WHERE transaction_id = ? AND thread_id IS NOT NULL
      )
      AND m.thread_id NOT IN (
        SELECT ic.thread_id FROM ignored_communications ic
        WHERE ic.transaction_id = ? AND ic.thread_id IS NOT NULL
      )
      AND (${phoneConditions})
      AND m.sent_at >= ?
      AND m.sent_at <= ?
    GROUP BY m.thread_id
    ORDER BY MAX(m.sent_at) DESC
  `;

  const results = dbAll<MessageWithThread>(sql, params);
  return results;
}

/**
 * Link an existing communication record to a transaction.
 *
 * For emails that are already in the communications table,
 * we update their transaction_id directly instead of creating
 * a new reference.
 *
 * @param communicationId - The communication record ID
 * @param transactionId - The transaction to link to
 * @param linkSource - How the link was created
 * @param linkConfidence - Confidence score
 * @returns true if linked, false if already linked to this transaction
 */
async function linkEmailToTransaction(
  emailId: string,
  transactionId: string,
  linkSource: "auto" | "manual" | "scan" = "auto",
  linkConfidence: number = 0.85
): Promise<"linked" | "already_linked" | "error"> {
  // Check if this email is already linked to this transaction via communications table
  const checkSql = `
    SELECT id, transaction_id FROM communications
    WHERE email_id = ? AND transaction_id = ?
  `;
  const existing = dbGet<{ id: string; transaction_id: string }>(checkSql, [emailId, transactionId]);

  if (existing) {
    // Already linked to this transaction
    return "already_linked";
  }

  // Get the email's user_id and thread_id to create a proper communication record.
  // BACKLOG-1718 (R3): thread_id must be propagated so unlinkCommunication can
  // expand the deletion to all sibling emails sharing the same thread.
  const emailRow = dbGet<{ user_id: string; thread_id: string | null }>(
    "SELECT user_id, thread_id FROM emails WHERE id = ?",
    [emailId]
  );

  if (!emailRow) {
    await logService.warn(
      `Email ${emailId} not found when trying to link`,
      "AutoLinkService"
    );
    return "error";
  }

  // Create a new communication record linking this email to the transaction
  const { v4: uuidv4 } = await import("uuid");
  const insertSql = `
    INSERT INTO communications (id, user_id, transaction_id, email_id, thread_id, link_source, link_confidence, linked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `;
  dbRun(insertSql, [
    uuidv4(),
    emailRow.user_id,
    transactionId,
    emailId,
    emailRow.thread_id || null,
    linkSource,
    linkConfidence,
  ]);

  return "linked";
}

// ============================================
// MAIN FUNCTION
// ============================================

/**
 * Auto-link communications for a contact added to a transaction.
 *
 * This function:
 * 1. Gets the contact's email addresses and phone numbers
 * 2. Searches for emails matching those addresses
 * 3. Searches for text messages matching those phone numbers
 * 4. Links found communications to the transaction
 * 5. Returns counts for user notification
 *
 * @param options - Auto-link options including contactId and transactionId
 * @returns Result with counts of linked communications
 */
export async function autoLinkCommunicationsForContact(
  options: AutoLinkOptions
): Promise<AutoLinkResult> {
  const { contactId, transactionId } = options;

  const result: AutoLinkResult = {
    emailsLinked: 0,
    messagesLinked: 0,
    alreadyLinked: 0,
    errors: 0,
  };

  const startTime = Date.now();

  try {
    // 1. Get contact info (emails and phone numbers)
    const contactInfo = await getContactInfo(contactId);

    if (!contactInfo) {
      await logService.warn(
        `Contact not found for auto-link: ${contactId}`,
        "AutoLinkService"
      );
      Sentry.addBreadcrumb({
        category: "auto_link.abort",
        message: "Contact not found",
        level: "warning",
        data: { contactId, transactionId },
      });
      return result;
    }

    // Skip if contact has no email or phone
    if (contactInfo.emails.length === 0 && contactInfo.phoneNumbers.length === 0) {
      await logService.debug(
        `Contact ${contactId} has no email or phone, skipping auto-link`,
        "AutoLinkService"
      );
      // BACKLOG-1340: Log when contact has no email addresses — common root cause
      Sentry.addBreadcrumb({
        category: "auto_link.abort",
        message: "Contact has no email addresses or phone numbers in contact_emails/contact_phones tables",
        level: "warning",
        data: { contactId, transactionId },
      });
      return result;
    }

    // 2. Get transaction info
    const transactionInfo = await getTransactionInfo(transactionId);

    if (!transactionInfo) {
      await logService.warn(
        `Transaction not found for auto-link: ${transactionId}`,
        "AutoLinkService"
      );
      Sentry.addBreadcrumb({
        category: "auto_link.abort",
        message: "Transaction not found",
        level: "warning",
        data: { contactId, transactionId },
      });
      return result;
    }

    // BACKLOG-1340: Log when transaction has no contacts assigned
    if (!transactionInfo.propertyAddress) {
      Sentry.addBreadcrumb({
        category: "auto_link.context",
        message: "Transaction has no property address — address filter will be skipped entirely",
        level: "info",
        data: { transactionId },
      });
    }

    const { userId } = transactionInfo;

    // 3. Determine date range for filtering
    // TASK-2068: Use canonical computeTransactionDateRange for date logic
    const dateRange: { start: Date; end: Date } = options.dateRange
      ? options.dateRange
      : computeTransactionDateRange({
          started_at: transactionInfo.started_at,
          created_at: transactionInfo.created_at,
          closed_at: transactionInfo.closed_at,
        });

    // TASK-2087: Normalize the transaction's property address for content filtering.
    // When multiple transactions share the same contacts, this helps link emails
    // to the correct transaction by checking if the email content mentions the address.
    const txnNormalizedAddress = normalizeAddress(transactionInfo.propertyAddress);

    // BACKLOG-1364: Determine effective address filter based on per-transaction toggle
    const { skipAddressFilter } = transactionInfo;

    // BACKLOG-1340: Log date range validity
    if (!dateRange.start || !dateRange.end || isNaN(dateRange.start.getTime()) || isNaN(dateRange.end.getTime())) {
      Sentry.addBreadcrumb({
        category: "auto_link.abort",
        message: "Date range is null or invalid",
        level: "warning",
        data: {
          transactionId,
          contactId,
          dateRangeStart: dateRange.start?.toISOString?.() ?? null,
          dateRangeEnd: dateRange.end?.toISOString?.() ?? null,
        },
      });
    }

    // BACKLOG-1340: Comprehensive sync trigger breadcrumb
    Sentry.addBreadcrumb({
      category: "auto_link.start",
      message: `Auto-link starting for contact`,
      level: "info",
      data: {
        contactId,
        transactionId,
        contactEmailCount: contactInfo.emails.length,
        contactPhoneCount: contactInfo.phoneNumbers.length,
        normalizedAddress: txnNormalizedAddress?.full ?? "(none)",
        skipAddressFilter,
        dateRangeStart: dateRange.start.toISOString(),
        dateRangeEnd: dateRange.end.toISOString(),
      },
    });

    await logService.info(
      `Auto-linking communications for contact ${contactId} to transaction ${transactionId}`,
      "AutoLinkService",
      {
        emails: contactInfo.emails.length,
        phones: contactInfo.phoneNumbers.length,
        normalizedAddress: txnNormalizedAddress?.full ?? null,
        skipAddressFilter,
        dateRange: {
          start: dateRange.start.toISOString(),
          end: dateRange.end.toISOString(),
        },
      }
    );

    // 4. Find matching emails (from communications table)
    // BACKLOG-1364: When skip_address_filter is ON, link ALL emails from contacts (no address filter).
    // When OFF (default), apply address filter WITHOUT silent fallback — if 0 emails match,
    // return 0 results with a user-facing message suggesting they turn off the filter.
    let emailIds: string[];
    if (skipAddressFilter) {
      // Skip address filtering — get all emails from contacts regardless of content
      emailIds = await findEmailsByContactEmails(userId, contactInfo.emails, transactionId, dateRange, null);
      await logService.debug(
        `Address filter SKIPPED (user toggle): ${emailIds.length} unfiltered emails found`,
        "AutoLinkService"
      );
    } else {
      // Apply address filter (default behavior) — NO silent fallback (BACKLOG-1364)
      emailIds = await findEmailsByContactEmails(userId, contactInfo.emails, transactionId, dateRange, txnNormalizedAddress);

      // If filter is ON and 0 emails found, set a user-facing message instead of silently widening
      if (emailIds.length === 0 && txnNormalizedAddress && contactInfo.emails.length > 0) {
        result.addressFilterMessage =
          "No emails found matching the property address. Turn off the address filter to widen the search.";
        await logService.debug(
          `Address filter ON, 0 emails matched "${txnNormalizedAddress.full}" — returning message to user (no silent fallback)`,
          "AutoLinkService"
        );
      } else if (emailIds.length > 0 && txnNormalizedAddress) {
        await logService.debug(
          `Address filter applied: ${emailIds.length} emails matched "${txnNormalizedAddress.full}"`,
          "AutoLinkService"
        );
      }
    }

    // BACKLOG-1340: Breadcrumb for auto-link matching results
    Sentry.addBreadcrumb({
      category: "auto_link.email_match",
      message: `Email matching complete: ${emailIds.length} unlinked emails found`,
      level: emailIds.length === 0 && contactInfo.emails.length > 0 ? "warning" : "info",
      data: {
        contactId,
        transactionId,
        emailsFound: emailIds.length,
        contactEmailCount: contactInfo.emails.length,
        hasAddress: !!txnNormalizedAddress,
        normalizedAddress: txnNormalizedAddress?.full ?? "(none)",
        skipAddressFilter,
        addressFilterMessage: result.addressFilterMessage ?? null,
      },
    });

    await logService.debug(
      `Found ${emailIds.length} matching emails for contact ${contactId}`,
      "AutoLinkService",
      { emailIds, contactEmails: contactInfo.emails }
    );

    // 5. Find matching text messages (from messages table)
    // Auto-linking messages to a transaction for an assigned contact is always
    // enabled. The "inferred messages" preference only gates contact *discovery*
    // from messages — it should NOT prevent linking messages for known contacts.
    // TASK-2087: Address filtering removed from text messages — only applies to emails.
    let messagesWithThreads: MessageWithThread[] = [];
    if (contactInfo.phoneNumbers.length > 0) {
      messagesWithThreads = await findMessagesByContactPhones(
        userId,
        contactInfo.phoneNumbers,
        transactionId,
        dateRange
      );

      await logService.debug(
        `Found ${messagesWithThreads.length} matching messages for contact ${contactId}`,
        "AutoLinkService",
        {
          messageCount: messagesWithThreads.length,
          contactPhones: contactInfo.phoneNumbers,
        }
      );
    }

    // 5b. BACKLOG-1560: Filter out emails and threads that the user previously unlinked.
    // This prevents deleted conversations from reappearing after re-sync.
    const ignoredEmailIds = getIgnoredEmailIdsForTransaction(transactionId);
    const ignoredThreadIds = getIgnoredThreadIdsForTransaction(transactionId);
    // BACKLOG-1560: Per-message suppression for messages without a valid thread_id
    const ignoredCommIds = getIgnoredCommunicationIdsForTransaction(transactionId);

    await logService.debug("[BACKLOG-1560] Auto-link suppression sets", "AutoLinkService", {
      transactionId,
      ignoredEmailIds: Array.from(ignoredEmailIds),
      ignoredThreadIds: Array.from(ignoredThreadIds)
    });

    await logService.debug("[BACKLOG-1560] Found message threads", "AutoLinkService", {
      count: messagesWithThreads.length,
      threads: messagesWithThreads.map(m => ({ id: m.id, thread_id: m.thread_id }))
    });

    if (ignoredEmailIds.size > 0 || ignoredThreadIds.size > 0 || ignoredCommIds.size > 0) {
      const emailCountBefore = emailIds.length;
      emailIds = emailIds.filter((id) => !ignoredEmailIds.has(id));
      const emailsSuppressed = emailCountBefore - emailIds.length;

      const threadCountBefore = messagesWithThreads.length;
      messagesWithThreads = messagesWithThreads.filter((msg) => {
        // BACKLOG-1560: Check per-message suppression (for messages with no/empty thread_id)
        if (ignoredCommIds.has(msg.id)) return false;
        // Check thread-level suppression (only for messages with a valid thread_id)
        if (msg.thread_id && msg.thread_id !== "" && ignoredThreadIds.has(msg.thread_id)) return false;
        return true;
      });
      const threadsSuppressed = threadCountBefore - messagesWithThreads.length;

      if (emailsSuppressed > 0 || threadsSuppressed > 0) {
        await logService.debug(
          `BACKLOG-1560: Suppressed ${emailsSuppressed} emails and ${threadsSuppressed} threads/messages previously unlinked by user`,
          "AutoLinkService",
          { transactionId, emailsSuppressed, threadsSuppressed }
        );
      }

      await logService.debug("[BACKLOG-1560] After suppression filter", "AutoLinkService", {
        remaining: messagesWithThreads.length, threadsSuppressed, emailsSuppressed
      });
    }

    // 6. Link emails to transaction
    // Creates communication records linking emails to the transaction
    for (const emailId of emailIds) {
      try {
        const linkResult = await linkEmailToTransaction(
          emailId,
          transactionId,
          "auto",
          0.85 // Email matching confidence
        );

        if (linkResult === "linked") {
          result.emailsLinked++;
        } else if (linkResult === "already_linked") {
          result.alreadyLinked++;
        } else {
          result.errors++;
        }
      } catch (error) {
        result.errors++;
        await logService.warn(
          `Failed to link email ${emailId}: ${error instanceof Error ? error.message : "Unknown"}`,
          "AutoLinkService"
        );
      }
    }

    // 7. Link text messages to transaction at THREAD level
    // TASK-1115: Group messages by thread_id and link once per thread
    const threadIds = new Set<string>();
    const messagesWithoutThread: string[] = [];

    for (const msg of messagesWithThreads) {
      if (msg.thread_id) {
        threadIds.add(msg.thread_id);
      } else {
        // Messages without thread_id will be skipped for now
        // They'll be picked up once thread_id is populated
        messagesWithoutThread.push(msg.id);
      }
    }

    await logService.debug(
      `Grouped ${messagesWithThreads.length} messages into ${threadIds.size} threads`,
      "AutoLinkService",
      {
        threadCount: threadIds.size,
        messagesWithoutThread: messagesWithoutThread.length,
      }
    );

    // Link each unique thread once
    for (const threadId of threadIds) {
      try {
        // Check if thread is already linked to avoid duplicates
        const alreadyLinked = await isThreadLinkedToTransaction(
          threadId,
          transactionId
        );

        if (alreadyLinked) {
          result.alreadyLinked++;
          continue;
        }

        await logService.debug("[BACKLOG-1560] LINKING thread to transaction", "AutoLinkService", {
          threadId, transactionId
        });

        await createThreadCommunicationReference(
          threadId,
          transactionId,
          userId,
          "auto",
          0.9 // Phone matching confidence
        );

        result.messagesLinked++; // Now represents threads linked
      } catch (error) {
        result.errors++;
        await logService.warn(
          `Failed to link thread ${threadId}: ${error instanceof Error ? error.message : "Unknown"}`,
          "AutoLinkService"
        );
      }
    }

    const duration = Date.now() - startTime;

    // BACKLOG-1340: Comprehensive result breadcrumb
    Sentry.addBreadcrumb({
      category: "auto_link.complete",
      message: `Auto-link complete: ${result.emailsLinked} emails, ${result.messagesLinked} threads linked`,
      level: "info",
      data: {
        contactId,
        transactionId,
        emailsLinked: result.emailsLinked,
        messagesLinked: result.messagesLinked,
        alreadyLinked: result.alreadyLinked,
        errors: result.errors,
        durationMs: duration,
      },
    });

    // BACKLOG-1340: Capture warning when auto-link finds 0 results despite having contacts with emails.
    // This is the key diagnostic for the silent failure scenario.
    if (
      result.emailsLinked === 0 &&
      result.messagesLinked === 0 &&
      result.alreadyLinked === 0 &&
      (contactInfo.emails.length > 0 || contactInfo.phoneNumbers.length > 0)
    ) {
      Sentry.captureMessage(
        `Auto-link completed with 0 results for contact with ${contactInfo.emails.length} emails and ${contactInfo.phoneNumbers.length} phones`,
        {
          level: "warning",
          tags: {
            feature: "auto_link",
            issue: "zero_results",
          },
          extra: {
            contactId,
            transactionId,
            contactEmailCount: contactInfo.emails.length,
            contactPhoneCount: contactInfo.phoneNumbers.length,
            normalizedAddress: txnNormalizedAddress?.full ?? "(none)",
            dateRangeStart: dateRange.start.toISOString(),
            dateRangeEnd: dateRange.end.toISOString(),
            durationMs: duration,
          },
        }
      );
    }

    await logService.info(
      `Auto-link complete for contact ${contactId}`,
      "AutoLinkService",
      {
        emailsLinked: result.emailsLinked,
        messagesLinked: result.messagesLinked,
        alreadyLinked: result.alreadyLinked,
        errors: result.errors,
        durationMs: duration,
      }
    );

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    await logService.error(
      `Auto-link failed for contact ${contactId}: ${errorMessage}`,
      "AutoLinkService"
    );

    return result;
  }
}

// ============================================
// AUTO-LINK AFTER MESSAGE SYNC (BACKLOG-1546)
// ============================================

/**
 * Result of running auto-link for all contact-transaction pairs for a user
 */
export interface AutoLinkNewMessagesResult {
  /** Total number of contact-transaction pairs processed */
  pairsProcessed: number;
  /** Total emails linked across all pairs */
  totalEmailsLinked: number;
  /** Total message threads linked across all pairs */
  totalMessagesLinked: number;
  /** Total already-linked items skipped */
  totalAlreadyLinked: number;
  /** Total errors across all pairs */
  totalErrors: number;
  /** Duration in milliseconds */
  durationMs: number;
}

/**
 * Debounce timer for autoLinkNewMessagesForUser.
 * Android sends messages in small batches (e.g., 100 messages in rapid succession).
 * We debounce to avoid running auto-link 100 times.
 */
let autoLinkDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const AUTO_LINK_DEBOUNCE_MS = 2000; // 2 seconds

/**
 * Auto-link new messages to transactions for all contact-transaction pairs
 * belonging to a user. Intended to be called after message import/sync completes.
 *
 * Queries all active transactions with assigned contacts for the user,
 * dedupes contact-transaction pairs, and runs autoLinkCommunicationsForContact
 * for each pair.
 *
 * BACKLOG-1546: Messages were inserted with transaction_id = NULL and never
 * auto-linked because the auto-link function was only called on contact
 * assignment, manual resync, or email sync — never after message import.
 *
 * @param userId - The user ID to auto-link messages for
 * @returns Result with counts of linked communications
 */
export async function autoLinkNewMessagesForUser(
  userId: string
): Promise<AutoLinkNewMessagesResult> {
  const startTime = Date.now();
  const result: AutoLinkNewMessagesResult = {
    pairsProcessed: 0,
    totalEmailsLinked: 0,
    totalMessagesLinked: 0,
    totalAlreadyLinked: 0,
    totalErrors: 0,
    durationMs: 0,
  };

  try {
    // Query all active transactions with assigned contacts for this user.
    // JOIN transaction_contacts to get contact-transaction pairs in one query.
    // Only include non-archived transactions (status != 'archived').
    const sql = `
      SELECT DISTINCT
        tc.contact_id,
        tc.transaction_id
      FROM transaction_contacts tc
      JOIN transactions t ON t.id = tc.transaction_id
      WHERE t.user_id = ?
        AND t.status != 'archived'
      ORDER BY tc.transaction_id
    `;

    const pairs = dbAll<{ contact_id: string; transaction_id: string }>(sql, [userId]);

    if (pairs.length === 0) {
      await logService.debug(
        "No contact-transaction pairs found for auto-link after sync",
        "AutoLinkService",
        { userId }
      );
      result.durationMs = Date.now() - startTime;
      return result;
    }

    await logService.info(
      `Auto-linking new messages for ${pairs.length} contact-transaction pairs`,
      "AutoLinkService",
      { userId, pairCount: pairs.length }
    );

    // Process each contact-transaction pair
    for (const pair of pairs) {
      try {
        const linkResult = await autoLinkCommunicationsForContact({
          contactId: pair.contact_id,
          transactionId: pair.transaction_id,
        });

        result.pairsProcessed++;
        result.totalEmailsLinked += linkResult.emailsLinked;
        result.totalMessagesLinked += linkResult.messagesLinked;
        result.totalAlreadyLinked += linkResult.alreadyLinked;
        result.totalErrors += linkResult.errors;
      } catch (error) {
        result.totalErrors++;
        await logService.warn(
          `Auto-link failed for contact ${pair.contact_id} -> transaction ${pair.transaction_id}`,
          "AutoLinkService",
          { error: error instanceof Error ? error.message : "Unknown" }
        );
      }
    }

    result.durationMs = Date.now() - startTime;

    await logService.info(
      `Auto-link after sync complete: ${result.totalEmailsLinked} emails, ${result.totalMessagesLinked} threads linked across ${result.pairsProcessed} pairs`,
      "AutoLinkService",
      {
        userId,
        ...result,
      }
    );

    Sentry.addBreadcrumb({
      category: "auto_link.post_sync",
      message: `Post-sync auto-link: ${result.totalEmailsLinked} emails, ${result.totalMessagesLinked} threads linked`,
      level: "info",
      data: {
        userId,
        pairsProcessed: result.pairsProcessed,
        totalEmailsLinked: result.totalEmailsLinked,
        totalMessagesLinked: result.totalMessagesLinked,
        totalAlreadyLinked: result.totalAlreadyLinked,
        totalErrors: result.totalErrors,
        durationMs: result.durationMs,
      },
    });

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    await logService.error(
      `Auto-link after sync failed: ${errorMessage}`,
      "AutoLinkService"
    );
    result.durationMs = Date.now() - startTime;
    return result;
  }
}

/**
 * Debounced version of autoLinkNewMessagesForUser.
 * Use this when messages arrive in rapid succession (e.g., Android WiFi sync)
 * to avoid running auto-link for every batch.
 *
 * The function waits AUTO_LINK_DEBOUNCE_MS (2s) after the last call before
 * actually running the auto-link. Subsequent calls within the window reset the timer.
 *
 * Fire-and-forget: errors are logged but not thrown.
 *
 * @param userId - The user ID to auto-link messages for
 */
export function autoLinkNewMessagesForUserDebounced(userId: string): void {
  if (autoLinkDebounceTimer) {
    clearTimeout(autoLinkDebounceTimer);
  }

  autoLinkDebounceTimer = setTimeout(() => {
    autoLinkDebounceTimer = null;
    autoLinkNewMessagesForUser(userId).catch((error) => {
      logService.error(
        `Debounced auto-link failed: ${error instanceof Error ? error.message : "Unknown"}`,
        "AutoLinkService"
      ).catch(() => { /* ignore logging errors */ });
    });
  }, AUTO_LINK_DEBOUNCE_MS);
}

export default {
  autoLinkCommunicationsForContact,
  autoLinkNewMessagesForUser,
  autoLinkNewMessagesForUserDebounced,
};
