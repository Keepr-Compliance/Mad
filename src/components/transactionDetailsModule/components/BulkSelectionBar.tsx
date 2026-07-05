/**
 * BulkSelectionBar Component (BACKLOG-1719)
 *
 * A lean floating toolbar for the transaction-details Emails/Texts tabs. It is a
 * sibling of the transaction-window BulkActionBar and matches its visual design
 * (dark gray-900 pill, mobile + desktop layouts, count badge, Select All / None,
 * a single primary action, and a close button), but exposes ONE parameterised
 * action so it can drive both:
 *  - bulk REMOVE on the active email/text lists (danger / red), and
 *  - bulk RESTORE in the "Show removed" sections (success / green).
 *
 * Kept intentionally small: the transaction window's BulkActionBar carries
 * Submit/Export/Status/Delete which are irrelevant here. Reusing it verbatim
 * would drag in transaction-only concerns, so this focused component matches its
 * look while staying purpose-built for the details tabs.
 */
import React from "react";
import { ResponsiveModal } from "../../common/ResponsiveModal";

type ActionVariant = "danger" | "success";

interface BulkSelectionBarProps {
  selectedCount: number;
  totalCount: number;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  /** Exit selection mode. */
  onClose: () => void;
  /** Label for the primary action button (e.g. "Remove", "Restore"). */
  actionLabel: string;
  /** Label shown while the action is processing (e.g. "Removing..."). */
  actionProcessingLabel?: string;
  onAction: () => void;
  isActionProcessing?: boolean;
  /** Colour treatment for the primary action. */
  actionVariant?: ActionVariant;
  /** Tailwind z-index class. Defaults above the details modal (z-[60]). */
  zIndexClass?: string;
  /** data-testid for the floating bar container. */
  testId?: string;
  /** data-testid for the primary action button. */
  actionTestId?: string;
}

const VARIANT_CLASSES: Record<ActionVariant, string> = {
  danger: "bg-red-600 hover:bg-red-700",
  success: "bg-green-600 hover:bg-green-700",
};

