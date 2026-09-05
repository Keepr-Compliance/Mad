/**
 * Email Deduplication Service
 *
 * Detects duplicate emails during sync by checking Message-ID header
 * and content hash. Returns the original message ID if a duplicate
 * is detected, allowing the caller to populate the `duplicate_of` field.
 *
 * @module electron/services/emailDeduplicationService
 * @see TASK-919
 */

import type { Database as DatabaseType } from "better-sqlite3";
import {
  FIND_BY_CONTENT_HASH_SQL,
  FIND_BY_MESSAGE_ID_HEADER_SQL,
  findExistingByContentHashes,
  findExistingByMessageIdHeaders,
} from "./db/emailDeduplicationSql";
import * as Sentry from "@sentry/electron/main";
import databaseService from "./databaseService";
import logService from "./logService";

/**
 * Result of a duplicate check operation
 */
export interface DuplicateCheckResult {
  /** Whether the email is a duplicate of an existing message */
  isDuplicate: boolean;
  /** ID of the original message if this is a duplicate */
  originalId?: string;
  /** Method used to detect the duplicate: 'message_id' or 'content_hash' */
  matchMethod?: "message_id" | "content_hash";
}

/**
 * Provider label for logging and Sentry tags
 */
export interface ProviderLabel {
  logLabel: string; // e.g., "OutlookFetch", "GmailFetch"
  sentryTag: string; // e.g., "outlook-fetch", "gmail-fetch"
}

/**
 * Minimal interface for emails that can be deduplicated.
 * Both provider-specific ParsedEmail types satisfy this constraint.
 */
interface DedupableEmail {
  messageIdHeader?: string | null;
  contentHash?: string | null;
  duplicateOf?: string | null;
}

/**
 * Email Deduplication Service
 *
 * Checks for duplicate emails using a two-tier strategy:
 * 1. Message-ID header (RFC 5322) - most reliable
 * 2. Content hash (SHA-256) - fallback for missing/unreliable Message-IDs
 *
 * @example
 * ```typescript
 * const dedup = new EmailDeduplicationService(db);
 * const result = dedup.checkForDuplicate(userId, messageIdHeader, contentHash);
 * if (result.isDuplicate) {
 *   // Store with duplicate_of = result.originalId
 * }
 * ```
 */
export class EmailDeduplicationService {
  private db: DatabaseType;

  constructor(db: DatabaseType) {
    this.db = db;
  }

  /**
   * Check if an email is a duplicate of an existing one.
   *
   * Priority:
   * 1. Match by message_id_header (most reliable)
   * 2. Match by content_hash (fallback)
   *
   * Only matches against non-duplicate messages (duplicate_of IS NULL)
   * to prevent chains of duplicate references.
   *
   * @param userId - The user ID to scope the check
   * @param messageIdHeader - RFC 5322 Message-ID header value (may be null)
   * @param contentHash - SHA-256 hash of email content
   * @returns Result indicating if duplicate and the original message ID
   */
  checkForDuplicate(
    userId: string,
    messageIdHeader: string | null,
    contentHash: string
  ): DuplicateCheckResult {
    // Try Message-ID match first (most reliable)
    if (messageIdHeader) {
      try {
        const existing = this.db
          .prepare(
  FIND_BY_MESSAGE_ID_HEADER_SQL
          )
          .get(userId, messageIdHeader) as { id: string } | undefined;

        if (existing) {
          logService.debug(
            "Duplicate detected via Message-ID",
            "EmailDeduplicationService",
            {
              userId,
              messageIdHeader: messageIdHeader.substring(0, 50),
              originalId: existing.id,
            }
          );
          return {
            isDuplicate: true,
            originalId: existing.id,
            matchMethod: "message_id",
          };
        }
      } catch (error) {
        logService.warn(
          "Error checking Message-ID duplicate",
          "EmailDeduplicationService",
          { error }
        );
        // Continue to content hash fallback
      }
    }

    // Fall back to content hash
    if (contentHash) {
      try {
        const existing = this.db
          .prepare(
  FIND_BY_CONTENT_HASH_SQL
          )
          .get(userId, contentHash) as { id: string } | undefined;

        if (existing) {
          logService.debug(
            "Duplicate detected via content hash",
            "EmailDeduplicationService",
            {
              userId,
              contentHashPrefix: contentHash.substring(0, 16),
              originalId: existing.id,
            }
          );
          return {
            isDuplicate: true,
            originalId: existing.id,
            matchMethod: "content_hash",
          };
        }
      } catch (error) {
        logService.warn(
          "Error checking content hash duplicate",
          "EmailDeduplicationService",
          { error }
        );
      }
    }

    return { isDuplicate: false };
  }

