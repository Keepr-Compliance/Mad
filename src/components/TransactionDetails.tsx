/**
 * TransactionDetails Component
 * Shows full details of a single transaction
 *
 * This is the main orchestration component that composes:
 * - TransactionHeader: Header with dynamic styling and action buttons
 * - TransactionTabs: Tab navigation
 * - TransactionDetailsTab: Details tab content
 * - TransactionContactsTab: Contacts tab with AI suggestions
 * - Various modal dialogs
 */
import React, { useState, useEffect, useCallback, useMemo, useRef, useLayoutEffect } from "react";
import { ResponsiveModal, MODAL_PANEL } from "./common/ResponsiveModal";
import type { Transaction } from "@/types";
import { transactionService } from '../services';
import ExportModal from "./ExportModal";
import AuditTransactionModal from "./AuditTransactionModal";
import { useNotification } from "../hooks/useNotification";
import type {
  NotificationAction,
  NotificationOptions,
} from "./ui/Notification/types";
import { useTransactionStatusUpdate } from "../hooks/useTransactionStatusUpdate";
import { useSyncOrchestrator } from "../hooks/useSyncOrchestrator";
import { useNetwork } from "../contexts/NetworkContext";
import { useContactNameMap } from "../hooks/useContactNameMap";

// Import from transactionDetails module
import {
  useTransactionDetails,
  useTransactionTabs,
  useTransactionCommunications,
  useSuggestedContacts,
  useTransactionMessages,
  useTransactionAllAttachments,
  useAttachmentCounts,
  TransactionHeader,
  TransactionTabs,
  TransactionDetailsTab,
  TransactionEmailsTab,
  TransactionMessagesTab,
  TransactionAttachmentsTab,
  DeleteConfirmModal,
  UnlinkEmailModal,
  EmailViewModal,
  RejectReasonModal,
  EditContactsModal,
} from "./transactionDetailsModule";
// Import ReviewNotesPanel for displaying broker feedback (BACKLOG-395)
import { ReviewNotesPanel } from "./transactionDetailsModule/components/ReviewNotesPanel";
// Import Submit for Review components (BACKLOG-391)
import { SubmitForReviewModal } from "./transactionDetailsModule/components/modals/SubmitForReviewModal";
// BACKLOG-2791 / BACKLOG-2792: the Needs Review queue and the merged Complete flow.
import { useReviewQueue } from "./transactionDetailsModule/hooks/useReviewQueue";
import { useResolvedContactNames } from "./transactionDetailsModule/hooks/useResolvedContactNames";
import { useCompleteTransaction } from "./transactionDetailsModule/hooks/useCompleteTransaction";
import { NeedsReviewScreen } from "./transactionDetailsModule/components/NeedsReviewScreen";
import { ReviewPromptDialog } from "./transactionDetailsModule/components/ReviewPromptDialog";
import {
  ReviewQueueSection,
  groupReviewItemsByThread,
} from "./transactionDetailsModule/components/ReviewQueueSection";
import { useSubmitForReview } from "./transactionDetailsModule/hooks/useSubmitForReview";
import type {
  AutoLinkResult,
  RemovedTransactionContactSummary,
} from "./transactionDetailsModule/components/modals/EditContactsModal";

import type { TransactionTab, HighlightTarget } from "./transactionDetailsModule/types";
import type { EmailThread } from "./transactionDetailsModule/components/EmailThreadCard";
import { restoreRemovedEmailsByContentIds, type EmailUndoOutcome } from "./transactionDetailsModule/utils/undoMoveRestore";
import { isEmailMessage } from '@/utils/channelHelpers';
import logger from '../utils/logger';
import { OfflineNotice } from './common/OfflineNotice';

interface TransactionDetailsComponentProps {
  transaction: Transaction;
  onClose: () => void;
  onTransactionUpdated?: () => void;
  /** If true, shows approve/reject buttons instead of export/delete (for pending review) */
  isPendingReview?: boolean;
  /** User ID for feedback recording */
  userId?: string;
  /**
   * Toast handler for success messages - if provided, uses parent's toast system.
   * BACKLOG-2390: accepts an optional inline action (e.g. Undo) for move toasts.
   */
  onShowSuccess?: (message: string, options?: NotificationOptions) => void;
  /** Toast handler for error messages - if provided, uses parent's toast system */
  onShowError?: (message: string) => void;
  /** Initial tab to display when opening TransactionDetails */
  initialTab?: TransactionTab;
  /**
   * BACKLOG-1876: Optional highlight target to seed on mount, used when the
   * transaction is opened from a global search hit so the BACKLOG-1869 viewer
   * scrolls+highlights the matching email/text card immediately.
   */
  initialHighlight?: HighlightTarget | null;
}

/**
 * TransactionDetails Component
 * Shows full details of a single transaction
 */
