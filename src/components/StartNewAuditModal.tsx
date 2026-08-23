import React from "react";
import { ResponsiveModal } from "./common/ResponsiveModal";
import type { Transaction } from "../types";
import { usePendingTransactions } from "../hooks/usePendingTransactions";
import { FeatureGate } from "./common/FeatureGate";
import { AlertBanner, AlertIcons } from "./common/AlertBanner";
import { useLicense } from "../contexts/LicenseContext";
import { useFeatureGate } from "../hooks/useFeatureGate";
import { useNetwork } from "../contexts/NetworkContext";
import { OfflineNotice } from "./common/OfflineNotice";
import { formatDate as formatDateShared, formatCurrency as formatCurrencyShared } from "../utils/formatUtils";
// BACKLOG-2805: this row printed the RAW ENUM and leaned on CSS `capitalize`
// to make it look like a label, so it read "Purchase" while every other
// surface said "Listing/Purchase". No "Purchase" token on the line, which is
// why a text sweep never found it.
import { TRANSACTION_TYPE_LABELS } from "../constants/transactionTypes";

interface StartNewAuditModalProps {
  /** Callback when user wants to view pending transaction details */
  onSelectPendingTransaction: (transaction: Transaction) => void;
  /** Callback when user wants to view all active transactions */
  onViewActiveTransactions: () => void;
  /** Callback when user wants to create a new transaction manually */
  onCreateManually: () => void;
  /** Callback to close the modal */
  onClose: () => void;
  /** Callback to trigger a new sync */
  onSync?: () => void;
  /** Whether sync is currently in progress */
  isSyncing?: boolean;
}

/**
 * StartNewAuditModal Component
 *
 * Redesigned "Start New Audit" flow that emphasizes automated transaction detection.
 * Shows pending/AI-detected transactions first, with options to view active transactions
 * or create manually as secondary actions.
 *
 * Visual hierarchy:
 * 1. Pending transactions list (primary focus)
 * 2. Add Manually button
 * 3. View Active Transactions button
 */
