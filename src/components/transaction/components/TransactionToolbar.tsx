import React from "react";
import { FeatureGate } from "@/components/common/FeatureGate";
import { useFeatureGate } from "@/hooks/useFeatureGate";

// ============================================
// TYPES AND INTERFACES
// ============================================

interface ScanProgress {
  step: string;
  message: string;
}

interface FilterCounts {
  all: number;
  pending: number;
  active: number;
  closed: number;
  rejected: number;
}

type FilterType = "all" | "pending" | "active" | "closed" | "rejected";

export interface TransactionToolbarProps {
  // Header
  transactionCount: number;
  onClose: () => void;

  // Filter
  filter: FilterType;
  onFilterChange: (filter: FilterType) => void;
  filterCounts: FilterCounts;

  // Scan
  scanning: boolean;
  scanProgress: ScanProgress | null;
  onStartScan: () => void;
  onStopScan: () => void;

  // Selection/Bulk edit
  selectionMode: boolean;
  onToggleSelectionMode: () => void;

  // Status info tooltip
  showStatusInfo: boolean;
  onToggleStatusInfo: () => void;

  // New transaction
  onNewTransaction: () => void;

  // Alerts
  error: string | null;
  quickExportSuccess: string | null;
  bulkActionSuccess: string | null;
}

// ============================================
// TRANSACTION TOOLBAR COMPONENT
// ============================================

/**
 * TransactionToolbar Component
 *
 * Renders the toolbar section of the transaction list including:
 * - Header with back button and title
 * - Filter tabs (All, Pending Review, Active, Closed, Rejected)
 * - Search input
 * - Bulk edit, new transaction, and scan buttons
 * - Scan progress indicator
 * - Error and success alerts
 */
// Filter display config
const FILTER_CONFIG: Record<FilterType, { label: string; shortLabel: string; color: string }> = {
  all: { label: "All", shortLabel: "All", color: "text-purple-600" },
  pending: { label: "Pending Review", shortLabel: "Pending", color: "text-amber-600" },
  active: { label: "Active", shortLabel: "Active", color: "text-blue-600" },
  closed: { label: "Closed", shortLabel: "Closed", color: "text-gray-800" },
  rejected: { label: "Rejected", shortLabel: "Rejected", color: "text-red-600" },
};