  /**
   * Batch check multiple emails for duplicates.
   *
   * More efficient than individual checks when processing many emails.
   * Uses a single query to load all potential matches.
   *
   * @param userId - The user ID to scope the check
   * @param emails - Array of emails with messageIdHeader and contentHash
   * @returns Map of email index to DuplicateCheckResult
   */
  checkForDuplicatesBatch(
    userId: string,
    emails: Array<{ messageIdHeader: string | null; contentHash: string }>
  ): Map<number, DuplicateCheckResult> {
    const results = new Map<number, DuplicateCheckResult>();

    if (emails.length === 0) {
      return results;
    }

    // Collect all message IDs and content hashes to check
    const messageIds = emails
      .map((e) => e.messageIdHeader)
      .filter((id): id is string => id !== null);
    const contentHashes = emails.map((e) => e.contentHash);

    // Build lookup maps for existing messages
    const existingByMessageId = new Map<string, string>();
    const existingByContentHash = new Map<string, string>();

    try {
      // Query for Message-ID matches
      if (messageIds.length > 0) {
        // The IN width is derived from the array that is bound, inside db/ —
        // see emailDeduplicationSql for why those cannot be two separate steps.
        const messageIdRows = findExistingByMessageIdHeaders(
          this.db,
          userId,
          messageIds,
        );

        for (const row of messageIdRows) {
          existingByMessageId.set(row.message_id_header, row.id);
        }
      }

      // Query for content hash matches
      if (contentHashes.length > 0) {
        const hashRows = findExistingByContentHashes(this.db, userId, contentHashes);

        for (const row of hashRows) {
          existingByContentHash.set(row.content_hash, row.id);
        }
      }
    } catch (error) {
      logService.error(
        "Error in batch duplicate check",
        "EmailDeduplicationService",
        { error }
      );
      // Return empty results - caller should handle as non-duplicates
      return results;
    }

    // Check each email against the lookup maps
    for (let i = 0; i < emails.length; i++) {
      const email = emails[i];

      // Check Message-ID first
      if (email.messageIdHeader) {
        const originalId = existingByMessageId.get(email.messageIdHeader);
        if (originalId) {
          results.set(i, {
            isDuplicate: true,
            originalId,
            matchMethod: "message_id",
          });
          continue;
        }
      }

      // Fall back to content hash
      const originalId = existingByContentHash.get(email.contentHash);
      if (originalId) {
        results.set(i, {
          isDuplicate: true,
          originalId,
          matchMethod: "content_hash",
        });
        continue;
      }

      results.set(i, { isDuplicate: false });
    }

    const duplicateCount = Array.from(results.values()).filter(
      (r) => r.isDuplicate
    ).length;
    if (duplicateCount > 0) {
      logService.info(
        `Batch duplicate check: ${duplicateCount}/${emails.length} duplicates found`,
        "EmailDeduplicationService"
      );
    }

    return results;
  }

  /**
   * Static convenience method to check emails for duplicates.
   *
   * Extracts the common logic used by both OutlookFetchService and
   * GmailFetchService. Creates an instance internally, runs the batch
   * check, and enriches the emails with duplicateOf information.
   *
   * @param userId - User ID to scope the duplicate check
   * @param emails - Array of emails with messageIdHeader and contentHash
   * @param provider - Provider label for logging and Sentry tags
   * @returns Same emails with duplicateOf field populated where applicable
   */
  static checkDuplicates<T extends DedupableEmail>(
    userId: string,
    emails: T[],
    provider: ProviderLabel
  ): T[] {
    if (emails.length === 0) {
      return emails;
    }

    try {
      const db = databaseService.getDatabaseForDeduplication();
      const dedupService = new EmailDeduplicationService(db);

      // Use batch check for efficiency
      const dedupInputs = emails.map((e) => ({
        messageIdHeader: e.messageIdHeader ?? null,
        contentHash: e.contentHash ?? "",
      }));

      const results = dedupService.checkForDuplicatesBatch(userId, dedupInputs);

      // Populate duplicateOf field for each email
      const enrichedEmails = emails.map((email, index) => {
        const result = results.get(index);
        if (result?.isDuplicate && result.originalId) {
          return {
            ...email,
            duplicateOf: result.originalId,
          };
        }
        return email;
      });

      const duplicateCount = enrichedEmails.filter((e) => e.duplicateOf).length;
      if (duplicateCount > 0) {
        logService.info(
          `Duplicate check: ${duplicateCount}/${emails.length} duplicates found`,
          provider.logLabel
        );
      }

      return enrichedEmails;
    } catch (error) {
      logService.error("Failed to check duplicates", provider.logLabel, {
        error,
      });
      Sentry.captureException(error, {
        tags: { service: provider.sentryTag, operation: "checkDuplicates" },
      });
      // Return original emails without duplicate info on error
      return emails;
    }
  }
}

// Export singleton factory function
// The service requires a database instance, so callers should create their own instance
export function createEmailDeduplicationService(
  db: DatabaseType
): EmailDeduplicationService {
  return new EmailDeduplicationService(db);
}

export default EmailDeduplicationService;
