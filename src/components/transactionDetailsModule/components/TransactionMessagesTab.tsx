/**
 * TransactionMessagesTab Component
 * Messages tab content showing text messages linked to a transaction.
 * Displays messages grouped by thread in conversation-style format.
 */
import React, { useState, useCallback, useEffect, useMemo, useRef } from "react";
import type { Communication } from "../types";
import type { HighlightTarget } from "../types";
import {
  MessageThreadCard,
  groupMessagesByThread,
  extractPhoneFromThread,
  sortThreadsByRecent,
  type MessageLike,
} from "./MessageThreadCard";
import { AttachMessagesModal, UnlinkMessageModal } from "./modals";
import { RemovedMessagesSection } from "./RemovedMessagesSection";
import { BulkSelectionBar, BulkRemoveConfirmModal } from "./BulkSelectionBar";
import { useSelection } from "../../../hooks/useSelection";
import { parseDateSafe } from "../../../utils/dateFormatters";
import { extractAllHandles } from "../../../utils/phoneNormalization";
import { mergeThreadsByContact, type MergedThreadEntry } from "../../../utils/threadMergeUtils";
import { formatDateRangeLabel } from "../../../utils/dateRangeUtils";
import logger from '../../../utils/logger';

/**
 * Check if a message falls within the audit date range
 */
function isMessageInAuditPeriod(
  msg: MessageLike,
  startDate: Date | null,
  endDate: Date | null
): boolean {
  const msgDate = parseDateSafe(msg.sent_at || msg.received_at) || new Date(0);

  // Check start date (if set)
  if (startDate && msgDate < startDate) {
    return false;
  }

  // Check end date (if set) - use end of day for inclusive comparison
  if (endDate) {
    const endOfDay = new Date(endDate);
    endOfDay.setHours(23, 59, 59, 999);
    if (msgDate > endOfDay) {
      return false;
    }
  }

  return true;
}

interface TransactionMessagesTabProps {
  /** Text messages linked to the transaction */
  messages: Communication[];
  /** Whether messages are being loaded */
  loading: boolean;
  /** Error message if loading failed */
  error: string | null;
  /** User ID for API calls */
  userId?: string;
  /** Transaction ID for API calls */
  transactionId?: string;
  /** Property address for display */
  propertyAddress?: string;
  /** Callback when messages are modified (attached/unlinked). Can be async for refresh. */
  onMessagesChanged?: () => void | Promise<void>;
  /**
   * BACKLOG-1793: SILENT refresh after a removed conversation is restored
   * (refreshCommunicationsSilently("text")) — no loading flag, no spinner, the
   * scroll container never shifts. Mirrors the Emails tab's onRestoreComplete.
   */
  onRestoreComplete?: () => void | Promise<void>;
  /** TASK-2094: Optimistic removal -- removes messages by ID from parent state without refetch */
  onRemoveMessagesByIds?: (ids: string[]) => void;
  /** Toast handler for success messages */
  onShowSuccess?: (message: string) => void;
  /** Toast handler for error messages */
  onShowError?: (message: string) => void;
  /** Audit period start date for filtering (TASK-1157) */
  auditStartDate?: Date | string | null;
  /** Audit period end date for filtering (TASK-1157) */
  auditEndDate?: Date | string | null;
  /** Callback to sync/re-link messages from contacts */
  onSyncMessages?: () => Promise<void>;
  /** Whether sync is in progress */
  syncingMessages?: boolean;
  /** Whether a global sync (from dashboard) is in progress */
  globalSyncRunning?: boolean;
  /** TASK-2074: Whether the app is online (network connectivity) */
  isOnline?: boolean;
  /** Whether there are contacts assigned (to show sync button) */
  hasContacts?: boolean;
  /** BACKLOG-1869: Deep-navigate target from search; scroll+highlight the matching card. */
  highlightTarget?: HighlightTarget | null;
  /** BACKLOG-1869: Called once the highlight has been applied (or gracefully skipped). */
  onHighlightConsumed?: () => void;
}

/**
 * Messages tab content component.
 * Shows loading state, empty state, or message threads.
 */
// extractAllHandles imported from src/utils/phoneNormalization.ts (TASK-2027)

