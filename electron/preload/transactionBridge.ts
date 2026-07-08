/**
 * Transaction Bridge
 * Manages real estate transactions, email scanning, and export functionality
 */

import { ipcRenderer } from "electron";
import type { NewTransaction, Transaction, TransactionStatus } from "../types/models";

/**
 * Options for scanning emails for transactions
 */
export interface ScanOptions {
  provider?: "google" | "microsoft";
  dateRange?: {
    start?: string | Date;
    end?: string | Date;
  };
  propertyAddress?: string;
  forceRescan?: boolean;
}

/**
 * Options for enhanced transaction export
 */
export interface ExportEnhancedOptions {
  exportFormat?: "pdf" | "csv" | "json" | "txt_eml" | "excel";
  contentType?: "text" | "email" | "both";
  includeContacts?: boolean;
  includeEmails?: boolean;
  includeSummary?: boolean;
  startDate?: string;
  endDate?: string;
  summaryOnly?: boolean; // If true, only export summary + indexes (no full content)
  attachmentType?: "all" | "email" | "text" | "none";
}

/**
 * Options for folder export
 */
export interface ExportFolderOptions {
  includeEmails?: boolean;
  includeTexts?: boolean;
  includeAttachments?: boolean;
  contentType?: "both" | "emails" | "texts";
  attachmentType?: "all" | "email" | "text" | "none";
}

