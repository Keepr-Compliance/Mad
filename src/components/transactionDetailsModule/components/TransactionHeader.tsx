/**
 * TransactionHeader Component
 * Header for transaction details modal with dynamic styling and action buttons
 */
import React from "react";
import type { Transaction } from "@/types";
import { formatAddress } from "@/utils/formatUtils";
import { useNetwork } from "@/contexts/NetworkContext";

interface TransactionHeaderProps {
  transaction: Transaction;
  isPendingReview: boolean;
  isRejected: boolean;
  isApproving: boolean;
  isRejecting: boolean;
  isRestoring: boolean;
  onClose: () => void;
  onShowRejectReasonModal: () => void;
  onShowEditModal: () => void;
  onApprove: () => void;
  onRestore: () => void;
  onShowExportModal: () => void;
  onShowDeleteConfirm: () => void;
  /**
   * @deprecated BACKLOG-2792 — Submit for Review is no longer its own header
   * button; it is reached through Complete, which branches by license. Kept so
   * existing callers still type-check; the header ignores it.
   */
  onShowSubmitModal?: () => void;
  isSubmitting?: boolean;
  /**
   * BACKLOG-2791: outstanding review THREADS — the unit the contract counts
   * badges in. Derived by the parent from the same grouping the review surfaces
   * render, so the badge and the cards behind it cannot disagree.
   *
   * Zero here means zero items too (grouping never turns some items into no
   * groups), which is why the Complete gate can keep counting items and still
   * agree with this badge about whether anything is outstanding.
   */
  reviewCount?: number;
  /** BACKLOG-2791: open the combined Needs Review screen (S2). */
  onShowNeedsReview?: () => void;
  /** BACKLOG-2792: the merged Complete action (gate, then license branch). */
  onComplete?: () => void;
  /**
   * BACKLOG-2849 — does this user need a standalone Export button?
   *
   * TRUE for a brokerage user only. BACKLOG-2792 merged Export and Submit into
   * Complete, which was right for an INDIVIDUAL — their Complete goes straight
   * to the export flow, so the button would be a duplicate — but it left a
   * brokerage user with no way to export at all: their Complete opens the
   * submit confirmation, and reaching a PDF meant re-entering a submit
   * confirmation for a deal they had already submitted. The founder ruled the
   * affordance back for them.
   *
   * The caller derives this from `useCompleteTransaction.resolveTarget()`, the
   * SAME branch that chooses the destination — so the button appears exactly
   * when Complete does NOT already lead to export, and the two can never
   * disagree.
   *
   * BACKLOG-2885 — this doc used to end "that branch fails closed to 'export',
   * so a user whose entitlements are still loading is treated as an individual
   * and simply sees no extra button." That was the founder's bug, written down
   * as if it were the design. It is now true for `"submit"` AND for
   * `"unknown"`: the caller passes `resolveTarget() !== "export"`, and pairs it
   * with `licensePending` below.
   */
  showExport?: boolean;
  /**
   * BACKLOG-2885 — the license class is not known yet, so no action here may be
   * taken and none may be silently withheld.
   *
   * WHY DISABLED RATHER THAN HIDDEN, which was the deliberate choice:
   *
   * The founder's report was "after clicking complete i suddenly saw the export
   * button appear". Hiding the button until the license resolves keeps exactly
   * that: the control set changes shape under the cursor, at the moment of a
   * click, which is how a click lands on a button the user did not mean to
   * press. Rendering it disabled makes a brokerage user's row of controls
   * IDENTICAL before and after the license lands — only the enabled state
   * changes, and an enabled state changing cannot move anything under a cursor.
   *
   * The cost is a genuinely-individual user briefly seeing a disabled Export
   * that then disappears. That is the smaller harm, and it is bounded: the
   * unknown window is one IPC round-trip after login (BACKLOG-2885 made the
   * license re-read on sign-in rather than waiting for a window focus), long
   * before any deal can be open. A disabled control also cannot be clicked, so
   * it can never produce a wrong action — which is precisely what the hidden
   * variant did.
   */
  licensePending?: boolean;
}

