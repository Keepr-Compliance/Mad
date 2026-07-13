/**
 * BulkActionBar Component
 * A floating toolbar that appears when multiple items are selected
 * Provides bulk actions like delete, export, and status change
 */
import React, { useState, useMemo } from "react";
import { ResponsiveModal } from "./common/ResponsiveModal";

interface SelectedTransaction {
  id: string;
  detection_source?: "manual" | "auto" | "hybrid";
  submission_status?: "not_submitted" | "submitted" | "under_review" | "needs_changes" | "resubmitted" | "approved" | "rejected";
}

interface BulkActionBarProps {
  selectedCount: number;
  totalCount: number;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onBulkDelete: () => void;
  onBulkExport: () => void;
  onBulkStatusChange: (status: "pending" | "active" | "closed" | "rejected") => void;
  onBulkSubmit?: () => void;
  onClose: () => void;
  isDeleting?: boolean;
  isExporting?: boolean;
  isUpdating?: boolean;
  isSubmitting?: boolean;
  /** Selected transactions to determine available status options */
  selectedTransactions?: SelectedTransaction[];
}

export function BulkActionBar({
  selectedCount,
  totalCount,
  onSelectAll,
  onDeselectAll,
  onBulkDelete,
  onBulkExport,
  onBulkStatusChange,
  onBulkSubmit,
  onClose,
  isDeleting = false,
  isExporting = false,
  isUpdating = false,
  isSubmitting = false,
  selectedTransactions = [],
}: BulkActionBarProps) {
  const [showStatusDropdown, setShowStatusDropdown] = useState(false);
  const isProcessing = isDeleting || isExporting || isUpdating || isSubmitting;
  const hasSelection = selectedCount > 0;

  // Determine available status options based on selected transactions
  // Manual transactions can only be set to "active" or "closed"
  // AI-detected transactions can use all 4 statuses
  const hasManualTransactions = useMemo(() => {
    return selectedTransactions.some((t) => t.detection_source === "manual");
  }, [selectedTransactions]);

  // Count transactions eligible for submission
  // Eligible: not_submitted, needs_changes, rejected
  const submittableCount = useMemo(() => {
    return selectedTransactions.filter((t) => {
      const status = t.submission_status;
      return (
        status === undefined ||
        status === "not_submitted" ||
        status === "needs_changes" ||
        status === "rejected"
      );
    }).length;
  }, [selectedTransactions]);

  return (
    <div className="fixed bottom-4 right-4 sm:bottom-6 sm:right-auto sm:left-1/2 sm:transform sm:-translate-x-1/2 z-50">
      {/* Mobile layout */}
      <div className="sm:hidden bg-gray-900 text-white rounded-xl shadow-2xl px-2 py-2">
        {/* Row 1: count + select/deselect + close */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center justify-center w-7 h-7 rounded-full text-sm font-bold ${hasSelection ? "bg-blue-500" : "bg-gray-600"}`}>
              {selectedCount}
            </span>
            <span className="text-xs text-gray-400">of {totalCount}</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={onSelectAll}
              disabled={isProcessing || selectedCount >= totalCount}
              className="px-2 py-1 text-xs font-medium text-gray-300 hover:text-white hover:bg-gray-800 rounded transition-colors disabled:opacity-50"
            >
              All
            </button>
            <button
              onClick={onDeselectAll}
              disabled={isProcessing || !hasSelection}
              className="px-2 py-1 text-xs font-medium text-gray-300 hover:text-white hover:bg-gray-800 rounded transition-colors disabled:opacity-50"
            >
              None
            </button>
            <button
              onClick={onClose}
              disabled={isProcessing}
              className="p-1 text-gray-400 hover:text-white hover:bg-gray-800 rounded transition-colors ml-1"
              title="Exit bulk edit mode"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
        {/* Row 2: action buttons — equal width */}
        <div className="flex items-center gap-1">
          {onBulkSubmit && (
            <button
              onClick={onBulkSubmit}
              disabled={isProcessing || submittableCount === 0}
              className="flex-1 flex items-center justify-center gap-1.5 px-2 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Submit
            </button>
          )}
          <button
            onClick={onBulkExport}
            disabled={isProcessing || !hasSelection}
            className="flex-1 flex items-center justify-center gap-1.5 px-2 py-2 bg-green-600 hover:bg-green-700 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Export
          </button>
          <button
            onClick={() => setShowStatusDropdown(!showStatusDropdown)}
            disabled={isProcessing || !hasSelection}
            className="flex-1 flex items-center justify-center gap-1.5 px-2 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 relative"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Status
          </button>
          <button
            onClick={onBulkDelete}
            disabled={isProcessing || !hasSelection}
            data-testid="bulk-delete-button"
            className="flex-1 flex items-center justify-center gap-1.5 px-2 py-2 bg-red-600 hover:bg-red-700 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            Delete
          </button>
        </div>
      </div>

      {/* Desktop layout */}
      <div className="hidden sm:flex bg-gray-900 text-white rounded-xl shadow-2xl px-6 py-4 items-center gap-4">
        {/* Selection Info */}
        <div className="flex items-center gap-3 pr-4 border-r border-gray-700">
          <div
            className={`flex items-center justify-center w-10 h-10 rounded-full ${hasSelection ? "bg-blue-500" : "bg-gray-600"}`}
          >
            <span className="font-bold text-lg">{selectedCount}</span>
          </div>
          <div className="text-sm whitespace-nowrap text-gray-400">
            of {totalCount}
          </div>
        </div>

        {/* Selection Actions */}
        <div className="flex items-center gap-2 pr-4 border-r border-gray-700">
          <button
            onClick={onSelectAll}
            disabled={isProcessing || selectedCount >= totalCount}
            className="px-3 py-2 text-sm font-medium text-gray-300 hover:text-white hover:bg-gray-800 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
          >
            Select All
          </button>
          <button
            onClick={onDeselectAll}
            disabled={isProcessing || !hasSelection}
            className="px-3 py-2 text-sm font-medium text-gray-300 hover:text-white hover:bg-gray-800 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
          >
            Deselect All
          </button>
        </div>

        {/* Bulk Actions */}
        <div className="flex items-center gap-2">
          {/* Submit Button (BACKLOG-392) */}
          {onBulkSubmit && (
            <button
              onClick={onBulkSubmit}
              disabled={isProcessing || submittableCount === 0}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
              title={submittableCount === 0 ? "No eligible transactions selected" : `Submit ${submittableCount} transactions`}
            >
              {isSubmitting ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                  <span>Submitting...</span>
                </>
              ) : (
                <>
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
                      d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                  <span>Submit{submittableCount > 0 && submittableCount !== selectedCount ? ` (${submittableCount})` : ""}</span>
                </>
              )}
            </button>
          )}

          {/* Export Button */}
          <button
            onClick={onBulkExport}
            disabled={isProcessing || !hasSelection}
            className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
          >
            {isExporting ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                <span>Exporting...</span>
              </>
            ) : (
              <>
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
                    d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                  />
                </svg>
                <span>Export</span>
              </>
            )}
          </button>

          {/* Status Change Dropdown */}
          <div className="relative">
            <button
              onClick={() => setShowStatusDropdown(!showStatusDropdown)}
              disabled={isProcessing || !hasSelection}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            >
              {isUpdating ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                  <span>Updating...</span>
                </>
              ) : (
                <>
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
                      d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                  <span>Status</span>
                  <svg
                    className="w-4 h-4 flex-shrink-0"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M19 9l-7 7-7-7"
                    />
                  </svg>
                </>
              )}
            </button>

            {/* Status Dropdown Menu */}
            {showStatusDropdown && !isProcessing && hasSelection && (
              <div className="absolute bottom-full mb-2 left-0 bg-gray-800 rounded-lg shadow-xl border border-gray-700 py-2 min-w-[160px]">
                {/* Pending - only for AI-detected transactions */}
                {!hasManualTransactions && (
                  <button
                    onClick={() => {
                      onBulkStatusChange("pending");
                      setShowStatusDropdown(false);
                    }}
                    className="w-full px-4 py-2 text-left text-sm hover:bg-gray-700 flex items-center gap-2 whitespace-nowrap"
                  >
                    <span className="w-2 h-2 bg-yellow-500 rounded-full flex-shrink-0"></span>
                    Mark as Pending
                  </button>
                )}
                <button
                  onClick={() => {
                    onBulkStatusChange("active");
                    setShowStatusDropdown(false);
                  }}
                  className="w-full px-4 py-2 text-left text-sm hover:bg-gray-700 flex items-center gap-2 whitespace-nowrap"
                >
                  <span className="w-2 h-2 bg-green-500 rounded-full flex-shrink-0"></span>
                  Mark as Active
                </button>
                <button
                  onClick={() => {
                    onBulkStatusChange("closed");
                    setShowStatusDropdown(false);
                  }}
                  className="w-full px-4 py-2 text-left text-sm hover:bg-gray-700 flex items-center gap-2 whitespace-nowrap"
                >
                  <span className="w-2 h-2 bg-gray-500 rounded-full flex-shrink-0"></span>
                  Mark as Closed
                </button>
                {/* Rejected - only for AI-detected transactions */}
                {!hasManualTransactions && (
                  <button
                    onClick={() => {
                      onBulkStatusChange("rejected");
                      setShowStatusDropdown(false);
                    }}
                    className="w-full px-4 py-2 text-left text-sm hover:bg-gray-700 flex items-center gap-2 whitespace-nowrap"
                  >
                    <span className="w-2 h-2 bg-red-500 rounded-full flex-shrink-0"></span>
                    Mark as Rejected
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Delete Button */}
          <button
            onClick={onBulkDelete}
            disabled={isProcessing || !hasSelection}
            data-testid="bulk-delete-button"
            className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
          >
            {isDeleting ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                <span>Deleting...</span>
              </>
            ) : (
              <>
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
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                  />
                </svg>
                <span>Delete</span>
              </>
            )}
          </button>
        </div>

        {/* Close Button */}
        <button
          onClick={onClose}
          disabled={isProcessing}
          className="ml-2 p-2 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-colors disabled:opacity-50"
          title="Exit bulk edit mode"
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
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}

/**
 * BulkDeleteConfirmModal Component
 * Confirmation modal for bulk delete operation
 */
interface BulkDeleteConfirmModalProps {
  selectedCount: number;
  onConfirm: () => void;
  onCancel: () => void;
  isDeleting?: boolean;
}

export function BulkDeleteConfirmModal({
  selectedCount,
  onConfirm,
  onCancel,
  isDeleting = false,
}: BulkDeleteConfirmModalProps) {
  return (
    <ResponsiveModal onClose={onCancel} zIndex="z-[70]" panelClassName="max-w-md p-6">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
            <svg
              className="w-6 h-6 text-red-600"
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
          </div>
          <h3 className="text-lg font-bold text-gray-900">
            Delete {selectedCount} Transaction{selectedCount > 1 ? "s" : ""}?
          </h3>
        </div>
        <p className="text-sm text-gray-600 mb-2">
          Are you sure you want to delete {selectedCount} selected transaction
          {selectedCount > 1 ? "s" : ""}? This will permanently remove:
        </p>
        <ul className="text-sm text-gray-600 mb-6 ml-6 list-disc">
          <li>All transaction details</li>
          <li>All contact assignments</li>
          <li>All related communications</li>
        </ul>
        <p className="text-sm text-red-600 font-semibold mb-6">
          This action cannot be undone.
        </p>
        <div className="flex items-center gap-3 justify-end">
          <button
            onClick={onCancel}
            disabled={isDeleting}
            className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg font-medium transition-all disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isDeleting}
            data-testid="bulk-delete-confirm"
            className="px-4 py-2 bg-red-600 text-white hover:bg-red-700 rounded-lg font-semibold transition-all disabled:opacity-50 flex items-center gap-2"
          >
            {isDeleting ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                Deleting...
              </>
            ) : (
              <>
                Delete {selectedCount} Transaction{selectedCount > 1 ? "s" : ""}
              </>
            )}
          </button>
        </div>
    </ResponsiveModal>
  );
}

/**
 * BulkExportModal Component
 * Modal for selecting export options for multiple transactions
 */
interface BulkExportModalProps {
  selectedCount: number;
  onConfirm: (format: string) => void;
  onCancel: () => void;
  isExporting?: boolean;
}

export function BulkExportModal({
  selectedCount,
  onConfirm,
  onCancel,
  isExporting = false,
}: BulkExportModalProps) {
  const [exportFormat, setExportFormat] = useState("pdf");

  return (
    <ResponsiveModal onClose={onCancel} zIndex="z-[70]" panelClassName="max-w-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-gray-900">
            Export {selectedCount} Transaction{selectedCount > 1 ? "s" : ""}
          </h3>
          <button
            onClick={onCancel}
            disabled={isExporting}
            className="text-gray-400 hover:text-gray-600 disabled:opacity-50"
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

        <p className="text-sm text-gray-600 mb-4">
          Select an export format for the selected transactions. Each
          transaction will be exported as a separate file.
        </p>

        <div className="mb-6">
          <label className="block text-sm font-medium text-gray-700 mb-3">
            Export Format
          </label>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setExportFormat("pdf")}
              className={`px-4 py-3 rounded-lg font-medium transition-all text-left ${
                exportFormat === "pdf"
                  ? "bg-purple-500 text-white shadow-md"
                  : "bg-gray-100 text-gray-700 hover:bg-gray-200"
              }`}
            >
              <div className="font-semibold">PDF Report</div>
              <div className="text-xs opacity-80">Transaction report</div>
            </button>
            <button
              onClick={() => setExportFormat("excel")}
              className={`px-4 py-3 rounded-lg font-medium transition-all text-left ${
                exportFormat === "excel"
                  ? "bg-purple-500 text-white shadow-md"
                  : "bg-gray-100 text-gray-700 hover:bg-gray-200"
              }`}
            >
              <div className="font-semibold">Excel (.xlsx)</div>
              <div className="text-xs opacity-80">Spreadsheet format</div>
            </button>
            <button
              onClick={() => setExportFormat("csv")}
              className={`px-4 py-3 rounded-lg font-medium transition-all text-left ${
                exportFormat === "csv"
                  ? "bg-purple-500 text-white shadow-md"
                  : "bg-gray-100 text-gray-700 hover:bg-gray-200"
              }`}
            >
              <div className="font-semibold">CSV</div>
              <div className="text-xs opacity-80">Comma-separated values</div>
            </button>
            <button
              onClick={() => setExportFormat("json")}
              className={`px-4 py-3 rounded-lg font-medium transition-all text-left ${
                exportFormat === "json"
                  ? "bg-purple-500 text-white shadow-md"
                  : "bg-gray-100 text-gray-700 hover:bg-gray-200"
              }`}
            >
              <div className="font-semibold">JSON</div>
              <div className="text-xs opacity-80">Structured data</div>
            </button>
          </div>
        </div>

        <div className="flex items-center gap-3 justify-end">
          <button
            onClick={onCancel}
            disabled={isExporting}
            className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg font-medium transition-all disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(exportFormat)}
            disabled={isExporting}
            className="px-6 py-2 bg-gradient-to-r from-purple-500 to-indigo-600 text-white hover:from-purple-600 hover:to-indigo-700 rounded-lg font-semibold transition-all shadow-md hover:shadow-lg disabled:opacity-50 flex items-center gap-2"
          >
            {isExporting ? (
              <>
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                Exporting...
              </>
            ) : (
              <>
                Export {selectedCount} Transaction{selectedCount > 1 ? "s" : ""}
              </>
            )}
          </button>
        </div>
    </ResponsiveModal>
  );
}

export default BulkActionBar;