export function TransactionMessagesTab({
  messages,
  loading,
  error,
  userId,
  transactionId,
  propertyAddress,
  onMessagesChanged,
  onRestoreComplete,
  onRemoveMessagesByIds,
  onShowSuccess,
  onShowError,
  auditStartDate,
  auditEndDate,
  onSyncMessages,
  syncingMessages = false,
  globalSyncRunning = false,
  isOnline = true,
  hasContacts = false,
  highlightTarget,
  onHighlightConsumed,
}: TransactionMessagesTabProps): React.ReactElement {
  // TASK-2074: Disable sync when offline, already syncing, or when a global dashboard sync is running
  const syncDisabled = !isOnline || syncingMessages || globalSyncRunning;
  const syncTooltip = !isOnline
    ? "You are offline"
    : globalSyncRunning
    ? "A sync is already in progress from the dashboard"
    : undefined;

  const [showAttachModal, setShowAttachModal] = useState(false);
  const [unlinkTarget, setUnlinkTarget] = useState<{
    threadId: string;
    phoneNumber: string;
    messageCount: number;
    originalThreadIds?: string[];
  } | null>(null);
  const [isUnlinking, setIsUnlinking] = useState(false);
  const [contactNames, setContactNames] = useState<Record<string, string>>({});
  // BACKLOG-1793: lift the "Show removed" open state so it survives the
  // loading-spinner re-mount — a restore never collapses the section.
  const [removedSectionOpen, setRemovedSectionOpen] = useState(false);
  // BACKLOG-1793: bump after each successful unlink → RemovedMessagesSection
  // silently refetches so its count label stays live.
  const [removedSectionRefreshKey, setRemovedSectionRefreshKey] = useState(0);

  // BACKLOG-1719: active-list multi-select bulk remove.
  const {
    selectedIds: selectedThreadIds,
    toggleSelection: toggleThreadSelection,
    selectAll: selectAllThreads,
    deselectAll: deselectAllThreads,
    isSelected: isThreadSelected,
    count: selectedCount,
  } = useSelection();
  const [selectionMode, setSelectionMode] = useState(false);
  const [isBulkRemoving, setIsBulkRemoving] = useState(false);
  const [showBulkRemoveConfirm, setShowBulkRemoveConfirm] = useState(false);

  // BACKLOG-357: Audit date filtering state
  // TASK-1795: Uses parseDateSafe from utils for Windows timezone handling
  const parsedStartDate = parseDateSafe(auditStartDate, 'TransactionMessagesTab');
  const parsedEndDate = parseDateSafe(auditEndDate, 'TransactionMessagesTab');
  // Show filter if at least one date is set (handles ongoing transactions with only start date)
  const hasAuditDates = !!(parsedStartDate || parsedEndDate);

  // Default to showing audit period only when dates are available
  const [showAuditPeriodOnly, setShowAuditPeriodOnly] = useState<boolean>(hasAuditDates);

  // TASK-2026: Look up contact names for all handles (phones + emails + Apple IDs)
  // Uses shared ContactResolutionService via resolveHandles IPC
  useEffect(() => {
    const lookupContactNames = async () => {
      if (messages.length === 0) return;

      const handles = extractAllHandles(messages);
      if (handles.length === 0) return;

      try {
        const result = await window.api.contacts.resolveHandles(handles, userId);

        if (result.success && result.names) {
          // Build a lookup map with both original and normalized keys
          const namesWithNormalized: Record<string, string> = {};
          Object.entries(result.names as Record<string, string>).forEach(([handle, name]) => {
            namesWithNormalized[handle] = name;
            // For phone-like handles, also add normalized version (last 10 digits)
            const isPhone = handle.startsWith("+") || /^\d[\d\s\-()]{6,}$/.test(handle);
            if (isPhone) {
              const normalized = handle.replace(/\D/g, '').slice(-10);
              if (normalized.length >= 7) {
                namesWithNormalized[normalized] = name;
              }
            }
            // For email handles, also store lowercase version
            if (handle.includes("@")) {
              namesWithNormalized[handle.toLowerCase()] = name;
            }
          });
          setContactNames(namesWithNormalized);
        }
      } catch (err) {
        logger.error("Failed to look up contact names:", err);
      }
    };

    lookupContactNames();
  }, [messages]);

  // BACKLOG-1589: Merge newly resolved contact names from removed messages into state
  const handleContactNamesResolved = useCallback((names: Record<string, string>) => {
    setContactNames(prev => ({ ...prev, ...names }));
  }, []);

  // Handle attach button click
  const handleAttachClick = useCallback(() => {
    setShowAttachModal(true);
  }, []);

  // Handle messages attached successfully
  const handleAttached = useCallback(() => {
    onMessagesChanged?.();
    onShowSuccess?.("Messages attached successfully");
  }, [onMessagesChanged, onShowSuccess]);

  // Handle unlink button click on a thread
  // TASK-2025: Updated to accept originalThreadIds for merged threads
  const handleUnlinkClick = useCallback(
    (threadId: string, originalThreadIds?: string[]) => {
      // For merged threads, collect all messages from all original thread IDs
      const rawThreads = groupMessagesByThread(messages);
      const idsToCollect = originalThreadIds && originalThreadIds.length > 1
        ? originalThreadIds
        : [threadId];

      const allMessages: MessageLike[] = [];
      for (const id of idsToCollect) {
        const threadMessages = rawThreads.get(id);
        if (threadMessages) {
          allMessages.push(...threadMessages);
        }
      }

      if (allMessages.length > 0) {
        setUnlinkTarget({
          threadId, // Use the display key for lookup
          phoneNumber: extractPhoneFromThread(allMessages),
          messageCount: allMessages.length,
          originalThreadIds: idsToCollect,
        });
      }
    },
    [messages]
  );

  // Handle unlink confirmation
  // TASK-2025: Updated to handle merged threads (collect messages from all original thread IDs)
  // TASK-2094: Uses optimistic removal to avoid full list unmount/remount
  const handleUnlinkConfirm = useCallback(async () => {
    if (!unlinkTarget || !transactionId) return;

    setIsUnlinking(true);
    try {
      // Get all message IDs for this thread (or merged group of threads)
      const rawThreads = groupMessagesByThread(messages);

      // Use stored originalThreadIds from handleUnlinkClick (avoids stale closure)
      const idsToCollect = unlinkTarget.originalThreadIds && unlinkTarget.originalThreadIds.length > 1
        ? unlinkTarget.originalThreadIds
        : [unlinkTarget.threadId];

      const allMessages: MessageLike[] = [];
      for (const id of idsToCollect) {
        const threadMessages = rawThreads.get(id);
        if (threadMessages) {
          allMessages.push(...threadMessages);
        }
      }

      if (allMessages.length === 0) {
        throw new Error("Thread not found");
      }

      const messageIds = allMessages.map((m) => m.id);
      // TASK-1116: Pass transactionId for thread-based unlinking
      const result = await window.api.transactions.unlinkMessages(messageIds, transactionId);

      if (result.success) {
        onShowSuccess?.("Messages removed from transaction");
        // TASK-2094: Optimistic removal — remove messages from parent state in-place.
        // This avoids a full refetch that triggers loading=true → list unmount → remount.
        if (onRemoveMessagesByIds) {
          onRemoveMessagesByIds(messageIds);
        } else {
          // Fallback: full refresh if optimistic removal is not available
          await onMessagesChanged?.();
        }
        // BACKLOG-1793: signal RemovedMessagesSection to refresh its count so the
        // just-removed conversation appears in the "Show removed" list live.
        setRemovedSectionRefreshKey((k) => k + 1);
        setUnlinkTarget(null);
      } else {
        onShowError?.(result.error || "Failed to remove messages");
      }
    } catch (err) {
      logger.error("Failed to unlink messages:", err);
      onShowError?.(
        err instanceof Error ? err.message : "Failed to remove messages"
      );
    } finally {
      setIsUnlinking(false);
    }
  }, [unlinkTarget, messages, transactionId, onRemoveMessagesByIds, onMessagesChanged, onShowSuccess, onShowError]);

  // Handle cancel unlink
  const handleUnlinkCancel = useCallback(() => {
    setUnlinkTarget(null);
  }, []);

  // Group messages by thread and sort by most recent
  // NOTE: These computations and useMemo MUST be called before any early returns
  // to comply with React's Rules of Hooks
  const sortedThreads = useMemo(() => {
    const threads = groupMessagesByThread(messages);
    return sortThreadsByRecent(threads);
  }, [messages]);

  // TASK-2025: Merge threads from the same contact (display-layer only)
  // This combines SMS, iMessage, and iCloud email threads into one per contact.
  const mergedThreads: MergedThreadEntry[] = useMemo(
    () => mergeThreadsByContact(sortedThreads, contactNames),
    [sortedThreads, contactNames],
  );

  // BACKLOG-357: Filter threads and messages by audit date range
  // TASK-2025: Uses mergedThreads (contact-merged) instead of raw sortedThreads
  const { filteredThreads, filteredMessageCount, totalMessageCount, filteredConversationCount, totalConversationCount } = useMemo(() => {
    if (!showAuditPeriodOnly || !hasAuditDates) {
      return {
        filteredThreads: mergedThreads,
        filteredMessageCount: messages.length,
        totalMessageCount: messages.length,
        filteredConversationCount: mergedThreads.length,
        totalConversationCount: mergedThreads.length,
      };
    }

    // Filter threads: keep only threads that have at least one message in audit period
    // Also filter messages within each thread
    const filtered: MergedThreadEntry[] = [];
    let msgCount = 0;

    for (const [threadId, threadMessages, originalIds] of mergedThreads) {
      const messagesInPeriod = threadMessages.filter((msg) =>
        isMessageInAuditPeriod(msg, parsedStartDate, parsedEndDate)
      );

      if (messagesInPeriod.length > 0) {
        filtered.push([threadId, messagesInPeriod, originalIds]);
        msgCount += messagesInPeriod.length;
      }
    }

    return {
      filteredThreads: filtered,
      filteredMessageCount: msgCount,
      totalMessageCount: messages.length,
      filteredConversationCount: filtered.length,
      totalConversationCount: mergedThreads.length,
    };
  }, [mergedThreads, messages.length, showAuditPeriodOnly, hasAuditDates, parsedStartDate, parsedEndDate]);

  // BACKLOG-1719: selectable conversations = the currently visible (filtered)
  // display threads, keyed by their display threadId.
  const selectableThreads = useMemo(
    () => filteredThreads.map(([threadId]) => ({ id: threadId })),
    [filteredThreads]
  );

  // Aggregate ALL underlying message IDs for the selected conversations. Uses the
  // raw (unfiltered) thread grouping via originalThreadIds so merged/contact-
  // combined threads remove every constituent message — matching the single
  // unlink flow (which also unlinks the whole thread, not just the audit window).
  const selectedMessageIds = useMemo(() => {
    const rawThreads = groupMessagesByThread(messages);
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const [threadId, , originalThreadIds] of filteredThreads) {
      if (!selectedThreadIds.has(threadId)) continue;
      const idsToCollect =
        originalThreadIds && originalThreadIds.length > 1 ? originalThreadIds : [threadId];
      for (const id of idsToCollect) {
        const threadMessages = rawThreads.get(id);
        if (!threadMessages) continue;
        for (const m of threadMessages) {
          if (!seen.has(m.id)) {
            seen.add(m.id);
            ids.push(m.id);
          }
        }
      }
    }
    return ids;
  }, [messages, filteredThreads, selectedThreadIds]);

  // BACKLOG-1869: When a highlight target arrives, locate the matching conversation
  // card (searching the full merged list so audit-period-filtered threads can still
  // be found), scroll it into view, and flash a brief highlight ring.
  //
  // Design notes (SR-reviewed):
  // • filteredThreads/mergedThreads and onHighlightConsumed are kept in refs so the
  //   effect deps are only [highlightTarget, loading]. If thread lists were deps,
  //   any re-sort would trigger cleanup → clearTimeout, making the ring permanent.
  // • onHighlightConsumed is called INSIDE the 2s timer (after ring removal). Calling
  //   it early sets highlightTarget→null, which fires cleanup and kills the timer.
  // • A ref guard (lastHighlightedCommIdRef) prevents re-flash when deps change
  //   while the animation is running.
  const filteredThreadsRef = useRef(filteredThreads);
  filteredThreadsRef.current = filteredThreads;
  const mergedThreadsRef = useRef(mergedThreads);
  mergedThreadsRef.current = mergedThreads;
  const onHighlightConsumedMsgRef = useRef(onHighlightConsumed);
  onHighlightConsumedMsgRef.current = onHighlightConsumed;

  // BACKLOG-1869 animation state refs — kept outside effect runs so re-renders
  // during the 2s animation window don't kill the ring through effect cleanup.
  const activeTextElRef = useRef<HTMLElement | null>(null);
  const activeTextTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeTextIdRef = useRef<string | null>(null);

  // Unmount-only cleanup: strips the ring if the tab unmounts mid-animation.
  useEffect(() => {
    return () => {
      if (activeTextTimerRef.current !== null) clearTimeout(activeTextTimerRef.current);
      if (activeTextElRef.current) activeTextElRef.current.classList.remove("ring-2", "ring-inset", "ring-blue-400", "bg-blue-50");
    };
  }, []); // empty deps — fires once on unmount only

  // BACKLOG-1869: When a highlight target arrives, locate the matching conversation
  // card (searching the full merged list so audit-period-filtered threads can still
  // be found), scroll it into view, and flash a brief highlight ring.
  //
  // Design notes (updated after founder trace confirmed root cause):
  //
  // Root cause of the original failure (proven via debug trace):
  //   handleNavigateToTab fires when loading=true; a loading flip during the 2s
  //   animation triggered effect cleanup which stripped the ring and cancelled the
  //   timer; the guard (lastHighlightedIdRef) then blocked re-application forever.
  //
  // Fix — two parts:
  //   1. PRIMITIVE DEP: dep is highlightTarget?.communicationId ?? null (string|null).
  //      Object identity churn can no longer trigger a spurious re-run and cleanup.
  //   2. ANIMATION REFS: ring element + 2s timer live in module-level refs. Per-run
  //      cleanup only cancels the retry loop; ring survives loading flips.
  //      Removed by (a) its own timer, (b) a new different-id entry, (c) unmount.
  //
  // Additional preservation from prior SR review:
  //   • filteredThreads/mergedThreads/onHighlightConsumed via refs (not deps).
  //   • onHighlightConsumed fires INSIDE the 2s timer.
  //   • DOM mount-race retry: up to 30 × 16 ms frames before giving up.
  //   • Clip-proof visual: ring-inset + bg-blue-50.
  useEffect(() => {
    // Extract primitive id — immune to object-identity churn between renders
    const targetId = highlightTarget?.type === "text" ? (highlightTarget.communicationId ?? null) : null;

    if (!targetId) {
      // Target gone: reset animation guard
      activeTextIdRef.current = null;
      return;
    }
    if (loading) return;

    // Animation for this exact id is already live — protect it from cleanup
    if (activeTextIdRef.current === targetId) return;

    // Different id arriving: clean up any leftover animation from the previous id
    if (activeTextIdRef.current !== null) {
      if (activeTextTimerRef.current !== null) { clearTimeout(activeTextTimerRef.current); activeTextTimerRef.current = null; }
      if (activeTextElRef.current) { activeTextElRef.current.classList.remove("ring-2", "ring-inset", "ring-blue-400", "bg-blue-50"); activeTextElRef.current = null; }
    }
    // Mark this id in-progress
    activeTextIdRef.current = targetId;

    // Search visible (filtered) threads first; fall back to all merged threads so a
    // card hidden by the audit-period filter still scrolls into view if rendered.
    const entry =
      filteredThreadsRef.current.find(([, msgs]) => msgs.some((m) => m.id === targetId)) ??
      mergedThreadsRef.current.find(([, msgs]) => msgs.some((m) => m.id === targetId));
    if (!entry) { activeTextIdRef.current = null; onHighlightConsumedMsgRef.current?.(); return; }
    const [displayThreadId] = entry;

    let loopCancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    const MAX_RETRIES = 30;

    function applyHighlight(el: HTMLElement): void {
      activeTextElRef.current = el;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.add("ring-2", "ring-inset", "ring-blue-400", "bg-blue-50");
      activeTextTimerRef.current = setTimeout(() => {
        el.classList.remove("ring-2", "ring-inset", "ring-blue-400", "bg-blue-50");
        activeTextElRef.current = null;
        activeTextTimerRef.current = null;
        onHighlightConsumedMsgRef.current?.(); // consumed AFTER ring is gone
      }, 2000);
    }

    function attempt(): void {
      if (loopCancelled) return;
      const el = document.querySelector<HTMLElement>(`[data-thread-id="${displayThreadId}"]`);
      if (el) { applyHighlight(el); return; }
      attempts++;
      if (attempts >= MAX_RETRIES) { activeTextIdRef.current = null; onHighlightConsumedMsgRef.current?.(); return; }
      retryTimer = setTimeout(attempt, 16);
    }

    attempt();

    return () => {
      // Per-run cleanup cancels only the retry loop.
      // Ring element + timer are in refs and outlive individual effect runs.
      loopCancelled = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  }, [highlightTarget?.communicationId ?? null, loading]); // primitive id dep — thread lists/onHighlightConsumed via refs

  // Selection-mode entry/exit (matches the transaction window).
  const handleToggleSelectionMode = useCallback(() => {
    setSelectionMode((prev) => {
      if (prev) deselectAllThreads();
      return !prev;
    });
  }, [deselectAllThreads]);

  const handleSelectAll = useCallback(() => {
    selectAllThreads(selectableThreads);
  }, [selectAllThreads, selectableThreads]);

  // BACKLOG-1719: bulk remove — ONE unlinkMessages call with every selected
  // conversation's message IDs aggregated, then a single in-place removal +
  // one toast (mirrors handleUnlinkConfirm's optimistic path).
  const handleBulkRemoveConfirm = useCallback(async () => {
    if (!transactionId || selectedMessageIds.length === 0) return;
    setIsBulkRemoving(true);
    try {
      const result = await window.api.transactions.unlinkMessages(selectedMessageIds, transactionId);
      if (result.success) {
        const convCount = selectedThreadIds.size;
        onShowSuccess?.(
          convCount > 1 ? `${convCount} conversations removed` : "Messages removed from transaction"
        );
        if (onRemoveMessagesByIds) {
          onRemoveMessagesByIds(selectedMessageIds);
        } else {
          await onMessagesChanged?.();
        }
        setRemovedSectionRefreshKey((k) => k + 1);
        deselectAllThreads();
        setSelectionMode(false);
      } else {
        onShowError?.(result.error || "Failed to remove messages");
      }
    } catch (err) {
      logger.error("Failed to bulk-unlink messages:", err);
      onShowError?.(err instanceof Error ? err.message : "Failed to remove messages");
    } finally {
      setIsBulkRemoving(false);
      setShowBulkRemoveConfirm(false);
    }
  }, [transactionId, selectedMessageIds, selectedThreadIds, onRemoveMessagesByIds, onMessagesChanged, onShowSuccess, onShowError, deselectAllThreads]);

  // Loading state (placed after hooks to comply with Rules of Hooks)
  if (loading) {
    return (
      <div className="text-center py-12">
        <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto"></div>
        <p className="text-gray-500 mt-4">Loading messages...</p>
      </div>
    );
  }

  // Error state (placed after hooks to comply with Rules of Hooks)
  if (error) {
    return (
      <div className="text-center py-12">
        <svg
          className="w-16 h-16 text-red-300 mx-auto mb-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <p className="text-red-600 mb-2">{error}</p>
        <p className="text-sm text-gray-500">
          Please try again or contact support if the issue persists.
        </p>
      </div>
    );
  }

  // Empty state
  if (messages.length === 0) {
    return (
      <div>
        <div className="bg-gray-50 rounded-lg p-6 text-center">
          <svg
            className="w-12 h-12 text-gray-300 mx-auto mb-3"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
            />
          </svg>
          <p className="text-gray-600 mb-1">No text messages linked</p>
          <p className="text-sm text-gray-500 mb-4">
            {hasContacts
              ? "Sync messages from assigned contacts or attach manually"
              : "Click \"Attach Messages\" to get started"}
          </p>
          <div className="flex items-center justify-center gap-3">
            {onSyncMessages && hasContacts && (
              <button
                onClick={onSyncMessages}
                disabled={syncDisabled}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-green-600 bg-green-50 hover:bg-green-100 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="sync-messages-button"
                title={syncTooltip}
              >
                <svg
                  className={`w-4 h-4 ${syncingMessages ? "animate-spin" : ""}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                  />
                </svg>
                {syncingMessages ? "Syncing..." : <>Sync<span className="hidden sm:inline"> Messages</span></>}
              </button>
            )}
            {userId && transactionId && (
              <button
                onClick={handleAttachClick}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors"
                data-testid="attach-messages-button"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 4v16m8-8H4"
                  />
                </svg>
                Attach<span className="hidden sm:inline"> Messages</span>
              </button>
            )}
          </div>
        </div>

        {/* BACKLOG-1577: Show removed conversations even when no active messages */}
        {transactionId && (
          <RemovedMessagesSection
            transactionId={transactionId}
            contactNames={contactNames}
            onMessagesChanged={onMessagesChanged}
            onRestoreComplete={onRestoreComplete}
            onShowSuccess={onShowSuccess}
            onShowError={onShowError}
            onContactNamesResolved={handleContactNamesResolved}
            isOpen={removedSectionOpen}
            onOpenChange={setRemovedSectionOpen}
            refreshKey={removedSectionRefreshKey}
          />
        )}

        {/* Modals */}
        {showAttachModal && userId && transactionId && (
          <AttachMessagesModal
            userId={userId}
            transactionId={transactionId}
            propertyAddress={propertyAddress}
            onClose={() => setShowAttachModal(false)}
            onAttached={handleAttached}
          />
        )}
      </div>
    );
  }

  return (
    <div>
      {/* Header with message count and filter toggle */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-lg font-medium text-gray-900">
            {filteredConversationCount} conversation{filteredConversationCount !== 1 ? "s" : ""}<span className="hidden sm:inline"> ({filteredMessageCount} text message{filteredMessageCount !== 1 ? "s" : ""})</span>
          </h3>
          {showAuditPeriodOnly && hasAuditDates && (filteredMessageCount !== totalMessageCount || filteredConversationCount !== totalConversationCount) && (
            <p className="text-sm text-gray-500 hidden sm:block">
              of {totalConversationCount} conversation{totalConversationCount !== 1 ? "s" : ""} ({totalMessageCount} messages)
            </p>
          )}
        </div>

        <div className="flex items-center gap-4">
          {/* BACKLOG-357: Audit period filter toggle */}

          {/* Attach button */}
          {userId && transactionId && (
            <button
              onClick={handleAttachClick}
              className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded-lg transition-colors"
              data-testid="attach-messages-button"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 4v16m8-8H4"
                />
              </svg>
              Attach<span className="hidden sm:inline"> Messages</span>
            </button>
          )}
          {/* Sync button */}
          {onSyncMessages && hasContacts && (
            <button
              onClick={onSyncMessages}
              disabled={syncDisabled}
              className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-green-600 hover:text-green-800 hover:bg-green-50 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              data-testid="sync-messages-button"
              title={syncTooltip}
            >
              {syncingMessages ? (
                <>
                  <svg
                    className="w-4 h-4 animate-spin"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    ></circle>
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    ></path>
                  </svg>
                  Syncing...
                </>
              ) : (
                <>
                  <svg
                    className="w-4 h-4"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                    />
                  </svg>
                  Sync<span className="hidden sm:inline"> Messages</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* BACKLOG-1719 (founder design): Select entry sits to the LEFT of the
          audit-period filter on the SAME row — kept IDENTICAL to the Emails tab
          (same icon: transaction-window Edit/bulk-edit clipboard-check, w-5,
          strokeWidth 2). */}
      <div className="flex items-center gap-2 mb-4">
        <button
          onClick={handleToggleSelectionMode}
          className={`flex items-center gap-1.5 px-3 h-10 text-sm font-medium rounded-lg transition-colors flex-shrink-0 ${
            selectionMode
              ? "bg-blue-500 text-white hover:bg-blue-600"
              : "bg-gray-200 text-gray-700 hover:bg-gray-300"
          }`}
          data-testid="select-messages-button"
        >
          <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
          </svg>
          {selectionMode ? "Cancel" : "Select"}
        </button>

        {/* Audit period filter + info line — right of Select, same row */}
        {hasAuditDates && (
        <div className="flex-1 flex items-center justify-between bg-gray-50 rounded-lg px-4 py-2.5" data-testid="audit-period-filter">
          <span className="text-sm text-gray-700 flex items-center gap-1.5" data-testid="audit-period-info">
            <span className="hidden sm:inline text-gray-500">
              {showAuditPeriodOnly
                ? `Showing ${filteredMessageCount} of ${totalMessageCount} messages within ${formatDateRangeLabel(parsedStartDate, parsedEndDate)}`
                : `${totalMessageCount} messages total`}
            </span>
            <span className="sm:hidden flex items-center gap-1.5">
              <button
                type="button"
                className="w-5 h-5 rounded-full bg-blue-100 text-blue-600 text-xs font-bold flex items-center justify-center hover:bg-blue-200 transition-colors"
                title={showAuditPeriodOnly
                  ? `Showing ${filteredMessageCount} of ${totalMessageCount} messages within ${formatDateRangeLabel(parsedStartDate, parsedEndDate)}`
                  : `${totalMessageCount} messages total`}
              >
                i
              </button>
              Audit period
            </span>
          </span>
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-700 hidden sm:inline">Audit period</span>
            <button
              type="button"
              role="switch"
              aria-checked={showAuditPeriodOnly}
              onClick={() => setShowAuditPeriodOnly(!showAuditPeriodOnly)}
              className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                showAuditPeriodOnly ? "bg-blue-600" : "bg-gray-300"
              }`}
              data-testid="audit-period-filter-checkbox"
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                  showAuditPeriodOnly ? "translate-x-4" : "translate-x-0"
                }`}
              />
            </button>
          </div>
        </div>
        )}
      </div>

      {/* Thread list */}
      <div className="space-y-4" data-testid="message-thread-list">
        {filteredThreads.map(([threadId, threadMessages, originalThreadIds]) => {
          const phoneNumber = extractPhoneFromThread(threadMessages);
          // Look up contact name for thread header
          const normalized = phoneNumber.replace(/\D/g, '').slice(-10);
          const contactName = contactNames[phoneNumber] || contactNames[normalized];

          return (
            <MessageThreadCard
              key={threadId}
              threadId={threadId}
              messages={threadMessages}
              phoneNumber={phoneNumber}
              contactName={contactName}
              contactNames={contactNames}
              onUnlink={userId && transactionId
                ? (id: string) => handleUnlinkClick(id, originalThreadIds)
                : undefined}
              auditStartDate={auditStartDate}
              auditEndDate={auditEndDate}
              selectionMode={selectionMode}
              isSelected={isThreadSelected(threadId)}
              onToggleSelect={() => toggleThreadSelection(threadId)}
            />
          );
        })}
      </div>

      {/* Empty filtered state */}
      {filteredThreads.length === 0 && totalMessageCount > 0 && (
        <div className="text-center py-8 bg-gray-50 rounded-lg">
          <svg
            className="w-12 h-12 text-gray-300 mx-auto mb-3"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
            />
          </svg>
          <p className="text-gray-600 mb-1">No messages in audit period</p>
          <p className="text-sm text-gray-500">
            {totalMessageCount} message{totalMessageCount !== 1 ? "s" : ""} exist outside the audit date range
          </p>
          <button
            onClick={() => setShowAuditPeriodOnly(false)}
            className="mt-3 text-sm text-blue-600 hover:text-blue-800"
          >
            Show all messages
          </button>
        </div>
      )}

      {/* BACKLOG-1577: Show removed/unlinked conversations */}
      {transactionId && (
        <RemovedMessagesSection
          transactionId={transactionId}
          contactNames={contactNames}
          onMessagesChanged={onMessagesChanged}
          onRestoreComplete={onRestoreComplete}
          onShowSuccess={onShowSuccess}
          onShowError={onShowError}
          onContactNamesResolved={handleContactNamesResolved}
          isOpen={removedSectionOpen}
          onOpenChange={setRemovedSectionOpen}
          refreshKey={removedSectionRefreshKey}
        />
      )}

      {/* Modals */}
      {showAttachModal && userId && transactionId && (
        <AttachMessagesModal
          userId={userId}
          transactionId={transactionId}
          propertyAddress={propertyAddress}
          onClose={() => setShowAttachModal(false)}
          onAttached={handleAttached}
        />
      )}

      {unlinkTarget && (
        <UnlinkMessageModal
          phoneNumber={unlinkTarget.phoneNumber}
          messageCount={unlinkTarget.messageCount}
          isUnlinking={isUnlinking}
          onCancel={handleUnlinkCancel}
          onUnlink={handleUnlinkConfirm}
        />
      )}

      {/* BACKLOG-1719: floating bulk bar + confirm dialog for active-list remove */}
      {selectionMode && (
        <BulkSelectionBar
          selectedCount={selectedCount}
          totalCount={filteredThreads.length}
          onSelectAll={handleSelectAll}
          onDeselectAll={deselectAllThreads}
          onClose={handleToggleSelectionMode}
          actionLabel="Remove"
          actionProcessingLabel="Removing..."
          onAction={() => setShowBulkRemoveConfirm(true)}
          isActionProcessing={isBulkRemoving}
          actionVariant="danger"
          testId="messages-bulk-bar"
          actionTestId="messages-bulk-remove"
        />
      )}
      {showBulkRemoveConfirm && (
        <BulkRemoveConfirmModal
          conversationCount={selectedCount}
          itemCount={selectedMessageIds.length}
          itemNoun="text"
          isProcessing={isBulkRemoving}
          onCancel={() => setShowBulkRemoveConfirm(false)}
          onConfirm={handleBulkRemoveConfirm}
        />
      )}
    </div>
  );
}