export function TransactionHeader({
  transaction,
  isPendingReview,
  isRejected,
  isApproving,
  isRejecting,
  isRestoring,
  onClose,
  onShowRejectReasonModal,
  onShowEditModal,
  onApprove,
  onRestore,
  onShowExportModal,
  onShowDeleteConfirm,
  isSubmitting = false,
  reviewCount = 0,
  onShowNeedsReview,
  onComplete,
  showExport = false,
  licensePending = false,
}: TransactionHeaderProps): React.ReactElement {
  // Determine header style based on state
  const getHeaderStyle = () => {
    if (isPendingReview) return "bg-gradient-to-r from-amber-500 to-orange-500";
    if (isRejected) return "bg-gradient-to-r from-red-500 to-red-600";
    return "bg-gradient-to-r from-green-500 to-teal-600";
  };

  const getHeaderTextStyle = () => {
    if (isPendingReview) return "text-amber-100";
    if (isRejected) return "text-red-100";
    return "text-green-100";
  };

  const getHeaderTitle = () => {
    if (isPendingReview) return "Review Transaction";
    if (isRejected) return "Rejected Transaction";
    return "Transaction Details";
  };

  // Split address into street and city/state/zip for two-line display
  const splitAddress = (address: string) => {
    if (!address) return { street: "", cityStateZip: "" };

    // Try to split at the first comma (street, city state zip)
    const firstCommaIndex = address.indexOf(",");
    if (firstCommaIndex === -1) {
      return { street: address, cityStateZip: "" };
    }

    const street = address.substring(0, firstCommaIndex).trim();
    const cityStateZip = address.substring(firstCommaIndex + 1).trim();

    return { street, cityStateZip };
  };

  const { street, cityStateZip } = splitAddress(formatAddress(transaction.property_address));

  // Close button (X) for desktop
  const CloseButton = ({ className = "" }: { className?: string }) => (
    <button
      onClick={onClose}
      aria-label="Close transaction details"
      data-testid="transaction-details-close"
      className={`text-white hover:bg-white hover:bg-opacity-20 rounded-full p-1 transition-all ${className}`}
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
  );

  // Render the correct action buttons based on transaction state
  const renderActions = () => {
    if (isPendingReview) {
      return (
        <PendingReviewActions
          isRejecting={isRejecting}
          isApproving={isApproving}
          onShowRejectReasonModal={onShowRejectReasonModal}
          onShowEditModal={onShowEditModal}
          onApprove={onApprove}
        />
      );
    }
    if (isRejected) {
      return (
        <RejectedActions
          isRestoring={isRestoring}
          onRestore={onRestore}
          onShowDeleteConfirm={onShowDeleteConfirm}
        />
      );
    }
    return (
      <ActiveActions
        transaction={transaction}
        isSubmitting={isSubmitting}
        reviewCount={reviewCount}
        onShowNeedsReview={onShowNeedsReview ?? (() => undefined)}
        onComplete={onComplete ?? onShowExportModal}
        showExport={showExport}
        licensePending={licensePending}
        onShowExportModal={onShowExportModal}
      />
    );
  };

  return (
    <div
      className={`flex-shrink-0 px-3 sm:px-6 pt-6 sm:pt-4 pb-3 sm:pb-4 sm:rounded-t-xl ${getHeaderStyle()}`}
    >
      {/* Mobile header: matches Transactions page layout */}
      <div className="sm:hidden">
        <div className="flex items-center justify-between">
          <button
            onClick={onClose}
            aria-label="Close transaction details"
            data-testid="transaction-details-close"
            className="text-white hover:bg-white hover:bg-opacity-20 rounded-lg px-2 py-2 transition-all flex items-center gap-1 font-medium text-sm"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            Back
          </button>
          <div className="text-right">
            <h3 className="text-lg font-bold text-white">{getHeaderTitle()}</h3>
            {/* Action buttons under the title */}
            <div className="flex flex-nowrap items-center gap-2 justify-end mt-1">
              {renderActions()}
            </div>
          </div>
        </div>
      </div>

      {/* Desktop header: title + address + actions + close */}
      <div className="hidden sm:flex sm:flex-row sm:flex-nowrap sm:items-center justify-between gap-1 overflow-hidden">
        {/* Title/Address section */}
        <div className="flex-1 min-w-0 overflow-hidden">
          <div className="flex items-center gap-2">
            <h3 className="text-xl font-bold text-white">{getHeaderTitle()}</h3>
            {isPendingReview && (
              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-white/20 text-white">
                Pending Review
              </span>
            )}
            {isRejected && (
              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-white/20 text-white">
                Rejected
              </span>
            )}
          </div>
          <div className={`text-sm ${getHeaderTextStyle()} truncate`}>
            <p className="truncate">{street}</p>
            {cityStateZip && <p className="truncate">{cityStateZip}</p>}
          </div>
        </div>

        {/* Action buttons + close */}
        <div className="flex flex-nowrap items-center gap-2 justify-end flex-shrink-0">
          {renderActions()}
          <CloseButton />
        </div>
      </div>
    </div>
  );
}

