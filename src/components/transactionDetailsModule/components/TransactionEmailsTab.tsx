/**
 * TransactionEmailsTab Component
 * TASK-1183: Emails tab content showing email threads linked to a transaction.
 * Now displays emails grouped into conversation threads for a natural viewing experience.
 * Moved from TransactionDetailsTab as part of TASK-1152.
 */
import React, { useState, useCallback, useMemo, useEffect, useRef } from "react";
import type { Communication } from "../types";
import type { HighlightTarget } from "../types";
import { useAuth } from "../../../contexts";
import { AttachEmailsModal } from "./modals";
import {
  EmailThreadCard,
  processEmailThreads,
  threadMatchReason,
  type EmailThread,
} from "./EmailThreadCard";
import { NeedsReviewSection } from "./NeedsReviewSection";
import { RemovedEmailsSection } from "./RemovedEmailsSection";
import { BulkSelectionBar, BulkRemoveConfirmModal } from "./BulkSelectionBar";
import { useContactNameMap } from "../../../hooks/useContactNameMap";
import { useSelection } from "../../../hooks/useSelection";
import type { ToastAction } from "../../../hooks/useToast";
import { restoreRemovedEmailsByContentIds, type EmailUndoOutcome } from "../utils/undoMoveRestore";

interface TransactionEmailsTabProps {
  communications: Communication[];
  loading: boolean;
  unlinkingCommId: string | null;
  onViewEmail: (comm: Communication) => void;
  onShowUnlinkConfirm: (comm: Communication) => void;
  /**
   * BACKLOG-1781: called instead of onShowUnlinkConfirm when the parent needs
   * the full thread so it can unlink ALL constituent backend threads in one action.
   */
  onShowUnlinkThread?: (thread: EmailThread) => void;
  /**
   * BACKLOG-1780: incremented by the parent after each successful unlink to
   * trigger a silent re-fetch of the removed-emails list and update the count.
   */
  removedSectionRefreshKey?: number;
  /** Callback to sync/re-link emails from contacts */
  onSyncCommunications?: () => Promise<void>;
  /** Whether sync is in progress */
  syncingCommunications?: boolean;
  /** Whether a global sync (from dashboard) is in progress */
  globalSyncRunning?: boolean;
  /** TASK-2074: Whether the app is online (network connectivity) */
  isOnline?: boolean;
  /** Whether there are contacts assigned (to show appropriate help text) */
  hasContacts?: boolean;
  /** User ID for API calls */
  userId?: string;
  /** Transaction ID for API calls */
  transactionId?: string;
  /** Property address for display */
  propertyAddress?: string;
  /** Callback when emails are modified (attached/unlinked) */
  onEmailsChanged?: () => void;
  /**
   * BACKLOG-1719: in-place optimistic removal for the bulk-remove flow. Mirrors
   * the Messages tab's onRemoveMessagesByIds — removes the unlinked rows from
   * parent state without a refetch. Returns the number of rows actually removed.
   */
  onRemoveEmailsByIds?: (ids: string[]) => number;
  /**
   * BACKLOG-1780: called on successful restore instead of onEmailsChanged.
   * Uses refreshCommunicationsSilently — no loading flag, no spinner, no scroll jump.
   */
  onRestoreComplete?: () => Promise<void>;
  /**
   * Toast handler for success messages.
   * BACKLOG-2390: accepts an optional inline action (e.g. Undo) for move toasts.
   */
  onShowSuccess?: (message: string, action?: ToastAction) => void;
  /** Toast handler for error messages */
  onShowError?: (message: string) => void;
  /** Audit period start date (ISO string) for email date filtering */
  auditStartDate?: string;
  /** Audit period end date (ISO string) for email date filtering */
  auditEndDate?: string;
  /**
   * BACKLOG-2319: called after a successful Confirm on a Needs-review thread.
   * Wired to refreshCommunicationsSilently in TransactionDetails so the card
   * moves to Linked with no spinner/scroll jump. Falls back to onEmailsChanged.
   */
  onConfirmComplete?: () => Promise<void>;
  /** BACKLOG-1869: Deep-navigate target from search; scroll+highlight the matching card. */
  highlightTarget?: HighlightTarget | null;
  /** BACKLOG-1869: Called once the highlight has been applied (or gracefully skipped). */
  onHighlightConsumed?: () => void;
}

