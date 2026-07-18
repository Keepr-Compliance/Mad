/**
 * TransactionMobileCard Component
 * Compact card display for transactions on mobile screens (< 640px)
 *
 * Shows: property address, status badge, stage, last activity date,
 * communication counts. Tap opens transaction detail.
 *
 * TASK-1440: Mobile-first responsive transaction view
 */
import React from "react";
import type { Transaction } from "@/types";
import { formatAddress, formatLastExported } from "@/utils/formatUtils";
import { ManualEntryBadge } from "./TransactionStatusWrapper";
import { SubmissionStatusBadge } from "../../transactionDetailsModule/components/SubmissionStatusBadge";
import { UnlockBadge } from "./UnlockBadge";

// ============================================
// TYPES
// ============================================

export interface TransactionMobileCardProps {
  transaction: Transaction;
  selectionMode: boolean;
  isSelected: boolean;
  onTransactionClick: () => void;
  onCheckboxClick: (e: React.MouseEvent) => void;
  formatDate: (dateString: string | Date | null | undefined) => string;
  /**
   * BACKLOG-2090: whether this transaction is confirmed-unlocked on this device.
   * Resolved by the list from the batch unlocked-ids Set. Defaults to false
   * (fail-closed — no badge / shows lock when unknown).
   */
  isUnlocked?: boolean;
}

// ============================================
// STATUS HELPERS
// ============================================

function getStatusDisplay(transaction: Transaction): {
  label: string;
  colorClass: string;
} {
  const detectionStatus = transaction.detection_status;
  const status = transaction.status;

  if (detectionStatus === "pending" || status === "pending") {
    return { label: "Pending", colorClass: "bg-amber-100 text-amber-800" };
  }
  if (detectionStatus === "rejected") {
    return { label: "Rejected", colorClass: "bg-red-100 text-red-800" };
  }
  if (status === "closed") {
    return { label: "Closed", colorClass: "bg-gray-100 text-gray-800" };
  }
  return { label: "Active", colorClass: "bg-green-100 text-green-800" };
}

// ============================================
// MOBILE CARD COMPONENT
// ============================================

function TransactionMobileCardInner({
  transaction,
  selectionMode,
  isSelected,
  onTransactionClick,
  onCheckboxClick,
  formatDate,
  isUnlocked = false,
}: TransactionMobileCardProps): React.ReactElement {
  const textCount = transaction.text_thread_count || 0;
  const emailCount = transaction.email_count || 0;
  const statusDisplay = getStatusDisplay(transaction);
  const lastExported = formatLastExported(transaction);

  // Determine the most recent activity date
  const lastActivity = transaction.updated_at || transaction.created_at;

  return (
    <div
      className={`bg-white rounded-xl border-2 p-4 transition-all cursor-pointer active:scale-[0.98] ${
        selectionMode && isSelected
          ? "border-blue-500 bg-blue-50 shadow-md"
          : "border-gray-200 shadow-sm active:shadow-md"
      }`}
      onClick={onTransactionClick}
    >
      <div className="flex items-start gap-3">
        {/* Selection checkbox */}
        {selectionMode && (
          <div
            className="flex-shrink-0 mt-0.5"
            onClick={onCheckboxClick}
          >
            <div
              className={`w-6 h-6 rounded-md border-2 flex items-center justify-center transition-all ${
                isSelected
                  ? "bg-blue-500 border-blue-500"
                  : "border-gray-300"
              }`}
            >
              {isSelected && (
                <svg
                  className="w-4 h-4 text-white"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={3}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              )}
            </div>
          </div>
        )}

        {/* Card content */}
        <div className="flex-1 min-w-0">
          {/* Row 1: Address + chevron */}
          <div className="flex items-start justify-between gap-2">
            <h3 className="font-semibold text-gray-900 text-sm leading-tight truncate">
              {formatAddress(transaction.property_address)}
            </h3>
            <svg
              className="w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5"
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

          {/* Row 2: Status badge + manual badge + submission status */}
          <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${statusDisplay.colorClass}`}
            >
              {statusDisplay.label}
            </span>
            <ManualEntryBadge source={transaction.detection_source} />
            {/* BACKLOG-2090: at-a-glance unlock status */}
            <UnlockBadge isUnlocked={isUnlocked} />
            {transaction.submission_status &&
              transaction.submission_status !== "not_submitted" && (
                <SubmissionStatusBadge
                  status={transaction.submission_status}
                />
              )}
            {transaction.transaction_type && (
              <span className="inline-flex items-center gap-1 text-xs text-gray-500">
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    transaction.transaction_type === "purchase"
                      ? "bg-green-500"
                      : "bg-blue-500"
                  }`}
                />
                {transaction.transaction_type === "purchase"
                  ? "Purchase"
                  : "Sale"}
              </span>
            )}
          </div>

          {/* Row 3: Communication counts + last activity */}
          <div className="flex items-center justify-between mt-2 text-xs text-gray-500">
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1">
                <svg
                  className="w-3.5 h-3.5"
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
                {emailCount}
              </span>
              <span className="flex items-center gap-1">
                <svg
                  className="w-3.5 h-3.5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                  />
                </svg>
                {textCount}
              </span>
            </div>
            {lastActivity && (
              <span className="text-gray-400">
                {formatDate(lastActivity)}
              </span>
            )}
          </div>

          {/* Row 4: last-exported affordance (BACKLOG-2109) — light, only when
              the deal has ever been exported. */}
          {lastExported && (
            <div
              className="mt-1 text-xs text-gray-400"
              data-testid="tx-last-exported"
            >
              {lastExported}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export const TransactionMobileCard = React.memo(TransactionMobileCardInner);
export default TransactionMobileCard;
