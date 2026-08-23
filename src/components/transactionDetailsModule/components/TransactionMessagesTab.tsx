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
import { AuditPeriodToggle } from "./AuditPeriodToggle";
import { RemovedMessagesSection } from "./RemovedMessagesSection";
import { BulkSelectionBar, BulkRemoveConfirmModal } from "./BulkSelectionBar";
import { useSelection } from "../../../hooks/useSelection";
import type { NotificationAction, NotificationOptions } from "../../ui/Notification/types";
import { extractAllHandles } from "../../../utils/phoneNormalization";
import { mergeThreadsByContact, type MergedThreadEntry } from "../../../utils/threadMergeUtils";
import { formatDateRangeLabel, parseLocalCalendarDay, isTimestampInAuditPeriod } from "../../../utils/dateRangeUtils";
import { isReactionRow } from "../../../utils/reactionUtils";
import logger from '../../../utils/logger';

/**
 * Check if a message falls within the audit date range.
 *
 * BACKLOG-2295: the boundary logic now lives in the shared
 * `isTimestampInAuditPeriod` (dateRangeUtils) so the Texts tab (which CROPS)
 * and the ConversationViewModal (which CLASSIFIES for exclusion shading) can
 * never disagree. BACKLOG-2277 local start/end-of-day semantics are preserved
 * there.
 */