function TransactionDetails({
  transaction: transactionProp,
  onClose,
  onTransactionUpdated,
  isPendingReview = false,
  userId,
  onShowSuccess,
  onShowError,
  initialTab = "overview",
  initialHighlight = null,
}: TransactionDetailsComponentProps) {
  // Local state to track transaction - allows updates from edit modal
  // without requiring parent to re-render
  const [transaction, setTransaction] = useState(transactionProp);

  // Sync with prop when parent updates (e.g., list refresh)
  useEffect(() => {
    setTransaction(transactionProp);
  }, [transactionProp]);

  // BACKLOG-1762: address -> contact display_name map, resolves From/To names
  // from Contacts when the email header carries no name.
  const emailNameMap = useContactNameMap(userId ?? transaction?.user_id);

  // Toast notifications - use props if provided, otherwise notify directly.
  // BACKLOG-2447: the fallback used to be a *local* useToast whose container
  // this component rendered itself. Both paths now reach the same app-level
  // container, so the prop is only about letting a parent intercept.
  const { notify } = useNotification();
  const showSuccess = onShowSuccess || notify.success;
  const showError = onShowError || notify.error;
  // TASK-2070: Warning toast for provider errors (no parent prop for warnings)
  const showWarning = notify.warning;

  // Transaction data hook
  const {
    communications,
    contactAssignments,
    resolvedSuggestions,
    loading,
    loadDetails,
    loadCommunications,
    refreshCommunicationsSilently,
    refreshContactsSilently,
    setResolvedSuggestions,
    updateSuggestedContacts,
    removeCommunicationsByIds,
  } = useTransactionDetails(transaction);

  // Tab state hook - use initialTab prop
  const { activeTab, setActiveTab } = useTransactionTabs(initialTab);

  // BACKLOG-1869: highlight target produced by the linked-content search; consumed
  // by the Emails or Messages tab to scroll+highlight the matching conversation card.
  // BACKLOG-1876: seeded from `initialHighlight` when opened from a global search hit.
  const [highlightTarget, setHighlightTarget] = useState<HighlightTarget | null>(
    initialHighlight,
  );
  const clearHighlightTarget = useCallback(() => setHighlightTarget(null), []);

  const handleNavigateToTab = useCallback(
    (payload: { tab: TransactionTab; highlight?: HighlightTarget }) => {
      setActiveTab(payload.tab);
      if (payload.highlight) setHighlightTarget(payload.highlight);
    },
    [setActiveTab],
  );

  // PERF: Load only the channel needed for the active tab.
  // Overview only needs contacts (loaded by loadOverview on mount).
  // Emails tab loads only email comms; Messages tab loads only text comms.
  const loadedChannelsRef = React.useRef<Set<string>>(new Set());
  // BACKLOG-1888: StrictMode-safe highlight reset — compare the previous transaction
  // id rather than counting effect runs. The old boolean guard (didMountRef) flipped
  // to true after StrictMode's first run, so run 2 was misinterpreted as a real
  // transaction change and wiped the seeded initialHighlight.
  //
  // With a value comparison:
  //   StrictMode run 1: prev=null → skip reset, record id.
  //   StrictMode run 2: prev===id → skip reset (same transaction, not a change).
  //   Real navigation to a new transaction: prev!==id → reset highlight.
  //
  // The loadedChannelsRef.clear() stays UNCONDITIONAL (SR directive: always clear
  // the channel cache on every effect run, even the StrictMode double-invoke).
  const prevTransactionIdRef = React.useRef<string | null>(null);
  useEffect(() => {
    loadedChannelsRef.current.clear();
    const prev = prevTransactionIdRef.current;
    if (prev !== null && prev !== transaction.id) {
      setHighlightTarget(null);
    }
    prevTransactionIdRef.current = transaction.id;
  }, [transaction.id]);

  useEffect(() => {
    if (activeTab === "emails" && !loadedChannelsRef.current.has("email")) {
      loadedChannelsRef.current.add("email");
      loadCommunications("email");
    } else if (activeTab === "messages" && !loadedChannelsRef.current.has("text")) {
      loadedChannelsRef.current.add("text");
      loadCommunications("text");
    }
    // BACKLOG-322: the Attachments tab no longer piggybacks on email
    // communications — useTransactionAllAttachments loads its own unified data.
  }, [activeTab, loadCommunications]);

  // Communications hook
  const {
    unlinkingCommId,
    showUnlinkConfirm,
    viewingEmail,
    setShowUnlinkConfirm,
    setViewingEmail,
    handleUnlinkCommunication,
  } = useTransactionCommunications();

  // BACKLOG-1781: full thread stored while the unlink-confirm modal is open so
  // handleUnlink can call unlinkCommunication for every constituent backend thread.
  const [showUnlinkThread, setShowUnlinkThread] = useState<EmailThread | null>(null);
  // BACKLOG-1780: bump after each successful unlink → RemovedEmailsSection refetches silently.
  const [removedRefreshKey, setRemovedRefreshKey] = useState(0);
  // BACKLOG-2367: same two pieces for the removed-CONTACTS section on Overview.
  // The open state is lifted here, above the Key Contacts loading spinner, so a
  // restore never collapses the section (the BACKLOG-1780 invariant).
  const [removedContactsOpen, setRemovedContactsOpen] = useState(false);
  const [removedContactsRefreshKey, setRemovedContactsRefreshKey] = useState(0);

  // Suggested contacts hook
  const {
    processingContactId,
    processingAll,
    handleAcceptSuggestion,
    handleRejectSuggestion,
    handleAcceptAll,
  } = useSuggestedContacts(transaction);

  // Messages hook — uses pre-loaded communications to avoid duplicate getDetails call
  const {
    messages: textMessages,
    loading: messagesLoading,
    error: messagesError,
  } = useTransactionMessages(transaction, communications);

  // BACKLOG-322 Phase A: unified attachments hook — loads ALL attachments (email
  // + text/iMessage) for the transaction via a dedicated IPC query, independent
  // of which communications channels have been loaded. No audit-date window is
  // applied (matches the Emails/Texts tabs, which show all linked content).
  const {
    attachments,
    loading: attachmentsLoading,
    error: attachmentsError,
    refresh: refreshAttachments,
  } = useTransactionAllAttachments(transaction.id);

  // Refresh messages by reloading text communications from the parent state.
  // This ensures derivedMessages (from useTransactionMessages) updates correctly,
  // unlike the local refresh which updates fetchedMessages but gets overridden
  // by the non-null derivedMessages. (TASK-2023)
  // BACKLOG-322: also refetch the unified attachments so the Attachments tab
  // reflects a just-attached (or unlinked) text without a manual reload.
  const refreshMessages = useCallback(async () => {
    await loadCommunications("text");
    refreshAttachments();
  }, [loadCommunications, refreshAttachments]);

  // Accurate attachment counts from database (TASK-1781)
  // PERF: Lazy-loaded — only fetched when Submit modal opens (takes ~1.3s)
  const { counts: dbAttachmentCounts, refresh: loadAttachmentCounts } = useAttachmentCounts(
    transaction.id,
    undefined,
    undefined,
    true, // lazy: don't auto-load on mount
  );

  // Global sync orchestrator state - disable transaction Sync buttons when dashboard sync is running
  const { isRunning: globalSyncRunning } = useSyncOrchestrator();

  // TASK-2074: Network status for disabling sync buttons when offline
  const { isOnline } = useNetwork();

  // Transaction status update hook
  const { state: statusState, approve, reject, restore } = useTransactionStatusUpdate(userId);
  const { isApproving, isRejecting, isRestoring } = statusState;

  // Filter emails only for Details tab
  const emailCommunications = useMemo(() => {
    return communications.filter((comm) => isEmailMessage(comm));
  }, [communications]);

  // Note: conversation/message count for tabs now uses transaction.text_thread_count
  // (stored count) instead of computing from dynamically loaded textMessages array.
  // This ensures correct counts display even before data loads (BACKLOG-415).

  // Modal states
  const [showExportModal, setShowExportModal] = useState<boolean>(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<boolean>(false);
  const [showRejectReasonModal, setShowRejectReasonModal] = useState<boolean>(false);
  const [rejectReason, setRejectReason] = useState<string>("");
  const [showEditModal, setShowEditModal] = useState<boolean>(false);
  const [showEditContactsModal, setShowEditContactsModal] = useState<boolean>(false);
  const [syncingCommunications, setSyncingCommunications] = useState<boolean>(false);
  const [syncingMessages, setSyncingMessages] = useState<boolean>(false);
  const [showSubmitModal, setShowSubmitModal] = useState<boolean>(false);

  // ---- BACKLOG-2791 / BACKLOG-2792 -------------------------------------
  // One review-state read feeds the badge, S2, P2 and the Complete gate.
  const [showNeedsReview, setShowNeedsReview] = useState<boolean>(false);
  const reviewQueue = useReviewQueue(transaction.id);
  const openSubmitFlow = useCallback(async () => {
    try {
      const refreshed = await transactionService.getDetails(transaction.id);
      if (refreshed.success && refreshed.data) setTransaction(refreshed.data);
    } catch (err) {
      logger.error("Failed to refresh transaction before submit:", err);
    }
    loadAttachmentCounts();
    setShowSubmitModal(true);
  }, [transaction.id]);
  // T1 — the sync runs on EVERY open. The renderer owns this call because it is
  // the one that advances the watermark, which is what makes `added` mean "new
  // since you last looked" rather than "inserted by this particular call": the
  // on-open provider fetch has usually queued the same items microseconds
  // earlier under "background", and counting only our own inserts would report
  // 0 for exactly the mail P2 exists to announce.
  //
  // Keyed on the transaction id ONLY, via a ref for the callback: this must fire
  // once per open, and runSync's own identity changes whenever the queue does,
  // so depending on it directly would re-sync in a loop.
  const runSyncRef = useRef(reviewQueue.runSync);
  runSyncRef.current = reviewQueue.runSync;
  useEffect(() => {
    void runSyncRef.current("open");
  }, [transaction.id]);

  // Handles across every TEXT item in the queue, resolved independently of the
  // Texts tab — the review screen can be opened from any tab.
  const reviewTextHandles = useMemo(
    () =>
      Array.from(
        new Set(
          reviewQueue.items
            .filter((i) => i.kind === "text")
            .flatMap((i) => i.display.threadParticipants),
        ),
      ),
    [reviewQueue.items],
  );
  const reviewContactNames = useResolvedContactNames(reviewTextHandles, userId);

  // THE BADGE COUNTS THREADS (contract: "badges and subtitles count threads"),
  // derived from the same grouping the review surfaces render, so the number on
  // the button and the number of cards behind it cannot disagree.
  //
  // The Complete GATE still reads the item count (reviewQueue.count) — it only
  // ever asks "is anything outstanding", and zero threads and zero items are the
  // same zero, so the gate is unaffected by which unit it counts in.
  const reviewThreadCount = useMemo(
    () => groupReviewItemsByThread(reviewQueue.items).length,
    [reviewQueue.items],
  );

  // BACKLOG-2791: review actions were silent. Every other destructive or
  // state-changing action in this screen toasts ("2 emails restored"), so these
  // reuse the same showSuccess/showError helpers and the same "N noun verbed"
  // phrasing rather than introducing a second convention.
  const reviewNoun = useCallback(
    (ids: string[]) => {
      const kinds = new Set(
        reviewQueue.items.filter((i) => ids.includes(i.id)).map((i) => i.kind),
      );
      const noun = kinds.size === 1 && kinds.has("text") ? "conversation" : "email";
      return ids.length === 1 ? noun : `${noun}s`;
    },
    [reviewQueue.items],
  );

  const handleApproveReview = useCallback(
    async (ids: string[]) => {
      const noun = reviewNoun(ids);
      try {
        await reviewQueue.approve(ids);
        showSuccess(`${ids.length} ${noun} linked to this transaction`);
      } catch (err) {
        showError(`Could not link ${noun}`);
      }
    },
    [reviewQueue, reviewNoun, showSuccess, showError],
  );

  const handleRejectReview = useCallback(
    async (ids: string[]) => {
      const noun = reviewNoun(ids);
      try {
        await reviewQueue.reject(ids);
        // "removed" — the same word the Removed section uses, because that is
        // exactly where the item now is.
        showSuccess(`${ids.length} ${noun} removed`);
      } catch (err) {
        showError(`Could not remove ${noun}`);
      }
    },
    [reviewQueue, reviewNoun, showSuccess, showError],
  );

  const complete = useCompleteTransaction({
    refreshReviewState: reviewQueue.refresh,
    openExport: () => setShowExportModal(true),
    openSubmit: () => { void openSubmitFlow(); },
    openNeedsReview: () => setShowNeedsReview(true),
  });
  // BACKLOG-1832: true while the background create-trigger sync is in flight for THIS transaction.
  // Drives the "fetching emails…" indicator on the empty emails tab.
  const [autoSyncRunning, setAutoSyncRunning] = useState<boolean>(false);
  // BACKLOG-2294: true while a BACKGROUND messages sync/import is in flight for the
  // user (audit-date-change / create auto-import, the orchestrator's post-login sync's
  // message import, or the 2293 re-sync expansion). Drives the Texts "Sync" button's
  // active affordance so it reads "working" instead of a dead disabled gray.
  const [messagesSyncInFlight, setMessagesSyncInFlight] = useState<boolean>(false);

  // BACKLOG-1832: Subscribe to background auto-sync lifecycle events so the UI
  // reflects the in-flight fetch state and auto-refreshes when emails arrive.
  useEffect(() => {
    if (!window.api.onTransactionAutoSyncStarted || !window.api.onTransactionAutoSyncComplete) {
      return;
    }

    const unsubStarted = window.api.onTransactionAutoSyncStarted((data) => {
      if (data.transactionId !== transaction.id) return;
      setAutoSyncRunning(true);
    });

    const unsubComplete = window.api.onTransactionAutoSyncComplete((data) => {
      if (data.transactionId !== transaction.id) return;
      setAutoSyncRunning(false);

      if (data.ran) {
        // Refresh the email list silently (no loading spinner, no scroll jump).
        if (loadedChannelsRef.current.has("email")) {
          void refreshCommunicationsSilently("email");
        }
        // Refresh the transaction row (email_count badge) via getOverview —
        // this does NOT trigger another auto-sync, avoiding a notification cycle.
        void (window.api.transactions.getOverview(transaction.id) as Promise<{
          success: boolean;
          transaction?: { email_count?: number };
        }>).then((result) => {
          if (result.success && result.transaction) {
            const ec = result.transaction.email_count;
            if (typeof ec === "number") {
              setTransaction((prev) => ({ ...prev, email_count: ec }));
            }
          }
        }).catch(() => { /* non-critical */ });
      }
    });

    // BACKLOG-1832 spinner timing fix: `transactions:auto-sync-started` is sent
    // from the main process BEFORE the CREATE IPC response returns, so it always
    // fires before this component mounts and subscribes. We close the race by
    // querying the main-process inflight registry immediately after subscribing.
    // By querying AFTER the subscriptions above are registered, any concurrent
    // `complete` event will first remove the transactionId from inflightSyncs
    // (and set inFlight: false) before our query resolves — preventing false-positives.
    void window.api.transactions.isAutoSyncInFlight?.(transaction.id)
      .then((result) => {
        if (result?.inFlight) {
          setAutoSyncRunning(true);
        }
      })
      .catch(() => { /* non-critical */ });

    return () => {
      unsubStarted();
      unsubComplete();
    };
  }, [transaction.id, refreshCommunicationsSilently]);

  // BACKLOG-2292 (Layer 2): when a background messages sync completes (date-change
  // or create auto-import + expansion), silently refresh the TEXT list so newly
  // imported/expanded messages appear without a manual Sync. The import is
  // user-global, so a null transactionId means "affects all" and still refreshes.
  useEffect(() => {
    if (!window.api.transactions.onMessagesSyncComplete) return;
    const unsub = window.api.transactions.onMessagesSyncComplete((data) => {
      if (!data.ran) return;
      if (data.transactionId && data.transactionId !== transaction.id) return;
      if (loadedChannelsRef.current.has("text")) {
        void refreshCommunicationsSilently("text");
      }
    });
    return () => {
      unsub();
    };
  }, [transaction.id, refreshCommunicationsSilently]);

  // BACKLOG-2294: reflect a BACKGROUND messages sync as "working" on the Texts sync
  // button. The macOS Messages importer streams `messages:import-progress` while it
  // runs; the BACKLOG-2292 `onMessagesSyncComplete` marks the transaction-triggered
  // scans done. A stall watchdog drops the flag if progress goes quiet without a
  // completion event (e.g. a Settings-initiated import that emits no sync-complete),
  // so the button can never get stuck showing "Syncing…". User-global signal, so no
  // transaction-id gating and no per-transaction dependency.
  useEffect(() => {
    const registerProgress = window.api.messages?.onImportProgress;
    const registerComplete = window.api.transactions.onMessagesSyncComplete;
    if (!registerProgress && !registerComplete) return;

    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const clearStall = () => {
      if (stallTimer !== null) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
    };
    // Drop the affordance if progress goes quiet this long without a completion
    // event — a safety net so the flag is never permanently stuck.
    const PROGRESS_STALL_MS = 30_000;

    const unsubProgress = registerProgress
      ? registerProgress(() => {
          setMessagesSyncInFlight(true);
          clearStall();
          stallTimer = setTimeout(() => setMessagesSyncInFlight(false), PROGRESS_STALL_MS);
        })
      : undefined;

    const unsubComplete = registerComplete
      ? registerComplete(() => {
          clearStall();
          setMessagesSyncInFlight(false);
        })
      : undefined;

    return () => {
      clearStall();
      unsubProgress?.();
      unsubComplete?.();
    };
  }, []);

  // Submit for Review hook (BACKLOG-391)
  const isResubmit = transaction.submission_status === "needs_changes";
  const {
    isSubmitting,
    progress: submitProgress,
    error: submitError,
    submit: handleSubmitForReview,
    reset: resetSubmit,
  } = useSubmitForReview({
    transactionId: transaction.id,
    isResubmit,
    onSuccess: (submissionId) => {
      showSuccess(`Transaction submitted successfully! ID: ${submissionId.slice(0, 8)}...`);
      // Refresh transaction data
      loadDetails();
      onTransactionUpdated?.();
    },
    onError: (error) => {
      showError(`Submission failed: ${error}`);
    },
  });

  // Check if transaction was rejected
  const isRejected = transaction.detection_status === "rejected";

  // Export handlers
  const handleExportComplete = async (_result: unknown): Promise<void> => {
    setShowExportModal(false);
    // The ExportModal now shows its own success screen (step 5) with buttons
    // No need to show a separate success bar in TransactionDetails

    // Refresh transaction data to reflect any date changes made during export
    try {
      const refreshed = await transactionService.getDetails(transaction.id);
      if (refreshed.success && refreshed.data) {
        setTransaction(refreshed.data);
        loadDetails();
        onTransactionUpdated?.();
      }
    } catch (err) {
      logger.error("Failed to refresh transaction after export:", err);
    }
    // Note: Close transaction prompt is now handled within ExportModal (step 4)
  };

  const handleDelete = async (): Promise<void> => {
    try {
      await transactionService.delete(transaction.id);
      setShowDeleteConfirm(false);
      onClose();
      onTransactionUpdated?.();
    } catch (err) {
      logger.error("Failed to delete transaction:", err);
      showError("Failed to delete transaction. Please try again.");
    }
  };

  // Status update handlers
  const handleApprove = useCallback(async (): Promise<void> => {
    await approve(transaction.id, {
      onSuccess: () => {
        showSuccess("Transaction approved successfully!");
        onClose();
        onTransactionUpdated?.();
      },
      onError: (error) => showError(error),
    });
  }, [approve, transaction.id, onClose, onTransactionUpdated, showSuccess, showError]);

  const handleReject = useCallback(async (): Promise<void> => {
    await reject(transaction.id, rejectReason, {
      onSuccess: () => {
        showSuccess("Transaction rejected");
        setShowRejectReasonModal(false);
        setRejectReason("");
        onClose();
        onTransactionUpdated?.();
      },
      onError: (error) => showError(error),
    });
  }, [reject, transaction.id, rejectReason, onClose, onTransactionUpdated, showSuccess, showError]);

  const handleRestore = useCallback(async (): Promise<void> => {
    await restore(transaction.id, {
      onSuccess: () => {
        showSuccess("Transaction restored to active");
        onClose();
        onTransactionUpdated?.();
      },
      onError: (error) => showError(error),
    });
  }, [restore, transaction.id, onClose, onTransactionUpdated, showSuccess, showError]);

  // BACKLOG-2390 (fix, Bug 3): Undo a single/thread email removal. Restores the
  // EXACT emails that moved by their CONTENT ids (email.id = emails.id) via the
  // shared thread-aware restore mapping. Fails LOUD on no-match / restore failure.
  const undoRestoreEmails = useCallback(
    async (emailContentIds: string[]) => {
      if (emailContentIds.length === 0) return;
      let outcome: EmailUndoOutcome;
      try {
        outcome = await restoreRemovedEmailsByContentIds(
          window.api.transactions,
          transaction.id,
          emailContentIds,
        );
      } catch {
        showError("Failed to undo");
        return;
      }
      if (outcome.status === "success" || outcome.status === "restore_failed") {
        await refreshCommunicationsSilently("email");
        refreshAttachments();
        setRemovedRefreshKey((k) => k + 1);
      }
      if (outcome.status === "success") {
        showSuccess("Move undone");
      } else if (outcome.status === "fetch_failed") {
        showError(outcome.error || "Failed to undo");
      } else {
        showError("Couldn't undo — emails are still removed");
      }
    },
    [transaction.id, refreshCommunicationsSilently, refreshAttachments, showSuccess, showError],
  );

  // Communication handlers
  // BACKLOG-1781: when the confirmed comm belongs to a merged card (showUnlinkThread),
  // collect one representative communicationId per distinct backend thread_id and call
  // unlinkCommunication sequentially. Aggregate all returned unlinkedIds into one
  // in-place list update and one toast ("N emails removed").
  const handleUnlink = useCallback(
    async (comm: typeof showUnlinkConfirm) => {
      if (!comm) return;

      // Build the list of additional thread representatives beyond the first.
      // Group the merged card's emails by their backend thread_id (or email id
      // for emails without a thread) and take one per group.
      const extraCommIds: string[] = [];
      if (showUnlinkThread) {
        const seen = new Set<string>();
        // Skip the first representative — it's handled by handleUnlinkCommunication.
        const firstKey = comm.thread_id ?? comm.id;
        seen.add(firstKey);
        for (const email of showUnlinkThread.emails) {
          const key = email.thread_id ?? email.id;
          if (!seen.has(key)) {
            seen.add(key);
            const cid = (email as unknown as { communication_id?: string }).communication_id ?? email.id;
            extraCommIds.push(cid);
          }
        }
      }

      await handleUnlinkCommunication(
        comm,
        async ({ unlinkedIds: firstIds }) => {
          // Unlink additional constituents (if merged card had multiple threads).
          const allUnlinkedIds: string[] = [...(firstIds ?? [])];
          for (const cid of extraCommIds) {
            try {
              const r = await window.api.transactions.unlinkCommunication(cid);
              if (r.success && r.unlinkedIds) allUnlinkedIds.push(...r.unlinkedIds);
            } catch {
              // non-blocking: one constituent failing shouldn't break the whole action
            }
          }

          const n = allUnlinkedIds.length;
          // BACKLOG-2390 (Bug 3): offer Undo on single/thread removal too. Restore
          // by the removed emails' CONTENT ids (email.id = emails.id), the id-space
          // getRemovedEmails() keys on — NOT allUnlinkedIds (communications ids).
          const removedEmailContentIds = (showUnlinkThread?.emails ?? [comm])
            .map((e) => e?.id)
            .filter((id): id is string => !!id);
          const undoAction: NotificationAction | undefined =
            removedEmailContentIds.length > 0
              ? { label: "Undo", onClick: () => void undoRestoreEmails(removedEmailContentIds) }
              : undefined;
          showSuccess(
            n > 1 ? `${n} emails removed` : "Email unlinked from transaction",
            { action: undoAction },
          );
          setShowUnlinkThread(null);
          // BACKLOG-1780: signal RemovedEmailsSection to refresh its count.
          setRemovedRefreshKey((k) => k + 1);

          // BACKLOG-1778: in-place list update — drop exactly the unlinked rows.
          if (allUnlinkedIds.length > 0) {
            const removed = removeCommunicationsByIds(allUnlinkedIds);
            if (removed === 0) void loadCommunications("email");
          } else {
            void loadCommunications("email");
          }
        },
        showError
      );
    },
    [showUnlinkThread, handleUnlinkCommunication, removeCommunicationsByIds, loadCommunications, showSuccess, showError, undoRestoreEmails]
  );

  // BACKLOG-1781: handler for thread-aware unlink confirmation. Stores the full
  // EmailThread so handleUnlink can iterate all constituent backend threads.
  const handleShowUnlinkThread = useCallback((thread: EmailThread) => {
    setShowUnlinkThread(thread);
    setShowUnlinkConfirm(thread.emails[0]); // first email for modal display
  }, [setShowUnlinkConfirm]);

  // BACKLOG-1778: preserve the email list scroll position across refetches.
  // Capture the scroll offset before the refetch and restore it once the new
  // content has painted so the list doesn't jump back to the top.
  // Used by the ATTACH flow (which triggers loadDetails). The RESTORE flow now
  // uses refreshCommunicationsSilently via onRestoreComplete, which never sets
  // loading=true — so the container never unmounts and scroll never jumps.
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const pendingScrollTop = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (!loading && pendingScrollTop.current !== null) {
      const el = scrollContainerRef.current;
      if (el) el.scrollTop = pendingScrollTop.current;
      pendingScrollTop.current = null;
    }
  }, [loading]);

  const handleEmailsChangedPreserveScroll = useCallback(async () => {
    pendingScrollTop.current = scrollContainerRef.current?.scrollTop ?? null;
    await loadDetails();
    // BACKLOG-322: refetch the unified attachments so the Attachments tab
    // reflects a just-attached (or unlinked) email without a manual reload.
    refreshAttachments();
  }, [loadDetails, refreshAttachments]);

  /**
   * Undo an Edit Contacts save that took parties off this deal (BACKLOG-2501).
   *
   * Calls the SAME `transactions:restore-contact` channel the "Show removed (N)"
   * section under Key Contacts restores through
   * (`RemovedTransactionContactsSection.restoreGroup`) — one path, two callers,
   * no second un-remove route.
   *
   * This restores the party's role on THIS transaction only. It deliberately
   * does NOT touch `contacts.removed_at`: the two tombstones are independent by
   * design, and undoing a removal from a deal must not un-delete the person from
   * the database (there is a suite asserting exactly that).
   *
   * Sequential rather than `Promise.all`: these are SQLite writes to the same
   * junction table through one IPC channel, and a partial failure has to be
   * attributable to a name.
   */
  const undoRemoveTransactionContacts = useCallback(
    async (removed: RemovedTransactionContactSummary[]) => {
      const failed: string[] = [];
      for (const party of removed) {
        try {
          const result = await window.api.transactions.restoreContact(
            transaction.id,
            party.contactId
          );
          if (!result.success) failed.push(party.displayName);
        } catch (err) {
          logger.error("Failed to restore transaction contact:", err);
          failed.push(party.displayName);
        }
      }

      // Silent: a spinner here unmounts the Key Contacts list and collapses the
      // removed section mid-interaction (the BACKLOG-1780 failure).
      await refreshContactsSilently();
      // The party is back on the deal, so the removed-section count is stale.
      setRemovedContactsRefreshKey((k) => k + 1);
      onTransactionUpdated?.();

      if (failed.length > 0) {
        showError(
          failed.length > 1
            ? `Failed to restore ${failed.length} contacts`
            : `Failed to restore ${failed[0]}`
        );
      }
    },
    [
      transaction.id,
      refreshContactsSilently,
      onTransactionUpdated,
      showError,
    ]
  );

  // BACKLOG-1780: silent communications refresh for the restore-removed path.
  // No loading flag, no spinner, no unmount — React reconciles keyed rows in place.
  const handleRefreshEmailsSilently = useCallback(async () => {
    await refreshCommunicationsSilently("email");
    // BACKLOG-322: a restored email brings its attachments back — refetch them.
    refreshAttachments();
  }, [refreshCommunicationsSilently, refreshAttachments]);

  // BACKLOG-1793: silent text-communications refresh for the restore-removed
  // path on the Messages tab — mirrors handleRefreshEmailsSilently so a restored
  // conversation reappears in place without a loading cycle or scroll jump.
  const handleRefreshMessagesSilently = useCallback(async () => {
    await refreshCommunicationsSilently("text");
    // BACKLOG-322: a restored conversation brings its attachments back — refetch.
    refreshAttachments();
  }, [refreshCommunicationsSilently, refreshAttachments]);

  // Suggested contacts handlers with callbacks
  const suggestionCallbacks = {
    onUpdateResolvedSuggestions: setResolvedSuggestions,
    resolvedSuggestions,
    updateSuggestedContacts,
    loadDetails,
    onTransactionUpdated,
    showSuccess,
    showError,
  };

  const handleAcceptSuggestionWithCallbacks = useCallback(
    (suggestion: typeof resolvedSuggestions[0]) => {
      handleAcceptSuggestion(suggestion, suggestionCallbacks);
    },
    [handleAcceptSuggestion, suggestionCallbacks]
  );

  const handleRejectSuggestionWithCallbacks = useCallback(
    (suggestion: typeof resolvedSuggestions[0]) => {
      handleRejectSuggestion(suggestion, suggestionCallbacks);
    },
    [handleRejectSuggestion, suggestionCallbacks]
  );

  const handleAcceptAllWithCallbacks = useCallback(() => {
    handleAcceptAll(resolvedSuggestions, {
      ...suggestionCallbacks,
      clearSuggestions: () => setResolvedSuggestions([]),
    });
  }, [handleAcceptAll, resolvedSuggestions, suggestionCallbacks, setResolvedSuggestions]);

  // Sync communications handler - fetches from provider and auto-links
  // BACKLOG-457: Now fetches NEW emails from Gmail/Outlook, not just local DB
  const handleSyncCommunications = useCallback(async () => {
    setSyncingCommunications(true);
    try {
      const result = await window.api.transactions.syncAndFetchEmails(transaction.id);

      // Handle rate-limited response with a non-alarming message
      if (!result.success && result.rateLimited) {
        showSuccess(result.error || "Please wait before syncing again");
        return;
      }

      // TASK-2070: Extract warning from result (provider error surfaced through IPC)
      const syncWarning = (result as { warning?: string }).warning;

      if (result.success) {
        const emailsFetched = result.emailsFetched || 0;
        const emailsStored = result.emailsStored || 0;
        const totalLinked = (result.totalEmailsLinked || 0) + (result.totalMessagesLinked || 0);

        // TASK-2070: Show warning toast if provider fetch failed (token expired, API error)
        // This takes priority over the green success message
        if (syncWarning) {
          showWarning(syncWarning);
          // Still refresh if any local data was linked
          if (totalLinked > 0) {
            loadDetails();
            refreshMessages();
          }
        } else if (emailsStored > 0 || totalLinked > 0) {
          const parts: string[] = [];
          if (emailsStored > 0) {
            parts.push(`${emailsStored} new email${emailsStored !== 1 ? "s" : ""} fetched`);
          }
          if (result.totalEmailsLinked && result.totalEmailsLinked > 0) {
            parts.push(`${result.totalEmailsLinked} email${result.totalEmailsLinked !== 1 ? "s" : ""} linked`);
          }
          if (result.totalMessagesLinked && result.totalMessagesLinked > 0) {
            parts.push(`${result.totalMessagesLinked} message thread${result.totalMessagesLinked !== 1 ? "s" : ""} linked`);
          }
          showSuccess(parts.join(", "));
          // Refresh to show newly fetched/linked communications
          loadDetails();
          refreshMessages();
        } else if (emailsFetched > 0 && emailsStored === 0) {
          showSuccess(`Checked ${emailsFetched} emails - all already in database`);
        } else if (result.totalAlreadyLinked && result.totalAlreadyLinked > 0) {
          showSuccess(`All communications already linked (${result.totalAlreadyLinked} found)`);
        } else if (result.message) {
          showSuccess(result.message);
        } else {
          showSuccess("No new communications found");
        }
      } else {
        showError(result.error || "Failed to sync communications");
      }
    } catch (err) {
      logger.error("Failed to sync communications:", err);
      showError("Failed to sync communications. Please try again.");
    } finally {
      setSyncingCommunications(false);
    }
  }, [transaction.id, showSuccess, showError, showWarning, loadDetails, refreshMessages]);

  // Sync messages handler - re-links text messages from assigned contacts (phone-based matching)
  const handleSyncMessages = useCallback(async () => {
    setSyncingMessages(true);
    try {
      const result = await (window.api.transactions as typeof window.api.transactions & {
        resyncAutoLink: (transactionId: string) => Promise<{
          success: boolean;
          totalEmailsLinked?: number;
          totalMessagesLinked?: number;
          totalAlreadyLinked?: number;
          totalErrors?: number;
          // BACKLOG-2293: messages linked by attached-thread expansion (backfill
          // already sharing an attached thread). Can be > 0 while
          // totalMessagesLinked is 0 (auto-link's date floor excludes backfill).
          attachedExpansionLinked?: number;
          message?: string;
          error?: string;
        }>;
      }).resyncAutoLink(transaction.id);

      if (result.success) {
        const threadsLinked = result.totalMessagesLinked || 0;
        const expansionLinked = result.attachedExpansionLinked || 0;
        const totalLinked = threadsLinked + expansionLinked;
        const alreadyLinked = result.totalAlreadyLinked || 0;

        // BACKLOG-2293: always refresh on success. Expansion can link messages
        // (totalLinked > 0) even when the per-contact auto-link linked 0 threads;
        // the old `messagesLinked > 0` gate skipped the refresh in exactly that
        // case, so the just-linked backfill never rendered until re-navigation.
        refreshMessages();

        if (totalLinked > 0) {
          showSuccess(`${totalLinked} message${totalLinked !== 1 ? "s" : ""} linked`);
        } else if (alreadyLinked > 0) {
          showSuccess(`All messages already linked (${alreadyLinked} found)`);
        } else if (result.message === "No contacts to sync") {
          showSuccess("No contacts assigned — assign contacts first to sync messages");
        } else {
          showSuccess("No new messages found for assigned contacts");
        }
      } else {
        showError(result.error || "Failed to sync messages");
      }
    } catch (err) {
      logger.error("Failed to sync messages:", err);
      showError("Failed to sync messages. Please try again.");
    } finally {
      setSyncingMessages(false);
    }
  }, [transaction.id, showSuccess, showError, refreshMessages]);

  // BACKLOG-2319: the "Filter by property address" toggle is retired. Unmatched
  // emails now surface in the Emails-tab "Needs review" section instead of being
  // hidden, so there is no longer a per-transaction skip_address_filter control
  // here. (The DB column remains but is no longer written from this screen.)

  // Show a loading overlay while initial data loads
  if (loading && contactAssignments.length === 0) {
    return (
      <ResponsiveModal zIndex="z-[60]" panelClassName={`${MODAL_PANEL.lg} items-center justify-center`}>
          <div className="w-10 h-10 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
          <p className="text-gray-500 mt-4">Loading transaction...</p>
      </ResponsiveModal>
    );
  }

  return (
    <ResponsiveModal onClose={onClose} zIndex="z-[60]" panelClassName={MODAL_PANEL.lg} testId="transaction-details-modal">
        {/* Header */}
        <TransactionHeader
          transaction={transaction}
          isPendingReview={isPendingReview}
          isRejected={isRejected}
          isApproving={isApproving}
          isRejecting={isRejecting}
          isRestoring={isRestoring}
          isSubmitting={isSubmitting}
          onClose={onClose}
          onShowRejectReasonModal={() => setShowRejectReasonModal(true)}
          onShowEditModal={() => setShowEditModal(true)}
          onApprove={handleApprove}
          onRestore={handleRestore}
          onShowExportModal={() => setShowExportModal(true)}
          onShowDeleteConfirm={() => setShowDeleteConfirm(true)}
          reviewCount={reviewThreadCount}
          onShowNeedsReview={() => setShowNeedsReview(true)}
          onComplete={() => { void complete.requestComplete(); }}
        />

        {/* Tabs */}
        <TransactionTabs
          activeTab={activeTab}
          conversationCount={transaction.text_thread_count || 0}
          emailCount={transaction.email_count || 0}
          onTabChange={setActiveTab}
        />

        <OfflineNotice />

        {/* Content */}
        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto p-3 sm:p-6">
          {/* Review Notes Panel - shown when broker requests changes (BACKLOG-395) */}
          {transaction.submission_status === "needs_changes" && transaction.last_review_notes && (
            <ReviewNotesPanel
              reviewNotes={transaction.last_review_notes}
            />
          )}

          {activeTab === "overview" && (
            <TransactionDetailsTab
              transaction={transaction}
              contactAssignments={contactAssignments}
              loading={loading}
              userId={userId}
              onEdit={() => setShowEditModal(true)}
              onEditContacts={() => setShowEditContactsModal(true)}
              onDelete={() => setShowDeleteConfirm(true)}
              resolvedSuggestions={resolvedSuggestions}
              processingContactId={processingContactId}
              processingAll={processingAll}
              onAcceptSuggestion={handleAcceptSuggestionWithCallbacks}
              onRejectSuggestion={handleRejectSuggestionWithCallbacks}
              onAcceptAll={handleAcceptAllWithCallbacks}
              onSyncCommunications={handleSyncCommunications}
              syncingCommunications={syncingCommunications}
              globalSyncRunning={globalSyncRunning}
              isOnline={isOnline}
              onContactUpdated={loadDetails}
              onNavigateToTab={handleNavigateToTab}
              onContactRestoreComplete={refreshContactsSilently}
              onShowSuccess={showSuccess}
              onShowError={showError}
              removedContactsOpen={removedContactsOpen}
              onRemovedContactsOpenChange={setRemovedContactsOpen}
              removedContactsRefreshKey={removedContactsRefreshKey}
            />
          )}

          {activeTab === "emails" && (
            <>
            <TransactionEmailsTab
              hasReviewItems={reviewQueue.items.some((i) => i.kind === "email")}
              /* BACKLOG-2791: the SAME set the badge counts and the Complete gate
                 blocks on, filtered to emails, rendered by the tab under its
                 Select row (develop's position). Not re-derived in the tab — that
                 is what stopped the badge and the section disagreeing. */
              reviewSection={
                <ReviewQueueSection
                  items={reviewQueue.items}
                  kind="email"
                  onApprove={handleApproveReview}
                  onReject={handleRejectReview}
                  onViewEmail={setViewingEmail}
                  nameMap={emailNameMap}
                />
              }
              communications={emailCommunications}
              loading={loading || (autoSyncRunning && emailCommunications.length === 0)}
              unlinkingCommId={unlinkingCommId}
              onViewEmail={setViewingEmail}
              onShowUnlinkConfirm={setShowUnlinkConfirm}
              onShowUnlinkThread={handleShowUnlinkThread}
              removedSectionRefreshKey={removedRefreshKey + reviewQueue.changeToken}
              onSyncCommunications={handleSyncCommunications}
              syncingCommunications={syncingCommunications}
              globalSyncRunning={globalSyncRunning}
              isOnline={isOnline}
              hasContacts={contactAssignments.length > 0}
              userId={userId}
              transactionId={transaction.id}
              propertyAddress={transaction.property_address}
              // BACKLOG-1778: preserve scroll position when the list refetches
              // after attach (unlink updates in place; restore now uses silent refresh).
              onEmailsChanged={handleEmailsChangedPreserveScroll}
              // BACKLOG-1719: in-place optimistic removal for the bulk-remove flow.
              onRemoveEmailsByIds={removeCommunicationsByIds}
              // BACKLOG-1780: silent refresh after restore — no loading cycle,
              // no spinner, scroll never moves.
              onRestoreComplete={handleRefreshEmailsSilently}
              onShowSuccess={showSuccess}
              onShowError={showError}
              auditStartDate={transaction.started_at ? String(transaction.started_at) : undefined}
              auditEndDate={transaction.closed_at ? String(transaction.closed_at) : undefined}
              // BACKLOG-2319: silent refresh after a Needs-review Confirm — the
              // card moves to Linked with no spinner/scroll jump.
              onConfirmComplete={handleRefreshEmailsSilently}
              // BACKLOG-1869: scroll+highlight the card matching the search result.
              highlightTarget={highlightTarget}
              onHighlightConsumed={clearHighlightTarget}
            />
            </>
          )}


          {activeTab === "messages" && (
            <>
            <TransactionMessagesTab
              hasReviewItems={reviewQueue.items.some((i) => i.kind === "text")}
              reviewRefreshKey={reviewQueue.changeToken}
              /* BACKLOG-2791: the texts half of the same set. develop has no
                 needs-review section on this tab at all — texts never had the
                 state — so this is new, positioned to match the Emails tab. */
              reviewSection={
                <ReviewQueueSection
                  items={reviewQueue.items}
                  kind="text"
                  onApprove={handleApproveReview}
                  onReject={handleRejectReview}
                  auditStartDate={transaction.started_at}
                  auditEndDate={transaction.closed_at}
                />
              }
              messages={textMessages}
              loading={messagesLoading || loading}
              error={messagesError}
              userId={userId}
              transactionId={transaction.id}
              propertyAddress={transaction.property_address}
              onMessagesChanged={refreshMessages}
              // BACKLOG-1793: restore uses a silent refresh — no loading cycle,
              // no spinner, scroll never moves (parallels the Emails tab).
              onRestoreComplete={handleRefreshMessagesSilently}
              onRemoveMessagesByIds={removeCommunicationsByIds}
              onShowSuccess={showSuccess}
              onShowError={showError}
              auditStartDate={transaction.started_at}
              auditEndDate={transaction.closed_at}
              onSyncMessages={handleSyncMessages}
              syncingMessages={syncingMessages}
              globalSyncRunning={globalSyncRunning}
              messagesSyncInFlight={messagesSyncInFlight}
              isOnline={isOnline}
              hasContacts={contactAssignments.length > 0}
              // BACKLOG-1869: scroll+highlight the card matching the search result.
              highlightTarget={highlightTarget}
              onHighlightConsumed={clearHighlightTarget}
            />
            </>
          )}

          {activeTab === "attachments" && (
            <TransactionAttachmentsTab
              attachments={attachments}
              loading={attachmentsLoading}
              error={attachmentsError}
              refresh={refreshAttachments}
            />
          )}
        </div>

      {/* Export Modal */}
      {showExportModal && (
        <ExportModal
          transaction={transaction}
          userId={transaction.user_id}
          onClose={() => setShowExportModal(false)}
          onExportComplete={handleExportComplete}
        />
      )}

      {/* Delete Confirmation */}
      {showDeleteConfirm && (
        <DeleteConfirmModal
          propertyAddress={transaction.property_address}
          onCancel={() => setShowDeleteConfirm(false)}
          onDelete={handleDelete}
        />
      )}

      {/* Unlink Email Confirmation */}
      {showUnlinkConfirm && (
        <UnlinkEmailModal
          communication={showUnlinkConfirm}
          isUnlinking={unlinkingCommId === showUnlinkConfirm.id}
          onCancel={() => { setShowUnlinkConfirm(null); setShowUnlinkThread(null); }}
          onUnlink={() => handleUnlink(showUnlinkConfirm)}
        />
      )}

      {/* Full Email View Modal */}
      {viewingEmail && (
        <EmailViewModal
          email={viewingEmail}
          onClose={() => setViewingEmail(null)}
          onRemoveFromTransaction={() => {
            setViewingEmail(null);
            setShowUnlinkConfirm(viewingEmail);
          }}
          nameMap={emailNameMap}
        />
      )}

      {/* Reject Reason Modal */}
      {showRejectReasonModal && (
        <RejectReasonModal
          rejectReason={rejectReason}
          onRejectReasonChange={setRejectReason}
          isRejecting={isRejecting}
          onCancel={() => {
            setShowRejectReasonModal(false);
            setRejectReason("");
          }}
          onReject={handleReject}
        />
      )}

      {/* Edit Transaction Modal */}
      {showEditModal && (
        <AuditTransactionModal
          userId={transaction.user_id}
          onClose={() => setShowEditModal(false)}
          onSuccess={(updatedTransaction) => {
            setShowEditModal(false);
            // Update local transaction state with fresh data from save
            setTransaction(updatedTransaction);
            loadDetails();
            onTransactionUpdated?.();
          }}
          editTransaction={transaction}
        />
      )}

      {/* Edit Contacts Modal - Direct access to contact assignment */}
      {showEditContactsModal && (
        <EditContactsModal
          transaction={transaction}
          userId={userId || transaction.user_id}
          onClose={() => setShowEditContactsModal(false)}
          onSave={(
            autoLinkResults?: AutoLinkResult[],
            removedContacts?: RemovedTransactionContactSummary[],
          ) => {
            loadDetails();
            onTransactionUpdated?.();
            // BACKLOG-2367: a save can REMOVE a party, so the removed-contacts
            // count is now stale. Bump to refetch it silently — no spinner.
            setRemovedContactsRefreshKey((k) => k + 1);
            // TASK-1126: Show detailed toast with auto-link results
            if (autoLinkResults && autoLinkResults.length > 0) {
              const totalEmails = autoLinkResults.reduce(
                (sum, r) => sum + r.emailsLinked,
                0
              );
              const totalMessages = autoLinkResults.reduce(
                (sum, r) => sum + r.messagesLinked,
                0
              );
              if (totalEmails > 0 || totalMessages > 0) {
                const parts: string[] = [];
                if (totalEmails > 0) {
                  parts.push(`${totalEmails} email${totalEmails !== 1 ? "s" : ""}`);
                }
                if (totalMessages > 0) {
                  parts.push(
                    `${totalMessages} message thread${totalMessages !== 1 ? "s" : ""}`
                  );
                }
                showSuccess(`Contacts updated. Linked ${parts.join(" and ")}.`);
              } else {
                showSuccess("Contacts updated. Use 'Sync' on the Emails tab to fetch new emails from your provider.");
              }
            } else if (!removedContacts || removedContacts.length === 0) {
              // BACKLOG-2501: when this save only REMOVED people, the removal
              // toast below is raised instead — it says who left and offers
              // Undo, which is strictly more than "Contacts updated
              // successfully" carries. A save that also linked communications
              // still reports that above; losing "12 emails linked" would be a
              // regression, so those two coexist.
              showSuccess("Contacts updated successfully");
            }

            // BACKLOG-2501: "{Name} removed" with Undo. Founder QA asked for the
            // same toast the Clients & Contacts delete now raises.
            if (removedContacts && removedContacts.length > 0) {
              const removed = [...removedContacts];
              showSuccess(
                removed.length > 1
                  ? `${removed.length} contacts removed`
                  : `${removed[0].displayName} removed`,
                {
                  action: {
                    label: "Undo",
                    onClick: () => void undoRemoveTransactionContacts(removed),
                  },
                }
              );
            }
          }}
        />
      )}

      {/* BACKLOG-2791 S2 — the combined review screen. An OVERLAY, not an early
          return, so the four tabs stay mounted underneath and keep their scroll
          position, highlight state and loaded channels. */}
      {showNeedsReview && (
        <NeedsReviewScreen
          items={reviewQueue.items}
          isLoading={reviewQueue.isLoading}
          onApprove={handleApproveReview}
          onReject={handleRejectReview}
          onClose={() => setShowNeedsReview(false)}
          /* Same props the tabs pass their cards, so the screen behaves
             identically — including click-to-preview. Text names resolve here
             rather than depending on the Texts tab being mounted. */
          onViewEmail={setViewingEmail}
          nameMap={emailNameMap}
          contactNames={reviewContactNames}
          auditStartDate={transaction.started_at}
          auditEndDate={transaction.closed_at}
        />
      )}

      {/* BACKLOG-2791 P2 — announces ONLY what this run newly added. Silent at
          zero. "Later" just closes: the items are already persisted. */}
      {reviewQueue.lastAdded > 0 && !showNeedsReview && (
        <ReviewPromptDialog
          variant="found"
          count={reviewQueue.lastAdded}
          linkedCount={reviewQueue.lastLinked}
          onReview={() => {
            reviewQueue.clearLastAdded();
            setShowNeedsReview(true);
          }}
          onDismiss={reviewQueue.clearLastAdded}
        />
      )}

      {/* BACKLOG-2792 P3 — the completeness gate. No bypass. */}
      {complete.blockedCount !== null && (
        <ReviewPromptDialog
          variant="blocked"
          count={complete.blockedCount}
          onReview={complete.reviewFromGate}
          onDismiss={complete.cancelGate}
        />
      )}

      {/* Submit for Review Modal (BACKLOG-391) */}
      {showSubmitModal && (
        <SubmitForReviewModal
          transaction={transaction}
          emailThreadCount={transaction.email_count || 0}
          textThreadCount={transaction.text_thread_count || 0}
          attachmentCount={dbAttachmentCounts.total}
          emailAttachmentCount={dbAttachmentCounts.emailAttachments}
          totalSizeBytes={dbAttachmentCounts.totalSizeBytes}
          isSubmitting={isSubmitting}
          progress={submitProgress}
          error={submitError}
          onCancel={() => {
            setShowSubmitModal(false);
            resetSubmit();
          }}
          onSubmit={handleSubmitForReview}
          // BACKLOG-2792: S4's Export option. The prop already existed and had
          // ZERO call sites; this is the founder's "the confirmation window
          // includes an Export option that triggers the same S3 export flow an
          // individual gets" — literally the same modal, not a parallel path.
          onExportFirst={() => {
            setShowSubmitModal(false);
            setShowExportModal(true);
          }}
        />
      )}
    </ResponsiveModal>
  );
}

export default TransactionDetails;
