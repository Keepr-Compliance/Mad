import React, { useState, useEffect, useRef } from "react";
import type { Transaction, OAuthProvider } from "@/types";
import type { TransactionTab, HighlightTarget } from "./transactionDetailsModule/types";
import type { GlobalTransactionAttribution } from "@electron/types/ipc/window-api-transactions";
import { LinkedContentSearch } from "./transactionDetailsModule/components";
import AuditTransactionModal from "./AuditTransactionModal";
import ExportModal from "./ExportModal";
import TransactionDetails from "./TransactionDetails";
import {
  BulkActionBar,
  BulkDeleteConfirmModal,
  BulkExportModal,
} from "./BulkActionBar";
import { ToastContainer } from "./Toast";
import { useSelection } from "../hooks/useSelection";
import { useToast } from "../hooks/useToast";
import { useAppStateMachine } from "../appCore";
import {
  // Components
  TransactionToolbar,
  TransactionMobileCard,
  // Hooks
  useTransactionList,
  useTransactionScan,
  useBulkActions,
  // Types
  type TransactionFilter,
} from "./transaction";
import { OfflineNotice } from "./common/OfflineNotice";
import { formatDate } from "../utils/formatUtils";

interface TransactionListComponentProps {
  userId: string;
  provider: OAuthProvider;
  onClose: () => void;
  initialTransaction?: Transaction | null;
  /**
   * BACKLOG-1898 T5: id of a transaction to auto-open once the list has loaded.
   * Used when opening a transaction from the Contacts detail card (which only
   * has the id, not the full row). Resolved against the loaded transactions and
   * opened on the overview tab (same open behaviour as openTransactionFromSearch,
   * including the BACKLOG-1888 remount bump). The open is latched per-id so a
   * later transactions refetch does not re-open a detail the user has closed.
   */
  initialTransactionId?: string | null;
}

/**
 * TransactionList Component
 * Main transaction management interface
 * Lists transactions, triggers scans, shows progress
 */
