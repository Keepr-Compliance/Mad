/**
 * WindowApi Messages & Outlook sub-interfaces
 * iMessage/SMS and Outlook integration methods
 */

import type { ConversationSummary, MessageAttachmentInfo } from "./common";
// BACKLOG-2743: ONE definition of the refusal shape. Re-exported here so the
// renderer imports it from the IPC contract rather than re-spelling the literal.
import type { AttachmentsRefusedForSpace } from "../../services/macOSMessagesImportService/types";

export type { AttachmentsRefusedForSpace };

/**
 * BACKLOG-2743: Filters for the selection-time import estimate.
 * `auditPeriodStart` mirrors the value the import itself uses to widen the
 * window, so the estimate describes the import that would actually run.
 */
/**
 * Payload of the background-import announcements (BACKLOG-2772).
 */
export interface BackgroundImportSignal {
  userId: string;
  /** Which lifecycle event asked for the import (create / date-change / ...). */
  reason: string;
}

export interface MessageImportCountFilters {
  lookbackMonths?: number | null;
  maxMessages?: number | null;
  skipAttachments?: boolean;
}

/*
 * BACKLOG-2772: `auditPeriodStart` was REMOVED from this type, and its removal
 * is the point rather than a tidy-up.
 *
 * The renderer used to compute the effective audit floor (over a second IPC)
 * and send it back down with every estimate request, which made the Settings
 * panel a participant in deciding what an import covers. It is not one. The
 * resolver derives the deal spans itself, from the same query the export gate
 * reads, so the panel now states only what the USER has selected and the
 * compiler rejects the old field.
 */

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
  /**
   * Import messages from macOS Messages app into the app database (macOS only)
   *
   * BACKLOG-2775: `forceReimport` was missing from this declaration while
   * `messageBridge.importMacOSMessages` had taken it since TASK-2150 — so the
   * only caller that passes it, the sync orchestrator, had to cast the function
   * to a two-parameter shape to call it at all. A canonical type that the real
   * bridge does not match stops being a check and becomes a cast generator.
   *
   * @param forceReimport - delete existing macOS messages and re-import all.
   *   Atomic: the clear and the re-import share one transaction.
   */
  importMacOSMessages: (userId: string, forceReimport?: boolean) => Promise<{
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
    attachmentsRefusedForSpace?: AttachmentsRefusedForSpace;
    /** BACKLOG-2743: user chose to import without attachments */
    attachmentsSkippedByChoice?: boolean;
    /**
     * BACKLOG-2748: the user cancelled the run. Partial counts, not a failure —
     * branch on this rather than on the `error` text.
     */
    cancelled?: boolean;
    /**
     * BACKLOG-2775: the cancelled run was a FORCE re-import and it rolled back.
     * Every count above is 0 and the message store is exactly as it was — the
     * UI must say "nothing changed", not report a count.
     */
    rolledBack?: boolean;
  }>;
  /** Get count of messages available for import from macOS Messages */
  getImportCount: (
    userId: string,
    selection?: MessageImportCountFilters
  ) => Promise<MessageImportCountResult>;
  /**
   * Subscribe to macOS Messages imports the renderer did not start
   * (BACKLOG-2772). See the preload bridge for why this exists.
   */
  onBackgroundImport: (callbacks: {
    onStarted: (signal: BackgroundImportSignal) => void;
    onFinished: (signal: BackgroundImportSignal) => void;
  }) => () => void;
  /**
   * Cancel the running macOS Messages import (BACKLOG-2748).
   *
   * One-way send; the outcome arrives on the normal import result with
   * `cancelled: true` and the partial counts. The preload bridge has exposed
   * this since TASK-1710, but it was missing from this interface, so no renderer
   * code could reach it — which is exactly how the app shipped with a running
   * import that could not be stopped.
   */
  cancelImport: () => void;
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
