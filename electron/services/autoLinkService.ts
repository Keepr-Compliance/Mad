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
import { unsafeSql } from "./db/core/sqlText";
import logService from "./logService";
import { normalizePhone, createCommunicationReference } from "./messageMatchingService";
import { linkMessageToTransaction } from "./db/messageDbService";
import {
  createThreadCommunicationReference,
  isThreadLinkedToTransaction,
  isMessageLinkedToTransaction,
  updateTransactionThreadCount,
  getIgnoredEmailIdsForTransaction,
  getIgnoredThreadIdsForTransaction,
  getIgnoredCommunicationIdsForTransaction,
} from "./db/communicationDbService";
import { computeTransactionDateRange } from "../utils/emailDateRange";
import { handleToIdentityToken } from "../utils/handleIdentity";
import {
  normalizeAddress,
  contentContainsAddress,
  type NormalizedAddress,
} from "../utils/addressNormalization";
import type { MatchReason } from "../types/models";
import { reactionExclusion } from "./db/reactionExclusion";
// BACKLOG-2562: the ONE definition of "is this deal live?". These queries
// previously carried `status != 'archived'`, which is a tautology ('archived'
// is not a permitted status) and therefore admitted REJECTED deals.
import { LIVE_TRANSACTION_SQL_PREDICATE } from "./transactionEligibility";
// BACKLOG-2393: scoped support-access tracing. A no-op unless a user has
// granted a support window covering the transaction-linking scope.
import { supportTrace } from "./supportAccess/trace";


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
  /**
   * BACKLOG-2791 (founder ruling, 2026-08-22): keep the SHIPPED split, and only
   * change where the ambiguous half lands.
   *
   *   false (default, every pre-existing caller) — develop's behaviour exactly:
   *     confident emails link as address_found, ambiguous ones link as
   *     address_missing and surface in the Needs-review section as a LINKED row.
   *
   *   true (the transaction-details discovery paths) — confident emails still
   *     link, but the ambiguous ones are QUEUED instead of linked. Nothing else
   *     about the classification moves: the same predicate decides, the same
   *     disambiguation still routes an email that names another candidate deal
   *     away, and texts are untouched.
   *
   * Why the ambiguous half must not link on those paths: the founder-dictated
   * popup promises "Communications that require review will only be linked after
   * you approve them." Linking them first and flagging them would make that
   * sentence false.
   */
  queueAmbiguousInsteadOfLinking?: boolean;
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
  /**
   * BACKLOG-2791: how many communications were QUEUED for review instead of
   * linked. Set only on the transaction-details discovery paths, where nothing
   * is linked without approval. Deliberately a separate field: a caller that
   * renders `emailsLinked` must never see a queued item counted as a link.
   */
  queuedForReview?: number;
  /**
   * BACKLOG-2880: how many links this pass REFUSED to write because the email
   * already holds a live pending-review row.
   *
   * Reported rather than swallowed on purpose. A guard that silently declines is
   * its own kind of surprise — the caller asked for a link and got nothing, and
   * with no counter the difference between "there was nothing to link" and "I
   * declined to link nine things" is invisible. That exact blindness is what
   * made this defect take a full log trace to find.
   */
  blockedPendingReview?: number;
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
  const contact = dbGet<{ id: string }>(unsafeSql(contactSql), [contactId]);

  if (!contact) {
    return null;
  }

  // Get all email addresses for this contact
  const emailsSql = `
    SELECT email FROM contact_emails
    WHERE contact_id = ?
  `;
  const emailRows = dbAll<{ email: string }>(unsafeSql(emailsSql), [contactId]);
  const emails = emailRows.map((r) => r.email.toLowerCase().trim());

  // Get all phone numbers for this contact
  const phonesSql = `
    SELECT phone_e164 FROM contact_phones
    WHERE contact_id = ?
  `;
  const phoneRows = dbAll<{ phone_e164: string }>(unsafeSql(phonesSql), [contactId]);
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
  }>(unsafeSql(sql), [transactionId]);

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
 * BACKLOG-2319: A candidate email for auto-linking, tagged with whether its
 * body matched the transaction's property address (and, for disambiguation,
 * whether it named a DIFFERENT candidate deal the contact is on).
 */
interface CandidateEmail {
  id: string;
  /**
   * true  = the body/subject named THIS transaction's property address,
   * false = it did not,
   * null  = there was no transaction address to check against.
   */
  addressMatched: boolean | null;
  /**
   * true = the body/subject named the address of ANOTHER (live)
   * transaction the contact is on. Such an email is disambiguated to that deal
   * and is NOT surfaced as Needs review here (it is not the "uncertain
   * contact-only" case). Always false when there are no other candidate deals.
   */
  matchesOtherCandidate: boolean;
}

/**
 * Find unlinked candidate emails matching the given email addresses, each tagged
 * with whether its content named the transaction's property address.
 *
 * IMPORTANT: Emails are stored in the `communications` table (not `messages`).
 * The `messages` table is used for iMessages/SMS only.
 *
 * BACKLOG-2319: This no longer DROPS non-matching emails. It returns ALL in-window
 * candidate emails from the contacts and reports the address match per email, so
 * the caller can link everything and classify each link (address_found vs
 * address_missing → "Needs review"). Nothing is hidden anymore.
 *
 * This function finds communications that:
 * 1. Belong to this user
 * 2. Are emails (have email_id set)
 * 3. Are NOT already linked to this transaction
 * 4. Match the contact's email addresses (sender or recipients)
 * 5. Fall within the date range
 * 6. EXCLUDES the user's own email (user shouldn't be treated as a contact)
 */
