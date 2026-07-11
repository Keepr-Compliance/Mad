/**
 * TransactionsToolbar Component
 * Toolbar for the transactions page with filters, search, and actions
 */
import React, { useState } from "react";
import type { Transaction } from "../../../../electron/types/models";
import { FeatureGate } from "../../common/FeatureGate";
import { TransactionLimitModal } from "../../common/TransactionLimitModal";
import { useLicense } from "../../../contexts/LicenseContext";

// ============================================
// TYPES
// ============================================

interface ScanProgress {
  step: string;
  message: string;
}

export interface TransactionsToolbarProps {
  // Transaction count
  transactionCount: number;
  transactions: Transaction[];

  // Filter
  statusFilter: "active" | "closed" | "all";
  onStatusFilterChange: (filter: "active" | "closed" | "all") => void;

  // Search
  searchQuery: string;
  onSearchChange: (query: string) => void;

  // Selection mode
  selectionMode: boolean;
  onToggleSelectionMode: () => void;

  // Actions
  onNewTransaction: () => void;
  onStartScan: () => void;
  onStopScan: () => void;
  scanning: boolean;
  scanProgress: ScanProgress | null;

  // Alerts
  error: string | null;
  quickExportSuccess: string | null;
  bulkActionSuccess: string | null;
}

// ============================================
// TRANSACTIONS TOOLBAR COMPONENT
// ============================================

