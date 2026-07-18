/**
 * Transactions Component
 * Main transaction management interface for Keepr
 *
 * This component serves as the coordinator for transaction listing,
 * filtering, bulk operations, and navigation to detail views.
 *
 * Extracted components:
 * - DetectionBadges (DetectionSourceBadge, ConfidencePill, PendingReviewBadge)
 * - TransactionDetails (modal for viewing/editing transaction details)
 * - EditTransactionModal (modal for editing transactions)
 *
 * State management via custom hooks:
 * - useTransactionList: transactions, loading, error, filtering
 * - useTransactionScan: scanning, scanProgress, startScan, stopScan
 * - useBulkActions: bulk delete/export/status change operations
 * - useTransactionModals: modal visibility and selected items
 */
import React, { useState, useCallback, useEffect } from "react";
import AuditTransactionModal from "./AuditTransactionModal";
import ExportModal from "./ExportModal";
import {
  BulkActionBar,
  BulkDeleteConfirmModal,
  BulkExportModal,
} from "./BulkActionBar";
import { BulkSubmitModal } from "./BulkSubmitModal";
import { useSelection } from "../hooks/useSelection";
import { useBulkSubmit } from "../hooks/useBulkSubmit";
import { useSubmissionSync } from "../hooks/useSubmissionSync";
import { useAppStateMachine } from "../appCore";
import { useToast } from "../hooks/useToast";
import { ToastContainer } from "./Toast";
import TransactionDetails from "./TransactionDetails";
import {
  TransactionsToolbar,
  TransactionMobileCard,
} from "./transaction";
import {
  useTransactionList,
  useTransactionScan,
  useBulkActions,
  useTransactionModals,
  type TransactionFilter,
} from "./transaction/hooks";
import type { Transaction } from "../../electron/types/models";
import type { TransactionTab } from "./transactionDetailsModule/types";
import { formatDate } from "../utils/formatUtils";
import { useUnlockedTransactionIds } from "../hooks/useUnlockedTransactionIds";

// ============================================
// TYPES
// ============================================

interface TransactionsProps {
  userId: string;
  provider?: string; // Optional - will auto-detect if not provided
  onClose: () => void;
}

// ============================================
// TRANSACTIONS COMPONENT
// ============================================

/**
 * Transactions Component
 * Main transaction management interface
 * Lists transactions, triggers scans, shows progress
 */