// Sub-components for different action sets
function PendingReviewActions({
  isRejecting,
  isApproving,
  onShowRejectReasonModal,
  onShowEditModal,
  onApprove,
}: {
  isRejecting: boolean;
  isApproving: boolean;
  onShowRejectReasonModal: () => void;
  onShowEditModal: () => void;
  onApprove: () => void;
}) {
  return (
    <>
      {/* Reject Button */}
      <button
        onClick={onShowRejectReasonModal}
        disabled={isRejecting}
        className="px-2 sm:px-4 py-2 rounded-lg font-semibold transition-all flex items-center gap-1 sm:gap-2 bg-white text-red-600 hover:bg-opacity-90 shadow-md hover:shadow-lg disabled:opacity-50 text-sm flex-shrink-0"
      >
        {isRejecting ? (
          <div className="w-5 h-5 border-2 border-red-600 border-t-transparent rounded-full animate-spin" />
        ) : (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        )}
        Reject
      </button>
      {/* Edit Button */}
      <button
        onClick={onShowEditModal}
        className="px-2 sm:px-4 py-2 rounded-lg font-semibold transition-all flex items-center gap-1 sm:gap-2 bg-white text-amber-600 hover:bg-opacity-90 shadow-md hover:shadow-lg text-sm flex-shrink-0"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
        </svg>
        Edit
      </button>
      {/* Approve Button */}
      <button
        onClick={onApprove}
        disabled={isApproving}
        className="px-2 sm:px-4 py-2 rounded-lg font-semibold transition-all flex items-center gap-1 sm:gap-2 bg-emerald-500 text-white hover:bg-emerald-600 shadow-md hover:shadow-lg disabled:opacity-50 text-sm flex-shrink-0"
      >
        {isApproving ? (
          <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
        ) : (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        )}
        Approve
      </button>
    </>
  );
}

function RejectedActions({
  isRestoring,
  onRestore,
  onShowDeleteConfirm,
}: {
  isRestoring: boolean;
  onRestore: () => void;
  onShowDeleteConfirm: () => void;
}) {
  return (
    <>
      {/* Restore to Active Button */}
      <button
        onClick={onRestore}
        disabled={isRestoring}
        className="px-2 sm:px-4 py-2 rounded-lg font-semibold transition-all flex items-center gap-1 sm:gap-2 bg-emerald-500 text-white hover:bg-emerald-600 shadow-md hover:shadow-lg disabled:opacity-50 text-sm flex-shrink-0"
      >
        {isRestoring ? (
          <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
        ) : (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        )}
        <span className="hidden sm:inline">Restore to Active</span>
        <span className="sm:hidden">Restore</span>
      </button>
      {/* Delete Button */}
      <button
        onClick={onShowDeleteConfirm}
        className="px-2 sm:px-4 py-2 rounded-lg font-semibold transition-all flex items-center gap-1 sm:gap-2 bg-white text-red-600 hover:bg-opacity-90 shadow-md hover:shadow-lg text-sm flex-shrink-0"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
        </svg>
        Delete
      </button>
    </>
  );
}

