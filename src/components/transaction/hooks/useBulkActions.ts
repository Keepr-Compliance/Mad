/**
 * Custom hook for managing bulk transaction actions
 * Handles bulk delete, export, and status change operations
 */
import { useState, useCallback, useRef, useEffect } from "react";
import { isPaywallLockedError } from "../../../services/entitlementService";

/**
 * Return type for useBulkActions hook
 */
export interface UseBulkActionsResult {
  /** Whether bulk delete is in progress */
  isBulkDeleting: boolean;
  /** Whether bulk export is in progress */
  isBulkExporting: boolean;
  /** Whether bulk status update is in progress */
  isBulkUpdating: boolean;
  /** Success message from last bulk action (auto-clears after 5 seconds) */
  bulkActionSuccess: string | null;
  /** Handle bulk delete of selected transactions */
  handleBulkDelete: () => Promise<void>;
  /** Handle bulk export of selected transactions */
  handleBulkExport: (format: string) => Promise<void>;
  /** Handle bulk status change of selected transactions */
  handleBulkStatusChange: (status: "pending" | "active" | "closed" | "rejected") => Promise<void>;
}

/**
 * Callbacks for bulk action completion and messaging
 */
export interface UseBulkActionsCallbacks {
  /** Callback after successful bulk action (to refresh transactions) */
  onComplete: () => Promise<void>;
  /** Callback to show error message */
  showError: (message: string | null) => void;
  /** Callback to exit selection mode */
  exitSelectionMode: () => void;
  /** Callback to close bulk delete confirmation modal */
  closeBulkDeleteModal: () => void;
  /** Callback to close bulk export modal */
  closeBulkExportModal: () => void;
}

/**
 * Custom hook for managing bulk transaction actions
 * @param selectedIds - Set of selected transaction IDs
 * @param selectedCount - Number of selected transactions
 * @param callbacks - Callbacks for completion and messaging
 * @returns Bulk action loading states and handlers
 */