export function BulkSelectionBar({
  selectedCount,
  totalCount,
  onSelectAll,
  onDeselectAll,
  onClose,
  actionLabel,
  actionProcessingLabel,
  onAction,
  isActionProcessing = false,
  actionVariant = "danger",
  zIndexClass = "z-[65]",
  testId = "bulk-selection-bar",
  actionTestId = "bulk-selection-action",
}: BulkSelectionBarProps): React.ReactElement {
  const hasSelection = selectedCount > 0;
  const actionColor = VARIANT_CLASSES[actionVariant];
  const processingLabel = actionProcessingLabel ?? `${actionLabel}...`;

  return (
    <div
      className={`fixed bottom-4 right-4 sm:bottom-6 sm:right-auto sm:left-1/2 sm:transform sm:-translate-x-1/2 ${zIndexClass}`}
      data-testid={testId}
    >
      {/* Mobile layout */}
      <div className="sm:hidden bg-gray-900 text-white rounded-xl shadow-2xl px-2 py-2">
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
              disabled={isActionProcessing || selectedCount >= totalCount}
              className="px-2 py-1 text-xs font-medium text-gray-300 hover:text-white hover:bg-gray-800 rounded transition-colors disabled:opacity-50"
            >
              All
            </button>
            <button
              onClick={onDeselectAll}
              disabled={isActionProcessing || !hasSelection}
              className="px-2 py-1 text-xs font-medium text-gray-300 hover:text-white hover:bg-gray-800 rounded transition-colors disabled:opacity-50"
            >
              None
            </button>
            <button
              onClick={onClose}
              disabled={isActionProcessing}
              className="p-1 text-gray-400 hover:text-white hover:bg-gray-800 rounded transition-colors ml-1"
              title="Exit selection mode"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
        <button
          onClick={onAction}
          disabled={isActionProcessing || !hasSelection}
          className={`w-full flex items-center justify-center gap-1.5 px-2 py-2 ${actionColor} rounded-lg text-xs font-medium transition-colors disabled:opacity-50`}
          data-testid={actionTestId}
        >
          {isActionProcessing ? (
            <>
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              {processingLabel}
            </>
          ) : (
            actionLabel
          )}
        </button>
      </div>

      {/* Desktop layout */}
      <div className="hidden sm:flex bg-gray-900 text-white rounded-xl shadow-2xl px-6 py-4 items-center gap-4">
        {/* Selection info */}
        <div className="flex items-center gap-3 pr-4 border-r border-gray-700">
          <div className={`flex items-center justify-center w-10 h-10 rounded-full ${hasSelection ? "bg-blue-500" : "bg-gray-600"}`}>
            <span className="font-bold text-lg">{selectedCount}</span>
          </div>
          <div className="text-sm whitespace-nowrap text-gray-400">of {totalCount}</div>
        </div>

        {/* Selection actions */}
        <div className="flex items-center gap-2 pr-4 border-r border-gray-700">
          <button
            onClick={onSelectAll}
            disabled={isActionProcessing || selectedCount >= totalCount}
            className="px-3 py-2 text-sm font-medium text-gray-300 hover:text-white hover:bg-gray-800 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
          >
            Select All
          </button>
          <button
            onClick={onDeselectAll}
            disabled={isActionProcessing || !hasSelection}
            className="px-3 py-2 text-sm font-medium text-gray-300 hover:text-white hover:bg-gray-800 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
          >
            Deselect All
          </button>
        </div>

        {/* Primary action */}
        <button
          onClick={onAction}
          disabled={isActionProcessing || !hasSelection}
          className={`flex items-center gap-2 px-4 py-2 ${actionColor} rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap`}
          data-testid={actionTestId}
        >
          {isActionProcessing ? (
            <>
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              <span>{processingLabel}</span>
            </>
          ) : (
            <span>{actionLabel}</span>
          )}
        </button>

        {/* Close */}
        <button
          onClick={onClose}
          disabled={isActionProcessing}
          className="ml-2 p-2 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-colors disabled:opacity-50"
          title="Exit selection mode"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}

/**
 * BulkRemoveConfirmModal Component (BACKLOG-1719)
 * Confirmation dialog shown before a bulk remove on the active email/text list.
 * Rendered above the details modal (z-[70]) so it sits on top of the floating bar.
 */
interface BulkRemoveConfirmModalProps {
  /** Number of conversations/threads selected. */
  conversationCount: number;
  /** Number of underlying items (emails / texts). */
  itemCount: number;
  /** Noun for a single underlying item, e.g. "email" or "text". */
  itemNoun: string;
  onConfirm: () => void;
  onCancel: () => void;
  isProcessing?: boolean;
}

export function BulkRemoveConfirmModal({
  conversationCount,
  itemCount,
  itemNoun,
  onConfirm,
  onCancel,
  isProcessing = false,
}: BulkRemoveConfirmModalProps): React.ReactElement {
  const convLabel = `${conversationCount} conversation${conversationCount !== 1 ? "s" : ""}`;
  const itemLabel = `${itemCount} ${itemNoun}${itemCount !== 1 ? "s" : ""}`;

  return (
    <ResponsiveModal onClose={onCancel} zIndex="z-[70]" panelClassName="max-w-md p-6">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
          <svg className="w-6 h-6 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </div>
        <h3 className="text-lg font-bold text-gray-900" data-testid="bulk-remove-confirm-title">
          Remove {convLabel} ({itemLabel})?
        </h3>
      </div>
      <p className="text-sm text-gray-600 mb-6">
        The selected {conversationCount !== 1 ? "conversations" : "conversation"} will be moved to the
        &ldquo;Show removed&rdquo; section. You can restore {conversationCount !== 1 ? "them" : "it"} at any time.
      </p>
      <div className="flex items-center gap-3 justify-end">
        <button
          onClick={onCancel}
          disabled={isProcessing}
          className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg font-medium transition-all disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          disabled={isProcessing}
          className="px-4 py-2 bg-red-600 text-white hover:bg-red-700 rounded-lg font-semibold transition-all disabled:opacity-50 flex items-center gap-2"
          data-testid="bulk-remove-confirm-button"
        >
          {isProcessing ? (
            <>
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Removing...
            </>
          ) : (
            <>Remove {convLabel}</>
          )}
        </button>
      </div>
    </ResponsiveModal>
  );
}

export default BulkSelectionBar;