export const transactionBridge = {
  /**
   * Scans user's mailbox for real estate transaction emails
   * @param userId - User ID to scan emails for
   * @param options - Scan options (provider, dateRange, propertyAddress, etc.)
   * @returns Scan results
   */
  scan: (userId: string, options?: ScanOptions) =>
    ipcRenderer.invoke("transactions:scan", userId, options),

  /**
   * Cancels an ongoing mailbox scan
   * @param userId - User ID to cancel scan for
   * @returns Cancellation result
   */
  cancelScan: (userId: string) =>
    ipcRenderer.invoke("transactions:cancel-scan", userId),

  /**
   * Retrieves all transactions for a user
   * @param userId - User ID to get transactions for
   * @returns All user transactions
   */
  getAll: (userId: string) =>
    ipcRenderer.invoke("transactions:get-all", userId),

  /**
   * BACKLOG-1124: Get count of pending auto-detected transactions.
   * Uses a server-side SQL COUNT query instead of fetching all transactions.
   * @param userId - User ID to count pending transactions for
   * @returns Count of pending transactions
   */
  getPendingCount: (userId: string) =>
    ipcRenderer.invoke("transactions:get-pending-count", userId),

  /**
   * Creates a new manual transaction
   * @param userId - User ID creating the transaction
   * @param transactionData - Transaction details (address, type, status, dates, etc.)
   * @returns Created transaction
   */
  create: (userId: string, transactionData: NewTransaction) =>
    ipcRenderer.invoke("transactions:create", userId, transactionData),

  /**
   * Creates a new audited transaction with verified data
   * @param userId - User ID creating the transaction
   * @param transactionData - Audited transaction details
   * @returns Created audited transaction
   */
  createAudited: (userId: string, transactionData: NewTransaction) =>
    ipcRenderer.invoke(
      "transactions:create-audited",
      userId,
      transactionData,
    ),

  /**
   * Gets detailed information for a specific transaction
   * @param transactionId - Transaction ID to retrieve
   * @returns Transaction details
   */
  getDetails: (transactionId: string) =>
    ipcRenderer.invoke("transactions:get-details", transactionId),

  /**
   * PERF: Lightweight overview — contacts only, no communications.
   * Use this for initial load; fetch full details only when needed.
   */
  getOverview: (transactionId: string) =>
    ipcRenderer.invoke("transactions:get-overview", transactionId),

  /**
   * PERF: Filtered communications — only emails or only texts.
   * Much faster than getDetails when transaction has many communications.
   */
  getCommunications: (transactionId: string, channelFilter: "email" | "text") =>
    ipcRenderer.invoke("transactions:get-communications", transactionId, channelFilter),

  /**
   * Gets transaction with all associated contacts
   * @param transactionId - Transaction ID to retrieve
   * @returns Transaction with contacts
   */
  getWithContacts: (transactionId: string) =>
    ipcRenderer.invoke("transactions:get-with-contacts", transactionId),

  /**
   * Updates transaction details
   * @param transactionId - Transaction ID to update
   * @param updates - Fields to update (status, dates, address, etc.)
   * @returns Updated transaction
   */
  update: (transactionId: string, updates: Partial<Transaction>) =>
    ipcRenderer.invoke("transactions:update", transactionId, updates),

  /**
   * Deletes a transaction
   * @param transactionId - Transaction ID to delete
   * @returns Deletion result
   */
  delete: (transactionId: string) =>
    ipcRenderer.invoke("transactions:delete", transactionId),

  /**
   * Assigns a contact to a transaction with a specific role
   * @param transactionId - Transaction ID
   * @param contactId - Contact ID to assign
   * @param role - Contact's role (e.g., "Buyer's Agent", "Seller", etc.)
   * @param roleCategory - Role category (buyer_side, seller_side, neutral, etc.)
   * @param isPrimary - Whether this is the primary contact for this role
   * @param notes - Additional notes about this assignment
   * @returns Assignment result
   */
  assignContact: (
    transactionId: string,
    contactId: string,
    role: string,
    roleCategory: string,
    isPrimary: boolean,
    notes: string,
  ) =>
    ipcRenderer.invoke(
      "transactions:assign-contact",
      transactionId,
      contactId,
      role,
      roleCategory,
      isPrimary,
      notes,
    ),

  /**
   * Removes a contact from a transaction
   * @param transactionId - Transaction ID
   * @param contactId - Contact ID to remove
   * @returns Removal result
   */
  removeContact: (transactionId: string, contactId: string) =>
    ipcRenderer.invoke(
      "transactions:remove-contact",
      transactionId,
      contactId,
    ),

  /**
   * Batch update contact assignments for a transaction
   * Performs multiple add/remove operations in a single atomic transaction
   * @param transactionId - Transaction ID
   * @param operations - Array of operations to perform
   * @returns Batch update result
   */
  batchUpdateContacts: (
    transactionId: string,
    operations: Array<{
      action: "add" | "remove";
      contactId: string;
      role?: string;
      roleCategory?: string;
      specificRole?: string;
      isPrimary?: boolean;
      notes?: string;
    }>,
  ) =>
    ipcRenderer.invoke(
      "transactions:batchUpdateContacts",
      transactionId,
      operations,
    ),

  /**
   * Unlinks a communication (email) from a transaction
   * The email will be added to an ignored list and won't be re-added during future scans
   * @param communicationId - Communication ID to unlink
   * @param reason - Optional reason for unlinking
   * @returns Unlink result
   */
  unlinkCommunication: (communicationId: string, reason?: string) =>
    ipcRenderer.invoke(
      "transactions:unlink-communication",
      communicationId,
      reason,
    ),

  /**
   * Re-analyzes emails for a specific property and date range
   * @param userId - User ID
   * @param provider - Email provider (google or microsoft)
   * @param propertyAddress - Property address to search for
   * @param dateRange - Date range to search within {start, end}
   * @returns Re-analysis results
   */
  reanalyze: (
    userId: string,
    provider: "google" | "microsoft",
    propertyAddress: string,
    dateRange: { start?: string | Date; end?: string | Date },
  ) =>
    ipcRenderer.invoke(
      "transactions:reanalyze",
      userId,
      provider,
      propertyAddress,
      dateRange,
    ),

  /**
   * Exports transaction as PDF to specified path
   * @param transactionId - Transaction ID to export
   * @param outputPath - File path to save PDF
   * @returns Export result
   */
  exportPDF: (transactionId: string, outputPath: string) =>
    ipcRenderer.invoke("transactions:export-pdf", transactionId, outputPath),

  /**
   * Exports transaction with enhanced options (format, included data, etc.)
   * @param transactionId - Transaction ID to export
   * @param options - Export options (format, includeContacts, includeEmails, etc.)
   * @returns Export result
   */
  exportEnhanced: (transactionId: string, options?: ExportEnhancedOptions) =>
    ipcRenderer.invoke(
      "transactions:export-enhanced",
      transactionId,
      options,
    ),

  /**
   * Bulk deletes multiple transactions
   * @param transactionIds - Array of transaction IDs to delete
   * @returns Bulk deletion result
   */
  bulkDelete: (transactionIds: string[]) =>
    ipcRenderer.invoke("transactions:bulk-delete", transactionIds),

  /**
   * Bulk updates status for multiple transactions
   * @param transactionIds - Array of transaction IDs to update
   * @param status - New status ('pending', 'active', 'closed', or 'rejected')
   * @returns Bulk update result
   */
  bulkUpdateStatus: (transactionIds: string[], status: TransactionStatus) =>
    ipcRenderer.invoke("transactions:bulk-update-status", transactionIds, status),

  /**
   * Gets unlinked messages (SMS/iMessage not attached to any transaction)
   * @param userId - User ID to get messages for
   * @returns List of unlinked messages
   */
  getUnlinkedMessages: (userId: string) =>
    ipcRenderer.invoke("transactions:get-unlinked-messages", userId),

  /**
   * Gets unlinked emails (not attached to any transaction)
   * Supports server-side search with query, date range, and pagination (TASK-1993)
   * @param userId - User ID to get emails for
   * @param options - Optional search/filter/pagination parameters
   * @returns List of unlinked emails
   */
  getUnlinkedEmails: (
    userId: string,
    options?: {
      query?: string;
      after?: string;
      before?: string;
      maxResults?: number;
      skip?: number;
      transactionId?: string;
    },
  ) =>
    ipcRenderer.invoke("transactions:get-unlinked-emails", userId, options),

  /**
   * Gets distinct contacts with unlinked message counts
   * @param userId - User ID to get contacts for
   * @returns List of contacts with message counts
   */
  getMessageContacts: (userId: string) =>
    ipcRenderer.invoke("transactions:get-message-contacts", userId),

  /**
   * Gets unlinked messages for a specific contact
   * @param userId - User ID
   * @param contact - Phone number/contact identifier
   * @returns List of messages for that contact
   */
  getMessagesByContact: (userId: string, contact: string) =>
    ipcRenderer.invoke("transactions:get-messages-by-contact", userId, contact),

  /**
   * Links messages to a transaction
   * @param messageIds - Array of message IDs to link
   * @param transactionId - Transaction ID to link messages to
   * @returns Link result
   */
  linkMessages: (messageIds: string[], transactionId: string) =>
    ipcRenderer.invoke("transactions:link-messages", messageIds, transactionId),

  /**
   * Unlinks messages from a transaction (sets transaction_id to null)
   * @param messageIds - Array of message IDs to unlink
   * @param transactionId - Transaction ID to unlink from (required for thread-based linking)
   * @returns Unlink result
   */
  unlinkMessages: (messageIds: string[], transactionId?: string) =>
    ipcRenderer.invoke("transactions:unlink-messages", messageIds, transactionId),

  /**
   * BACKLOG-1577: Get removed/unlinked messages for a transaction.
   * Returns messages that were manually unlinked (from ignored_communications).
   * @param transactionId - Transaction ID to get removed messages for
   * @returns List of removed messages with metadata
   */
  getRemovedMessages: (transactionId: string) =>
    ipcRenderer.invoke("transactions:get-removed-messages", transactionId),

  /**
   * BACKLOG-1577: Restore a removed message (re-link + remove suppression).
   * Deletes the ignored_communications record and re-links messages to the transaction.
   * @param ignoredCommId - Ignored communication record ID to delete
   * @param messageIds - Array of message IDs to re-link
   * @param transactionId - Transaction ID to re-link messages to
   * @returns Restore result
   */
  restoreRemovedMessage: (ignoredCommId: string, messageIds: string[], transactionId: string) =>
    ipcRenderer.invoke("transactions:restore-removed-message", ignoredCommId, messageIds, transactionId),

  /**
   * BACKLOG-1578: Get removed/unlinked emails for a transaction.
   * Returns emails that were manually unlinked (from ignored_communications).
   * @param transactionId - Transaction ID to get removed emails for
   * @returns List of removed emails with metadata
   */
  getRemovedEmails: (transactionId: string) =>
    ipcRenderer.invoke("transactions:get-removed-emails", transactionId),

  /**
   * BACKLOG-1578: Restore a removed email (re-link + remove suppression).
   * Deletes the ignored_communications record and re-links the email to the transaction.
   * @param ignoredCommId - Ignored communication record ID to delete
   * @param emailId - Email ID to re-link
   * @param transactionId - Transaction ID to re-link email to
   * @returns Restore result
   */
  restoreRemovedEmail: (ignoredCommId: string, emailId: string, transactionId: string) =>
    ipcRenderer.invoke("transactions:restore-removed-email", ignoredCommId, emailId, transactionId),

  /**
   * Auto-links text messages to a transaction based on assigned contacts
   * Finds SMS/iMessage messages from contacts' phone numbers and creates
   * communication references linking them to the transaction.
   * @param transactionId - Transaction ID to link messages to
   * @returns Auto-link result with counts of linked/skipped messages
   */
  autoLinkTexts: (transactionId: string) =>
    ipcRenderer.invoke("transactions:auto-link-texts", transactionId),

  /**
   * Exports transaction to an organized folder structure
   * Creates: Summary_Report.pdf, emails/, texts/, attachments/
   * @param transactionId - Transaction ID to export
   * @param options - Export options (includeEmails, includeTexts, includeAttachments)
   * @returns Export result with path to created folder
   */
  exportFolder: (transactionId: string, options?: ExportFolderOptions) =>
    ipcRenderer.invoke("transactions:export-folder", transactionId, options),

  /**
   * Re-syncs auto-link communications for all contacts on a transaction.
   * Useful when contacts have been updated with new email/phone info and
   * user wants to re-link matching communications.
   * @param transactionId - Transaction ID to re-sync
   * @returns Results with counts of newly linked communications
   */
  resyncAutoLink: (transactionId: string) =>
    ipcRenderer.invoke("transactions:resync-auto-link", transactionId),

  /**
   * BACKLOG-1364: Update the address filter toggle for a transaction and re-run auto-link.
   * When skipAddressFilter is true, ALL emails from assigned contacts are linked.
   * When false (default), only emails mentioning the property address are linked.
   * @param transactionId - Transaction ID to update
   * @param skipAddressFilter - true to skip address filtering, false to enable it
   * @returns Results with counts of newly linked communications after re-link
   */
  updateAddressFilter: (transactionId: string, skipAddressFilter: boolean) =>
    ipcRenderer.invoke("transactions:update-address-filter", transactionId, skipAddressFilter),

  /**
   * Sync emails from provider (Gmail/Outlook) for a transaction.
   * BACKLOG-457: Fetches NEW emails from connected email provider based on
   * contact email addresses, stores them, then runs auto-link.
   * @param transactionId - Transaction ID to sync emails for
   * @returns Results with counts of fetched, stored, and linked emails
   */
  syncAndFetchEmails: (transactionId: string) =>
    ipcRenderer.invoke("transactions:sync-and-fetch-emails", transactionId),

  /**
   * BACKLOG-1362: Pre-cache emails from connected providers.
   * Bulk-fetches ALL emails within the user's configured cache window
   * into the local database. Incremental -- only fetches newer than
   * what is already cached.
   * @param userId - User ID to pre-cache emails for
   * @returns Results with counts of fetched and stored emails
   */
  precacheEmails: (userId: string) =>
    ipcRenderer.invoke("emails:precache", userId),

  /**
   * Link emails to a transaction
   * @param emailIds - Array of email IDs to link
   * @param transactionId - Transaction ID to link to
   * @returns Success/error result
   */
  linkEmails: (emailIds: string[], transactionId: string) =>
    ipcRenderer.invoke("transactions:link-emails", emailIds, transactionId),

  // ============================================
  // SUBMISSION METHODS (BACKLOG-391)
  // ============================================

  /**
   * Submit transaction to broker portal for review
   * @param transactionId - Transaction ID to submit
   * @returns Submission result with cloud submission ID
   */
  submit: (transactionId: string) =>
    ipcRenderer.invoke("transactions:submit", transactionId),

  /**
   * Resubmit transaction (creates new version)
   * @param transactionId - Transaction ID to resubmit
   * @returns Submission result with new submission ID
   */
  resubmit: (transactionId: string) =>
    ipcRenderer.invoke("transactions:resubmit", transactionId),

  /**
   * Get submission status from cloud
   * @param submissionId - Cloud submission ID
   * @returns Current status and review info
   */
  getSubmissionStatus: (submissionId: string) =>
    ipcRenderer.invoke("transactions:get-submission-status", submissionId),

  /**
   * Listen for submission progress updates
   * @param callback - Progress callback
   * @returns Cleanup function
   */
  onSubmitProgress: (callback: (progress: {
    stage: string;
    stageProgress: number;
    overallProgress: number;
    currentItem?: string;
  }) => void) => {
    const handler = (_event: unknown, progress: {
      stage: string;
      stageProgress: number;
      overallProgress: number;
      currentItem?: string;
    }) => callback(progress);
    ipcRenderer.on("transactions:submit-progress", handler);
    return () => {
      ipcRenderer.removeListener("transactions:submit-progress", handler);
    };
  },

  // ============================================
  // SYNC METHODS (BACKLOG-395)
  // ============================================

  /**
   * Trigger manual sync of submission statuses
   * @returns Sync result with updated count
   */
  syncSubmissions: () =>
    ipcRenderer.invoke("transactions:sync-submissions"),

  /**
   * Sync a specific transaction's submission status
   * @param transactionId - Transaction ID to sync
   * @returns Whether status was updated
   */
  syncSubmission: (transactionId: string) =>
    ipcRenderer.invoke("transactions:sync-submission", transactionId),

  /**
   * Listen for submission status change events
   * @param callback - Status change callback
   * @returns Cleanup function
   */
  onSubmissionStatusChanged: (callback: (data: {
    transactionId: string;
    propertyAddress: string;
    oldStatus: string;
    newStatus: string;
    reviewNotes?: string;
    title: string;
    message: string;
  }) => void) => {
    const handler = (_event: unknown, data: {
      transactionId: string;
      propertyAddress: string;
      oldStatus: string;
      newStatus: string;
      reviewNotes?: string;
      title: string;
      message: string;
    }) => callback(data);
    ipcRenderer.on("submission-status-changed", handler);
    return () => {
      ipcRenderer.removeListener("submission-status-changed", handler);
    };
  },

  // ============================================
  // EMAIL ATTACHMENT METHODS (TASK-1776)
  // ============================================

  /**
   * Get attachments for a specific email
   * @param emailId - Email ID to get attachments for
   * @returns Array of attachment records
   */
  getEmailAttachments: (emailId: string) =>
    ipcRenderer.invoke("emails:get-attachments", emailId),

  /**
   * Backfill missing email attachments (runs in background after login)
   * Downloads attachments for emails that have has_attachments=true but no DB records
   */
  backfillAttachments: (userId: string) =>
    ipcRenderer.invoke("emails:backfill-attachments", userId),

  /**
   * Open attachment with system viewer
   * @param storagePath - Path to attachment file
   * @returns Success/error result
   */
  openAttachment: (storagePath: string) =>
    ipcRenderer.invoke("attachments:open", storagePath),

  /**
   * Get attachment data as base64 data URL for CSP-safe image preview
   * TASK-1778 fix: CSP blocks file:// URLs, so we read the file and return as data: URL
   * @param storagePath - Path to attachment file
   * @param mimeType - MIME type for the data URL
   * @returns Success/error result with data URL in data field
   */
  getAttachmentData: (storagePath: string, mimeType: string) =>
    ipcRenderer.invoke("attachments:get-data", storagePath, mimeType),

  /**
   * Get attachment counts for a transaction from the actual attachments table
   * TASK-1781: Returns accurate counts matching what submission service uploads
   * @param transactionId - Transaction ID
   * @param auditStart - Optional audit start date (ISO string)
   * @param auditEnd - Optional audit end date (ISO string)
   * @returns Counts for text and email attachments
   */
  getAttachmentCounts: (transactionId: string, auditStart?: string, auditEnd?: string) =>
    ipcRenderer.invoke("transactions:get-attachment-counts", transactionId, auditStart, auditEnd),

  /**
   * Get attachment buffer as raw base64 (for DOCX conversion)
   * TASK-1783: Returns raw base64 without data: URL prefix for mammoth.js
   * @param storagePath - Path to attachment file
   * @returns Success/error result with base64 data in data field
   */
  getAttachmentBuffer: (storagePath: string) =>
    ipcRenderer.invoke("attachments:get-buffer", storagePath),

  // ============================================
  // AUTO-DETECT START DATE (TASK-1974)
  // ============================================

  /**
   * Get the earliest communication date for a set of contacts.
   * Used by the audit wizard to auto-detect the transaction start date.
   * @param contactIds - Array of contact IDs to search
   * @param userId - User ID who owns the communications
   * @returns Earliest communication date (ISO string) or null
   */
  getEarliestCommunicationDate: (contactIds: string[], userId: string) =>
    ipcRenderer.invoke(
      "transactions:get-earliest-communication-date",
      contactIds,
      userId,
    ),

  /**
   * BACKLOG-1832: Query whether a background auto-sync is currently in flight
   * for a transaction. Called on mount by TransactionDetails to retroactively
   * show the spinner when the component mounts mid-sync (after the
   * `transactions:auto-sync-started` push event has already been missed).
   */
  isAutoSyncInFlight: (transactionId: string) =>
    ipcRenderer.invoke("transactions:is-auto-sync-in-flight", transactionId),

  /**
   * BACKLOG-1866: Search everything linked to a single transaction — assigned
   * contacts, linked emails, and linked texts. Results are grouped by type and
   * strictly scoped to this transaction's links.
   * @param transactionId - Transaction whose linked content is searched
   * @param query - Raw search string (empty ⇒ empty result groups)
   * @returns Grouped search results
   */
  searchLinkedContent: (transactionId: string, query: string) =>
    ipcRenderer.invoke("transactions:search-linked-content", transactionId, query),

  /**
   * BACKLOG-1876: Global (unscoped) search across all of the user's content.
   * Returns five groups — transactions, contacts, emails, texts, and an
   * "unattached" bucket — with each attributable hit carrying its owning
   * transaction (primary/earliest link).
   * @param userId - Owner whose content is searched
   * @param query - Raw search string (empty ⇒ empty result groups)
   * @returns Grouped global search results
   */
  searchGlobalContent: (userId: string, query: string) =>
    ipcRenderer.invoke("transactions:search-global", userId, query),
};
