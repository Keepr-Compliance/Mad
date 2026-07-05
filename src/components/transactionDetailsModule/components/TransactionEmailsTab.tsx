/**
 * TransactionEmailsTab Component
 * TASK-1183: Emails tab content showing email threads linked to a transaction.
 * Now displays emails grouped into conversation threads for a natural viewing experience.
 * Moved from TransactionDetailsTab as part of TASK-1152.
 */
import React, { useState, useCallback, useMemo } from "react";
import type { Communication } from "../types";
import { useAuth } from "../../../contexts";
import { AttachEmailsModal } from "./modals";
import {
  EmailThreadCard,
  processEmailThreads,
  type EmailThread,
} from "./EmailThreadCard";
import { RemovedEmailsSection } from "./RemovedEmailsSection";
import { BulkSelectionBar, BulkRemoveConfirmModal } from "./BulkSelectionBar";
import { useContactNameMap } from "../../../hooks/useContactNameMap";
import { useSelection } from "../../../hooks/useSelection";

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
  /** Toast handler for success messages */
  onShowSuccess?: (message: string) => void;
  /** Toast handler for error messages */
  onShowError?: (message: string) => void;
  /** Audit period start date (ISO string) for email date filtering */
  auditStartDate?: string;
  /** Audit period end date (ISO string) for email date filtering */
  auditEndDate?: string;
  /** BACKLOG-1364: Whether address filtering is currently skipped */
  skipAddressFilter?: boolean;
  /** BACKLOG-1364: Callback to toggle the address filter */
  onToggleAddressFilter?: (skipFilter: boolean) => Promise<void>;
  /** BACKLOG-1364: Message from auto-link when filter is ON and no results */
  addressFilterMessage?: string;
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
  skipAddressFilter = false,
  onToggleAddressFilter,
  addressFilterMessage,
}: TransactionEmailsTabProps): React.ReactElement {
  const { currentUser } = useAuth();
  const [showAttachModal, setShowAttachModal] = useState(false);
  const [togglingFilter, setTogglingFilter] = useState(false);
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

  const [showFilterInfo, setShowFilterInfo] = useState(false);

  // Handle attach button click
  const handleAttachClick = useCallback(() => {
    setShowAttachModal(true);
  }, []);

  // Handle emails attached successfully
  const handleAttached = useCallback(() => {
    onEmailsChanged?.();
    onShowSuccess?.("Emails attached successfully");
  }, [onEmailsChanged, onShowSuccess]);

  // BACKLOG-1364: Handle address filter toggle
  const handleToggleAddressFilter = useCallback(async () => {
    if (!onToggleAddressFilter || togglingFilter) return;
    setTogglingFilter(true);
    try {
      await onToggleAddressFilter(!skipAddressFilter);
    } finally {
      setTogglingFilter(false);
    }
  }, [onToggleAddressFilter, skipAddressFilter, togglingFilter]);

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

  // BACKLOG-1719: selection-mode entry/exit (matches the transaction window).
  const handleToggleSelectionMode = useCallback(() => {
    setSelectionMode((prev) => {
      if (prev) deselectAllThreads();
      return !prev;
    });
  }, [deselectAllThreads]);

  const handleSelectAll = useCallback(() => {
    selectAllThreads(emailThreads);
  }, [selectAllThreads, emailThreads]);

  // Threads currently selected (for confirm counts + the bulk unlink loop).
  const selectedThreads = useMemo(
    () => emailThreads.filter((t) => selectedThreadIds.has(t.id)),
    [emailThreads, selectedThreadIds]
  );
  const selectedEmailCount = useMemo(
    () => selectedThreads.reduce((sum, t) => sum + t.emailCount, 0),
    [selectedThreads]
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
      onShowSuccess?.(n > 1 ? `${n} emails removed` : "Email removed from transaction");
      // Refresh the removed-emails count in place.
      setLocalRemovedBump((b) => b + 1);
    } finally {
      setIsBulkRemoving(false);
      setShowBulkRemoveConfirm(false);
      deselectAllThreads();
      setSelectionMode(false);
    }
  }, [selectedThreads, selectedEmailCount, onRemoveEmailsByIds, onEmailsChanged, onShowSuccess, deselectAllThreads]);

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
        {/* BACKLOG-1364: Address filter toggle — above empty state */}
        {onToggleAddressFilter && hasContacts && (
          <div className="flex items-center justify-between bg-gray-50 rounded-lg px-4 py-2.5 mb-4">
            <span className="text-sm text-gray-700 flex items-center gap-1.5">
              <button type="button" onClick={() => setShowFilterInfo(!showFilterInfo)} className="w-5 h-5 rounded-full bg-blue-100 text-blue-600 text-xs font-bold flex items-center justify-center hover:bg-blue-200 transition-colors" title="When ON, only emails mentioning the property address are linked. When OFF, all emails from assigned contacts are included.">i</button>
              <span className="hidden sm:inline">Filter by property address</span>
              <span className="sm:hidden">Address filter</span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={!skipAddressFilter}
              onClick={handleToggleAddressFilter}
              disabled={togglingFilter}
              className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed ${
                !skipAddressFilter ? "bg-blue-600" : "bg-gray-300"
              }`}
              data-testid="address-filter-toggle"
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                  !skipAddressFilter ? "translate-x-4" : "translate-x-0"
                }`}
              />
            </button>
          </div>
        )}

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
            {addressFilterMessage
              ? addressFilterMessage
              : hasContacts
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

      {/* BACKLOG-1719 (founder design): Select entry sits to the LEFT of the
          "Filter by property address" control on the SAME row. The icon matches
          the transaction-window Edit/bulk-edit button (clipboard-check, w-5,
          strokeWidth 2). Kept identical to the Texts tab. */}
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

        {/* BACKLOG-1364: Address filter toggle — right of Select, same row */}
        {onToggleAddressFilter && hasContacts && (
          <div className="flex-1 flex items-center justify-between bg-gray-50 rounded-lg px-4 py-2.5">
            <span className="text-sm text-gray-700 flex items-center gap-1.5">
              <button type="button" onClick={() => setShowFilterInfo(!showFilterInfo)} className="w-5 h-5 rounded-full bg-blue-100 text-blue-600 text-xs font-bold flex items-center justify-center hover:bg-blue-200 transition-colors" title="When ON, only emails mentioning the property address are linked. When OFF, all emails from assigned contacts are included.">i</button>
              <span className="hidden sm:inline">Filter by property address</span>
              <span className="sm:hidden">Address filter</span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={!skipAddressFilter}
              onClick={handleToggleAddressFilter}
              disabled={togglingFilter}
              className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed ${
                !skipAddressFilter ? "bg-blue-600" : "bg-gray-300"
              }`}
              data-testid="address-filter-toggle"
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                  !skipAddressFilter ? "translate-x-4" : "translate-x-0"
                }`}
              />
            </button>
          </div>
        )}
      </div>

      {/* Email thread list */}
      <div className="space-y-3">
        {emailThreads.map((thread) => (
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
          totalCount={emailThreads.length}
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