export function TransactionsToolbar({
  transactionCount,
  transactions,
  statusFilter,
  onStatusFilterChange,
  searchQuery,
  onSearchChange,
  selectionMode,
  onToggleSelectionMode,
  onNewTransaction,
  onStartScan,
  onStopScan,
  scanning,
  scanProgress,
  error,
  quickExportSuccess,
  bulkActionSuccess,
}: TransactionsToolbarProps): React.ReactElement {
  const { canCreateTransaction, transactionCount: licenseTransactionCount, transactionLimit } = useLicense();
  const [showLimitModal, setShowLimitModal] = useState(false);
  const [searchExpanded, setSearchExpanded] = useState(false);
  const searchInputRef = React.useRef<HTMLInputElement>(null);

  const handleNewTransaction = () => {
    if (!canCreateTransaction) {
      setShowLimitModal(true);
      return;
    }
    onNewTransaction();
  };

  const handleExpandSearch = () => {
    setSearchExpanded(true);
    // Focus after render
    setTimeout(() => searchInputRef.current?.focus(), 50);
  };

  const handleCollapseSearch = () => {
    if (!searchQuery) {
      setSearchExpanded(false);
    }
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onSearchChange("");
      setSearchExpanded(false);
    }
  };

  const activeCount = transactions.filter(
    (t: Transaction) => t.status === "active"
  ).length;
  const closedCount = transactions.filter(
    (t: Transaction) => t.status === "closed"
  ).length;

  return (
    <div className="flex-shrink-0 px-3 sm:px-6 py-3 bg-white shadow-md space-y-2">
      {/* Row 1: Action buttons + collapsible search */}
      <div className="flex items-center gap-2">
        {searchExpanded ? (
          /* Expanded search — takes over the row */
          <div className="flex-1 relative flex items-center gap-2">
            <div className="flex-1 relative">
              <input
                ref={searchInputRef}
                type="text"
                placeholder="Search by address..."
                value={searchQuery}
                onChange={(e) => onSearchChange(e.target.value)}
                onBlur={handleCollapseSearch}
                onKeyDown={handleSearchKeyDown}
                className="w-full h-10 pl-10 pr-4 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-gray-900 bg-white text-sm"
              />
              <svg
                className="w-5 h-5 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
            </div>
            <button
              onClick={() => { onSearchChange(""); setSearchExpanded(false); }}
              className="flex-shrink-0 p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors"
              aria-label="Close search"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        ) : (
          /* Collapsed state — search icon + Edit + New */
          <>
            {/* Search icon button */}
            <button
              onClick={handleExpandSearch}
              className="p-2.5 h-10 w-10 rounded-lg border border-gray-300 text-gray-500 hover:text-gray-700 hover:bg-gray-50 transition-colors flex items-center justify-center flex-shrink-0"
              aria-label="Search transactions"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </button>

            <div className="flex-1" />

            {/* Edit Mode Button */}
            <button
              onClick={onToggleSelectionMode}
              data-testid="tx-selection-toggle"
              className={`px-3 py-2 h-10 rounded-lg font-semibold transition-all flex items-center gap-1.5 text-sm whitespace-nowrap ${
                selectionMode
                  ? "bg-purple-500 text-white hover:bg-purple-600 shadow-md"
                  : "bg-gray-200 text-gray-700 hover:bg-gray-300"
              }`}
            >
              <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
              </svg>
              {selectionMode ? "Done" : "Edit"}
            </button>

            {/* New Transaction Button */}
            <button
              onClick={handleNewTransaction}
              className="px-3 py-2 h-10 rounded-lg font-semibold transition-all bg-green-500 text-white hover:bg-green-600 shadow-md hover:shadow-lg flex items-center gap-1.5 text-sm whitespace-nowrap"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
              </svg>
              New
            </button>

            {/* Scan/Stop Button - AI add-on only */}
            <FeatureGate requires="ai_addon">
              {scanning ? (
                <button
                  onClick={onStopScan}
                  className="px-3 py-2 h-10 rounded-lg font-semibold transition-all bg-red-500 text-white hover:bg-red-600 shadow-md flex items-center gap-1.5 text-sm whitespace-nowrap"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                  Stop
                </button>
              ) : (
                <button
                  onClick={onStartScan}
                  className="px-3 py-2 h-10 rounded-lg font-semibold transition-all bg-gradient-to-r from-blue-500 to-purple-600 text-white hover:from-blue-600 hover:to-purple-700 shadow-md flex items-center gap-1.5 text-sm whitespace-nowrap"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                  Scan
                </button>
              )}
            </FeatureGate>
          </>
        )}
      </div>

      {/* Row 2: Status filter tabs */}
      <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide">
        <div className="inline-flex items-center bg-gray-200 rounded-lg p-1 h-9">
          <button
            onClick={() => onStatusFilterChange("active")}
            className={`px-3 py-1.5 rounded-md font-medium transition-all text-sm whitespace-nowrap ${
              statusFilter === "active"
                ? "bg-white text-blue-600 shadow-sm"
                : "text-gray-600 hover:text-gray-900"
            }`}
          >
            Active
            <span className="ml-1.5 px-1.5 py-0.5 text-xs rounded-full bg-blue-100 text-blue-700">{activeCount}</span>
          </button>
          <button
            onClick={() => onStatusFilterChange("closed")}
            className={`px-3 py-1.5 rounded-md font-medium transition-all text-sm whitespace-nowrap ${
              statusFilter === "closed"
                ? "bg-white text-gray-800 shadow-sm"
                : "text-gray-600 hover:text-gray-900"
            }`}
          >
            Closed
            <span className="ml-1.5 px-1.5 py-0.5 text-xs rounded-full bg-gray-300">{closedCount}</span>
          </button>
          <button
            onClick={() => onStatusFilterChange("all")}
            className={`px-3 py-1.5 rounded-md font-medium transition-all text-sm whitespace-nowrap ${
              statusFilter === "all"
                ? "bg-white text-purple-600 shadow-sm"
                : "text-gray-600 hover:text-gray-900"
            }`}
          >
            All
            <span className="ml-1.5 px-1.5 py-0.5 text-xs rounded-full bg-gray-300">{transactionCount}</span>
          </button>
        </div>
      </div>

      {/* Scan Progress */}
      {scanProgress && (
        <div
          className={`mt-3 p-3 border rounded-lg ${
            scanProgress.step === "cancelled"
              ? "bg-orange-50 border-orange-200"
              : "bg-blue-50 border-blue-200"
          }`}
        >
          <div className="flex items-center gap-2">
            {scanProgress.step !== "complete" &&
              scanProgress.step !== "cancelled" && (
                <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
              )}
            {scanProgress.step === "complete" && (
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
                  d="M5 13l4 4L19 7"
                />
              </svg>
            )}
            {scanProgress.step === "cancelled" && (
              <svg
                className="w-5 h-5 text-orange-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
            )}
            <span
              className={`text-sm font-medium ${
                scanProgress.step === "cancelled"
                  ? "text-orange-900"
                  : "text-blue-900"
              }`}
            >
              {scanProgress.message}
            </span>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-sm text-red-800">{error}</p>
        </div>
      )}

      {/* Quick Export Success */}
      {quickExportSuccess && (
        <div className="mt-3 p-3 bg-green-50 border border-green-200 rounded-lg">
          <div className="flex items-start gap-2">
            <svg
              className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5"
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
            <div className="flex-1">
              <p className="text-sm font-medium text-green-900">
                Export completed successfully!
              </p>
              <p className="text-xs text-green-700 mt-1 break-all">
                {quickExportSuccess}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Action Success */}
      {bulkActionSuccess && (
        <div className="mt-3 p-3 bg-green-50 border border-green-200 rounded-lg">
          <div className="flex items-start gap-2">
            <svg
              className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5"
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
            <div className="flex-1">
              <p className="text-sm font-medium text-green-900">
                {bulkActionSuccess}
              </p>
            </div>
          </div>
        </div>
      )}
    {showLimitModal && (
        <TransactionLimitModal
          transactionCount={licenseTransactionCount}
          transactionLimit={transactionLimit}
          onClose={() => setShowLimitModal(false)}
        />
      )}
    </div>
  );
}

export default TransactionsToolbar;