async function findCandidateEmailsWithMatch(
  userId: string,
  emails: string[],
  transactionId: string,
  dateRange: { start: Date; end: Date },
  normalizedAddress: NormalizedAddress | null,
  otherCandidateAddresses: NormalizedAddress[] = []
): Promise<CandidateEmail[]> {
  if (emails.length === 0) {
    return [];
  }

  // Get the user's email to exclude it from contact matching
  const userSql = "SELECT email FROM users_local WHERE id = ?";
  const userResult = dbGet<{ email: string | null }>(unsafeSql(userSql), [userId]);
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

  // BACKLOG-2311: Address filtering moved OUT of SQL and into JS.
  //
  // The old approach appended `LIKE '%<number>%' AND LIKE '%<word>%' ...` for
  // each street-name word. That could not canonicalize abbreviations or
  // directionals ("3414 Sapp Rd SW" never matched a stored "3414 Sapp Road
  // Southwest"), and required EVERY name word including the suffix/directional.
  // We now fetch the candidate emails (participant + date window, indexed) and
  // filter them in JS with contentContainsAddress, which canonicalizes both
  // ways and requires only the street number + distinctive name word(s).
  //
  // BACKLOG-1722 G5: EXPLAIN QUERY PLAN still shows
  // `SEARCH email_participants USING INDEX idx_email_participants_email_address`.
  const sql = `
    SELECT DISTINCT e.id, e.subject, e.body_plain
    FROM email_participants ep
    JOIN emails e ON e.id = ep.email_id
    LEFT JOIN communications c ON c.email_id = e.id AND c.transaction_id = ?
    WHERE ep.email_address IN (${placeholders})
      AND e.user_id = ?
      AND c.id IS NULL
      AND e.sent_at >= ?
      AND e.sent_at <= ?
    ORDER BY e.sent_at DESC
  `;

  const sqlParams: (string | number)[] = [
    transactionId,
    ...emailParams,
    userId,
    dateRange.start.toISOString(),
    dateRange.end.toISOString(),
  ];

  const results = dbAll<{ id: string; subject: string | null; body_plain: string | null }>(
    unsafeSql(sql),
    sqlParams
  );

  // No address to check → every candidate is address-unknowable (addressMatched
  // = null); the caller treats these as address_found (nothing to review). With
  // no address on this deal we can't disambiguate, so matchesOtherCandidate=false.
  if (!normalizedAddress) {
    return results.map((r) => ({ id: r.id, addressMatched: null, matchesOtherCandidate: false }));
  }

  // BACKLOG-2311 matcher, BACKLOG-2319 classification: report the match per
  // email instead of dropping the misses. Combine subject + body so the number
  // and name words can appear in either. Also flag emails that clearly name a
  // DIFFERENT candidate deal (disambiguation) so they aren't shown as Needs
  // review here.
  return results.map((r) => {
    const content = `${r.subject ?? ""} ${r.body_plain ?? ""}`;
    return {
      id: r.id,
      addressMatched: contentContainsAddress(content, normalizedAddress),
      matchesOtherCandidate: otherCandidateAddresses.some((addr) =>
        contentContainsAddress(content, addr)
      ),
    };
  });
}

/**
 * BACKLOG-2311: Count how many LIVE transactions this contact is assigned to
 * for the user. When a contact belongs to only ONE candidate transaction there
 * is no other deal to disambiguate against, so no other-candidate addresses are
 * gathered. Two or more transactions sharing the contact is exactly the
 * multi-candidate case the address filter exists to disambiguate.
 *
 * BACKLOG-2562: a REJECTED deal is not a candidate. Counting it inflated the
 * candidate count and pulled a dead deal's address into the disambiguation set.
 * Exported so the eligibility contract can be asserted per-site.
 */
export function countContactCandidateTransactions(userId: string, contactId: string): number {
  const sql = `
    SELECT COUNT(DISTINCT tc.transaction_id) AS cnt
    FROM transaction_contacts tc
    JOIN transactions t ON t.id = tc.transaction_id
    WHERE tc.contact_id = ?
      AND t.user_id = ?
      AND ${LIVE_TRANSACTION_SQL_PREDICATE}
      AND tc.removed_at IS NULL
  `;
  const row = dbGet<{ cnt: number }>(unsafeSql(sql), [contactId, userId]);
  return row?.cnt ?? 0;
}

/**
 * BACKLOG-2319: The property addresses of the OTHER LIVE transactions this
 * contact is on (excluding the current one). Used to disambiguate: an email
 * that clearly names one of these belongs to that deal, so it is NOT surfaced as
 * "Needs review" on the current transaction.
 *
 * BACKLOG-2562: a REJECTED deal's address must NOT appear here. It did, and the
 * effect was that an email naming a deal the user had already rejected was
 * routed away from the live deal it actually belonged to. Exported so the
 * eligibility contract can be asserted per-site.
 */
