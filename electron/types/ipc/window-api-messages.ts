/**
 * WindowApi Messages & Outlook sub-interfaces
 * iMessage/SMS and Outlook integration methods
 */

import type { ConversationSummary, MessageAttachmentInfo } from "./common";

/**
 * BACKLOG-2743: Filters for the selection-time import estimate.
 * `auditPeriodStart` mirrors the value the import itself uses to widen the
 * window, so the estimate describes the import that would actually run.
 */
export interface MessageImportCountFilters {
  lookbackMonths?: number | null;
  maxMessages?: number | null;
  auditPeriodStart?: string | null;
}

/**
 * BACKLOG-2743: Selection-time import estimate.
 *
 * `fitsOnDisk` is computed in the MAIN process by the same helper the pre-flight
 * check uses. The renderer must render this verdict, never recompute it from
 * `attachmentBytes` vs `availableDiskBytes` — two comparisons would drift, and
 * the headroom rule lives on the main side.
 */
export interface MessageImportCountResult {
  success: boolean;
  count?: number;
  filteredCount?: number;
  error?: string;
  /** Bytes of attachments that would be copied for the selected window. */
  attachmentBytes?: number;
  /** Number of attachments that would be copied. */
  attachmentCount?: number;
  /** df-equivalent free space available to the app; null when unreadable. */
  availableDiskBytes?: number | null;
  /** False only when free space is known AND insufficient. */
  fitsOnDisk?: boolean;
}

/**
 * Messages API (iMessage/SMS - migrated from window.electron)
 */
export interface WindowApiMessages {
  /** Get conversations — routes to macOS chat.db or local messages table based on phone type (BACKLOG-1470) */
  getConversations: (userId?: string) => Promise<{
    success: boolean;
    conversations?: ConversationSummary[];
    error?: string;
  }>;
  getMessages: (chatId: string) => Promise<unknown[]>;
  /** Import messages from macOS Messages app into the app database (macOS only) */
  importMacOSMessages: (userId: string) => Promise<{
    success: boolean;
    messagesImported: number;
    messagesSkipped: number;
    attachmentsImported: number;
    attachmentsSkipped: number;
    duration: number;
    error?: string;
    totalAvailable?: number;
    wasCapped?: boolean;
    /** BACKLOG-2743: pre-flight free-space check refused the attachment copy */
    attachmentsRefusedForSpace?: { estimatedBytes: number; availableBytes: number; attachmentCount: number };
    /** BACKLOG-2743: user chose to import without attachments */
    attachmentsSkippedByChoice?: boolean;
  }>;
  /** Get count of messages available for import from macOS Messages */
  getImportCount: (filters?: MessageImportCountFilters) => Promise<MessageImportCountResult>;
  /** Listen for import progress updates */
  onImportProgress: (callback: (progress: { phase: "deleting" | "importing" | "attachments"; current: number; total: number; percent: number }) => void) => () => void;
  /** Get attachments for a message with base64 data (TASK-1012) */
  getMessageAttachments: (messageId: string) => Promise<MessageAttachmentInfo[]>;
  /** Get attachments for multiple messages at once (TASK-1012) */
  getMessageAttachmentsBatch: (messageIds: string[]) => Promise<Record<string, MessageAttachmentInfo[]>>;
  /** Repair attachment message_id mappings without full re-import */
  repairAttachments: () => Promise<{
    total: number;
    repaired: number;
    orphaned: number;
    alreadyCorrect: number;
  }>;
  /** Get macOS messages import status (count and last import time) */
  getImportStatus: (userId: string) => Promise<{
    success: boolean;
    messageCount?: number;
    lastImportAt?: string | null;
    error?: string;
  }>;
  /**
   * Get the EFFECTIVE (audit-aware) macOS Messages import window for display (BACKLOG-2286).
   * effectiveCutoffISO is the actual import lower bound (null = all time); source
   * indicates whether the audit period or the lookback preference governs it.
   */
  getEffectiveImportWindow: (userId: string) => Promise<{
    success: boolean;
    effectiveCutoffISO: string | null;
    source: "audit-period" | "lookback-pref";
    lookbackMonths: number | null;
  }>;
}

/**
 * Outlook integration methods (migrated from window.electron)
 */
export interface WindowApiOutlook {
  initialize: () => Promise<{ success: boolean; error?: string }>;
  authenticate: () => Promise<{
    success: boolean;
    error?: string;
    userInfo?: { username?: string };
  }>;
  isAuthenticated: () => Promise<boolean>;
  getUserEmail: () => Promise<string | null>;
  signout: () => Promise<{ success: boolean }>;
  onDeviceCode: (callback: (info: unknown) => void) => () => void;
  onExportProgress: (callback: (progress: unknown) => void) => () => void;
}
