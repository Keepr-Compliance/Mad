/**
 * WindowApi Messages & Outlook sub-interfaces
 * iMessage/SMS and Outlook integration methods
 */

import type { ConversationSummary, MessageAttachmentInfo } from "./common";
// BACKLOG-2743: ONE definition of the refusal shape. Re-exported here so the
// renderer imports it from the IPC contract rather than re-spelling the literal.
import type { AttachmentsRefusedForSpace } from "../../services/macOSMessagesImportService/types";
// BACKLOG-2749: the override list is the resolver's own type, re-exported here
// rather than re-spelled. The dialog renders `overrides[]` as DATA (the shape
// BACKLOG-2772 emitted for exactly this consumer), so a new override kind added
// in the resolver becomes a compile-time fact on the renderer side instead of a
// silently-unhandled case.
import type { ImportPlanOverride } from "../../services/importPlan";

export type { AttachmentsRefusedForSpace, ImportPlanOverride };

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
/**
 * BACKLOG-2749: the resolved plan's own facts, carried alongside the counts.
 *
 * The ONE pre-import dialog renders these DIRECTLY. It exists because several
 * surfaces had each worked out "is the cap biting, and by how much?" from
 * whatever numbers were nearest to hand, and they disagreed — the header said
 * "up to 50,000" while the selection line beneath it said 62,823 (founder,
 * 2026-08-22, live).
 *
 * The temptation the dialog must not yield to is INFERRING the cap from the
 * counts. `filteredCount > effectiveCap` is what "protected audit history rides
 * along" looks like, but `min(windowCount, cap)` is NOT the admitted count and
 * `filteredCount` is NOT the cap: under Cap' the admitted set is
 * `protected ∪ (the newest `cap` unprotected messages)`, whose size no pair of
 * counts can reconstruct. So the cap is stated by the resolver that enforces
 * it, and the dialog reads it rather than deriving it.
 */
export interface MessageImportPlanFacts {
  /**
   * The "Maximum messages" cap the run will enforce; `null` = Unlimited.
   * `ImportPlan.effectiveCap`, verbatim.
   */
  effectiveCap: number | null;
  /** Lower bound of the fetch, ISO; `null` = unbounded. `ImportPlan.fetchStartISO`. */
  fetchStartISO: string | null;
  /**
   * Everything the plan decided AGAINST the user's raw settings —
   * `ImportPlan.overrides`, verbatim. Today the only kind is
   * `window-extended-by-deals`. An empty array means the run does exactly what
   * the user's own selection asked for, and the dialog says nothing about deals.
   */
  overrides: ImportPlanOverride[];
}

/**
 * BACKLOG-2749: the largest preset range whose own resolved count fits under
 * the cap — the founder's [R], the dialog's recommendation.
 *
 * `windowCount` is main's count for THAT range's own plan. Carried so the
 * recommendation can be pinned against the resolver, and so the renderer never
 * scales one range's figure into another's: messages are not spread evenly
 * across months, and a proportional guess names a range that does not fit.
 */
export interface RecommendedImportRange {
  lookbackMonths: number;
  windowCount: number;
}

export interface MessageImportCountResult {
  success: boolean;
  count?: number;
  /**
   * BACKLOG-2749: the recommendation, PRECOMPUTED with the estimate.
   *
   * `null` = asked and nothing shorter fits (a definitive answer — the dialog
   * shows no recommendation and no spinner). ABSENT = this response predates
   * the precompute, and the renderer falls back to asking after the click.
   *
   * It is computed here rather than after the dialog opens because the founder
   * saw the consequence: "the Change the time range button takes a sec to
   * load". The per-candidate round trips are the right mechanism — asked, never
   * proportional — they were simply happening a beat too late. Same work, moved
   * ahead of the click, and only when the cap is actually exceeded.
   */
  recommendedRange?: RecommendedImportRange | null;
  /**
   * BACKLOG-2749: the plan these counts describe, as the resolver returned it.
   *
   * Absent on failure, and absent in a caller's own pre-2749 mocks — the dialog
   * treats an absent `plan` as "not enough is known to offer this choice" and
   * declines to render the choice, rather than guessing the missing fact.
   */
  plan?: MessageImportPlanFacts;
  /**
   * What the run will IMPORT for this plan — Cap' applied (BACKLOG-2772).
   * Present only when it differs from `count`.
   *
   * BACKLOG-2749 names what this is in user terms: the COVERAGE the store will
   * have when the run finishes, not the volume this run downloads. A delta
   * import skips what is already present, so the two differ by exactly the
   * messages already stored — and conflating them is what produced the wrong
   * completion figure (708,400 − 48,781 = 659,619 instead of
   * 708,400 − 62,824 = 645,576).
   */
  filteredCount?: number;
  /**
   * What the SELECTION covers, before the cap (BACKLOG-2772).
   *
   * The cap warning needs both numbers. With only the admitted count, a cap
   * truncating 707,842 messages to 50,000 is indistinguishable from a window
   * that happens to hold 50,000, and the user stops being told anything is
   * being left out.
   */
  windowCount?: number;
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
    /**
     * BACKLOG-2794: what the run's plan ADMITS — protected messages in full
     * plus the newest N of the remainder. `totalAvailable - coveredCount` is
     * what the import limit left out; `totalAvailable - messagesImported` is
     * not, because a delta import does not re-fetch what the store already has.
     * The founder's restore reported 659,619 excluded where 645,576 were.
     */
    coveredCount?: number;
    /**
     * BACKLOG-2794: refused because another import owns the service. Nothing
     * ran and nothing failed — the caller coalesces on this flag instead of
     * turning the refusal into a red error row.
     */
    alreadyInProgress?: boolean;
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