function isMessageInAuditPeriod(
  msg: MessageLike,
  startDate: Date | null,
  endDate: Date | null
): boolean {
  return isTimestampInAuditPeriod(msg.sent_at || msg.received_at, startDate, endDate);
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
  /**
   * Toast handler for success messages.
   * BACKLOG-2390: accepts an optional inline action (e.g. Undo) for move toasts.
   */
  onShowSuccess?: (message: string, options?: NotificationOptions) => void;
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
  /**
   * BACKLOG-2294: true while a BACKGROUND messages sync/import is in flight
   * (audit-date-change auto-import, create auto-import, or the 2293 re-sync
   * expansion). Drives the SAME active affordance as a user-initiated sync so
   * the button reads "working" rather than a dead disabled gray.
   */
  messagesSyncInFlight?: boolean;
  /** TASK-2074: Whether the app is online (network connectivity) */
  isOnline?: boolean;
  /** Whether there are contacts assigned (to show sync button) */
  hasContacts?: boolean;
  /** BACKLOG-1869: Deep-navigate target from search; scroll+highlight the matching card. */
  highlightTarget?: HighlightTarget | null;
  /** BACKLOG-1869: Called once the highlight has been applied (or gracefully skipped). */
  onHighlightConsumed?: () => void;
  /** BACKLOG-2791: the shared Needs review section, rendered under the Select row. */
  reviewSection?: React.ReactNode;
  /** BACKLOG-2791: whether the review section has anything — suppresses the
   *  "nothing linked" placeholder when items are waiting. */
  hasReviewItems?: boolean;
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
  messagesSyncInFlight = false,
  isOnline = true,
  hasContacts = false,
  highlightTarget,
  onHighlightConsumed,
  reviewSection = null,
  hasReviewItems = false,
}: TransactionMessagesTabProps): React.ReactElement {
  // TASK-2074: Disable sync when offline, already syncing, or when a global dashboard sync is running.
  // BACKLOG-2294: a BACKGROUND messages sync (audit-date-change / create auto-import, the
  // orchestrator's post-login sync, or the 2293 re-sync expansion) is also "active" — surface the
  // SAME spinner + "Syncing…" affordance instead of a dead disabled gray, and keep the button
  // non-clickable while it runs (a manual re-sync would only coalesce onto the in-flight one).
  const syncActive = syncingMessages || globalSyncRunning || messagesSyncInFlight;
  const syncDisabled = !isOnline || syncActive;
  const syncTooltip = !isOnline
    ? "You are offline"
    : globalSyncRunning
    ? "A sync is already in progress from the dashboard"
    : messagesSyncInFlight
    ? "Syncing messages…"
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

  // BACKLOG-357: Audit date filtering state.
  // BACKLOG-2277: interpret the audit boundaries as LOCAL calendar days so the
  // inclusion FILTER and the displayed range BOTH agree with the day the user
  // set. parseDateSafe only applied the local-time fix on Windows (TASK-1795), so
  // on macOS a bare "YYYY-MM-DD" start parsed as UTC midnight — shifting the
  // boundary back a day in negative-offset timezones and wrongly cutting/adding
  // first-/last-day messages. parseLocalCalendarDay pins each boundary to LOCAL
  // midnight on every platform (mirrors the BACKLOG-2247 email-range fix).
  const parsedStartDate = parseLocalCalendarDay(auditStartDate);
  const parsedEndDate = parseLocalCalendarDay(auditEndDate);
  // Show filter if at least one date is set (handles ongoing transactions with only start date)
  const hasAuditDates = !!(parsedStartDate || parsedEndDate);

  // BACKLOG-2291: the audit-range label + explanation copy and the "(i)" popover
  // state now live inside the shared AuditPeriodToggle so the Texts tab and the
  // ConversationViewModal render one identical control.
  const auditRangeLabel = formatDateRangeLabel(parsedStartDate, parsedEndDate);

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

  // BACKLOG-2390: Undo a just-completed attach. Removes the EXACT message ids that
  // were linked via the symmetric `unlinkMessages` IPC (the same call the remove
  // flow uses) — no new backend path. The confirmation toast it fires carries NO
  // action, so undo can never loop into another undo.
  const undoAttachMessages = useCallback(
    async (attachedMessageIds: string[]) => {
      if (!transactionId || attachedMessageIds.length === 0) return;
      try {
        const result = await window.api.transactions.unlinkMessages(
          attachedMessageIds,
          transactionId
        );
        if (result.success) {
          if (onRemoveMessagesByIds) {
            onRemoveMessagesByIds(attachedMessageIds);
          } else {
            await onMessagesChanged?.();
          }
          setRemovedSectionRefreshKey((k) => k + 1);
          onShowSuccess?.("Move undone");
        } else {
          onShowError?.(result.error || "Failed to undo");
        }
      } catch (err) {
        logger.error("Failed to undo attach:", err);
        onShowError?.(err instanceof Error ? err.message : "Failed to undo");
      }
    },
    [transactionId, onRemoveMessagesByIds, onMessagesChanged, onShowSuccess, onShowError]
  );

  // BACKLOG-2390: Undo a just-completed remove. Restores the EXACT message ids that
  // moved by looking up their suppression rows (getRemovedMessages) and calling the
  // existing restore path (restoreRemovedMessage), grouped by ignored_id so every
  // suppression record is cleared. Reuses existing IPC only. The confirmation toast
  // it fires carries NO action, so undo can never loop.
  const undoRemoveMessages = useCallback(
    async (removedMessageIds: string[]) => {
      if (!transactionId || removedMessageIds.length === 0) return;
      try {
        const res = await window.api.transactions.getRemovedMessages(transactionId);
        if (!res.success) {
          onShowError?.(res.error || "Failed to undo");
          return;
        }
        const idSet = new Set(removedMessageIds);
        // Group the moved message ids by the suppression row that now covers them.
        // message_id here is messages.id — the SAME id-space the renderer's m.id
        // and unlinkMessages operate on, so this filter matches correctly.
        const byIgnored = new Map<string, string[]>();
        for (const row of res.removedMessages ?? []) {
          if (!idSet.has(row.message_id)) continue;
          const arr = byIgnored.get(row.ignored_id);
          if (arr) arr.push(row.message_id);
          else byIgnored.set(row.ignored_id, [row.message_id]);
        }
        // BACKLOG-2390 (fix): fail LOUD — no suppression row matched means nothing
        // can be restored, so don't claim a false "Move undone".
        if (byIgnored.size === 0) {
          onShowError?.("Couldn't undo — messages are still removed");
          return;
        }
        let failed = false;
        for (const [ignoredId, ids] of byIgnored) {
          try {
            const r = await window.api.transactions.restoreRemovedMessage(ignoredId, ids, transactionId);
            if (!r?.success) failed = true;
          } catch {
            failed = true;
          }
        }
        if (onRestoreComplete) {
          await onRestoreComplete();
        } else {
          await onMessagesChanged?.();
        }
        setRemovedSectionRefreshKey((k) => k + 1);
        // BACKLOG-2390 (fix): report the real result — a failed restore is an error,
        // not a "Move undone".
        if (failed) {
          onShowError?.("Couldn't undo — messages are still removed");
        } else {
          onShowSuccess?.("Move undone");
        }
      } catch (err) {
        logger.error("Failed to undo remove:", err);
        onShowError?.(err instanceof Error ? err.message : "Failed to undo");
      }
    },
    [transactionId, onRestoreComplete, onMessagesChanged, onShowSuccess, onShowError]
  );

  // Handle messages attached successfully
  const handleAttached = useCallback(
    (attachedMessageIds: string[]) => {
      onMessagesChanged?.();
      const undoAction: NotificationAction | undefined =
        transactionId && attachedMessageIds.length > 0
          ? { label: "Undo", onClick: () => void undoAttachMessages(attachedMessageIds) }
          : undefined;
      onShowSuccess?.("Messages attached successfully", { action: undoAction });
    },
    [onMessagesChanged, onShowSuccess, transactionId, undoAttachMessages]
  );

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
          // BACKLOG-2280: display real-message count (reactions are removed with
          // the thread but are not counted as messages in the confirmation copy).
          messageCount: allMessages.reduce((n, m) => (isReactionRow(m) ? n : n + 1), 0),
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
        // BACKLOG-2390: offer Undo that restores the EXACT ids that moved.
        const movedIds = [...messageIds];
        onShowSuccess?.("Messages removed from transaction", {
          action: {
            label: "Undo",
            onClick: () => void undoRemoveMessages(movedIds),
          },
        });
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
  }, [unlinkTarget, messages, transactionId, onRemoveMessagesByIds, onMessagesChanged, onShowSuccess, onShowError, undoRemoveMessages]);

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
  // BACKLOG-2280: reactions ride along in the thread arrays (so the conversation
  // modal can render tapback pills), but they are NOT standalone messages — they
  // must be excluded from the "X text messages"/conversation counts and must not
  // make a reaction-only thread appear as its own conversation. We therefore count
  // only non-reaction rows and keep only threads with ≥1 real message, while still
  // passing the full (reaction-carrying) arrays down to the cards.
  const { filteredThreads, filteredMessageCount, totalMessageCount, filteredConversationCount, totalConversationCount } = useMemo(() => {
    const realCount = (msgs: MessageLike[]): number =>
      msgs.reduce((n, m) => (isReactionRow(m) ? n : n + 1), 0);
    const totalRealMessages = messages.reduce((n, m) => (isReactionRow(m) ? n : n + 1), 0);

    if (!showAuditPeriodOnly || !hasAuditDates) {
      const visible = mergedThreads.filter(([, msgs]) => realCount(msgs) > 0);
      return {
        filteredThreads: visible,
        filteredMessageCount: totalRealMessages,
        totalMessageCount: totalRealMessages,
        filteredConversationCount: visible.length,
        totalConversationCount: visible.length,
      };
    }

    // Filter threads: keep only threads that have at least one REAL message in the
    // audit period. Reactions stay in the passed-down array but never keep a thread
    // alive on their own, and never count toward msgCount.
    const filtered: MergedThreadEntry[] = [];
    let msgCount = 0;
    let visibleTotal = 0;

    for (const [threadId, threadMessages, originalIds] of mergedThreads) {
      if (realCount(threadMessages) > 0) visibleTotal++;

      const messagesInPeriod = threadMessages.filter((msg) =>
        isMessageInAuditPeriod(msg, parsedStartDate, parsedEndDate)
      );

      const realInPeriod = realCount(messagesInPeriod);
      if (realInPeriod > 0) {
        filtered.push([threadId, messagesInPeriod, originalIds]);
        msgCount += realInPeriod;
      }
    }

    return {
      filteredThreads: filtered,
      filteredMessageCount: msgCount,
      totalMessageCount: totalRealMessages,
      filteredConversationCount: filtered.length,
      totalConversationCount: visibleTotal,
    };
  }, [mergedThreads, messages, showAuditPeriodOnly, hasAuditDates, parsedStartDate, parsedEndDate]);

  // BACKLOG-1719: selectable conversations = the currently visible (filtered)
  // display threads, keyed by their display threadId.
  const selectableThreads = useMemo(
    () => filteredThreads.map(([threadId]) => ({ id: threadId })),
    [filteredThreads]
  );

  // BACKLOG-2295: the FULL, uncropped messages for each display thread, keyed by
  // its display threadId. mergedThreads is built from the whole message set
  // BEFORE the audit-period crop, so this is what the ConversationViewModal must
  // receive to make its own toggle independent of the Texts-tab toggle. (The
  // tab list still renders the cropped `filteredThreads` arrays.)
  const fullMessagesByThreadId = useMemo(() => {
    const map = new Map<string, MessageLike[]>();
    for (const [threadId, threadMessages] of mergedThreads) {
      map.set(threadId, threadMessages);
    }
    return map;
  }, [mergedThreads]);

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
  const filteredThreadsRef = useRef(filteredThreads);
  filteredThreadsRef.current = filteredThreads;
  const mergedThreadsRef = useRef(mergedThreads);
  mergedThreadsRef.current = mergedThreads;
  const onHighlightConsumedMsgRef = useRef(onHighlightConsumed);
  onHighlightConsumedMsgRef.current = onHighlightConsumed;

  // BACKLOG-1869 — React-state highlight (remount-proof). See EmailsTab for full
  // design rationale. Short version: the list remounts on loading flips (skeleton
  // swap), so classList mutations on a stale element are invisible. React state
  // lets the card re-assert ring classes on every render/remount automatically.
  const [highlightedThreadId, setHighlightedThreadId] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeTextIdRef = useRef<string | null>(null);
  // Tracks when we first received a target while the thread list was still empty,
  // so we can enforce a 10 s leak-guard deadline and avoid an infinite wait.
  const firstTargetTimestampMsgRef = useRef<number | null>(null);

  // Unmount cleanup: cancel the 2s timer so it doesn't fire after the tab is gone.
  // IMPORTANT: also reset activeTextIdRef — same StrictMode fix as EmailsTab.
  // Without the reset, StrictMode's fake-unmount kills the timer and the guard
  // blocks re-arming on re-mount → ring shows but never clears in dev.
  useEffect(() => {
    return () => {
      if (highlightTimerRef.current !== null) clearTimeout(highlightTimerRef.current);
      activeTextIdRef.current = null; // let StrictMode re-mount re-arm the timer
    };
  }, []); // empty deps — fires on unmount + StrictMode fake-unmount

  useEffect(() => {
    const targetId = highlightTarget?.type === "text" ? (highlightTarget.communicationId ?? null) : null;

    if (!targetId) { activeTextIdRef.current = null; return; }
    if (loading) return;

    // Same id already being animated — card still shows ring via React state; no-op.
    if (activeTextIdRef.current === targetId) return;

    // New or different target: cancel any existing timer before starting fresh.
    if (highlightTimerRef.current !== null) {
      clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = null;
    }

    // Search visible (filtered) threads first; fall back to all merged threads so a
    // card hidden by the audit-period filter still scrolls into view if rendered.
    const entry =
      filteredThreadsRef.current.find(([, msgs]) => msgs.some((m) => m.id === targetId)) ??
      mergedThreadsRef.current.find(([, msgs]) => msgs.some((m) => m.id === targetId));
    if (!entry) {
      // No threads yet: data may still be staging on first open — wait for the length dep
      // to re-trigger the effect rather than consuming the target prematurely.
      if (mergedThreadsRef.current.length === 0) {
        if (firstTargetTimestampMsgRef.current === null) firstTargetTimestampMsgRef.current = Date.now();
        if (Date.now() - firstTargetTimestampMsgRef.current < 10_000) return;
        // 10 s deadline exceeded — consume as a leak-guard.
      }
      firstTargetTimestampMsgRef.current = null;
      activeTextIdRef.current = null;
      onHighlightConsumedMsgRef.current?.();
      return;
    }
    firstTargetTimestampMsgRef.current = null;
    const [displayThreadId] = entry;

    activeTextIdRef.current = targetId;

    // Highlight the card via React state — remount-proof.
    setHighlightedThreadId(displayThreadId);

    // Start 2s removal timer.
    highlightTimerRef.current = setTimeout(() => {
      setHighlightedThreadId(null);
      highlightTimerRef.current = null;
      onHighlightConsumedMsgRef.current?.();
    }, 2000);

    // Scroll to the card (imperative, with retry for fresh-mount DOM race).
    // 90×32ms (~2.9s) — same wider window as EmailsTab; covers first-open path.
    let loopCancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    const MAX_RETRIES = 90;
    const RETRY_INTERVAL_MS = 32;

    function attempt(): void {
      if (loopCancelled) return;
      const el = document.querySelector<HTMLElement>(`[data-thread-id="${displayThreadId}"]`);
      if (el) { el.scrollIntoView({ block: "center", behavior: "smooth" }); return; }
      attempts++;
      if (attempts >= MAX_RETRIES) return;
      retryTimer = setTimeout(attempt, RETRY_INTERVAL_MS);
    }
    attempt();

    return () => {
      // Cancel the scroll retry loop only — the 2s highlight timer is in
      // highlightTimerRef and must outlive individual effect runs (loading flips).
      loopCancelled = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  // messages.length: primitive dep so data arrival (0→N on first open) re-fires the
  // effect without reacting to re-sorts. onHighlightConsumed via ref (stable).
  }, [highlightTarget?.communicationId ?? null, loading, messages.length]);

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
        // BACKLOG-2390: offer Undo that restores the EXACT ids that moved.
        const movedIds = [...selectedMessageIds];
        onShowSuccess?.(
          convCount > 1 ? `${convCount} conversations removed` : "Messages removed from transaction",
          { action: { label: "Undo", onClick: () => void undoRemoveMessages(movedIds) } }
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
  }, [transactionId, selectedMessageIds, selectedThreadIds, onRemoveMessagesByIds, onMessagesChanged, onShowSuccess, onShowError, deselectAllThreads, undoRemoveMessages]);

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

  // Empty state.
  //
  // BACKLOG-2791 (founder, 2026-08-22): "no text messages linked" must mean
  // genuinely nothing — no linked messages AND nothing waiting in Needs review.
  if (messages.length === 0 && !hasReviewItems) {
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
                  className={`w-4 h-4 ${syncActive ? "animate-spin" : ""}`}
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
                {syncActive ? "Syncing..." : <>Sync<span className="hidden sm:inline"> Messages</span></>}
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
              {syncActive ? (
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

        {/* BACKLOG-2278/BACKLOG-2291: audit-period filter — shared
            AuditPeriodToggle (pill "(i)" info button + plain-language label +
            switch). Also rendered by ConversationViewModal so both surfaces
            stay visually identical. flex-1 makes it fill the row beside Select. */}
        {hasAuditDates && (
          <AuditPeriodToggle
            checked={showAuditPeriodOnly}
            onChange={setShowAuditPeriodOnly}
            auditRangeLabel={auditRangeLabel}
            className="flex-1"
          />
        )}
      </div>

      {/* BACKLOG-2791: Needs review, under the Select row — the same position
          the Emails tab uses. develop has no needs-review section on this tab
          at all (texts never had the state), so this is new, matched to the
          Emails tab rather than invented separately.

          contactNames is injected HERE rather than passed down from
          TransactionDetails, because this tab is where it is resolved (the
          resolveHandles effect above). Without it MessageThreadCard falls back
          to `contactName || phoneNumber` and every sender renders as a raw
          number — the names regression the founder reported. */}
      {React.isValidElement(reviewSection)
        ? React.cloneElement(
            reviewSection as React.ReactElement<{ contactNames?: Record<string, string> }>,
            { contactNames },
          )
        : reviewSection}

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
              /* BACKLOG-2295: hand the modal the uncropped thread so its audit
                 toggle is independent of this tab's toggle. */
              fullMessages={fullMessagesByThreadId.get(threadId) ?? threadMessages}
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
              isHighlighted={threadId === highlightedThreadId}
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