function TransactionToolbar({
  transactionCount,
  onClose,
  filter,
  onFilterChange,
  filterCounts,
  scanning,
  scanProgress,
  onStartScan,
  onStopScan,
  selectionMode,
  onToggleSelectionMode,
  showStatusInfo,
  onToggleStatusInfo,
  onNewTransaction,
  error,
  quickExportSuccess,
  bulkActionSuccess,
}: TransactionToolbarProps): React.ReactElement {
  const { isAllowed } = useFeatureGate();
  const hasAIAddon = isAllowed("ai_detection");

  // Cycle through available filters on mobile tap
  const cycleFilter = () => {
    const filters: FilterType[] = hasAIAddon
      ? ["all", "pending", "active", "closed", "rejected"]
      : ["all", "active", "closed"];
    const currentIndex = filters.indexOf(filter);
    const nextIndex = (currentIndex + 1) % filters.length;
    onFilterChange(filters[nextIndex]);
  };

  const currentFilterConfig = FILTER_CONFIG[filter];
  const currentFilterCount = filterCounts[filter];

  return (
    <>
      {/* Header */}
      <div className="flex-shrink-0 bg-gradient-to-r from-blue-500 to-purple-600 px-3 sm:px-6 pt-6 sm:pt-10 pb-3 sm:pb-4 flex items-center justify-between shadow-lg">
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
            {transactionCount} properties found
          </p>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex-shrink-0 px-3 sm:px-6 py-3 sm:py-6 bg-white shadow-md">
        {/*
          BACKLOG-1876: the address-only search input was removed here. The
          transaction list now renders the global LinkedContentSearch box (which
          includes a "Transactions" result group that replaces address-open), so
          the toolbar keeps only the status filters and action buttons.
        */}
        <div className="flex flex-col md:flex-row md:items-center gap-2 sm:gap-3">
          {/* Filter + action buttons */}
          <div className="flex items-center gap-2 w-full min-w-0">
            {/* Mobile: compact cycling filter button */}
            <button
              onClick={cycleFilter}
              className={`sm:hidden inline-flex items-center justify-center gap-1.5 bg-gray-200 rounded-lg px-3 h-10 font-medium text-sm whitespace-nowrap flex-1 ${currentFilterConfig.color}`}
            >
              {currentFilterConfig.shortLabel}
              <span className="px-1.5 py-0.5 text-xs rounded-full bg-gray-300">{currentFilterCount}</span>
              <svg className="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {/* Desktop: full filter tabs */}
            <div className="hidden sm:inline-flex items-center bg-gray-200 rounded-lg p-1 min-w-0 h-11 flex-shrink-0">
              <button
                onClick={() => onFilterChange("all")}
                className={`px-4 py-2 rounded-md font-medium transition-all text-sm whitespace-nowrap ${
                  filter === "all"
                    ? "bg-white text-purple-600 shadow-sm"
                    : "text-gray-600 hover:text-gray-900"
                }`}
              >
                All
                <span className="ml-1.5 px-1.5 py-0.5 text-xs rounded-full bg-gray-300">
                  {filterCounts.all}
                </span>
              </button>
              {/* Pending Review tab - AI add-on only */}
              <FeatureGate requires="ai_addon">
                <button
                  onClick={() => onFilterChange("pending")}
                  className={`px-4 py-2 rounded-md font-medium transition-all text-sm whitespace-nowrap ${
                    filter === "pending"
                      ? "bg-white text-amber-600 shadow-sm"
                      : "text-gray-600 hover:text-gray-900"
                  }`}
                >
                  Pending Review
                  {filterCounts.pending > 0 && (
                    <span className="ml-1.5 px-1.5 py-0.5 text-xs rounded-full bg-amber-100 text-amber-700">
                      {filterCounts.pending}
                    </span>
                  )}
                </button>
              </FeatureGate>
              <button
                onClick={() => onFilterChange("active")}
                className={`px-4 py-2 rounded-md font-medium transition-all text-sm whitespace-nowrap ${
                  filter === "active"
                    ? "bg-white text-blue-600 shadow-sm"
                    : "text-gray-600 hover:text-gray-900"
                }`}
              >
                Active
                <span className="ml-1.5 px-1.5 py-0.5 text-xs rounded-full bg-blue-100 text-blue-700">
                  {filterCounts.active}
                </span>
              </button>
              <button
                onClick={() => onFilterChange("closed")}
                className={`px-4 py-2 rounded-md font-medium transition-all text-sm whitespace-nowrap ${
                  filter === "closed"
                    ? "bg-white text-gray-800 shadow-sm"
                    : "text-gray-600 hover:text-gray-900"
                }`}
              >
                Closed
                <span className="ml-1.5 px-1.5 py-0.5 text-xs rounded-full bg-gray-300">
                  {filterCounts.closed}
                </span>
              </button>
              {/* Rejected tab - AI add-on only */}
              <FeatureGate requires="ai_addon">
                <button
                  onClick={() => onFilterChange("rejected")}
                  className={`px-4 py-2 rounded-md font-medium transition-all text-sm whitespace-nowrap ${
                    filter === "rejected"
                      ? "bg-white text-red-600 shadow-sm"
                      : "text-gray-600 hover:text-gray-900"
                  }`}
                >
                  Rejected
                  {filterCounts.rejected > 0 && (
                    <span className="ml-1.5 px-1.5 py-0.5 text-xs rounded-full bg-red-100 text-red-700">
                      {filterCounts.rejected}
                    </span>
                  )}
                </button>
              </FeatureGate>

              {/* Status Info Button */}
              <div className="relative ml-2">
                <button
                  onClick={onToggleStatusInfo}
                  className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-full transition-all"
                  title="What do these statuses mean?"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </button>

                {/* Status Info Tooltip */}
                {showStatusInfo && (
                  <>
                    {/* Backdrop */}
                    <div
                      className="fixed inset-0 z-10"
                      onClick={onToggleStatusInfo}
                    />
                    {/* Tooltip */}
                    <div className="absolute left-0 top-full mt-2 w-80 bg-white rounded-xl shadow-xl border border-gray-200 p-4 z-20">
                      <h4 className="font-semibold text-gray-900 mb-3">Transaction Statuses</h4>
                      <div className="space-y-3">
                        {hasAIAddon && (
                          <div className="flex items-start gap-3">
                            <span className="w-3 h-3 rounded-full bg-amber-500 mt-1 flex-shrink-0" />
                            <div>
                              <p className="font-medium text-gray-900">Pending Review</p>
                              <p className="text-sm text-gray-600">Auto-detected transaction awaiting your approval</p>
                            </div>
                          </div>
                        )}
                        <div className="flex items-start gap-3">
                          <span className="w-3 h-3 rounded-full bg-blue-500 mt-1 flex-shrink-0" />
                          <div>
                            <p className="font-medium text-gray-900">Active</p>
                            <p className="text-sm text-gray-600">{hasAIAddon ? "Confirmed real estate transaction in progress" : "Real estate transaction in progress"}</p>
                          </div>
                        </div>
                        <div className="flex items-start gap-3">
                          <span className="w-3 h-3 rounded-full bg-gray-500 mt-1 flex-shrink-0" />
                          <div>
                            <p className="font-medium text-gray-900">Closed</p>
                            <p className="text-sm text-gray-600">Completed transaction (deal closed)</p>
                          </div>
                        </div>
                        {hasAIAddon && (
                          <div className="flex items-start gap-3">
                            <span className="w-3 h-3 rounded-full bg-red-500 mt-1 flex-shrink-0" />
                            <div>
                              <p className="font-medium text-gray-900">Rejected</p>
                              <p className="text-sm text-gray-600">Not a real transaction (false positive)</p>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Edit Button */}
            <button
              onClick={onToggleSelectionMode}
              className={`px-2 sm:px-4 py-2 h-11 rounded-lg font-semibold transition-all flex items-center justify-center gap-1 sm:gap-2 text-sm whitespace-nowrap flex-1 sm:flex-none ${
                selectionMode
                  ? "bg-blue-500 text-white hover:bg-blue-600"
                  : "bg-gray-200 text-gray-700 hover:bg-gray-300"
              }`}
            >
              <svg
                className="w-5 h-5 flex-shrink-0"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"
                />
              </svg>
              {selectionMode ? "Cancel" : "Edit"}
            </button>

            {/* Audit New Transaction Button */}
            <button
              onClick={onNewTransaction}
              className="px-2 sm:px-4 py-2 h-11 rounded-lg font-semibold transition-all bg-green-500 text-white hover:bg-green-600 shadow-md hover:shadow-lg flex items-center justify-center gap-1 sm:gap-2 text-sm whitespace-nowrap flex-1 sm:flex-none"
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

            {/* Scan/Stop Button - AI add-on only */}
            <FeatureGate requires="ai_addon">
              {scanning ? (
                <button
                  onClick={onStopScan}
                  className="px-4 py-2 rounded-lg font-semibold transition-all bg-red-500 text-white hover:bg-red-600 shadow-md hover:shadow-lg"
                >
                  <span className="flex items-center gap-2">
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
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                    Stop Scan
                  </span>
                </button>
              ) : (
                <button
                  onClick={onStartScan}
                  className="px-4 py-2 rounded-lg font-semibold transition-all bg-gradient-to-r from-blue-500 to-purple-600 text-white hover:from-blue-600 hover:to-purple-700 shadow-md hover:shadow-lg"
                >
                  <span className="flex items-center gap-2">
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
                        d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                      />
                    </svg>
                    Auto Detect
                  </span>
                </button>
              )}
            </FeatureGate>
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
      </div>
    </>
  );
}

export default TransactionToolbar;