function TransactionList({
  userId,
  provider,
  onClose,
  initialTransaction,
  initialTransactionId,
}: TransactionListComponentProps) {
  // Database initialization guard (belt-and-suspenders defense)
  const { isDatabaseInitialized } = useAppStateMachine();

  // UI state for filter. BACKLOG-1876: the address-only search box was replaced
  // by the global LinkedContentSearch box below, so there is no `searchQuery`
  // state here anymore.
  const [filter, setFilter] = useState<TransactionFilter>(() => {
    const params = new URLSearchParams(window.location.search);
    const urlFilter = params.get("filter");
    if (
      urlFilter === "pending" ||
      urlFilter === "active" ||
      urlFilter === "closed" ||
      urlFilter === "rejected"
    ) {
      return urlFilter;
    }
    return "all";
  });

  // Transaction data management via hook. BACKLOG-1876: address filtering is
  // disabled here — the global search box handles content discovery.
  const {
    transactions,
    filteredTransactions,
    loading,
    error,
    filterCounts,
    refetch: loadTransactions,
    setError,
  } = useTransactionList(userId, filter, "", { disableAddressFilter: true });

  // Scan functionality via hook
  const { scanning, scanProgress, startScan, stopScan } = useTransactionScan(
    userId,
    loadTransactions,
    setError
  );

  // Modal state
  const [selectedTransaction, setSelectedTransaction] =
    useState<Transaction | null>(null);
  const [pendingReviewTransaction, setPendingReviewTransaction] =
    useState<Transaction | null>(null);
  const [showAuditCreate, setShowAuditCreate] = useState<boolean>(false);
  const [quickExportTransaction, setQuickExportTransaction] =
    useState<Transaction | null>(null);
  const [quickExportSuccess, setQuickExportSuccess] = useState<string | null>(
    null,
  );

  // Initial tab state for TransactionDetails
  const [initialTab, setInitialTab] = useState<TransactionTab>("overview");
  // BACKLOG-1876: highlight to seed when opening a transaction from a global
  // email/text search hit (deep-navigates the BACKLOG-1869 viewer). Reset to
  // null on every normal row-open so it never leaks between openings.
  const [initialHighlight, setInitialHighlight] = useState<HighlightTarget | null>(
    null,
  );
  // BACKLOG-1888: monotonic counter incremented on every global-search open so the
  // `key` on TransactionDetails changes, forcing a full remount and guaranteeing
  // useState(initialHighlight) / useState(initialTab) re-seed with fresh values.
  // Without this, a cross-transaction navigation (modal already mounted) keeps the
  // old highlightTarget because useState only captures on first mount.
  const [searchOpenKey, setSearchOpenKey] = useState(0);

  // Auto-open transaction details when initialTransaction is provided (e.g., after creating a new audit)
  useEffect(() => {
    if (initialTransaction) {
      setSelectedTransaction(initialTransaction);
    }
  }, [initialTransaction]);

  // BACKLOG-1898 T5: auto-open a transaction by id (from the Contacts detail
  // card). We only have the id, so resolve it against the loaded rows once they
  // are available, then open the detail on the overview tab.
  //
  // Latch which id we've already auto-opened so a later `transactions` refetch
  // (scan complete / transaction update / bulk action) does NOT re-open the
  // detail after the user has closed it. A genuinely new id (the prop changing)
  // resets the latch and opens again. Effect-Safety Pattern 1 (value latch, not
  // a didMount guard).
  const openedTransactionIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialTransactionId) {
      // Prop cleared (Transactions view closed) — reset so the same id can be
      // re-opened next time it is requested.
      openedTransactionIdRef.current = null;
      return;
    }
    if (openedTransactionIdRef.current === initialTransactionId) return;
    const txn = transactions.find((t) => t.id === initialTransactionId);
    if (!txn) return;
    openedTransactionIdRef.current = initialTransactionId;
    setInitialTab("overview");
    setInitialHighlight(null);
    setSearchOpenKey((k) => k + 1);
    setSelectedTransaction(txn);
  }, [initialTransactionId, transactions]);

  // Selection state for bulk operations
  const {
    selectedIds,
    toggleSelection,
    selectAll,
    deselectAll,
    isSelected,
    count: selectedCount,
  } = useSelection();

  // Bulk action UI state
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const [showBulkExportModal, setShowBulkExportModal] = useState(false);
  const [showStatusInfo, setShowStatusInfo] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);

  // Bulk action handlers via hook
  const handleExitSelectionMode = () => {
    deselectAll();
    setSelectionMode(false);
  };

  const {
    isBulkDeleting,
    isBulkExporting,
    isBulkUpdating,
    bulkActionSuccess,
    handleBulkDelete,
    handleBulkExport,
    handleBulkStatusChange,
  } = useBulkActions(selectedIds, selectedCount, {
    onComplete: loadTransactions,
    showError: setError,
    exitSelectionMode: handleExitSelectionMode,
    closeBulkDeleteModal: () => setShowBulkDeleteConfirm(false),
    closeBulkExportModal: () => setShowBulkExportModal(false),
  });

  // Toast notifications - lifted from TransactionDetails so toasts persist after modal close
  const { toasts, showSuccess, showError, removeToast } = useToast();

  // Sync filter to URL params
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (filter === "all") {
      params.delete("filter");
    } else {
      params.set("filter", filter);
    }
    const newUrl = params.toString()
      ? `${window.location.pathname}?${params.toString()}`
      : window.location.pathname;
    window.history.replaceState({}, "", newUrl);
  }, [filter]);

  // DEFENSIVE CHECK: Return loading state if database not initialized
  // Should never trigger if AppShell gate works, but prevents errors if bypassed
  if (!isDatabaseInitialized) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50 flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-2"></div>
          <p className="text-gray-500 text-sm">Waiting for database...</p>
        </div>
      </div>
    );
  }


  const handleQuickExportComplete = (result: unknown): void => {
    const exportResult = result as { path?: string };
    setQuickExportTransaction(null);
    setQuickExportSuccess(
      exportResult.path || "Export completed successfully!",
    );
    // Auto-hide success message after 5 seconds
    setTimeout(() => setQuickExportSuccess(null), 5000);
    // Reload transactions to update export status
    loadTransactions();
  };

  // Toggle bulk edit mode
  const handleToggleBulkEdit = (): void => {
    if (selectionMode) {
      deselectAll();
      setSelectionMode(false);
    } else {
      setSelectionMode(true);
    }
  };

  // Handle transaction card click (either select or open details)
  const handleTransactionClick = (transaction: Transaction): void => {
    if (selectionMode) {
      toggleSelection(transaction.id);
    } else if (transaction.detection_status === "pending" || transaction.status === "pending") {
      // Pending transactions open in review mode with approve/reject/edit buttons
      setInitialTab("overview");
      setInitialHighlight(null);
      setPendingReviewTransaction(transaction);
    } else {
      setInitialTab("overview");
      setInitialHighlight(null);
      setSelectedTransaction(transaction);
    }
  };

  // BACKLOG-1876: open a transaction from a global search hit. The full
  // Transaction row is already loaded (getAll), so look it up by id and open the
  // details modal on the right tab, optionally seeding a viewer highlight.
  // BACKLOG-1888: increment searchOpenKey so TransactionDetails receives a new
  // `key` prop on every search navigation, forcing a full remount and guaranteeing
  // useState(initialHighlight) picks up the new seed value.
  const openTransactionFromSearch = (
    transactionId: string,
    tab: TransactionTab,
    highlight: HighlightTarget | null,
  ): void => {
    const txn = transactions.find((t) => t.id === transactionId);
    if (!txn) return;
    setInitialTab(tab);
    setInitialHighlight(highlight);
    setSearchOpenKey((k) => k + 1);
    setSelectedTransaction(txn);
  };

  const handleSearchNavigateTransaction = (transactionId: string): void => {
    openTransactionFromSearch(transactionId, "overview", null);
  };

  const handleSearchNavigateContact = (
    _contactId: string,
    attribution?: GlobalTransactionAttribution | null,
  ): void => {
    // P1: contact hits open their owning transaction's overview. Unattached
    // contacts (no attribution) are inert.
    if (attribution) {
      openTransactionFromSearch(attribution.transactionId, "overview", null);
    }
  };

  const handleSearchNavigateEmail = (
    emailId: string,
    attribution?: GlobalTransactionAttribution | null,
  ): void => {
    if (attribution) {
      openTransactionFromSearch(attribution.transactionId, "emails", {
        type: "email",
        emailId,
      });
    }
  };

  const handleSearchNavigateText = (
    textId: string,
    attribution?: GlobalTransactionAttribution | null,
  ): void => {
    if (attribution) {
      openTransactionFromSearch(attribution.transactionId, "messages", {
        type: "text",
        communicationId: textId,
      });
    }
  };

  // Handle checkbox click separately to prevent event bubbling
  const handleCheckboxClick = (e: React.MouseEvent, transactionId: string): void => {
    e.stopPropagation();
    toggleSelection(transactionId);
  };

  // Handle select all for filtered transactions
  const handleSelectAll = (): void => {
    selectAll(filteredTransactions);
  };

  return (
    <div className="h-screen bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50 flex flex-col overflow-hidden">
      {/* Header and Toolbar */}
      <TransactionToolbar
        transactionCount={transactions.length}
        onClose={onClose}
        filter={filter}
        onFilterChange={setFilter}
        filterCounts={filterCounts}
        scanning={scanning}
        scanProgress={scanProgress}
        onStartScan={startScan}
        onStopScan={stopScan}
        selectionMode={selectionMode}
        onToggleSelectionMode={handleToggleBulkEdit}
        showStatusInfo={showStatusInfo}
        onToggleStatusInfo={() => setShowStatusInfo(!showStatusInfo)}
        onNewTransaction={() => setShowAuditCreate(true)}
        error={error}
        quickExportSuccess={quickExportSuccess}
        bulkActionSuccess={bulkActionSuccess}
      />

      <OfflineNotice />

      {/* Transactions List */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 sm:p-6 max-w-7xl mx-auto w-full">
        {/* BACKLOG-1876: global search across all transactions, contacts, emails,
            and texts. Replaces the old address-only toolbar filter. */}
        <LinkedContentSearch
          scope={{ type: "global", userId }}
          onNavigateTransaction={handleSearchNavigateTransaction}
          onNavigateContact={handleSearchNavigateContact}
          onNavigateEmail={handleSearchNavigateEmail}
          onNavigateText={handleSearchNavigateText}
        />

        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <div className="w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
              <p className="text-gray-600">Loading transactions...</p>
            </div>
          </div>
        ) : filteredTransactions.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center max-w-md px-4">
              <svg
                className="w-12 h-12 sm:w-16 sm:h-16 text-gray-300 mx-auto mb-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
              <h3 className="text-base sm:text-lg font-semibold text-gray-900 mb-2">
                No transactions yet
              </h3>
              <button
                onClick={() => setShowAuditCreate(true)}
                className="px-4 py-2 h-10 rounded-lg font-semibold transition-all bg-green-500 text-white hover:bg-green-600 shadow-md hover:shadow-lg flex items-center gap-2 text-sm whitespace-nowrap mx-auto"
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                  />
                </svg>
                New Transaction
              </button>
            </div>
          </div>
        ) : (
          <div className="grid gap-3">
            {filteredTransactions.map((transaction) => (
              <TransactionMobileCard
                key={transaction.id}
                transaction={transaction}
                selectionMode={selectionMode}
                isSelected={isSelected(transaction.id)}
                onTransactionClick={() => handleTransactionClick(transaction)}
                onCheckboxClick={(e) => handleCheckboxClick(e, transaction.id)}
                formatDate={formatDate}
              />
            ))}
          </div>
        )}
      </div>

      {/* Transaction Details Modal (regular) */}
      {/* BACKLOG-1888: key={searchOpenKey} forces a full remount on every global-search
          navigation so useState(initialHighlight) / useState(initialTab) re-seed with
          the new values. Without the key, a cross-transaction search hit re-renders the
          already-mounted component and the stale highlightTarget is never updated. */}
      {selectedTransaction && (
        <TransactionDetails
          key={searchOpenKey}
          transaction={selectedTransaction}
          onClose={() => setSelectedTransaction(null)}
          onTransactionUpdated={loadTransactions}
          userId={userId}
          onShowSuccess={showSuccess}
          onShowError={showError}
          initialTab={initialTab}
          initialHighlight={initialHighlight}
        />
      )}

      {/* Transaction Details Modal (pending review mode) */}
      {pendingReviewTransaction && (
        <TransactionDetails
          transaction={pendingReviewTransaction}
          onClose={() => setPendingReviewTransaction(null)}
          onTransactionUpdated={loadTransactions}
          isPendingReview={true}
          userId={userId}
          onShowSuccess={showSuccess}
          onShowError={showError}
          initialTab={initialTab}
        />
      )}

      {/* Audit Transaction Creation Modal */}
      {showAuditCreate && (
        <AuditTransactionModal
          userId={userId}
          provider={provider}
          onClose={() => setShowAuditCreate(false)}
          onSuccess={(transaction: Transaction) => {
            setShowAuditCreate(false);
            setSelectedTransaction(transaction);
            loadTransactions();
          }}
        />
      )}

      {/* Quick Export Modal */}
      {quickExportTransaction && (
        <ExportModal
          transaction={quickExportTransaction}
          userId={quickExportTransaction.user_id}
          onClose={() => setQuickExportTransaction(null)}
          onExportComplete={handleQuickExportComplete}
        />
      )}

      {/* Bulk Action Bar */}
      {selectionMode && (
        <BulkActionBar
          selectedCount={selectedCount}
          totalCount={filteredTransactions.length}
          onSelectAll={handleSelectAll}
          onDeselectAll={deselectAll}
          onBulkDelete={() => setShowBulkDeleteConfirm(true)}
          onBulkExport={() => setShowBulkExportModal(true)}
          onBulkStatusChange={handleBulkStatusChange}
          onClose={handleToggleBulkEdit}
          isDeleting={isBulkDeleting}
          isExporting={isBulkExporting}
          isUpdating={isBulkUpdating}
          selectedTransactions={filteredTransactions.filter((t) =>
            selectedIds.has(t.id)
          )}
        />
      )}

      {/* Bulk Delete Confirmation Modal */}
      {showBulkDeleteConfirm && (
        <BulkDeleteConfirmModal
          selectedCount={selectedCount}
          onConfirm={handleBulkDelete}
          onCancel={() => setShowBulkDeleteConfirm(false)}
          isDeleting={isBulkDeleting}
        />
      )}

      {/* Bulk Export Modal */}
      {showBulkExportModal && (
        <BulkExportModal
          selectedCount={selectedCount}
          onConfirm={handleBulkExport}
          onCancel={() => setShowBulkExportModal(false)}
          isExporting={isBulkExporting}
        />
      )}

      {/* Toast Notifications - persists after modal close */}
      <ToastContainer toasts={toasts} onDismiss={removeToast} />
    </div>
  );
}

export default TransactionList;
