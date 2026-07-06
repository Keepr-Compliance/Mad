/**
 * WindowApi Transactions sub-interface
 * Transaction CRUD, linking, export, and submission methods
 */
import type { Transaction, Communication } from "../models";

// ============================================
// BACKLOG-1866: Overview linked-content search result shapes
// ============================================

/** A contact assigned to the transaction that matched the search. */
export interface LinkedContentContactHit {
  contactId: string;
  displayName: string;
  role: string | null;
}

/** An email linked to the transaction that matched the search. */
export interface LinkedContentEmailHit {
  id: string;
  subject: string | null;
  sender: string | null;
  sentAt: string | null;
  snippet: string | null;
}

/** A text/message linked to the transaction that matched the search. */
export interface LinkedContentTextHit {
  id: string;
  sender: string | null;
  snippet: string | null;
  sentAt: string | null;
}

/** One result group: up to `limit` items plus the true total match count. */
export interface LinkedContentGroup<T> {
  items: T[];
  total: number;
}

/** Grouped results for a linked-content search, one group per content type. */
export interface LinkedContentSearchResults {
  contacts: LinkedContentGroup<LinkedContentContactHit>;
  emails: LinkedContentGroup<LinkedContentEmailHit>;
  texts: LinkedContentGroup<LinkedContentTextHit>;
}