export function useBulkActions(
  selectedIds: Set<string>,
  selectedCount: number,
  callbacks: UseBulkActionsCallbacks
): UseBulkActionsResult {
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [isBulkExporting, setIsBulkExporting] = useState(false);
  const [isBulkUpdating, setIsBulkUpdating] = useState(false);
  const [bulkActionSuccess, setBulkActionSuccess] = useState<string | null>(null);

  // Ref for auto-clear timeout
  const successTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (successTimeoutRef.current) {
        clearTimeout(successTimeoutRef.current);
      }
    };
  }, []);

  // Internal helper to show success with auto-clear after 5 seconds
  const showSuccessWithAutoClear = useCallback((message: string) => {
    // Clear any existing timeout
    if (successTimeoutRef.current) {
      clearTimeout(successTimeoutRef.current);
    }
    setBulkActionSuccess(message);
    successTimeoutRef.current = setTimeout(() => {
      setBulkActionSuccess(null);
    }, 5000);
  }, []);

  const {
    onComplete,
    showError,
    exitSelectionMode,
    closeBulkDeleteModal,
    closeBulkExportModal,
  } = callbacks;

  /**
   * Handle bulk delete of selected transactions
   */
  const handleBulkDelete = useCallback(async (): Promise<void> => {
    if (selectedCount === 0) return;

    setIsBulkDeleting(true);
    try {
      const result = await window.api.transactions.bulkDelete(
        Array.from(selectedIds)
      );

      if (result.success) {
        showSuccessWithAutoClear(
          `Successfully deleted ${result.deletedCount || selectedCount} transaction${(result.deletedCount || selectedCount) > 1 ? "s" : ""}`
        );
        exitSelectionMode();
        await onComplete();
      } else {
        showError(result.error || "Failed to delete transactions");
      }
    } catch (err) {
      showError((err as Error).message);
    } finally {
      setIsBulkDeleting(false);
      closeBulkDeleteModal();
    }
  }, [
    selectedIds,
    selectedCount,
    onComplete,
    showSuccessWithAutoClear,
    showError,
    exitSelectionMode,
    closeBulkDeleteModal,
  ]);

  /**
   * Handle bulk export of selected transactions
   */
  const handleBulkExport = useCallback(
    async (format: string): Promise<void> => {
      if (selectedCount === 0) return;

      setIsBulkExporting(true);
      try {
        const selectedTransactionIds = Array.from(selectedIds);
        let successCount = 0;
        // BACKLOG-2075: locked transactions (PAYWALL_LOCKED) are counted SEPARATELY
        // from generic failures. We do NOT storm the user with per-tx unlock modals
        // in the bulk flow; instead we export the unlocked ones and report how many
        // were skipped because they need unlocking.
        let lockedCount = 0;
        const errors: string[] = [];

        for (const transactionId of selectedTransactionIds) {
          try {
            const result = await window.api.transactions.exportEnhanced(
              transactionId,
              { exportFormat: format }
            );
            if (result.success) {
              successCount++;
            } else if (isPaywallLockedError(result.error)) {
              lockedCount++;
            } else {
              errors.push(result.error || `Failed to export transaction`);
            }
          } catch (err) {
            const message = (err as Error).message;
            if (isPaywallLockedError(message)) {
              lockedCount++;
            } else {
              errors.push(message);
            }
          }
        }

        // Suffix summarizing skipped (locked) and failed transactions, if any.
        const notes: string[] = [];
        if (lockedCount > 0) {
          notes.push(`${lockedCount} locked — unlock to include`);
        }
        if (errors.length > 0) {
          notes.push(`${errors.length} failed`);
        }
        const suffix = notes.length > 0 ? ` (${notes.join(", ")})` : "";

        if (successCount > 0) {
          showSuccessWithAutoClear(
            `Successfully exported ${successCount} transaction${successCount > 1 ? "s" : ""}${suffix}`
          );
          exitSelectionMode();
          await onComplete();
        } else if (lockedCount > 0 && errors.length === 0) {
          // Nothing exported solely because every selected deal is locked.
          showError(
            `${lockedCount} transaction${lockedCount > 1 ? "s are" : " is"} locked — unlock ${lockedCount > 1 ? "them" : "it"} to export.`
          );
        } else {
          showError("Failed to export transactions");
        }
      } catch (err) {
        showError((err as Error).message);
      } finally {
        setIsBulkExporting(false);
        closeBulkExportModal();
      }
    },
    [
      selectedIds,
      selectedCount,
      onComplete,
      showSuccessWithAutoClear,
      showError,
      exitSelectionMode,
      closeBulkExportModal,
    ]
  );

  /**
   * Handle bulk status change of selected transactions
   */
  const handleBulkStatusChange = useCallback(
    async (status: "pending" | "active" | "closed" | "rejected"): Promise<void> => {
      if (selectedCount === 0) return;

      setIsBulkUpdating(true);
      try {
        const result = await window.api.transactions.bulkUpdateStatus(
          Array.from(selectedIds),
          status
        );

        if (result.success) {
          showSuccessWithAutoClear(
            `Successfully updated ${result.updatedCount || selectedCount} transaction${(result.updatedCount || selectedCount) > 1 ? "s" : ""} to ${status}`
          );
          exitSelectionMode();
          await onComplete();
        } else {
          showError(result.error || "Failed to update transactions");
        }
      } catch (err) {
        showError((err as Error).message);
      } finally {
        setIsBulkUpdating(false);
      }
    },
    [selectedIds, selectedCount, onComplete, showSuccessWithAutoClear, showError, exitSelectionMode]
  );

  return {
    isBulkDeleting,
    isBulkExporting,
    isBulkUpdating,
    bulkActionSuccess,
    handleBulkDelete,
    handleBulkExport,
    handleBulkStatusChange,
  };
}

export default useBulkActions;