export function getOtherCandidateTransactionAddresses(
  userId: string,
  contactId: string,
  transactionId: string
): string[] {
  const sql = `
    SELECT DISTINCT COALESCE(t.property_address, t.property_street) AS address
    FROM transaction_contacts tc
    JOIN transactions t ON t.id = tc.transaction_id
    WHERE tc.contact_id = ?
      AND t.user_id = ?
      AND ${LIVE_TRANSACTION_SQL_PREDICATE}
      AND t.id != ?
      AND tc.removed_at IS NULL
      AND COALESCE(t.property_address, t.property_street) IS NOT NULL
  `;
  return dbAll<{ address: string }>(unsafeSql(sql), [contactId, userId, transactionId])
    .map((r) => r.address)
    .filter((a): a is string => !!a);
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
  // (e.g. "12065550142" vs "2065550142"), so matching on the last 10
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
      AND ${reactionExclusion("m")}
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

  const results = dbAll<MessageWithThread>(unsafeSql(sql), params);
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
export async function linkEmailToTransaction(
  emailId: string,
  transactionId: string,
  linkSource: "auto" | "manual" | "scan" = "auto",
  linkConfidence: number = 0.85,
  matchReason: MatchReason = "address_found"
): Promise<"linked" | "already_linked" | "pending_review" | "error"> {
  // Check if this email is already linked to this transaction via communications table
  const checkSql = `
    SELECT id, transaction_id FROM communications
    WHERE email_id = ? AND transaction_id = ?
  `;
  const existing = dbGet<{ id: string; transaction_id: string }>(unsafeSql(checkSql), [emailId, transactionId]);

  if (existing) {
    // Already linked to this transaction. BACKLOG-2319: intentionally leave the
    // existing match_reason untouched — a re-sync must not clobber a
    // user_confirmed link back to address_missing (idempotent + preserves the
    // user's decision).
    return "already_linked";
  }

  // BACKLOG-2880: AN AUTOMATIC PASS MAY NOT LINK WHAT REVIEW ALREADY OWNS.
  //
  // Observed on the founder's machine: the deal surface queued nine emails at
  // 15:28:46, and the "Sync Emails" button linked the same nine at 15:29:11 —
  // 25 seconds later, as address_missing, with no approval. The founder's
  // standing rule is that nothing is ever silently linked; it is why
  // BACKLOG-2791 exists. A pending row means a human has been asked to decide,
  // and a background classifier does not get to decide it for them.
  //
  // It ALSO closes the BACKLOG-2831 twin at its source: this function never
  // deleted the pending row, so the linked email landed in both stores and the
  // union had to dedup it. Nothing writes that twin any more.
  //
  // SCOPED TO "auto" DELIBERATELY. `approveReviewItems` links with "manual" and
  // deletes the pending row AFTERWARDS, so an unscoped guard would make approval
  // itself a silent no-op — the guard would break the feature it defends. A
  // manual link is a human's explicit act and is exactly what is allowed to
  // resolve a pending item.
  //
  // The flag at each deal-surface trigger is still the primary fix; this is the
  // backstop for callers nobody enumerated — `autoLinkNewMessagesForUser` above
  // all, which sweeps every live contact-transaction pair after any message
  // import and, by the founder's scope decision, never carries the flag.
  //
  // The lookup is delegated to reviewStateService rather than run here.
  // BACKLOG-2791 made that service the ONLY reader of the pending store, and
  // `reviewStateService.singleReadPath` fails on a second SELECT anywhere —
  // correctly, because a write-time interlock is exactly the sort of "I just
  // need one quick count" query the rule exists to stop. Dynamically imported
  // for the same reason the queue call below is: reviewStateService imports this
  // module for `linkEmailToTransaction`.
  if (linkSource === "auto") {
    const { isEmailAwaitingReview } = await import("./reviewStateService");
    if (isEmailAwaitingReview(transactionId, emailId)) {
      await logService.debug(
        `BACKLOG-2880: refused to auto-link email ${emailId} — it is awaiting review on this transaction`,
        "AutoLinkService",
        { transactionId, emailId, linkSource, matchReason }
      );
      return "pending_review";
    }
  }

  // Get the email's user_id and thread_id to create a proper communication record.
  // BACKLOG-1718 (R3): thread_id must be propagated so unlinkCommunication can
  // expand the deletion to all sibling emails sharing the same thread.
  const emailRow = dbGet<{ user_id: string; thread_id: string | null }>(
    unsafeSql("SELECT user_id, thread_id FROM emails WHERE id = ?"),
    [emailId]
  );

  if (!emailRow) {
    await logService.warn(
      `Email ${emailId} not found when trying to link`,
      "AutoLinkService"
    );
    return "error";
  }

  // Create a new communication record linking this email to the transaction.
  // BACKLOG-2319: persist match_reason so the Emails tab can split Needs-review
  // (address_missing) from Linked (address_found / manual / user_confirmed).
  const { v4: uuidv4 } = await import("uuid");
  const insertSql = `
    INSERT INTO communications (id, user_id, transaction_id, email_id, thread_id, link_source, link_confidence, match_reason, linked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `;
  dbRun(unsafeSql(insertSql), [
    uuidv4(),
    emailRow.user_id,
    transactionId,
    emailId,
    emailRow.thread_id || null,
    linkSource,
    linkConfidence,
    matchReason,
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

    // BACKLOG-2319: the legacy skip_address_filter toggle is retired — it no
    // longer influences linking (emails are always linked and classified). It is
    // still read here purely for observability in the breadcrumbs/logs below.
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

    // 4. Find candidate emails and classify each by address match.
    // BACKLOG-2338: The address check applies to ALL assigned contacts — there
    // is NO single-candidate bypass. For every in-window candidate email we
    // record WHY it was classified:
    //   - no transaction address to check          → address_found (Linked)
    //   - body/subject names THIS deal's address   → address_found (Linked)
    //   - body/subject names ANOTHER of the         → SKIP (routed to that deal)
    //       contact's candidate deals
    //   - otherwise (address exists but this email  → address_missing → surfaces
    //     never named it)                              in the "Needs review" section
    // BACKLOG-2338 rationale: the retired single-candidate rule marked EVERY
    // in-window email from a contact on ≤1 live deal as confident
    // "Linked" — so a shared professional (e.g. a lender on 4 deals) assigned to
    // ONE Keepr deal had all their emails linked here, including emails about
    // OTHER properties, and Needs review never populated. Non-address emails now
    // route to Needs review for the user to confirm or remove. singleCandidate /
    // otherCandidateAddresses below are still gathered — they no longer gate
    // confidence; they only supply the OTHER deals' addresses for multi-deal
    // disambiguation. The legacy skip_address_filter column is no longer
    // consulted (see the retired toggle).
    const candidateTxnCount = countContactCandidateTransactions(userId, contactId);
    const singleCandidate = candidateTxnCount <= 1;

    // BACKLOG-2319: when the contact is shared across deals, gather the OTHER
    // deals' addresses so an email that clearly names one of them is routed
    // there (disambiguation) rather than surfaced as Needs review here.
    const otherCandidateAddresses: NormalizedAddress[] = singleCandidate
      ? []
      : getOtherCandidateTransactionAddresses(userId, contactId, transactionId)
          .map((a) => normalizeAddress(a))
          .filter((a): a is NormalizedAddress => a !== null);

    let emailCandidates = await findCandidateEmailsWithMatch(
      userId,
      contactInfo.emails,
      transactionId,
      dateRange,
      txnNormalizedAddress,
      otherCandidateAddresses
    );

    // BACKLOG-1340: Breadcrumb for auto-link matching results
    const needsReviewCount = emailCandidates.filter(
      (c) => c.addressMatched === false && !c.matchesOtherCandidate
    ).length;
    Sentry.addBreadcrumb({
      category: "auto_link.email_match",
      message: `Email matching complete: ${emailCandidates.length} candidate emails (${needsReviewCount} needs-review)`,
      level: emailCandidates.length === 0 && contactInfo.emails.length > 0 ? "warning" : "info",
      data: {
        contactId,
        transactionId,
        emailsFound: emailCandidates.length,
        needsReviewCount,
        singleCandidate,
        contactEmailCount: contactInfo.emails.length,
        hasAddress: !!txnNormalizedAddress,
        normalizedAddress: txnNormalizedAddress?.full ?? "(none)",
      },
    });

    await logService.debug(
      `Found ${emailCandidates.length} candidate emails for contact ${contactId} (${needsReviewCount} needs-review)`,
      "AutoLinkService",
      { emailIds: emailCandidates.map((c) => c.id), contactEmails: contactInfo.emails }
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
      const emailCountBefore = emailCandidates.length;
      emailCandidates = emailCandidates.filter((c) => !ignoredEmailIds.has(c.id));
      const emailsSuppressed = emailCountBefore - emailCandidates.length;

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

    // 6. Link emails to transaction.
    // BACKLOG-2338: classify each candidate. The address check applies to ALL
    // assigned contacts (no single-candidate bypass):
    //   - names THIS deal's address / no txn address → address_found (Linked)
    //   - names ANOTHER candidate deal's address      → SKIP (routed there)
    //   - otherwise (address exists, named no deal)   → address_missing
    //                                                    (Needs review)
    // Lower the link confidence for the ambiguous ones so downstream signals
    // reflect the doubt.
    let disambiguatedAway = 0;
    for (const candidate of emailCandidates) {
      const isConfident =
        candidate.addressMatched === true ||
        candidate.addressMatched === null;

      if (!isConfident && candidate.matchesOtherCandidate) {
        // Belongs to a different deal the contact is on — don't attach here.
        disambiguatedAway++;
        continue;
      }

      const matchReason: MatchReason = isConfident ? "address_found" : "address_missing";
      const linkConfidence = matchReason === "address_missing" ? 0.5 : 0.85;

      // The ONE divergence from develop, and only on the details-discovery
      // paths: the ambiguous half is queued rather than linked.
      if (!isConfident && options.queueAmbiguousInsteadOfLinking) {
        try {
          const { queueEmailForReview } = await import("./reviewStateService");
          if (await queueEmailForReview(transactionId, candidate.id, userId)) {
            result.queuedForReview = (result.queuedForReview ?? 0) + 1;
          } else {
            result.alreadyLinked++;
          }
        } catch (error) {
          result.errors++;
          await logService.warn(
            `Failed to queue email ${candidate.id} for review: ${error instanceof Error ? error.message : "Unknown"}`,
            "AutoLinkService",
          );
        }
        continue;
      }

      try {
        const linkResult = await linkEmailToTransaction(
          candidate.id,
          transactionId,
          "auto",
          linkConfidence,
          matchReason
        );

        if (linkResult === "linked") {
          result.emailsLinked++;
        } else if (linkResult === "already_linked") {
          result.alreadyLinked++;
        } else if (linkResult === "pending_review") {
          // BACKLOG-2880: refused, not failed. Counting it as an error would
          // send the next investigation looking for a broken write.
          result.blockedPendingReview = (result.blockedPendingReview ?? 0) + 1;
        } else {
          result.errors++;
        }
      } catch (error) {
        result.errors++;
        await logService.warn(
          `Failed to link email ${candidate.id}: ${error instanceof Error ? error.message : "Unknown"}`,
          "AutoLinkService"
        );
      }
    }

    if (disambiguatedAway > 0) {
      await logService.debug(
        `BACKLOG-2319: ${disambiguatedAway} candidate email(s) routed to a different deal the contact is on (not attached here)`,
        "AutoLinkService",
        { transactionId, contactId, disambiguatedAway }
      );
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
        queuedForReview: result.queuedForReview ?? 0,
        blockedPendingReview: result.blockedPendingReview ?? 0,
        errors: result.errors,
        durationMs: duration,
      },
    });

    // BACKLOG-1340: Capture warning when auto-link finds 0 results despite having contacts with emails.
    // This is the key diagnostic for the silent failure scenario.
    //
    // BACKLOG-2880: queued and refused communications count as RESULTS. A pass
    // that queues nine emails for review found nine emails; reporting it as
    // "0 results" is the same blind spot as the completion log below, and it
    // sends the next investigation looking for a matcher that never ran.
    if (
      result.emailsLinked === 0 &&
      result.messagesLinked === 0 &&
      result.alreadyLinked === 0 &&
      (result.queuedForReview ?? 0) === 0 &&
      (result.blockedPendingReview ?? 0) === 0 &&
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

    // BACKLOG-2880: `queuedForReview` and `blockedPendingReview` are reported
    // HERE, not just in the result object. Their absence is why the founder's
    // three-pass collision took a full log trace to find: the pass that queued
    // nine emails logged `emailsLinked: 0, alreadyLinked: 0` and read as a
    // no-op, so the pass that linked them 25 seconds later looked like the only
    // thing that had ever happened.
    await logService.info(
      `Auto-link complete for contact ${contactId}`,
      "AutoLinkService",
      {
        emailsLinked: result.emailsLinked,
        messagesLinked: result.messagesLinked,
        alreadyLinked: result.alreadyLinked,
        queuedForReview: result.queuedForReview ?? 0,
        blockedPendingReview: result.blockedPendingReview ?? 0,
        errors: result.errors,
        durationMs: duration,
      }
    );

    // BACKLOG-2393: the auto-linking decision, not just its outcome. "Why did
    // this email land on the wrong deal, or in review instead of on the deal?"
    // needs to know how many transactions were in the running and how the
    // address comparison resolved between them — a linked count alone says
    // nothing about the ones that were considered and rejected. Counts and
    // decisions only; no address strings or message bodies. A no-op outside a
    // granted support window.
    supportTrace("transaction-linking", "auto-link-contact-complete", {
      contact_id: contactId,
      transaction_id: transactionId,
      candidate_transactions: candidateTxnCount,
      single_candidate: singleCandidate,
      other_candidate_addresses: otherCandidateAddresses.length,
      address_filter_skipped: skipAddressFilter,
      email_candidates: emailCandidates.length,
      emails_linked: result.emailsLinked,
      threads_linked: result.messagesLinked,
      already_linked: result.alreadyLinked,
      queued_for_review: result.queuedForReview ?? 0,
      blocked_pending_review: result.blockedPendingReview ?? 0,
      sent_to_review: needsReviewCount,
      disambiguated_to_other_deal: disambiguatedAway,
      thread_ids_examined: threadIds.size,
      messages_without_thread: messagesWithoutThread.length,
      errors: result.errors,
      duration_ms: duration,
    });

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
    // Query all LIVE transactions with assigned contacts for this user.
    // JOIN transaction_contacts to get contact-transaction pairs in one query.
    //
    // BACKLOG-2562: the filter here was `status != 'archived'` — a tautology, so
    // every REJECTED deal was processed on every sync and kept receiving mail
    // the user had already said did not belong to a transaction.
    //
    // BACKLOG-2366: `tc.removed_at IS NULL` is the negative-signal enforcement
    // point. This loop is what pulls newly-synced mail and messages into a deal
    // on behalf of each assigned contact. Without the filter, a party the user
    // removed would keep dragging their communications back into the transaction
    // on every sync — the same failure `ignored_communications` prevents for
    // individually unlinked emails.
    const sql = `
      SELECT DISTINCT
        tc.contact_id,
        tc.transaction_id
      FROM transaction_contacts tc
      JOIN transactions t ON t.id = tc.transaction_id
      WHERE t.user_id = ?
        AND ${LIVE_TRANSACTION_SQL_PREDICATE}
        AND tc.removed_at IS NULL
      ORDER BY tc.transaction_id
    `;

    const pairs = dbAll<{ contact_id: string; transaction_id: string }>(unsafeSql(sql), [userId]);

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

    // BACKLOG-2393: the post-sync sweep. `pairs.length` vs `pairsProcessed` is
    // the difference between "we looked and found nothing" and "we never
    // looked", which is the ambiguity this whole scope exists to remove.
    supportTrace("transaction-linking", "auto-link-post-sync-complete", {
      pairs_enumerated: pairs.length,
      pairs_processed: result.pairsProcessed,
      emails_linked: result.totalEmailsLinked,
      threads_linked: result.totalMessagesLinked,
      already_linked: result.totalAlreadyLinked,
      errors: result.totalErrors,
      duration_ms: result.durationMs,
    });

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
    // BACKLOG-2285: after the debounced auto-link settles, expand attached
    // conversations so backfilled/older messages (e.g. Android WiFi sync of
    // older history) are picked up. This is the localSyncService post-sync path;
    // it runs here (rather than per-batch at the call site) to inherit the same
    // debounce that batches rapid Android message bursts.
    autoLinkNewMessagesForUser(userId)
      .catch((error) => {
        logService.error(
          `Debounced auto-link failed: ${error instanceof Error ? error.message : "Unknown"}`,
          "AutoLinkService"
        ).catch(() => { /* ignore logging errors */ });
      })
      // Match the handler sites: run expansion via .finally so it fires even if
      // auto-link rejected, and stays fire-and-forget.
      .finally(() => {
        expandAttachedThreadsForUser(userId).catch((error) => {
          logService.error(
            `Debounced attached-thread expansion failed: ${error instanceof Error ? error.message : "Unknown"}`,
            "AutoLinkService"
          ).catch(() => { /* ignore logging errors */ });
        });
      });
  }, AUTO_LINK_DEBOUNCE_MS);
}

// ============================================
// ATTACHED-THREAD BACKFILL EXPANSION (BACKLOG-2285)
// ============================================

/**
 * Result of expandAttachedThreadsForUser.
 */
export interface ExpandAttachedThreadsResult {
  /** Number of attached (transaction, thread) pairs examined */
  pairsExamined: number;
  /** Number of individual messages newly linked */
  messagesLinked: number;
  /** Candidate messages skipped because the user had removed the thread/message */
  skippedSuppressed: number;
  /** Candidate messages skipped because they were already linked (idempotency) */
  skippedAlreadyLinked: number;
  /** Errors encountered while linking */
  errors: number;
  /** Duration in milliseconds */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// BACKLOG-2287: direction-aware thread identity (cross-thread expansion gate).
//
// `isPhoneLikeHandle` / `handleToIdentityToken` USED TO LIVE HERE. BACKLOG-2854
// moved them, unchanged, to `electron/utils/handleIdentity.ts`, because search
// needed the same question answered ("are these two handles the same person?")
// and a second normalization invented next door is how two callers start
// disagreeing about who is in a conversation. They are still the self-contained
// electron mirror of the renderer's getHandleMergeKey
// (src/utils/threadMergeUtils.ts) and are still NOT imported across the renderer
// boundary — that file's header carries the reasoning.
//
// What remains here is the part that is genuinely autoLink's: reading a
// message's DIRECTION to decide which end of it names the contact.
// ---------------------------------------------------------------------------

/**
 * Compute the DIRECTION-AWARE set of external (non-user) identity tokens for a
 * thread from its messages' `participants` JSON.
 *
 * - inbound  → take `from` only (the contact; `to` is the user's own handle)
 * - outbound → take `to`   only (the contact; `from` is the user's own handle)
 * - always   → take `chat_members` (authoritative group signal — present only when
 *              the chat has >1 member, so it never pollutes a genuine 1:1 and
 *              always inflates a group to >1 identity).
 *
 * A genuine 1:1 thread therefore resolves to EXACTLY ONE token; a group resolves
 * to >1 (the C1 gate) even if only one member has spoken in our data.
 */
function computeThreadIdentitySet(
  rows: Array<{ direction: string | null; participants: string | null }>,
): Set<string> {
  const tokens = new Set<string>();
  for (const row of rows) {
    if (!row.participants) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.participants);
    } catch {
      continue; // skip invalid JSON (mirrors renderer)
    }
    if (!parsed || typeof parsed !== "object") continue;
    const p = parsed as { from?: unknown; to?: unknown; chat_members?: unknown };

    if (Array.isArray(p.chat_members)) {
      for (const m of p.chat_members) {
        const t = handleToIdentityToken(String(m));
        if (t) tokens.add(t);
      }
    }
    if (row.direction === "inbound" && typeof p.from === "string") {
      const t = handleToIdentityToken(p.from);
      if (t) tokens.add(t);
    }
    if (row.direction === "outbound" && p.to !== null && p.to !== undefined) {
      const toList = Array.isArray(p.to) ? p.to : [p.to];
      for (const raw of toList) {
        const t = handleToIdentityToken(String(raw));
        if (t) tokens.add(t);
      }
    }
  }
  return tokens;
}