function Transactions({
  userId,
  provider,
  onClose,
}: TransactionsProps): React.ReactElement {
  // Database initialization guard (belt-and-suspenders defense)
  const { isDatabaseInitialized } = useAppStateMachine();

  // Toast notifications
  const { toasts, showSuccess, showError, removeToast } = useToast();

  // UI state (local to component)
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<"active" | "closed" | "all">(
    "active"
  );
  const [selectionMode, setSelectionMode] = useState(false);

  // BACKLOG-1106: Debounce search query (300ms) to prevent filtering on every keystroke
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Map component's statusFilter to TransactionFilter type
  // The useTransactionList hook uses TransactionFilter which includes "pending" and "rejected"
  // but this component only uses "active", "closed", "all"
  const transactionFilter: TransactionFilter = statusFilter;

  // Transaction list data and operations
  const {
    transactions,
    filteredTransactions,
    loading,
    error,
    refetch,
    setError,
  } = useTransactionList(userId, transactionFilter, debouncedSearchQuery);

  // Scan operations
  const { scanning, scanProgress, startScan, stopScan } = useTransactionScan(
    userId,
    refetch,
    setError
  );

  // BACKLOG-2090: batch unlock status for the at-a-glance "Unlocked" badge.
  const { unlockedIds } = useUnlockedTransactionIds();

  // Submission sync - listens for status changes from cloud (BACKLOG-395)
  useSubmissionSync({
    onStatusChange: () => {
      // Refresh transaction list when status changes
      refetch();
    },
    showToasts: true,
  });

  // Modal states
  const {
    showAuditCreate,
    openAuditCreate,
    closeAuditCreate,
    quickExportTransaction,
    openQuickExport,
    closeQuickExport,
    quickExportSuccess,
    setQuickExportSuccess,
    showBulkDeleteConfirm,
    openBulkDeleteConfirm,
    closeBulkDeleteConfirm,
    showBulkExportModal,
    openBulkExportModal,
    closeBulkExportModal,
    selectedTransaction,
    setSelectedTransaction,
  } = useTransactionModals();

  // Initial tab state for TransactionDetails
  const [initialTab, setInitialTab] = useState<TransactionTab>("overview");

  // Selection state for bulk operations
  const {
    selectedIds,
    toggleSelection,
    selectAll,
    deselectAll,
    isSelected,
    count: selectedCount,
  } = useSelection();

  // Exit selection mode helper
  const exitSelectionMode = useCallback(() => {
    deselectAll();
    setSelectionMode(false);
  }, [deselectAll]);

  // Bulk actions (bulkActionSuccess auto-clears after 5 seconds)
  const {
    isBulkDeleting,
    isBulkExporting,
    isBulkUpdating,
    bulkActionSuccess,
    handleBulkDelete,
    handleBulkExport,
    handleBulkStatusChange,
  } = useBulkActions(selectedIds, selectedCount, {
    onComplete: refetch,
    showError: setError,
    exitSelectionMode,
    closeBulkDeleteModal: closeBulkDeleteConfirm,
    closeBulkExportModal,
  });

  // Bulk submit state (BACKLOG-392)
  const [showBulkSubmitModal, setShowBulkSubmitModal] = useState(false);
  const {
    isSubmitting: isBulkSubmitting,
    progress: bulkSubmitProgress,
    startBulkSubmit,
    cancelSubmission: cancelBulkSubmission,
    reset: resetBulkSubmit,
  } = useBulkSubmit();

  // Get transactions eligible for submission
  const getSubmittableTransactions = useCallback(() => {
    return filteredTransactions.filter((t) => {
      if (!selectedIds.has(t.id)) return false;
      const status = t.submission_status;
      return (
        status === undefined ||
        status === "not_submitted" ||
        status === "needs_changes" ||
        status === "rejected"
      );
    });
  }, [filteredTransactions, selectedIds]);

  // Handle opening bulk submit modal
  const handleOpenBulkSubmitModal = useCallback(() => {
    setShowBulkSubmitModal(true);
  }, []);

  // Handle closing bulk submit modal
  const handleCloseBulkSubmitModal = useCallback(() => {
    setShowBulkSubmitModal(false);
    resetBulkSubmit();
  }, [resetBulkSubmit]);

  // Handle bulk submit
  const handleBulkSubmit = useCallback(async () => {
    const submittable = getSubmittableTransactions();
    if (submittable.length === 0) return;

    await startBulkSubmit(submittable.map((t) => ({
      id: t.id,
      property_address: t.property_address,
      submission_status: t.submission_status,
      message_count: t.message_count,
      attachment_count: t.attachment_count,
    })));

    // Refresh transactions to get updated statuses
    await refetch();
  }, [getSubmittableTransactions, startBulkSubmit, refetch]);

  // Handle closing after completion
  const handleBulkSubmitComplete = useCallback(() => {
    handleCloseBulkSubmitModal();
    exitSelectionMode();
  }, [handleCloseBulkSubmitModal, exitSelectionMode]);

  // DEFENSIVE CHECK: Return loading state if database not initialized
  // Should never trigger if AppShell gate works, but prevents errors if bypassed
  if (!isDatabaseInitialized) {
    return (
      <div className="h-screen bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50 flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-2"></div>
          <p className="text-gray-500 text-sm">Waiting for database...</p>
        </div>
      </div>
    );
  }

  // ============================================
  // SELECTION HANDLERS
  // ============================================

  const handleToggleSelectionMode = () => {
    if (selectionMode) {
      deselectAll();
      setSelectionMode(false);
    } else {
      setSelectionMode(true);
    }
  };

  const handleCloseBulkEdit = () => {
    deselectAll();
    setSelectionMode(false);
  };

  const handleTransactionClick = (transaction: Transaction) => {
    if (selectionMode) {
      toggleSelection(transaction.id);
    } else {
      setInitialTab("overview");
      setSelectedTransaction(transaction);
    }
  };

  const handleCheckboxClick = (e: React.MouseEvent, transactionId: string) => {
    e.stopPropagation();
    toggleSelection(transactionId);
  };

  const handleSelectAll = () => {
    selectAll(filteredTransactions);
  };

  // ============================================
  // EXPORT HANDLERS
  // ============================================

  const handleQuickExportComplete = (result: unknown) => {
    const exportResult = result as { path?: string };
    closeQuickExport();
    setQuickExportSuccess(
      exportResult.path || "Export completed successfully!"
    );
    setTimeout(() => setQuickExportSuccess(null), 5000);
    refetch();
  };

  // ============================================
  // RENDER
  // ============================================

  return (
    <div className="h-screen bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 bg-gradient-to-r from-blue-500 to-purple-600 px-3 sm:px-6 py-4 sm:py-6 flex items-center justify-between shadow-lg">
        <button
          onClick={onClose}
          className="text-white hover:bg-white hover:bg-opacity-20 rounded-lg px-2 sm:px-4 py-2 transition-all flex items-center gap-1 sm:gap-2 font-medium text-sm sm:text-base"
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
              d="M10 19l-7-7m0 0l7-7m-7 7h18"
            />
          </svg>
          <span className="hidden sm:inline">Back to Dashboard</span>
          <span className="sm:hidden">Back</span>
        </button>
        <div className="text-right">
          <h2 className="text-lg sm:text-2xl font-bold text-white">Transactions</h2>
          <p className="text-blue-100 text-xs sm:text-sm">
            {transactions.length} properties found
          </p>
        </div>
      </div>

      {/* Toolbar */}
      <TransactionsToolbar
        transactionCount={transactions.length}
        transactions={transactions}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        selectionMode={selectionMode}
        onToggleSelectionMode={handleToggleSelectionMode}
        onNewTransaction={openAuditCreate}
        onStartScan={startScan}
        onStopScan={stopScan}
        scanning={scanning}
        scanProgress={scanProgress}
        error={error}
        quickExportSuccess={quickExportSuccess}
        bulkActionSuccess={bulkActionSuccess}
      />

      {/* Transactions List */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 sm:p-6 max-w-7xl mx-auto w-full">
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
                {searchQuery
                  ? "No matching transactions"
                  : "No transactions yet"}
              </h3>
              {searchQuery && (
                <p className="text-gray-600 mb-4 text-sm">Try adjusting your search</p>
              )}
              {!searchQuery && (
                <button
                  onClick={openAuditCreate}
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
              )}
            </div>
          </div>
        ) : (
          <div className="grid gap-3">
            {filteredTransactions.map((transaction: Transaction) => (
              <TransactionMobileCard
                key={transaction.id}
                transaction={transaction}
                selectionMode={selectionMode}
                isSelected={isSelected(transaction.id)}
                onTransactionClick={() => handleTransactionClick(transaction)}
                onCheckboxClick={(e) => handleCheckboxClick(e, transaction.id)}
                formatDate={formatDate}
                isUnlocked={unlockedIds.has(transaction.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Transaction Details Modal */}
      {selectedTransaction && (
        <TransactionDetails
          transaction={selectedTransaction}
          onClose={() => setSelectedTransaction(null)}
          onTransactionUpdated={refetch}
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
          onClose={closeAuditCreate}
          onSuccess={() => {
            closeAuditCreate();
            refetch();
          }}
        />
      )}

      {/* Quick Export Modal */}
      {quickExportTransaction && (
        <ExportModal
          transaction={quickExportTransaction}
          userId={quickExportTransaction.user_id}
          onClose={closeQuickExport}
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
          onBulkDelete={openBulkDeleteConfirm}
          onBulkExport={openBulkExportModal}
          onBulkStatusChange={handleBulkStatusChange}
          onBulkSubmit={handleOpenBulkSubmitModal}
          onClose={handleCloseBulkEdit}
          isDeleting={isBulkDeleting}
          isExporting={isBulkExporting}
          isUpdating={isBulkUpdating}
          isSubmitting={isBulkSubmitting}
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
          onCancel={closeBulkDeleteConfirm}
          isDeleting={isBulkDeleting}
        />
      )}

      {/* Bulk Export Modal */}
      {showBulkExportModal && (
        <BulkExportModal
          selectedCount={selectedCount}
          onConfirm={handleBulkExport}
          onCancel={closeBulkExportModal}
          isExporting={isBulkExporting}
        />
      )}

      {/* Bulk Submit Modal (BACKLOG-392) */}
      {showBulkSubmitModal && (
        <BulkSubmitModal
          transactions={getSubmittableTransactions().map((t) => ({
            id: t.id,
            property_address: t.property_address,
            submission_status: t.submission_status,
            message_count: t.message_count,
            attachment_count: t.attachment_count,
            email_count: t.email_count,
            text_count: t.text_count,
          }))}
          isSubmitting={isBulkSubmitting}
          progress={bulkSubmitProgress}
          onSubmit={handleBulkSubmit}
          onCancel={handleCloseBulkSubmitModal}
          onCancelRemaining={cancelBulkSubmission}
          onClose={handleBulkSubmitComplete}
        />
      )}

      {/* Toast Notifications */}
      <ToastContainer toasts={toasts} onDismiss={removeToast} />
    </div>
  );
}

export default Transactions;