/** Transaction methods on window.api */
export interface WindowApiTransactions {
  getAll: (userId: string) => Promise<{
    success: boolean;
    transactions?: Transaction[];
    error?: string;
  }>;
  /** BACKLOG-1124: Lightweight pending count query */
  getPendingCount: (userId: string) => Promise<{
    success: boolean;
    count: number;
    error?: string;
  }>;
  /**
   * BACKLOG-1866: Search everything linked to a single transaction — assigned
   * contacts, linked emails, and linked texts. Strictly scoped to the given
   * transaction's junction rows. Empty query returns empty groups.
   */
  searchLinkedContent: (
    transactionId: string,
    query: string,
  ) => Promise<{
    success: boolean;
    results?: LinkedContentSearchResults;
    error?: string;
  }>;
  scan: (
    userId: string,
    options?: Record<string, unknown>,
  ) => Promise<{
    success: boolean;
    transactions?: Transaction[];
    transactionsFound?: number;
    emailsScanned?: number;
    error?: string;
  }>;
  cancelScan: (
    userId: string,
  ) => Promise<{ success: boolean; cancelled?: boolean; error?: string }>;
  getDetails: (
    transactionId: string,
  ) => Promise<{
    success: boolean;
    transaction?: Transaction & {
      communications?: Communication[];
      contact_assignments?: Array<{
        id: string;
        contact_id: string;
        contact_name?: string;
        contact_email?: string;
        contact_phone?: string;
        contact_company?: string;
        role?: string;
        specific_role?: string;
        is_primary?: number;
        notes?: string;
      }>;
    };
    error?: string;
  }>;
  /**
   * PERF: Lightweight overview - contacts only, no communications.
   */
  getOverview: (transactionId: string) => Promise<{
    success: boolean;
    transaction?: Transaction & {
      contact_assignments?: Array<{
        id: string;
        contact_id: string;
        contact_name?: string;
        contact_email?: string;
        contact_phone?: string;
        contact_company?: string;
        role?: string;
        specific_role?: string;
        is_primary?: number;
        notes?: string;
      }>;
    };
    error?: string;
  }>;
  /**
   * PERF: Filtered communications - only emails or only texts.
   */
  getCommunications: (transactionId: string, channelFilter?: "email" | "text") => Promise<{
    success: boolean;
    communications?: Communication[];
    error?: string;
  }>;
  getWithContacts: (transactionId: string) => Promise<{
    success: boolean;
    transaction?: Transaction;
    contacts?: Array<Record<string, unknown>>;
    error?: string;
  }>;
  create: (
    userId: string,
    transactionData: Record<string, unknown>,
  ) => Promise<{
    success: boolean;
    transaction?: Transaction;
    error?: string;
  }>;
  createAudited: (
    userId: string,
    transactionData: Record<string, unknown>,
  ) => Promise<{
    success: boolean;
    transaction?: Transaction;
    error?: string;
  }>;
  update: (
    transactionId: string,
    data: Record<string, unknown>,
  ) => Promise<{ success: boolean; error?: string }>;
  delete: (
    transactionId: string,
  ) => Promise<{ success: boolean; error?: string }>;
  exportPDF: (
    transactionId: string,
    outputPath: string,
  ) => Promise<{ success: boolean; filePath?: string; error?: string }>;
  exportEnhanced: (
    transactionId: string,
    options?: {
      exportFormat?: string;
      contentType?: "text" | "email" | "both";
      startDate?: string;
      endDate?: string;
      summaryOnly?: boolean;
      attachmentType?: "all" | "email" | "text" | "none";
    },
  ) => Promise<{ success: boolean; path?: string; error?: string }>;
  assignContact: (
    transactionId: string,
    contactId: string,
    role: string,
    roleCategory?: string,
    isPrimary?: boolean,
    notes?: string,
  ) => Promise<{ success: boolean; error?: string }>;
  removeContact: (
    transactionId: string,
    contactId: string,
  ) => Promise<{ success: boolean; error?: string }>;
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
  ) => Promise<{
    success: boolean;
    error?: string;
    autoLinkResults?: Array<{
      contactId: string;
      emailsLinked: number;
      messagesLinked: number;
      alreadyLinked: number;
      errors: number;
    }>;
  }>;
  unlinkCommunication: (
    communicationId: string,
    reason?: string,
  ) => Promise<{
    success: boolean;
    /**
     * BACKLOG-1778: communication ids actually removed (clicked row + thread
     * siblings). Lets the renderer drop those rows in place instead of
     * refetching the whole list (which reset the email list scroll position).
     */
    unlinkedIds?: string[];
    error?: string;
  }>;
  bulkDelete: (
    transactionIds: string[],
  ) => Promise<{
    success: boolean;
    deletedCount?: number;
    errors?: string[];
    error?: string;
  }>;
  bulkUpdateStatus: (
    transactionIds: string[],
    status: "pending" | "active" | "closed" | "rejected",
  ) => Promise<{
    success: boolean;
    updatedCount?: number;
    errors?: string[];
    error?: string;
  }>;

  // ============================================
  // MESSAGE / EMAIL LINK METHODS
  // ============================================

  /** Gets unlinked messages (SMS/iMessage not attached to any transaction) */
  getUnlinkedMessages: (userId: string) => Promise<{
    success: boolean;
    messages?: unknown[];
    error?: string;
  }>;
  /** Gets unlinked emails with server-side search support (TASK-1993) */
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
  ) => Promise<{
    success: boolean;
    emails?: Array<{
      id: string;
      subject: string | null;
      sender: string | null;
      sent_at: string | null;
      body_preview?: string | null;
      thread_id?: string | null;
      has_attachments?: boolean;
    }>;
    error?: string;
  }>;
  /** Gets distinct contacts with unlinked message counts */
  getMessageContacts: (userId: string) => Promise<{
    success: boolean;
    contacts?: unknown[];
    error?: string;
  }>;
  /** Gets unlinked messages for a specific contact */
  getMessagesByContact: (userId: string, contact: string) => Promise<{
    success: boolean;
    messages?: unknown[];
    error?: string;
  }>;
  /** Links messages to a transaction */
  linkMessages: (messageIds: string[], transactionId: string) => Promise<{
    success: boolean;
    error?: string;
  }>;
  /** Unlinks messages from a transaction */
  unlinkMessages: (messageIds: string[], transactionId?: string) => Promise<{
    success: boolean;
    error?: string;
  }>;
  /** BACKLOG-1577: Get removed/unlinked messages for a transaction */
  getRemovedMessages: (transactionId: string) => Promise<{
    success: boolean;
    removedMessages?: Array<{
      ignored_id: string;
      ic_thread_id: string | null;
      reason: string | null;
      ignored_at: string;
      message_id: string;
      body: string | null;
      subject: string | null;
      channel: string | null;
      thread_id: string | null;
      sent_at: string | null;
      received_at: string | null;
      participants: string | null;
      participants_flat: string | null;
      direction: string | null;
    }>;
    error?: string;
  }>;
  /** BACKLOG-1577: Restore a removed message (re-link + remove suppression) */
  restoreRemovedMessage: (ignoredCommId: string, messageIds: string[], transactionId: string) => Promise<{
    success: boolean;
    error?: string;
  }>;
  /** BACKLOG-1578: Get removed/unlinked emails for a transaction */
  getRemovedEmails: (transactionId: string) => Promise<{
    success: boolean;
    removedEmails?: Array<{
      ignored_id: string;
      ic_email_id: string | null;
      reason: string | null;
      ignored_at: string;
      email_id: string;
      subject: string | null;
      sender: string | null;
      recipients: string | null;
      cc: string | null;
      sent_at: string | null;
      thread_id: string | null;
      body_preview: string | null;
      body_plain: string | null;
      has_attachments: boolean | number | null;
      source: string | null;
    }>;
    error?: string;
  }>;
  /** BACKLOG-1578: Restore a removed email (re-link + remove suppression) */
  restoreRemovedEmail: (ignoredCommId: string, emailId: string, transactionId: string) => Promise<{
    success: boolean;
    restoredCount?: number;
    error?: string;
  }>;
  /** Link emails to a transaction */
  linkEmails: (emailIds: string[], transactionId: string) => Promise<{
    success: boolean;
    linked?: number;
    error?: string;
  }>;
  /** Auto-links text messages to a transaction based on assigned contacts */
  autoLinkTexts: (transactionId: string) => Promise<{
    success: boolean;
    error?: string;
  }>;
  /** Re-syncs auto-link communications for all contacts on a transaction */
  resyncAutoLink: (transactionId: string) => Promise<{
    success: boolean;
    contactsProcessed?: number;
    totalEmailsLinked?: number;
    totalMessagesLinked?: number;
    totalAlreadyLinked?: number;
    totalErrors?: number;
    addressFilterMessage?: string;
    message?: string;
    error?: string;
  }>;
  /** BACKLOG-1364: Update address filter toggle and re-run auto-link */
  updateAddressFilter: (transactionId: string, skipAddressFilter: boolean) => Promise<{
    success: boolean;
    contactsProcessed?: number;
    totalEmailsLinked?: number;
    totalMessagesLinked?: number;
    totalAlreadyLinked?: number;
    totalErrors?: number;
    addressFilterMessage?: string;
    message?: string;
    error?: string;
  }>;
  /** Sync emails from provider for a transaction */
  syncAndFetchEmails: (transactionId: string) => Promise<{
    success: boolean;
    provider?: "gmail" | "outlook";
    emailsFetched?: number;
    emailsStored?: number;
    totalEmailsLinked?: number;
    totalMessagesLinked?: number;
    totalAlreadyLinked?: number;
    totalErrors?: number;
    error?: string;
    message?: string;
    rateLimited?: boolean;
  }>;
  /** BACKLOG-1362: Pre-cache emails from connected providers */
  precacheEmails: (userId: string) => Promise<{
    success: boolean;
    emailsFetched?: number;
    emailsStored?: number;
    error?: string;
    rateLimited?: boolean;
  }>;
  /** Export transaction to organized folder structure */
  exportFolder: (transactionId: string, options?: {
    includeEmails?: boolean;
    includeTexts?: boolean;
    includeAttachments?: boolean;
    contentType?: "both" | "emails" | "texts";
    attachmentType?: "all" | "email" | "text" | "none";
  }) => Promise<{
    success: boolean;
    path?: string;
    error?: string;
  }>;
  /** Get earliest communication date for contacts (TASK-1974) */
  getEarliestCommunicationDate: (contactIds: string[], userId: string) => Promise<{
    success: boolean;
    date?: string | null;
    error?: string;
  }>;
  reanalyze: (
    userId: string,
    provider: string,
    propertyAddress: string,
    dateRange: { start?: string | Date; end?: string | Date },
  ) => Promise<{
    success: boolean;
    newCount?: number;
    updatedCount?: number;
    error?: string;
  }>;

  // ============================================
  // EMAIL ATTACHMENT METHODS (TASK-1776)
  // ============================================

  /** Get attachments for a specific email */
  getEmailAttachments: (emailId: string) => Promise<{
    success: boolean;
    data?: Array<{
      id: string;
      filename: string;
      mime_type: string | null;
      file_size_bytes: number | null;
      storage_path: string | null;
    }>;
    error?: string;
    downloadBlocked?: boolean;
    offline?: boolean;
    downloadRequired?: boolean;
    reason?: string;
  }>;
  /** Backfill missing email attachments */
  backfillAttachments: (userId: string) => Promise<{
    success: boolean;
    error?: string;
  }>;
  /** Open attachment with system viewer */
  openAttachment: (storagePath: string) => Promise<{
    success: boolean;
    error?: string;
  }>;
  /** Get attachment data as base64 data URL for preview */
  getAttachmentData: (storagePath: string, mimeType: string) => Promise<{
    success: boolean;
    data?: string;
    error?: string;
  }>;
  /** Get attachment buffer as raw base64 (for DOCX conversion) */
  getAttachmentBuffer: (storagePath: string) => Promise<{
    success: boolean;
    data?: string;
    error?: string;
  }>;
  /** Get attachment counts for a transaction (TASK-1781) */
  getAttachmentCounts: (transactionId: string, auditStart?: string, auditEnd?: string) => Promise<{
    success: boolean;
    data?: {
      textAttachments: number;
      emailAttachments: number;
      total: number;
      totalSizeBytes?: number;
    };
    error?: string;
  }>;

  // ============================================
  // SUBMISSION METHODS (BACKLOG-391)
  // ============================================

  /**
   * Submit transaction to broker portal for review
   */
  submit: (transactionId: string) => Promise<{
    success: boolean;
    submissionId?: string;
    messagesCount?: number;
    attachmentsCount?: number;
    attachmentsFailed?: number;
    error?: string;
  }>;

  /**
   * Resubmit transaction (creates new version)
   */
  resubmit: (transactionId: string) => Promise<{
    success: boolean;
    submissionId?: string;
    messagesCount?: number;
    attachmentsCount?: number;
    attachmentsFailed?: number;
    error?: string;
  }>;

  /** Get submission status from cloud */
  getSubmissionStatus: (submissionId: string) => Promise<{
    success: boolean;
    status?: string;
    reviewNotes?: string;
    reviewedBy?: string;
    reviewedAt?: string;
    error?: string;
  }>;

  /**
   * Listen for submission progress updates
   */
  onSubmitProgress: (callback: (progress: {
    stage: string;
    stageProgress: number;
    overallProgress: number;
    currentItem?: string;
  }) => void) => () => void;

  /**
   * BACKLOG-1832: Mount-time inflight-sync query.
   * Returns whether a background auto-sync is currently in progress for the
   * given transaction. Used by TransactionDetails to retroactively show the
   * spinner when the component mounts after the push event was already sent.
   */
  isAutoSyncInFlight: (transactionId: string) => Promise<{
    success: boolean;
    inFlight: boolean;
  }>;
}