/**
 * BACKLOG-2285: Expand attached conversations to pick up backfilled/older
 * messages imported AFTER the user manually attached the thread.
 *
 * Root cause: manual "Attach Texts" freezes the junction at attach time — it
 * persists a per-message communications row only for the messages that existed
 * then. Older messages imported later by the BACKLOG-2276/2262 audit-window
 * widening share the same thread but have no junction row, so the attached view
 * (submissionDbService.getTransactionMessages / getCommunicationsWithMessages)
 * never shows them. The post-import auto-link cannot heal this: its candidate
 * query (findMessagesByContactPhones) has a date floor (transaction started_at)
 * that excludes older backfill, and it only inspects thread-level links — blind
 * to the per-message manual links.
 *
 * This runs AFTER the existing post-import auto-link and, for every MANUALLY
 * attached conversation (per-message links only — see below), links its
 * currently-unlinked SIBLING text messages (same thread_id) with NO date floor —
 * the user already chose to attach the whole conversation. It honors the exact
 * suppression sets auto-link honors (ignored threads + ignored messages), so
 * anything the user removed stays removed. Idempotent: a re-run with nothing new
 * links 0 (guarded by isMessageLinkedToTransaction + the idx_comm_msg_txn unique
 * index backstop).
 *
 * CROSS-THREAD EXPANSION (BACKLOG-2287): after the sibling pass, for every
 * attached thread that is ITSELF a 1:1 conversation, this also links the same
 * contact's currently-unlinked backfill that lives under a DIFFERENT internal
 * thread_id (the macOS multi-chat_id / Romina reality, BACKLOG-2263). It is gated
 * by two invariants that the first attempt (PR #2073 SR review) got wrong:
 *   - DIRECTION-AWARE identity (C2): macOS import writes the user's OWN handle
 *     (userAccountLogin) into outbound `from` / inbound `to`
 *     (macOSMessagesImportService.ts). We mirror the renderer's direction-aware
 *     getExternalParticipants (src/utils/threadMergeUtils.ts) — `from` only on
 *     inbound, `to` only on outbound, always chat_members — so the user's own
 *     handle is excluded WITHOUT needing to know it and a genuine 1:1 resolves to
 *     EXACTLY ONE external identity. A naive from+to+chat_members identity would
 *     see (contact + user) = 2 identities on real macOS data and never fire.
 *   - GROUP GATE (C1, worst failure mode): a candidate message is accepted ONLY
 *     when its thread ITSELF resolves (direction-aware) to exactly the pooled 1:1
 *     identity. A group chat that merely contains the contact resolves to >1
 *     identity and is rejected wholesale — its other members' messages never enter
 *     a compliance export. This mirrors getContactMergeKey returning null for
 *     groups (threadMergeUtils.ts).
 * Matching is done via a thread -> identity map compared for EQUALITY on the full
 * identity token (never a bare participants_flat LIKE), which also neutralizes the
 * short-token substring risk and avoids an unindexable leading-% full scan.
 * Suppression, reaction exclusion (BACKLOG-2280), and idempotency apply to the
 * cross-thread candidates exactly as they do to siblings.
 *
 * Scoped to per-message (manual-attach) links only: thread-level (auto-link)
 * attaches already surface backfill via the c.thread_id join in
 * getTransactionMessages, and converting them to per-message rows every sync
 * would break thread-level unlink semantics (deleteCommunicationByThread only
 * removes thread rows) — a removed conversation could stay linked.
 *
 * @param userId - The user whose attached conversations to expand
 * @returns Counts for observable verification (BACKLOG-1875)
 */
