import React from "react";
import type { Transaction } from "@/types";
import { ManualEntryBadge } from "./TransactionStatusWrapper";
import { UnlockBadge } from "./UnlockBadge";
import { formatLastExported } from "@/utils/formatUtils";

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
// UTILITY FUNCTIONS
// ============================================

/**
 * Formats email and text counts into a human-readable string.
 * Handles singular/plural grammar. Always shows both counts for design consistency.
 *
 * @example
 * formatCommunicationCounts(5, 0) // "5 email threads, 0 Texts"
 * formatCommunicationCounts(0, 3) // "0 email threads, 3 Texts"
 * formatCommunicationCounts(8, 4) // "8 email threads, 4 Texts"
 * formatCommunicationCounts(1, 1) // "1 email thread, 1 Text"
 * formatCommunicationCounts(0, 0) // "0 email threads, 0 Texts"
 */
export function formatCommunicationCounts(
  emailCount: number,
  textCount: number
): string {
  const emailPart = `${emailCount} ${emailCount === 1 ? "email thread" : "email threads"}`;
  const textPart = `${textCount} ${textCount === 1 ? "Text" : "Texts"}`;

  return `${emailPart}, ${textPart}`;
}

// ============================================
// TRANSACTION CARD COMPONENT
// ============================================

export interface TransactionCardProps {
  /** The transaction data to display */
  transaction: Transaction;
  /** Whether selection mode is active */
  selectionMode: boolean;
  /** Whether this transaction is currently selected */
  isSelected: boolean;
  /** Handler for clicking the transaction card */
  onTransactionClick: () => void;
  /** Handler for clicking the selection checkbox */
  onCheckboxClick: (e: React.MouseEvent) => void;
  /** Handler for clicking the messages count - opens transaction on Messages tab */
  onMessagesClick?: (e: React.MouseEvent) => void;
  /** Handler for clicking the emails count - opens transaction on Emails tab */
  onEmailsClick?: (e: React.MouseEvent) => void;
  /** Function to format currency values */
  formatCurrency: (amount: number | null | undefined) => string;
  /** Function to format date values */
  formatDate: (dateString: string | Date | null | undefined) => string;
  /**
   * BACKLOG-2090: whether this transaction is confirmed-unlocked on this device,
   * or `undefined` while the batch unlock status is still loading (⇒ no badge).
   */
  isUnlocked?: boolean | undefined;
}

/**
 * TransactionCard Component
 *
 * Renders a single transaction card with:
 * - Selection checkbox (in selection mode)
 * - Property address with manual entry badge
 * - Transaction type, price, and closing date
 * - Email count and confidence indicator
 * - Arrow indicator for navigation
 *
 * This component is used inside TransactionStatusWrapper
 * which provides the status header styling.
 */
function TransactionCard({
  transaction,
  selectionMode,
  isSelected,
  onTransactionClick,
  onCheckboxClick,
  onMessagesClick,
  onEmailsClick,
  formatCurrency,
  formatDate,
  isUnlocked,
}: TransactionCardProps): React.ReactElement {
  // BACKLOG-396: Use text_thread_count (stored) instead of text_count (computed dynamically)
  // This ensures consistency between card view and details page
  const textCount = transaction.text_thread_count || 0;
  const emailCount = transaction.email_count || 0;
  const lastExported = formatLastExported(transaction);
  return (
    <div
      className={`bg-white p-6 hover:shadow-xl transition-all cursor-pointer ${
        selectionMode && isSelected ? "bg-blue-50" : ""
      }`}
      onClick={onTransactionClick}
    >
      <div className="flex items-start justify-between gap-4">
        {/* Selection checkbox */}
        {selectionMode && (
          <div
            className="flex-shrink-0 mt-1"
            onClick={onCheckboxClick}
          >
            <div
              className={`w-6 h-6 rounded-md border-2 flex items-center justify-center transition-all ${
                isSelected
                  ? "bg-blue-500 border-blue-500"
                  : "border-gray-300 hover:border-blue-400"
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
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-semibold text-gray-900">
              {transaction.property_address}
            </h3>
            {/* Manual badge for manually entered transactions */}
            <ManualEntryBadge source={transaction.detection_source} />
            {/* BACKLOG-2090: at-a-glance unlock status */}
            <UnlockBadge isUnlocked={isUnlocked} />
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
              onClick={onMessagesClick}
              className="flex items-center gap-1 hover:text-blue-600 transition-colors"
              title="View messages"
            >
              <MessagesIcon />
              <span>{textCount} {textCount === 1 ? "Text thread" : "Text threads"}</span>
            </button>
            <button
              onClick={onEmailsClick}
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
            {/* BACKLOG-2109: light last-exported affordance */}
            {lastExported && (
              <span className="text-gray-400" data-testid="tx-last-exported">
                {lastExported}
              </span>
            )}
          </div>
        </div>
        {/* Arrow indicator */}
        <div className="flex items-center">
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

export default TransactionCard;