function StartNewAuditModal({
  onSelectPendingTransaction,
  onViewActiveTransactions,
  onCreateManually,
  onClose,
  onSync,
  isSyncing = false,
}: StartNewAuditModalProps): React.ReactElement {
  const { pendingTransactions, isLoading, error, refetch } = usePendingTransactions();
  const { canCreateTransaction, transactionCount, transactionLimit } = useLicense();
  const { isAllowed } = useFeatureGate();
  const hasAIAddon = isAllowed("ai_detection");
  // TASK-2056: Disable sync button when offline
  const { isOnline } = useNetwork();

  const formatDate = (dateString: string | Date | null | undefined): string =>
    formatDateShared(dateString, { fallback: "", includeYear: false });

  const formatCurrency = (amount: number | null | undefined): string =>
    formatCurrencyShared(amount, "");

  return (
    <ResponsiveModal onClose={onClose} testId="start-new-audit-modal" panelClassName="max-w-2xl max-h-[85vh]">
        {/* Header */}
        <div className="flex-shrink-0 bg-gradient-to-r from-blue-500 to-indigo-600 px-6 py-4 flex items-center justify-between rounded-t-xl">
          <div>
            <h2 className="text-xl font-bold text-white">Start New Audit</h2>
            <p className="text-blue-100 text-sm">
              {hasAIAddon
                ? "Review AI-detected transactions or create one manually"
                : "Create a new transaction manually"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* Sync button - AI add-on only */}
            <FeatureGate requires="ai_addon">
              {onSync && (
                <button
                  onClick={() => {
                    onSync();
                    // Refetch pending transactions after sync starts
                    setTimeout(() => refetch(), 1000);
                  }}
                  disabled={isSyncing || !isOnline}
                  title={!isOnline ? "You are offline" : undefined}
                  className={`flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg transition-all ${
                    isSyncing || !isOnline
                      ? "bg-white bg-opacity-20 text-blue-100 cursor-not-allowed opacity-50"
                      : "bg-white bg-opacity-10 text-white hover:bg-white hover:bg-opacity-20"
                  }`}
                  aria-label={!isOnline ? "Sync now (offline)" : "Sync now"}
                >
                  <svg
                    className={`w-4 h-4 ${isSyncing ? "animate-spin" : ""}`}
                    style={isSyncing ? { animationDirection: "reverse" } : undefined}
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
                  {isSyncing ? "Syncing..." : "Sync Now"}
                </button>
              )}
            </FeatureGate>
            <button
              onClick={onClose}
              className="text-white hover:bg-white hover:bg-opacity-20 rounded-full p-1 transition-all"
              aria-label="Close modal"
            >
              <svg
                className="w-6 h-6"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        </div>

        <OfflineNotice />

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* Pending Transactions Section - AI add-on only */}
          <FeatureGate requires="ai_addon">
            <div className="mb-6">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-8 h-8 bg-indigo-100 rounded-full flex items-center justify-center">
                  <svg
                    className="w-4 h-4 text-indigo-600"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z"
                    />
                  </svg>
                </div>
                <h3 className="text-lg font-semibold text-gray-900">
                  AI-Detected Transactions
                </h3>
                {!isLoading && pendingTransactions.length > 0 && (
                  <span className="ml-auto px-2.5 py-0.5 bg-indigo-100 text-indigo-700 text-sm font-medium rounded-full">
                    {pendingTransactions.length} pending
                  </span>
                )}
              </div>

              {/* Loading State */}
              {isLoading && (
                <div className="flex items-center justify-center py-8">
                  <div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
                </div>
              )}

              {/* Error State */}
              {error && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4">
                  <p className="text-sm text-red-800">{error}</p>
                </div>
              )}

              {/* Pending Transactions List */}
              {!isLoading && !error && pendingTransactions.length > 0 && (
                <div className="space-y-3">
                  {pendingTransactions.map((transaction) => (
                    <button
                      key={transaction.id}
                      onClick={() => onSelectPendingTransaction(transaction)}
                      className="w-full text-left bg-gradient-to-r from-indigo-50 to-purple-50 border border-indigo-200 rounded-lg p-4 hover:border-indigo-400 hover:shadow-md transition-all group"
                      data-testid={`pending-transaction-${transaction.id}`}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <h4 className="font-semibold text-gray-900 truncate">
                            {transaction.property_address || "Unknown Address"}
                          </h4>
                          <div className="flex items-center gap-3 mt-1 text-sm text-gray-600">
                            {transaction.transaction_type && (
                              // `capitalize` is kept for the FALLBACK path: a
                              // type with no label still renders the raw enum
                              // and should still look like a word. Mapped
                              // labels are already correctly cased, so the
                              // class is a no-op for them.
                              <span className="capitalize">
                                {TRANSACTION_TYPE_LABELS[
                                  transaction.transaction_type as keyof typeof TRANSACTION_TYPE_LABELS
                                ] ?? transaction.transaction_type}
                              </span>
                            )}
                            {transaction.listing_price && (
                              <span>{formatCurrency(transaction.listing_price)}</span>
                            )}
                            {transaction.created_at && (
                              <span>
                                Detected {formatDate(transaction.created_at)}
                              </span>
                            )}
                          </div>
                          {transaction.detection_confidence && (
                            <div className="mt-2 flex items-center gap-2">
                              <div className="flex-1 max-w-24 bg-gray-200 rounded-full h-1.5">
                                <div
                                  className="bg-indigo-500 h-1.5 rounded-full"
                                  style={{
                                    width: `${transaction.detection_confidence * 100}%`,
                                  }}
                                ></div>
                              </div>
                              <span className="text-xs text-gray-500">
                                {Math.round(transaction.detection_confidence * 100)}%
                                confidence
                              </span>
                            </div>
                          )}
                        </div>
                        <svg
                          className="w-5 h-5 text-gray-400 group-hover:text-indigo-600 group-hover:translate-x-1 transition-all flex-shrink-0 ml-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M9 5l7 7-7 7"
                          />
                        </svg>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {/* Empty State */}
              {!isLoading && !error && pendingTransactions.length === 0 && (
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-6 text-center">
                  <div className="w-12 h-12 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-3">
                    <svg
                      className="w-6 h-6 text-gray-400"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  </div>
                  <h4 className="text-sm font-medium text-gray-900 mb-1">
                    All Caught Up
                  </h4>
                  <p className="text-sm text-gray-500">
                    No pending transactions to review. New transactions will appear
                    here when detected from your emails.
                  </p>
                </div>
              )}
            </div>

            {/* Divider */}
            <div className="relative my-6">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-gray-200"></div>
              </div>
              <div className="relative flex justify-center">
                <span className="px-3 bg-white text-sm text-gray-500">
                  Other Options
                </span>
              </div>
            </div>
          </FeatureGate>

          {/* Transaction Limit Warning */}
          {!canCreateTransaction && (
            <AlertBanner
              icon={AlertIcons.warning}
              title="Transaction Limit Reached"
              description={`You've used all ${transactionLimit} transactions in your plan (${transactionCount}/${transactionLimit}). Upgrade to create more.`}
              actionText="Upgrade"
              onAction={() => window.open("https://www.keeprcompliance.com/beta", "_blank")}
              testId="modal-transaction-limit-banner"
            />
          )}

          {/* Secondary Actions */}
          <div className="grid grid-cols-2 gap-4">
            {/* Add Manually */}
            <button
              onClick={canCreateTransaction ? onCreateManually : undefined}
              disabled={!canCreateTransaction}
              className={`flex items-center gap-3 p-4 bg-white border-2 rounded-lg transition-all group ${
                canCreateTransaction
                  ? "border-gray-200 hover:border-purple-400 hover:bg-purple-50 cursor-pointer"
                  : "border-gray-200 bg-gray-50 cursor-not-allowed opacity-60"
              }`}
              data-testid="create-manually-button"
            >
              <div className={`w-10 h-10 rounded-lg flex items-center justify-center transition-colors ${
                canCreateTransaction
                  ? "bg-purple-100 group-hover:bg-purple-200"
                  : "bg-gray-200"
              }`}>
                <svg
                  className={`w-5 h-5 ${canCreateTransaction ? "text-purple-600" : "text-gray-400"}`}
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
              </div>
              <div className="text-left">
                <h4 className={`font-semibold text-sm ${canCreateTransaction ? "text-gray-900" : "text-gray-500"}`}>
                  Add Manually
                </h4>
                <p className="text-xs text-gray-500">
                  {canCreateTransaction
                    ? "Transaction not here?"
                    : `Limit reached (${transactionCount}/${transactionLimit})`}
                </p>
              </div>
            </button>

            {/* View Active Transactions */}
            <button
              onClick={onViewActiveTransactions}
              className="flex items-center gap-3 p-4 bg-white border-2 border-gray-200 rounded-lg hover:border-green-400 hover:bg-green-50 transition-all group"
              data-testid="view-active-transactions-button"
            >
              <div className="w-10 h-10 bg-green-100 rounded-lg flex items-center justify-center group-hover:bg-green-200 transition-colors">
                <svg
                  className="w-5 h-5 text-green-600"
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
              </div>
              <div className="text-left">
                <h4 className="font-semibold text-gray-900 text-sm">
                  View Active Transactions
                </h4>
                <p className="text-xs text-gray-500">
                  Browse existing audits
                </p>
              </div>
            </button>
          </div>
        </div>
    </ResponsiveModal>
  );
}

export default StartNewAuditModal;