export async function expandAttachedThreadsForUser(
  userId: string
): Promise<ExpandAttachedThreadsResult> {
  const startTime = Date.now();
  const result: ExpandAttachedThreadsResult = {
    pairsExamined: 0,
    messagesLinked: 0,
    skippedSuppressed: 0,
    skippedAlreadyLinked: 0,
    errors: 0,
    durationMs: 0,
  };

  try {
    // 1. Enumerate every MANUALLY attached (transaction, thread) TEXT pair.
    //    Scoped to per-message links (c.message_id IS NOT NULL): thread-level
    //    (auto-link) attaches already surface their whole thread via the
    //    c.thread_id join in getTransactionMessages, so expanding them would only
    //    convert thread-links into per-message rows and break thread-level unlink
    //    (BACKLOG-2285 SR review, I1). This also keeps the candidate lookup on an
    //    indexed thread_id equality (no LIKE scan).
    const pairSql = `
      SELECT DISTINCT
        c.transaction_id AS transaction_id,
        m.thread_id AS thread_id
      FROM communications c
      JOIN messages m ON m.id = c.message_id
      WHERE c.user_id = ?
        AND c.transaction_id IS NOT NULL
        AND c.message_id IS NOT NULL
        AND m.thread_id IS NOT NULL
        AND m.thread_id != ''
    `;
    const pairs = dbAll<{ transaction_id: string; thread_id: string }>(unsafeSql(pairSql), [userId]);
    result.pairsExamined = pairs.length;

    if (pairs.length === 0) {
      result.durationMs = Date.now() - startTime;
      return result;
    }

    // Group attached thread_ids by transaction so suppression sets load once each.
    const threadsByTxn = new Map<string, Set<string>>();
    for (const p of pairs) {
      let set = threadsByTxn.get(p.transaction_id);
      if (!set) {
        set = new Set<string>();
        threadsByTxn.set(p.transaction_id, set);
      }
      set.add(p.thread_id);
    }

    // BACKLOG-2287: Build a thread -> direction-aware external-identity map for ALL
    // of the user's text threads, then index the 1:1 threads (identity size === 1)
    // by identity token. Cross-thread expansion matches on THIS map (equality on the
    // full token — never a per-message participants_flat LIKE), which both avoids an
    // unindexable leading-% full scan and neutralizes the short-token substring risk.
    // Identity is computed from ALL of a thread's messages (linked or not) so the
    // 1:1-vs-group classification sees the whole conversation. Built here (after the
    // pairs early-return) so it only runs when there is attached work to expand.
    const identityRows = dbAll<{
      thread_id: string;
      direction: string | null;
      participants: string | null;
    }>(
      unsafeSql(`SELECT thread_id, direction, participants
         FROM messages
        WHERE user_id = ?
          AND channel IN ('sms', 'imessage')
          AND duplicate_of IS NULL
          AND thread_id IS NOT NULL
          AND thread_id != ''`),
      [userId],
    );
    const rowsByThread = new Map<
      string,
      Array<{ direction: string | null; participants: string | null }>
    >();
    for (const r of identityRows) {
      let arr = rowsByThread.get(r.thread_id);
      if (!arr) {
        arr = [];
        rowsByThread.set(r.thread_id, arr);
      }
      arr.push({ direction: r.direction, participants: r.participants });
    }
    const threadIdentity = new Map<string, Set<string>>();
    const oneToOneThreadsByToken = new Map<string, Set<string>>();
    for (const [tid, rws] of rowsByThread) {
      const idSet = computeThreadIdentitySet(rws);
      threadIdentity.set(tid, idSet);
      if (idSet.size === 1) {
        const token = [...idSet][0];
        let s = oneToOneThreadsByToken.get(token);
        if (!s) {
          s = new Set<string>();
          oneToOneThreadsByToken.set(token, s);
        }
        s.add(tid);
      }
    }

    for (const [transactionId, attachedThreadIds] of threadsByTxn) {
      // 6. Suppression sets for THIS transaction — identical to the ones
      //    autoLinkCommunicationsForContact honors. A conversation/message the
      //    user removed stays removed.
      const ignoredThreadIds = getIgnoredThreadIdsForTransaction(transactionId);
      const ignoredCommIds = getIgnoredCommunicationIdsForTransaction(transactionId);

      // messageId -> thread_id, deduped across sibling discovery.
      const candidates = new Map<string, string | null>();

      for (const threadId of attachedThreadIds) {
        // A fully-removed thread never appears here (its junction row is gone),
        // but guard defensively so a removed conversation is never resurrected.
        if (ignoredThreadIds.has(threadId)) continue;

        // 2. Sibling expansion: unlinked messages sharing this thread_id, NO date
        //    floor (the date floor is exactly what hid the backfill).
        // BACKLOG-2280: exclude tapback/reaction rows. Without this, an unlinked
        // reaction sharing an attached thread would be given a transaction_id + a
        // communications junction row on the expansion re-sync (BACKLOG-2293),
        // polluting the compliance junction (and getMessagesByTransaction). The
        // reaction still renders as a pill via the thread-join in
        // getCommunicationsWithMessages, so nothing is hidden.
        const siblingSql = `
          SELECT m.id AS id, m.thread_id AS thread_id
          FROM messages m
          WHERE m.user_id = ?
            AND m.thread_id = ?
            AND m.transaction_id IS NULL
            AND m.channel IN ('sms', 'imessage')
            AND m.duplicate_of IS NULL
            AND ${reactionExclusion("m")}
        `;
        const siblings = dbAll<{ id: string; thread_id: string | null }>(unsafeSql(siblingSql), [
          userId,
          threadId,
        ]);
        for (const s of siblings) candidates.set(s.id, s.thread_id);
      }

      // 3. BACKLOG-2287 cross-thread expansion. Pool the 1:1 contact identity of
      //    every attached thread that IS a 1:1 (direction-aware, size === 1) — group
      //    attached threads are skipped entirely (C1). Removed conversations never
      //    contribute a pooled token (their ignored thread is skipped).
      const pooledTokens = new Set<string>();
      for (const threadId of attachedThreadIds) {
        if (ignoredThreadIds.has(threadId)) continue;
        const idSet = threadIdentity.get(threadId);
        if (idSet && idSet.size === 1) pooledTokens.add([...idSet][0]);
      }

      if (pooledTokens.size > 0) {
        // Constituent candidate threads: threads that are THEMSELVES 1:1 for a pooled
        // token (the C1 group gate — a group merely containing the contact resolves
        // to >1 identity and is absent from oneToOneThreadsByToken), excluding this
        // txn's already-attached threads (siblings handled above) and any thread the
        // user removed for this txn (suppression, for BOTH target and constituents).
        const candidateThreadIds = new Set<string>();
        for (const token of pooledTokens) {
          const threads = oneToOneThreadsByToken.get(token);
          if (!threads) continue;
          for (const tid of threads) {
            if (attachedThreadIds.has(tid)) continue;
            if (ignoredThreadIds.has(tid)) continue;
            candidateThreadIds.add(tid);
          }
        }

        if (candidateThreadIds.size > 0) {
          const tids = [...candidateThreadIds];
          const placeholders = tids.map(() => "?").join(", ");
          // Same candidate shape as the sibling pass: unlinked, text, non-duplicate,
          // reactions excluded (BACKLOG-2280 — a reaction must never be auto-linked
          // into the compliance junction). No date floor — this is backfill history.
          const crossSql = `
            SELECT m.id AS id, m.thread_id AS thread_id
            FROM messages m
            WHERE m.user_id = ?
              AND m.thread_id IN (${placeholders})
              AND m.transaction_id IS NULL
              AND m.channel IN ('sms', 'imessage')
              AND m.duplicate_of IS NULL
              AND ${reactionExclusion("m")}
          `;
          const crossMsgs = dbAll<{ id: string; thread_id: string | null }>(unsafeSql(crossSql), [
            userId,
            ...tids,
          ]);
          for (const c of crossMsgs) candidates.set(c.id, c.thread_id);
        }
      }

      // 4/5/6. Link candidates the way manual attach does — suppression first,
      //        then idempotency guard, then link.
      let linkedForTxn = 0;
      for (const [messageId, threadId] of candidates) {
        // 6. Suppression: a removed thread or a removed individual message stays removed.
        if (threadId && threadId !== "" && ignoredThreadIds.has(threadId)) {
          result.skippedSuppressed++;
          continue;
        }
        if (ignoredCommIds.has(messageId)) {
          result.skippedSuppressed++;
          continue;
        }

        try {
          // 5. Idempotency: skip anything already linked to this transaction.
          if (await isMessageLinkedToTransaction(messageId, transactionId)) {
            result.skippedAlreadyLinked++;
            continue;
          }

          // 4. Link EXACTLY the way manual attach does (transactionService.linkMessages):
          //    set messages.transaction_id, then insert the per-message junction row.
          //    link_source is constrained to ('auto','manual','scan'), so reuse 'auto'.
          linkMessageToTransaction(messageId, transactionId);
          const refId = await createCommunicationReference(
            messageId,
            transactionId,
            userId,
            "auto",
            0.9
          );

          if (refId) {
            result.messagesLinked++;
            linkedForTxn++;
          } else {
            // Lost the idempotency race — the unique-index backstop rejected it.
            result.skippedAlreadyLinked++;
          }
        } catch (error) {
          result.errors++;
          await logService.warn(
            `[BACKLOG-2285] Failed to expand message ${messageId} into transaction ${transactionId}: ${
              error instanceof Error ? error.message : "Unknown"
            }`,
            "AutoLinkService"
          );
        }
      }

      // 4. Keep the transaction's text thread count in sync (same path manual
      //    attach ultimately relies on). Recomputed from the junction, so it is
      //    idempotent across re-runs.
      if (linkedForTxn > 0) {
        updateTransactionThreadCount(transactionId);
      }
    }

    result.durationMs = Date.now() - startTime;

    // 7. Observable verification (BACKLOG-1875): one INFO summary line with counts.
    await logService.info(
      `[BACKLOG-2285] Attached-thread expansion complete: linked ${result.messagesLinked} message(s) across ${result.pairsExamined} attached pair(s)`,
      "AutoLinkService",
      {
        userId,
        pairsExamined: result.pairsExamined,
        messagesLinked: result.messagesLinked,
        skippedSuppressed: result.skippedSuppressed,
        skippedAlreadyLinked: result.skippedAlreadyLinked,
        errors: result.errors,
        durationMs: result.durationMs,
      }
    );

    // BACKLOG-2393: thread expansion, where "half the conversation is attached
    // and half isn't" is decided. `skippedSuppressed` is the count that
    // distinguishes a deliberate exclusion from a miss.
    supportTrace("transaction-linking", "attached-thread-expansion-complete", {
      pairs_examined: result.pairsExamined,
      messages_linked: result.messagesLinked,
      skipped_suppressed: result.skippedSuppressed,
      skipped_already_linked: result.skippedAlreadyLinked,
      errors: result.errors,
      duration_ms: result.durationMs,
    });

    Sentry.addBreadcrumb({
      category: "auto_link.attached_expansion",
      message: `Attached-thread expansion: ${result.messagesLinked} linked, ${result.skippedSuppressed} suppressed`,
      level: "info",
      data: { userId, ...result },
    });

    return result;
  } catch (error) {
    result.durationMs = Date.now() - startTime;
    await logService.error(
      `[BACKLOG-2285] Attached-thread expansion failed: ${
        error instanceof Error ? error.message : "Unknown"
      }`,
      "AutoLinkService"
    );
    return result;
  }
}

export default {
  autoLinkCommunicationsForContact,
  autoLinkNewMessagesForUser,
  autoLinkNewMessagesForUserDebounced,
  expandAttachedThreadsForUser,
};
