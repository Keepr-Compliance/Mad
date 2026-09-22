/**
 * BACKLOG-3498 — the "Verify Transaction Dates" block, ONE component rendered
 * by both ExportModal (Step 1) and SubmitForReviewModal (its date step).
 *
 * Moved out of ExportModal (develop 5177d9bed, ExportModal.tsx:553-708)
 * without changing its markup. Two slots keep Export's extras out of the shared
 * block: `headerAction` (Export's "Export format" button, beside the heading)
 * and `meta` (Export's last-exported line, under the explanation).
 *
 * It sets no panel width, so it fits both Export's MODAL_PANEL.lg frame and the
 * Submit dialog's `max-w-md`.
 */
import React from "react";
import type { Transaction } from "@/types";
import type { ConfirmedTransactionDates } from "./saveConfirmedTransactionDates";
import type { TransactionDateField } from "./useTransactionDatesForm";

interface TransactionDatesFieldsProps {
  transaction: Pick<
    Transaction,
    | "representation_start_confidence"
    | "closing_date_confidence"
    | "first_communication_date"
    | "last_communication_date"
  >;
  dates: ConfirmedTransactionDates;
  onDateChange: (field: TransactionDateField, value: string) => void;
  /** Rendered at the right of the heading row. */
  headerAction?: React.ReactNode;
  /** Rendered under the explanation paragraph. */
  meta?: React.ReactNode;
}

const formatConfidence = (confidence?: number) => {
  if (!confidence) return null;
  if (confidence >= 80)
    return { text: "High", color: "text-green-600 bg-green-50" };
  if (confidence >= 50)
    return { text: "Medium", color: "text-yellow-600 bg-yellow-50" };
  return { text: "Low", color: "text-red-600 bg-red-50" };
};

export function TransactionDatesFields({
  transaction,
  dates,
  onDateChange,
  headerAction,
  meta,
}: TransactionDatesFieldsProps): React.ReactElement {
  return (
    <div className="space-y-6">
      <div>
        {/* BACKLOG-334 (founder QA 2026-09-19): title left, button right,
            the same header row the emails/texts tabs use —
            TransactionEmailsTab.tsx:667 (container) and :675 (button
            group). The button is shown only with saved defaults. */}
        <div className="flex justify-between items-center mb-4">
          <h4 className="text-lg font-semibold text-gray-900">
            Verify Transaction Dates
          </h4>
          {headerAction}
        </div>
        <p className="text-sm text-gray-600 mb-2">
          Communications will be filtered to only include those between
          Start Date and End Date.
        </p>
        {meta}
      </div>

      <div className="space-y-4">
        {/* Start Date */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block text-sm font-medium text-gray-700">
              Start Date *
            </label>
            {transaction.representation_start_confidence &&
              formatConfidence(
                transaction.representation_start_confidence,
              ) && (
                <span
                  className={`text-xs px-2 py-1 rounded ${formatConfidence(transaction.representation_start_confidence)!.color}`}
                >
                  Confidence:{" "}
                  {
                    formatConfidence(
                      transaction.representation_start_confidence,
                    )!.text
                  }
                </span>
              )}
          </div>
          <input
            type="date"
            value={dates.startDate}
            onChange={(e) => onDateChange("startDate", e.target.value)}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 text-gray-900 bg-white min-h-[44px]"
          />
          <p className="mt-1 text-xs text-gray-500">
            When did you sign the representation agreement with the
            client?
          </p>
        </div>

        {/* Closing Date (optional) */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block text-sm font-medium text-gray-700">
              Closing Date
            </label>
            {transaction.closing_date_confidence &&
              formatConfidence(transaction.closing_date_confidence) && (
                <span
                  className={`text-xs px-2 py-1 rounded ${formatConfidence(transaction.closing_date_confidence)!.color}`}
                >
                  Confidence:{" "}
                  {
                    formatConfidence(
                      transaction.closing_date_confidence,
                    )!.text
                  }
                </span>
              )}
          </div>
          <input
            type="date"
            value={dates.closingDate}
            onChange={(e) => onDateChange("closingDate", e.target.value)}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 text-gray-900 bg-white min-h-[44px]"
          />
          <p className="mt-1 text-xs text-gray-500">
            Scheduled closing date (optional)
          </p>
        </div>

        {/* End Date */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block text-sm font-medium text-gray-700">
              End Date *
            </label>
          </div>
          <input
            type="date"
            value={dates.endDate}
            onChange={(e) => onDateChange("endDate", e.target.value)}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 text-gray-900 bg-white min-h-[44px]"
          />
          <p className="mt-1 text-xs text-gray-500">
            When did the transaction end? (Used to filter communications)
          </p>
        </div>
      </div>

      {transaction.first_communication_date &&
        transaction.last_communication_date && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <p className="text-sm font-medium text-blue-900 mb-2">
              Communication Date Range
            </p>
            <p className="text-xs text-blue-700">
              We found communications from{" "}
              <span className="font-semibold">
                {new Date(
                  transaction.first_communication_date,
                ).toLocaleDateString()}
              </span>{" "}
              to{" "}
              <span className="font-semibold">
                {new Date(
                  transaction.last_communication_date,
                ).toLocaleDateString()}
              </span>
            </p>
          </div>
        )}
    </div>
  );
}

export default TransactionDatesFields;
