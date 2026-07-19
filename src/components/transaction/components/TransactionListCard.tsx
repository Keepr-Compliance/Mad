/**
 * TransactionListCard Component
 * Card display for a single transaction in the transaction list
 * Includes detection badges, quick export, and selection checkbox
 */
import React from "react";
import type { Transaction } from "../../../../electron/types/models";
import {
  DetectionSourceBadge,
  ConfidencePill,
  PendingReviewBadge,
} from "./DetectionBadges";
// Note: formatCommunicationCounts is available in TransactionCard.tsx but UI uses inline JSX for thread labels
import { SubmissionStatusBadge } from "../../transactionDetailsModule/components/SubmissionStatusBadge";
import { FeatureGate } from "../../common/FeatureGate";
import { formatLastExported } from "../../../utils/formatUtils";

// ============================================
// SVG ICONS (matching TransactionTabs)
// ============================================

/** Chat bubble icon for messages/texts - matches TransactionTabs */
const MessagesIcon = (): React.ReactElement => (
  <svg
    className="w-4 h-4"
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
);

/** Envelope icon for emails - matches TransactionTabs */
const EmailsIcon = (): React.ReactElement => (
  <svg
    className="w-4 h-4"
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
);

// ============================================
// TYPES
// ============================================

export interface TransactionListCardProps {
  transaction: Transaction;
  selectionMode: boolean;
  isSelected: boolean;
  onTransactionClick: (transaction: Transaction) => void;
  onCheckboxClick: (e: React.MouseEvent, transactionId: string) => void;
  onQuickExport: (transaction: Transaction, e: React.MouseEvent) => void;
  /** Handler for clicking the messages count - opens transaction on Messages tab */
  onMessagesClick?: (transaction: Transaction, e: React.MouseEvent) => void;
  /** Handler for clicking the emails count - opens transaction on Emails tab */
  onEmailsClick?: (transaction: Transaction, e: React.MouseEvent) => void;
  formatCurrency: (amount: number | undefined) => string;
  formatDate: (dateString: string | Date | undefined) => string;
}

// ============================================
// TRANSACTION LIST CARD COMPONENT
// ============================================

/**
 * TransactionListCard - BACKLOG-1096: Wrapped with React.memo
 */
const TransactionListCardInner = function TransactionListCard({
  transaction,
  selectionMode,
  isSelected,
  onTransactionClick,
  onCheckboxClick,
  onQuickExport,
  onMessagesClick,
  onEmailsClick,
  formatCurrency,
  formatDate,
}: TransactionListCardProps): React.ReactElement {
  // BACKLOG-396: Use text_thread_count (stored) instead of text_count (computed dynamically)
  // This ensures consistency between card view and details page
  const textCount = transaction.text_thread_count || 0;
  const emailCount = transaction.email_count || 0;
  const lastExported = formatLastExported(transaction);
  return (
    <div
      className={`bg-white border-2 rounded-xl p-6 transition-all cursor-pointer transform hover:scale-[1.01] ${
        selectionMode && isSelected
          ? "border-purple-500 bg-purple-50 shadow-lg"
          : "border-gray-200 hover:border-blue-400 hover:shadow-xl"
      }`}
      onClick={() => onTransactionClick(transaction)}
    >
      <div className="flex items-start justify-between gap-4">
        {/* Selection Checkbox */}
        {selectionMode && (
          <div
            className="flex-shrink-0 mt-1"
            onClick={(e) => onCheckboxClick(e, transaction.id)}
          >
            <div
              className={`w-6 h-6 rounded-md border-2 flex items-center justify-center transition-all ${
                isSelected
                  ? "bg-purple-500 border-purple-500"
                  : "border-gray-300 hover:border-purple-400"
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
        <div className="flex-1">
          <div className="flex items-center justify-between gap-2 mb-1">
            <div className="flex items-center gap-2 min-w-0">
              <h3 className="font-semibold text-gray-900 truncate">
                {transaction.property_address}
              </h3>
              {/* Detection Status Badges - AI add-on only (BACKLOG-462) */}
              <FeatureGate requires="ai_addon">
                <div className="flex items-center gap-1.5">
                  <DetectionSourceBadge source={transaction.detection_source} />
                  {transaction.detection_source === "auto" &&
                    transaction.detection_confidence !== undefined && (
                      <ConfidencePill
                        confidence={transaction.detection_confidence}
                      />
                    )}
                  {transaction.detection_status === "pending" && (
                    <PendingReviewBadge />
                  )}
                </div>
              </FeatureGate>
              {/* Submission Status Badge (BACKLOG-392) */}
              {transaction.submission_status && transaction.submission_status !== "not_submitted" && (
                <SubmissionStatusBadge status={transaction.submission_status} />
              )}
            </div>
            {/* BACKLOG-2109: light last-exported affordance, to the RIGHT of the
                address (founder QA). Only when the deal has ever been exported. */}
            {lastExported && (
              <span
                className="text-xs text-gray-400 flex-shrink-0"
                data-testid="tx-last-exported"
              >
                {lastExported}
              </span>
            )}
          </div>
          <div className="flex items-center gap-4 text-sm text-gray-600">
            {transaction.transaction_type && (
              <span className="flex items-center gap-1">
                <span
                  className={`w-2 h-2 rounded-full ${
                    transaction.transaction_type === "purchase"
                      ? "bg-green-500"
                      : "bg-blue-500"
                  }`}
                ></span>
                {transaction.transaction_type === "purchase"
                  ? "Purchase"
                  : "Sale"}
              </span>
            )}
            {transaction.sale_price && (
              <span className="font-semibold text-gray-900">
                {formatCurrency(transaction.sale_price)}
              </span>
            )}
            {transaction.closed_at && (
              <span className="flex items-center gap-1">
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                  />
                </svg>
                Closed: {formatDate(transaction.closed_at)}
              </span>
            )}
          </div>
          <div className="mt-2 flex items-center gap-3 text-xs text-gray-500">
            <button
              onClick={(e) => onMessagesClick?.(transaction, e)}
              className="flex items-center gap-1 hover:text-blue-600 transition-colors"
              title="View messages"
            >
              <MessagesIcon />
              <span>{textCount} {textCount === 1 ? "Text thread" : "Text threads"}</span>
            </button>
            <button
              onClick={(e) => onEmailsClick?.(transaction, e)}
              className="flex items-center gap-1 hover:text-blue-600 transition-colors"
              title="View emails"
            >
              <EmailsIcon />
              <span>{emailCount} {emailCount === 1 ? "Email thread" : "Email threads"}</span>
            </button>
            {transaction.extraction_confidence && (
              <span className="flex items-center gap-1">
                <div className="w-16 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-500 rounded-full"
                    style={{
                      width: `${transaction.extraction_confidence}%`,
                    }}
                  ></div>
                </div>
                {transaction.extraction_confidence}% confidence
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Quick Export Button */}
          <button
            onClick={(e) => onQuickExport(transaction, e)}
            className="px-3 py-2 rounded-lg font-semibold transition-all flex items-center gap-2 bg-green-500 text-white hover:bg-green-600 shadow-md hover:shadow-lg"
            title="Quick Export"
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
                d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
              />
            </svg>
            Export
          </button>
          <svg
            className="w-5 h-5 text-gray-400"
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
      </div>
    </div>
  );
}

export const TransactionListCard = React.memo(TransactionListCardInner);

export default TransactionListCard;