function ActiveActions({
  transaction,
  isSubmitting,
  reviewCount,
  onShowNeedsReview,
  onComplete,
  showExport,
  licensePending,
  onShowExportModal,
}: {
  transaction: Transaction;
  isSubmitting: boolean;
  /** BACKLOG-2791: outstanding review items — the ONE count from getReviewState. */
  reviewCount: number;
  onShowNeedsReview: () => void;
  onComplete: () => void;
  /** BACKLOG-2849 — brokerage users only. See TransactionHeaderProps. */
  showExport: boolean;
  /** BACKLOG-2885 — license class not yet known. See TransactionHeaderProps. */
  licensePending: boolean;
  onShowExportModal: () => void;
}) {
  const { isOnline } = useNetwork();
  const isSubmitted = transaction.submission_status === "submitted" ||
    transaction.submission_status === "under_review" ||
    transaction.submission_status === "approved";

  return (
    <>
      {/* B1 · Needs Review (BACKLOG-2791). Hidden entirely when the queue is
          empty (founder ruling 2026-08-22, superseding "always visible") — a
          button that opens an empty screen is a dead control. It reappears the
          moment the count goes above zero, which rides on the same live-refresh
          wiring as every other review surface. Complete stays always visible. */}
      {reviewCount > 0 && (
      <>
      {/* live count badge.
          Opens the combined review screen at any time. The count is the single
          getReviewState total, so it can never disagree with the gate. */}
      <button
        onClick={onShowNeedsReview}
        data-testid="needs-review-button"
        className="relative px-2 sm:px-4 py-2 rounded-lg font-semibold transition-all flex items-center gap-1 sm:gap-2 bg-amber-600 text-white hover:bg-amber-700 shadow-md hover:shadow-lg text-sm flex-shrink-0"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M5 19h14a2 2 0 001.84-2.75L13.74 4a2 2 0 00-3.48 0L3.16 16.25A2 2 0 005 19z" />
        </svg>
        <span className="hidden sm:inline">Needs Review</span>
        <span className="sm:hidden">Review</span>
        <span
          data-testid="needs-review-badge"
          className="ml-0.5 inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-white px-1.5 py-0.5 text-xs font-bold text-amber-700"
        >
          {reviewCount}
        </span>
      </button>
      </>
      )}

      {/* B2 · Complete (BACKLOG-2792) — always visible beside B1. Export and
          Submit for Review are GONE, merged here; the branch by license happens
          inside the handler, after the completeness gate. */}
      {/* BACKLOG-2885 — disabled while the license class is unknown. Complete
          branches on that class (submit for a brokerage user, export for an
          individual), and with no answer yet the only correct behaviour is to
          take neither. It previously took the export branch by default, which
          handed a brokerage user a local file while they believed the deal had
          gone to their broker. The hook refuses the same click independently;
          this is the affordance, that is the lock. */}
      <button
        onClick={onComplete}
        disabled={isSubmitting || licensePending}
        data-testid="complete-button"
        title={
          licensePending
            ? "Checking your license…"
            : !isOnline
              ? "You are offline — export is still available"
              : undefined
        }
        className="px-2 sm:px-4 py-2 rounded-lg font-semibold transition-all flex items-center gap-1 sm:gap-2 bg-blue-600 text-white hover:bg-blue-700 shadow-md hover:shadow-lg disabled:opacity-50 text-sm flex-shrink-0"
      >
        {isSubmitting ? (
          <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
        ) : (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        )}
        Complete
      </button>

      {/* B3 · Export (BACKLOG-2849) — RESTORED for brokerage users.
          Class-for-class the button BACKLOG-2792 removed (BACKLOG-459's
          "Available for ALL license types"; white on green, download glyph,
          the word "Export"), in the same position it held then: after the
          primary action, before the Submitted badge.

          What changed is only WHO sees it. Before 2792 it was unconditional;
          now an individual's Complete already IS the export flow, so showing
          it to them would be two controls for one action.

          No offline gating, exactly as before — the export writes a local
          file and does not need the network. Complete carries the offline
          title because IT may need to reach the broker.

          The label is "Export", not "Export PDF": this opens a format chooser
          (combined PDF by default, folder and summary PDF also offered), and
          it is the same destination the modal's Export button reaches. */}
      {/* BACKLOG-2885 — `showExport` is now true for a brokerage user AND while
          the license class is unknown, with the unknown case rendered disabled.
          A brokerage user therefore sees the same controls throughout, instead
          of watching Export appear the instant the license lands — which is what
          the founder hit, mid-click. See TransactionHeaderProps.licensePending
          for why disabled beat hidden. */}
      {showExport && (
        <button
          onClick={onShowExportModal}
          disabled={licensePending}
          data-testid="header-export-button"
          title={licensePending ? "Checking your license…" : undefined}
          className="px-2 sm:px-4 py-2 rounded-lg font-semibold transition-all flex items-center gap-1 sm:gap-2 bg-white text-green-600 hover:bg-opacity-90 shadow-md hover:shadow-lg disabled:opacity-50 disabled:cursor-not-allowed text-sm flex-shrink-0"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          Export
        </button>
      )}

      {/* Submitted badge stays — it is status, not an action. */}
      {isSubmitted && (
        <span className="px-2 sm:px-4 py-2 rounded-lg font-medium flex items-center gap-1 sm:gap-2 bg-green-100 text-green-700 text-sm flex-shrink-0">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          Submitted
        </span>
      )}
    </>
  );
}