export function TransactionEmailsTab({
  communications,
  loading,
  unlinkingCommId,
  onViewEmail,
  onShowUnlinkConfirm,
  onShowUnlinkThread,
  removedSectionRefreshKey,
  onSyncCommunications,
  syncingCommunications = false,
  globalSyncRunning = false,
  isOnline = true,
  hasContacts = false,
  userId,
  transactionId,
  propertyAddress,
  onEmailsChanged,
  onRemoveEmailsByIds,
  onRestoreComplete,
  onShowSuccess,
  onShowError,
  auditStartDate,
  auditEndDate,
  onConfirmComplete,
  highlightTarget,
  onHighlightConsumed,
}: TransactionEmailsTabProps): React.ReactElement {
  const { currentUser } = useAuth();
  const [showAttachModal, setShowAttachModal] = useState(false);
  // BACKLOG-2319: thread id whose Confirm action is in flight.
  const [confirmingThreadId, setConfirmingThreadId] = useState<string | null>(null);
  // BACKLOG-1780: lift isOpen state so it survives the loading-spinner re-mount
  const [removedSectionOpen, setRemovedSectionOpen] = useState(false);

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
  // Bumped after an in-tab bulk remove so RemovedEmailsSection refetches its count.
  const [localRemovedBump, setLocalRemovedBump] = useState(0);
  const combinedRemovedRefreshKey = (removedSectionRefreshKey ?? 0) + localRemovedBump;

  // BACKLOG-1762: address -> contact display_name map, resolves participant
  // names from Contacts when the email header carries no name.
  const nameMap = useContactNameMap(userId ?? currentUser?.id);

  // TASK-2074: Disable sync when offline, already syncing, or when a global dashboard sync is running
  const syncDisabled = !isOnline || syncingCommunications || globalSyncRunning;
  const syncTooltip = !isOnline
    ? "You are offline"
    : globalSyncRunning
    ? "A sync is already in progress from the dashboard"
    : undefined;

  // Process communications into email threads
  const emailThreads = useMemo(() => {
    return processEmailThreads(communications);
  }, [communications]);

  // Track which thread is being unlinked (by thread ID -> set of email IDs being unlinked)
  const unlinkingThreadId = useMemo(() => {
    if (!unlinkingCommId) return null;
    // Find which thread contains the email being unlinked
    for (const thread of emailThreads) {
      if (thread.emails.some((e) => e.id === unlinkingCommId)) {
        return thread.id;
      }
    }
    return null;
  }, [unlinkingCommId, emailThreads]);

  // BACKLOG-1869: When a highlight target arrives, find the matching thread card,
  // scroll it into view, and briefly flash a ring to draw the user's eye.
  //
  // Design notes (SR-reviewed):
  // • emailThreads and onHighlightConsumed are kept in refs so the effect deps are
  //   only [highlightTarget, loading]. This is critical: if emailThreads were a dep,
  //   any re-sort would trigger cleanup → clearTimeout, making the ring permanent.
  // • onHighlightConsumed is called INSIDE the 2s timer (after ring removal), never
  //   before. Calling it early would set highlightTarget→null, fire cleanup, and
  //   clearTimeout would kill the timer before the ring is removed.
  const emailThreadsRef = useRef(emailThreads);
  emailThreadsRef.current = emailThreads;
  const onHighlightConsumedRef = useRef(onHighlightConsumed);
  onHighlightConsumedRef.current = onHighlightConsumed;

  // BACKLOG-1869 — React-state highlight (remount-proof).
  //
  // Root cause of the cross-tab failure (confirmed via debug trace):
  //   handleNavigateToTab fires when loading=true. The subsequent loading flip
  //   caused the list to remount (skeleton swap), destroying any DOM element we
  //   had mutated with classList.add. Even DOM-mutation + ref tricks can't survive
  //   an element being replaced — the element we ringed no longer exists.
  //
  // Solution: store the highlighted thread id in React state. When the list
  //   remounts, each card receives isHighlighted={thread.id === highlightedThreadId}
  //   and re-asserts the ring classes in its own className. The ring is now
  //   remount-proof by construction.
  //
  // Design:
  //   • highlightedThreadId (useState) — which card renders with ring classes
  //   • highlightTimerRef — the 2s removal timer, kept in a ref so per-run effect
  //     cleanup doesn't cancel it during a loading flip
  //   • activeEmailIdRef — guard: same email id → animation already live, no-op
  //   • Scroll is still imperative (querySelector + retry for fresh-mount DOM race),
  //     matching the house pattern in Settings.tsx
  //   • onHighlightConsumed fires INSIDE the 2s timer, never before
  const [highlightedThreadId, setHighlightedThreadId] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeEmailIdRef = useRef<string | null>(null);
  // Tracks when we first received a target while the thread list was still empty,
  // so we can enforce a 10 s leak-guard deadline and avoid an infinite wait.
  const firstTargetTimestampRef = useRef<number | null>(null);

  // Unmount cleanup: cancel the 2s timer so it doesn't fire after the tab is gone.
  // IMPORTANT: also reset activeEmailIdRef so React StrictMode's double-mount can
  // restart the timer. StrictMode runs cleanup → re-run on every mount in dev:
  //   1. mount  → effect runs  → ring set, T1 started, activeEmailIdRef = "e-1"
  //   2. cleanup → [] fires   → T1 cleared  ← timer killed
  //   3. re-run  → guard hits  → returns early ← no new timer (ring never clears!)
  // Fix: reset guard in [] cleanup so step 3 misses the guard and re-arms T2.
  useEffect(() => {
    return () => {
      if (highlightTimerRef.current !== null) clearTimeout(highlightTimerRef.current);
      activeEmailIdRef.current = null; // let StrictMode re-mount re-arm the timer
    };
  }, []); // empty deps — fires on unmount + StrictMode fake-unmount

  useEffect(() => {
    const targetId = highlightTarget?.type === "email" ? (highlightTarget.emailId ?? null) : null;

    if (!targetId) {
      activeEmailIdRef.current = null;
      return;
    }
    if (loading) return;

    // Same id already being animated — the card still shows the ring via React state; no-op.
    if (activeEmailIdRef.current === targetId) return;

    // New or different target: cancel any existing timer before starting fresh.
    if (highlightTimerRef.current !== null) {
      clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = null;
    }

    const thread = emailThreadsRef.current.find((t) => t.emails.some((e) => e.id === targetId));
    if (!thread) {
      // List is empty: data may still be staging on first open — wait for the length dep
      // to re-trigger the effect rather than consuming the target prematurely.
      if (emailThreadsRef.current.length === 0) {
        if (firstTargetTimestampRef.current === null) firstTargetTimestampRef.current = Date.now();
        if (Date.now() - firstTargetTimestampRef.current < 10_000) return;
        // 10 s deadline exceeded — consume as a leak-guard.
      }
      firstTargetTimestampRef.current = null;
      activeEmailIdRef.current = null;
      onHighlightConsumedRef.current?.();
      return;
    }
    firstTargetTimestampRef.current = null;
    const threadId = thread.id;

    activeEmailIdRef.current = targetId;

    // Highlight the card via React state — remount-proof.
    setHighlightedThreadId(threadId);

    // Start 2s removal timer.
    highlightTimerRef.current = setTimeout(() => {
      setHighlightedThreadId(null);
      highlightTimerRef.current = null;
      onHighlightConsumedRef.current?.();
    }, 2000);

    // Scroll to the card (imperative, with retry for fresh-mount DOM race).
    // First open of a transaction loads more DOM nodes than subsequent opens —
    // 30×16ms (~480ms) was too short. 90×32ms (~2.9s) covers the first-open path
    // while remaining a no-op whenever the element appears in the first few frames.
    let loopCancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    const MAX_RETRIES = 90;
    const RETRY_INTERVAL_MS = 32;

    function attempt(): void {
      if (loopCancelled) return;
      const el = document.querySelector<HTMLElement>(`[data-thread-id="${threadId}"]`);
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
  // emailThreads.length: primitive dep so data arrival (0→N on first open) re-fires the
  // effect without reacting to re-sorts. onHighlightConsumed via ref (stable).
  }, [highlightTarget?.emailId ?? null, loading, emailThreads.length]);

  // Handle attach button click
  const handleAttachClick = useCallback(() => {
    setShowAttachModal(true);
  }, []);

  // Handle emails attached successfully
  // BACKLOG-2390: left as a plain toast (no Undo). `linkEmails` takes pre-link
  // email ids, but the only email unlink IPC (`unlinkCommunication`) operates on a
  // communications-row id and expands to the whole thread — there is no safe
  // exact-id inverse for an email attach, so faking one would risk over-removing
  // sibling emails. Messages attach (symmetric `unlinkMessages`) does get Undo.
  const handleAttached = useCallback(() => {
    onEmailsChanged?.();
    onShowSuccess?.("Emails attached successfully");
  }, [onEmailsChanged, onShowSuccess]);

  // Handle thread unlink.
  // BACKLOG-1781: when onShowUnlinkThread is provided, pass the full thread so the
  // parent can unlink every constituent backend thread in one user action.
  // Falls back to sending the first email (single-unlink legacy path).
  const handleUnlinkThread = useCallback(
    (thread: EmailThread) => {
      if (onShowUnlinkThread) {
        onShowUnlinkThread(thread);
      } else if (thread.emails.length > 0) {
        onShowUnlinkConfirm(thread.emails[0]);
      }
    },
    [onShowUnlinkConfirm, onShowUnlinkThread]
  );

  // BACKLOG-2319: split attached conversations into Needs-review (ambiguous
  // contact-only, all emails address_missing) vs Linked (everything else).
  const needsReviewThreads = useMemo(
    () => emailThreads.filter((t) => threadMatchReason(t) === "needs_review"),
    [emailThreads]
  );
  const linkedThreads = useMemo(
    () => emailThreads.filter((t) => threadMatchReason(t) !== "needs_review"),
    [emailThreads]
  );

  // BACKLOG-2319: Confirm a Needs-review thread → promotes it to Linked. Passes
  // every email id in the conversation so the whole thread flips at once.
  const handleConfirmThread = useCallback(
    async (thread: EmailThread) => {
      if (!transactionId || confirmingThreadId) return;
      const emailIds = thread.emails.map((e) => e.id).filter((id): id is string => !!id);
      if (emailIds.length === 0) return;
      setConfirmingThreadId(thread.id);
      try {
        const res = await window.api.transactions.confirmEmailLinks(emailIds, transactionId);
        if (res?.success) {
          // BACKLOG-2390: left as a plain toast (no Undo). Confirm sets
          // match_reason='user_confirmed'; there is no `unconfirm` IPC to cleanly
          // revert a thread back to Needs-review, so no exact inverse exists.
          onShowSuccess?.(thread.emailCount > 1 ? "Conversation confirmed" : "Email confirmed");
          if (onConfirmComplete) {
            await onConfirmComplete();
          } else {
            onEmailsChanged?.();
          }
        } else {
          onShowError?.(res?.error || "Failed to confirm email");
        }
      } catch {
        onShowError?.("Failed to confirm email");
      } finally {
        setConfirmingThreadId(null);
      }
    },
    [transactionId, confirmingThreadId, onShowSuccess, onShowError, onConfirmComplete, onEmailsChanged]
  );

  // BACKLOG-1719: selection-mode entry/exit (matches the transaction window).
  const handleToggleSelectionMode = useCallback(() => {
    setSelectionMode((prev) => {
      if (prev) deselectAllThreads();
      return !prev;
    });
  }, [deselectAllThreads]);

  // BACKLOG-2319: bulk selection acts on the LINKED list only. Needs-review
  // conversations have their own per-card Confirm / Remove actions.
  const handleSelectAll = useCallback(() => {
    selectAllThreads(linkedThreads);
  }, [selectAllThreads, linkedThreads]);

  // Threads currently selected (for confirm counts + the bulk unlink loop).
  const selectedThreads = useMemo(
    () => linkedThreads.filter((t) => selectedThreadIds.has(t.id)),
    [linkedThreads, selectedThreadIds]
  );
  const selectedEmailCount = useMemo(
    () => selectedThreads.reduce((sum, t) => sum + t.emailCount, 0),
    [selectedThreads]
  );

  // BACKLOG-2390 (fix): Undo a just-completed bulk remove. Restores the EXACT
  // emails that moved by mapping their CONTENT ids (emails.id) to their
  // suppression rows and calling the existing restore path (restoreRemovedEmail).
  //
  // The caller passes CONTENT ids (email.id = emails.id), NOT the communications
  // ids that unlinkCommunication returns — those never match getRemovedEmails()'s
  // email_id column (which is emails.id), which is why the old undo restored
  // nothing while still claiming "Move undone".
  //
  // Fails LOUD: if no suppression row matches, or any restore fails, an error
  // toast is shown instead of a false "Move undone". The confirmation toast it
  // fires carries NO action, so an undo can never loop into another undo.
  const undoBulkRemoveEmails = useCallback(
    async (removedEmailContentIds: string[]) => {
      if (!transactionId || removedEmailContentIds.length === 0) return;
      let outcome: EmailUndoOutcome;
      try {
        outcome = await restoreRemovedEmailsByContentIds(
          window.api.transactions,
          transactionId,
          removedEmailContentIds
        );
      } catch {
        onShowError?.("Failed to undo");
        return;
      }
      // Refresh only when a restore was actually attempted (keeps the removed
      // count + list in sync); skip the pointless refresh on fetch/no-match.
      if (outcome.status === "success" || outcome.status === "restore_failed") {
        if (onRestoreComplete) {
          await onRestoreComplete();
        } else {
          onEmailsChanged?.();
        }
        setLocalRemovedBump((b) => b + 1);
      }
      if (outcome.status === "success") {
        onShowSuccess?.("Move undone");
      } else if (outcome.status === "fetch_failed") {
        onShowError?.(outcome.error || "Failed to undo");
      } else {
        onShowError?.("Couldn't undo — emails are still removed");
      }
    },
    [transactionId, onRestoreComplete, onEmailsChanged, onShowSuccess, onShowError]
  );

  // BACKLOG-1719: bulk remove. Generalises the BACKLOG-1781 loop across ALL
  // selected threads: collect ONE representative communicationId per distinct
  // backend thread_id (dedup across selections), then call the FROZEN
  // unlinkCommunication once per representative, aggregate every returned
  // unlinkedId, and apply a SINGLE in-place removal + ONE toast (no refetch).
  const handleBulkRemoveConfirm = useCallback(async () => {
    if (selectedThreads.length === 0) return;
    setIsBulkRemoving(true);
    try {
      const seen = new Set<string>();
      const repCommIds: string[] = [];
      for (const thread of selectedThreads) {
        for (const email of thread.emails) {
          const key = email.thread_id ?? email.id;
          if (seen.has(key)) continue;
          seen.add(key);
          const cid = (email as unknown as { communication_id?: string }).communication_id ?? email.id;
          repCommIds.push(cid);
        }
      }

      const allUnlinkedIds: string[] = [];
      for (const cid of repCommIds) {
        try {
          const r = await window.api.transactions.unlinkCommunication(cid);
          if (r.success && r.unlinkedIds) allUnlinkedIds.push(...r.unlinkedIds);
        } catch {
          // Non-blocking: one constituent failing shouldn't abort the batch.
        }
      }

      // Single in-place removal; fall back to a refetch only if nothing matched.
      const removed = onRemoveEmailsByIds ? onRemoveEmailsByIds(allUnlinkedIds) : 0;
      if (!onRemoveEmailsByIds || removed === 0) {
        onEmailsChanged?.();
      }

      const n = allUnlinkedIds.length || selectedEmailCount;
      // BACKLOG-2390 (fix): attach an Undo that restores the EXACT emails that
      // moved. The undo payload is the emails' CONTENT ids (email.id = emails.id),
      // which live in the same id-space as getRemovedEmails().email_id — NOT the
      // communications ids in allUnlinkedIds (those never matched, so the old undo
      // restored nothing). Restore is thread-aware, so one matched email per
      // thread pulls its whole conversation back.
      const removedEmailContentIds = selectedThreads.flatMap((t) =>
        t.emails.map((e) => e.id).filter((id): id is string => !!id)
      );
      const undoAction: ToastAction | undefined =
        removedEmailContentIds.length > 0
          ? { label: "Undo", onClick: () => void undoBulkRemoveEmails(removedEmailContentIds) }
          : undefined;
      onShowSuccess?.(
        n > 1 ? `${n} emails removed` : "Email removed from transaction",
        undoAction
      );
      // Refresh the removed-emails count in place.
      setLocalRemovedBump((b) => b + 1);
    } finally {
      setIsBulkRemoving(false);
      setShowBulkRemoveConfirm(false);
      deselectAllThreads();
      setSelectionMode(false);
    }
  }, [selectedThreads, selectedEmailCount, onRemoveEmailsByIds, onEmailsChanged, onShowSuccess, deselectAllThreads, undoBulkRemoveEmails]);

  // Loading state
  if (loading) {
    return (
      <div className="text-center py-12">
        <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto"></div>
        <p className="text-gray-500 mt-4">Loading emails...</p>
      </div>
    );
  }

  // Empty state
  if (emailThreads.length === 0) {
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
              d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
            />
          </svg>
          <p className="text-gray-600 mb-1">No emails linked</p>
          <p className="text-sm text-gray-500 mb-4">
            {hasContacts
              ? "Sync emails from assigned contacts or attach manually"
              : "Click \"Attach Emails\" to get started"}
          </p>
          <div className="flex items-center justify-center gap-3">
            {onSyncCommunications && hasContacts && (
              <button
                onClick={onSyncCommunications}
                disabled={syncDisabled}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-green-600 bg-green-50 hover:bg-green-100 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="sync-emails-button"
                title={syncTooltip}
              >
                <svg
                  className={`w-4 h-4 ${syncingCommunications ? "animate-spin" : ""}`}
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
                {syncingCommunications ? "Syncing..." : "Sync Emails"}
              </button>
            )}
            {userId && transactionId && (
              <button
                onClick={handleAttachClick}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors"
                data-testid="attach-emails-button"
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
                Attach<span className="hidden sm:inline"> Emails</span>
              </button>
            )}
          </div>

        </div>

        {/* BACKLOG-1578: Show removed emails even when no active emails */}
        {transactionId && (
          <RemovedEmailsSection
            transactionId={transactionId}
            onRestoreComplete={onRestoreComplete}
            onShowSuccess={onShowSuccess}
            onShowError={onShowError}
            userEmail={currentUser?.email}
            isOpen={removedSectionOpen}
            onOpenChange={setRemovedSectionOpen}
            refreshKey={combinedRemovedRefreshKey}
          />
        )}

        {/* Attach Emails Modal */}
        {showAttachModal && userId && transactionId && (
          <AttachEmailsModal
            userId={userId}
            transactionId={transactionId}
            propertyAddress={propertyAddress}
            auditStartDate={auditStartDate}
            auditEndDate={auditEndDate}
            onClose={() => setShowAttachModal(false)}
            onAttached={handleAttached}
          />
        )}
      </div>
    );
  }

  // Calculate total email count
  const totalEmailCount = emailThreads.reduce(
    (sum, thread) => sum + thread.emailCount,
    0
  );

  return (
    <div>
      {/* Action buttons and summary */}
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-medium text-gray-900">
          {emailThreads.length} conversation{emailThreads.length !== 1 ? "s" : ""}<span className="hidden sm:inline"> ({totalEmailCount} email{totalEmailCount !== 1 ? "s" : ""})</span>
        </h3>

        <div className="flex gap-2">
          {/* Attach Emails button */}
          {userId && transactionId && (
            <button
              onClick={handleAttachClick}
              className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded-lg transition-colors"
              data-testid="attach-emails-button"
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
              Attach<span className="hidden sm:inline"> Emails</span>
            </button>
          )}
          {/* Sync button */}
          {onSyncCommunications && hasContacts && (
            <button
              onClick={onSyncCommunications}
              disabled={syncDisabled}
              className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-green-600 hover:text-green-800 hover:bg-green-50 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title={syncTooltip}
            >
              {syncingCommunications ? (
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
                  Sync<span className="hidden sm:inline"> Emails</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* BACKLOG-1719 (founder design): Select entry. Icon matches the
          transaction-window Edit/bulk-edit button (clipboard-check, w-5,
          strokeWidth 2). Kept identical to the Texts tab.
          BACKLOG-2319: the "Filter by property address" toggle that used to sit
          on this row is retired — unmatched emails now surface in Needs review. */}
      <div className="flex items-center gap-2 mb-4">
        <button
          onClick={handleToggleSelectionMode}
          className={`flex items-center gap-1.5 px-3 h-10 text-sm font-medium rounded-lg transition-colors flex-shrink-0 ${
            selectionMode
              ? "bg-blue-500 text-white hover:bg-blue-600"
              : "bg-gray-200 text-gray-700 hover:bg-gray-300"
          }`}
          data-testid="select-emails-button"
        >
          <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
          </svg>
          {selectionMode ? "Cancel" : "Select"}
        </button>
      </div>

      {/* BACKLOG-2319: Needs review — ambiguous contact-only conversations, at
          the TOP above the linked list. Renders nothing when there are none. */}
      <NeedsReviewSection
        threads={needsReviewThreads}
        onViewEmail={onViewEmail}
        onConfirm={handleConfirmThread}
        onRemove={handleUnlinkThread}
        confirmingThreadId={confirmingThreadId}
        unlinkingThreadId={unlinkingThreadId}
        userEmail={currentUser?.email}
        nameMap={nameMap}
      />

      {/* BACKLOG-2319: "Linked emails" divider — only when a Needs-review section
          sits above it (a normal transaction with no review items is unchanged). */}
      {needsReviewThreads.length > 0 && (
        <div className="flex items-center gap-3 mb-3" data-testid="linked-emails-divider">
          <span className="text-sm font-medium text-gray-500">Linked emails</span>
          <div className="flex-1 border-t border-gray-200" />
        </div>
      )}

      {/* Email thread list (Linked) */}
      <div className="space-y-3">
        {linkedThreads.map((thread) => (
          <EmailThreadCard
            key={thread.id}
            thread={thread}
            onViewEmail={onViewEmail}
            onUnlink={() => handleUnlinkThread(thread)}
            isUnlinking={unlinkingThreadId === thread.id}
            userEmail={currentUser?.email}
            nameMap={nameMap}
            selectionMode={selectionMode}
            isSelected={isThreadSelected(thread.id)}
            onToggleSelect={() => toggleThreadSelection(thread.id)}
            isHighlighted={thread.id === highlightedThreadId}
          />
        ))}
      </div>

      {/* BACKLOG-1578: Show removed/unlinked emails */}
      {transactionId && (
        <RemovedEmailsSection
          transactionId={transactionId}
          onRestoreComplete={onRestoreComplete}
          onShowSuccess={onShowSuccess}
          onShowError={onShowError}
          userEmail={currentUser?.email}
          nameMap={nameMap}
          isOpen={removedSectionOpen}
          onOpenChange={setRemovedSectionOpen}
          refreshKey={combinedRemovedRefreshKey}
        />
      )}

      {/* BACKLOG-1719: floating bulk bar + confirm dialog for active-list remove */}
      {selectionMode && (
        <BulkSelectionBar
          selectedCount={selectedCount}
          totalCount={linkedThreads.length}
          onSelectAll={handleSelectAll}
          onDeselectAll={deselectAllThreads}
          onClose={handleToggleSelectionMode}
          actionLabel="Remove"
          actionProcessingLabel="Removing..."
          onAction={() => setShowBulkRemoveConfirm(true)}
          isActionProcessing={isBulkRemoving}
          actionVariant="danger"
          testId="emails-bulk-bar"
          actionTestId="emails-bulk-remove"
        />
      )}
      {showBulkRemoveConfirm && (
        <BulkRemoveConfirmModal
          conversationCount={selectedCount}
          itemCount={selectedEmailCount}
          itemNoun="email"
          isProcessing={isBulkRemoving}
          onCancel={() => setShowBulkRemoveConfirm(false)}
          onConfirm={handleBulkRemoveConfirm}
        />
      )}

      {/* Attach Emails Modal */}
      {showAttachModal && userId && transactionId && (
        <AttachEmailsModal
          userId={userId}
          transactionId={transactionId}
          propertyAddress={propertyAddress}
          auditStartDate={auditStartDate}
          auditEndDate={auditEndDate}
          onClose={() => setShowAttachModal(false)}
          onAttached={handleAttached}
        />
      )}
    </div>
  );
}
