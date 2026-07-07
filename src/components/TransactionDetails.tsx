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
import { ToastContainer } from "./Toast";
import { useToast } from "../hooks/useToast";
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
  useTransactionAttachments,
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
import { useSubmitForReview } from "./transactionDetailsModule/hooks/useSubmitForReview";
import type { AutoLinkResult } from "./transactionDetailsModule/components/modals/EditContactsModal";

import type { TransactionTab, HighlightTarget } from "./transactionDetailsModule/types";
import type { EmailThread } from "./transactionDetailsModule/components/EmailThreadCard";
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
  /** Toast handler for success messages - if provided, uses parent's toast system */
  onShowSuccess?: (message: string) => void;
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

  // Toast notifications - use props if provided, otherwise use local fallback
  const localToast = useToast();
  const showSuccess = onShowSuccess || localToast.showSuccess;
  const showError = onShowError || localToast.showError;
  // TASK-2070: Warning toast for provider errors (always local -- no parent prop for warnings)
  const showWarning = localToast.showWarning;

  // Transaction data hook
  const {
    communications,
    contactAssignments,
    resolvedSuggestions,
    loading,
    loadDetails,
    loadCommunications,
    refreshCommunicationsSilently,
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
  // Reset loaded channels and any stale highlight target when transaction changes.
  // BACKLOG-1876: skip the highlight reset on the FIRST run so a seeded
  // `initialHighlight` (opened from a global search hit) survives mount. The
  // channel cache clear stays UNCONDITIONAL.
  const didMountRef = React.useRef(false);
  useEffect(() => {
    loadedChannelsRef.current.clear();
    if (didMountRef.current) {
      setHighlightTarget(null);
    } else {
      didMountRef.current = true;
    }
  }, [transaction.id]);

  useEffect(() => {
    if (activeTab === "emails" && !loadedChannelsRef.current.has("email")) {
      loadedChannelsRef.current.add("email");
      loadCommunications("email");
    } else if (activeTab === "messages" && !loadedChannelsRef.current.has("text")) {
      loadedChannelsRef.current.add("text");
      loadCommunications("text");
    } else if (activeTab === "attachments" && !loadedChannelsRef.current.has("email")) {
      // Attachments come from emails
      loadedChannelsRef.current.add("email");
      loadCommunications("email");
    }
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

  // Refresh messages by reloading text communications from the parent state.
  // This ensures derivedMessages (from useTransactionMessages) updates correctly,
  // unlike the local refresh which updates fetchedMessages but gets overridden
  // by the non-null derivedMessages. (TASK-2023)
  const refreshMessages = useCallback(async () => {
    await loadCommunications("text");
  }, [loadCommunications]);

  // Attachments hook — uses pre-loaded communications to avoid duplicate getDetails call
  const {
    attachments,
    loading: attachmentsLoading,
    error: attachmentsError,
    count: attachmentCount,
  } = useTransactionAttachments(transaction, communications);

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
  // BACKLOG-1832: true while the background create-trigger sync is in flight for THIS transaction.
  // Drives the "fetching emails…" indicator on the empty emails tab.
  const [autoSyncRunning, setAutoSyncRunning] = useState<boolean>(false);

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

  // BACKLOG-1364: Derive address filter message — shown when filter is ON, no emails linked, and contacts exist
  const addressFilterMessage = useMemo(() => {
    if (
      transaction.skip_address_filter !== 1 &&
      transaction.property_address &&
      emailCommunications.length === 0 &&
      contactAssignments.length > 0 &&
      !loading
    ) {
      return "No emails found matching the property address. Turn off the address filter to widen the search.";
    }
    return undefined;
  }, [transaction.skip_address_filter, transaction.property_address, emailCommunications.length, contactAssignments.length, loading]);

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
          showSuccess(n > 1 ? `${n} emails removed` : "Email unlinked from transaction");
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
    [showUnlinkThread, handleUnlinkCommunication, removeCommunicationsByIds, loadCommunications, showSuccess, showError]
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
  }, [loadDetails]);

  // BACKLOG-1780: silent communications refresh for the restore-removed path.
  // No loading flag, no spinner, no unmount — React reconciles keyed rows in place.
  const handleRefreshEmailsSilently = useCallback(async () => {
    await refreshCommunicationsSilently("email");
  }, [refreshCommunicationsSilently]);

  // BACKLOG-1793: silent text-communications refresh for the restore-removed
  // path on the Messages tab — mirrors handleRefreshEmailsSilently so a restored
  // conversation reappears in place without a loading cycle or scroll jump.
  const handleRefreshMessagesSilently = useCallback(async () => {
    await refreshCommunicationsSilently("text");
  }, [refreshCommunicationsSilently]);

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
          message?: string;
          error?: string;
        }>;
      }).resyncAutoLink(transaction.id);

      if (result.success) {
        const messagesLinked = result.totalMessagesLinked || 0;
        const alreadyLinked = result.totalAlreadyLinked || 0;

        if (messagesLinked > 0) {
          showSuccess(`${messagesLinked} message thread${messagesLinked !== 1 ? "s" : ""} linked`);
          refreshMessages();
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

  // BACKLOG-1364: Handle address filter toggle
  const handleToggleAddressFilter = useCallback(async (skipFilter: boolean) => {
    try {
      const result = await window.api.transactions.updateAddressFilter(transaction.id, skipFilter);

      if (result.success) {
        // Update local transaction state to reflect the new toggle value
        setTransaction(prev => ({ ...prev, skip_address_filter: skipFilter ? 1 : 0 }));

        const totalLinked = (result.totalEmailsLinked || 0) + (result.totalMessagesLinked || 0);
        if (totalLinked > 0) {
          showSuccess(
            `Address filter ${skipFilter ? "off" : "on"}. ${totalLinked} new email${totalLinked !== 1 ? "s" : ""} linked.`
          );
          loadDetails();
          // Reload email communications
          loadCommunications("email");
        } else {
          showSuccess(`Address filter ${skipFilter ? "off" : "on"}. No new emails to link.`);
        }
        onTransactionUpdated?.();
      } else {
        showError("Failed to update address filter");
      }
    } catch (err) {
      logger.error("Failed to toggle address filter:", err);
      showError("Failed to update address filter. Please try again.");
    }
  }, [transaction.id, showSuccess, showError, loadDetails, loadCommunications, onTransactionUpdated]);

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
    <ResponsiveModal onClose={onClose} zIndex="z-[60]" panelClassName={MODAL_PANEL.lg}>
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
          onShowSubmitModal={async () => {
            try {
              const refreshed = await transactionService.getDetails(transaction.id);
              if (refreshed.success && refreshed.data) {
                setTransaction(refreshed.data);
              }
            } catch (err) {
              logger.error("Failed to refresh transaction before submit:", err);
            }
            // Load attachment counts now (deferred from mount for perf)
            loadAttachmentCounts();
            setShowSubmitModal(true);
          }}
        />

        {/* Tabs */}
        <TransactionTabs
          activeTab={activeTab}
          conversationCount={transaction.text_thread_count || 0}
          emailCount={transaction.email_count || 0}
          attachmentCount={attachmentCount}
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
            />
          )}

          {activeTab === "emails" && (
            <TransactionEmailsTab
              communications={emailCommunications}
              loading={loading || (autoSyncRunning && emailCommunications.length === 0)}
              unlinkingCommId={unlinkingCommId}
              onViewEmail={setViewingEmail}
              onShowUnlinkConfirm={setShowUnlinkConfirm}
              onShowUnlinkThread={handleShowUnlinkThread}
              removedSectionRefreshKey={removedRefreshKey}
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
              auditStartDate={transaction.started_at ? String(transaction.started_at) : undefined}
              auditEndDate={transaction.closed_at ? String(transaction.closed_at) : undefined}
              skipAddressFilter={transaction.skip_address_filter === 1}
              onToggleAddressFilter={handleToggleAddressFilter}
              addressFilterMessage={addressFilterMessage}
              // BACKLOG-1869: scroll+highlight the card matching the search result.
              highlightTarget={highlightTarget}
              onHighlightConsumed={clearHighlightTarget}
            />
          )}


          {activeTab === "messages" && (
            <TransactionMessagesTab
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
              isOnline={isOnline}
              hasContacts={contactAssignments.length > 0}
              // BACKLOG-1869: scroll+highlight the card matching the search result.
              highlightTarget={highlightTarget}
              onHighlightConsumed={clearHighlightTarget}
            />
          )}

          {activeTab === "attachments" && (
            <TransactionAttachmentsTab
              attachments={attachments}
              loading={attachmentsLoading}
              error={attachmentsError}
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
          onSave={(autoLinkResults?: AutoLinkResult[]) => {
            loadDetails();
            onTransactionUpdated?.();
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
            } else {
              showSuccess("Contacts updated successfully");
            }
          }}
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
        />
      )}

      {/* Toast Notifications - render if using local toast, or if local toasts exist (TASK-2070: warnings always use local) */}
      {(!onShowSuccess && !onShowError || localToast.toasts.length > 0) && (
        <ToastContainer toasts={localToast.toasts} onDismiss={localToast.removeToast} />
      )}
    </ResponsiveModal>
  );
}

export default TransactionDetails;
