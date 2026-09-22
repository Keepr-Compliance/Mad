/**
 * BACKLOG-3498 — the "Verify Transaction Details" block, ONE component rendered
 * by both ExportModal (Step 1) and SubmitForReviewModal (its date step).
 *
 * Moved out of ExportModal (develop 5177d9bed, ExportModal.tsx:553-708). Two
 * slots keep Export's extras out of the shared block: `headerAction` (Export's
 * "Export format" button, beside the heading) and `meta` (Export's
 * last-exported line, under the explanation).
 *
 * Founder design changes (2026-09-21, same PR): the heading reads "Verify
 * Transaction Details"; each field's helper sentence is an InfoTooltip beside
 * its label instead of a line under the input (texts unchanged); the
 * "Communication Date Range" box is gone. `hideHeading` lets the Submit dialog,
 * whose own title already reads "Verify Transaction Details" on this screen,
 * skip the duplicate heading. Export keeps it.
 *
 * It sets no panel width, so it fits both Export's MODAL_PANEL.lg frame and the
 * Submit dialog's `max-w-md`.
 */
import React from "react";
import type { Transaction } from "@/types";
import { InfoTooltip } from "../common/InfoTooltip";
import type { ConfirmedTransactionDates } from "./saveConfirmedTransactionDates";
import type { TransactionDateField } from "./useTransactionDatesForm";

/** The block's heading, and the Submit dialog's title on its date screen. One literal for both. */
export const VERIFY_TRANSACTION_DETAILS_TITLE = "Verify Transaction Details";

/**
 * Each field's helper sentence, shown in the InfoTooltip beside its label.
 * Verbatim from the lines that used to sit under the inputs.
 */
const TRANSACTION_DATE_HELP: Record<TransactionDateField, string> = {
  startDate: "When did you sign the representation agreement with the client?",
  closingDate: "Scheduled closing date (optional)",
  endDate: "When did the transaction end? (Used to filter communications)",
};

interface TransactionDatesFieldsProps {
  transaction: Pick<
    Transaction,
    "representation_start_confidence" | "closing_date_confidence"
  >;
  dates: ConfirmedTransactionDates;
  onDateChange: (field: TransactionDateField, value: string) => void;
  /** Rendered at the right of the heading row. */
  headerAction?: React.ReactNode;
  /** Rendered under the explanation paragraph. */
  meta?: React.ReactNode;
  /**
   * Skip the "Verify Transaction Details" heading because the host already
   * titles the screen with it (the Submit dialog). A `headerAction` still
   * renders.
   */
  hideHeading?: boolean;
}

/**
 * A field label with its helper sentence in an InfoTooltip beside it. The
 * tooltip is a SIBLING of the `<label>`, not inside it: a `<label>` is not one
 * of InfoTooltip's interactive hosts, so the icon is its own tab stop either
 * way, and keeping it outside means the label's text stays exactly the label.
 */
function FieldLabel({ text, help }: { text: string; help: string }): React.ReactElement {
  return (
    <div className="flex items-center" data-testid="transaction-date-label">
      <label className="block text-sm font-medium text-gray-700">{text}</label>
      <InfoTooltip text={help} />
    </div>
  );
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
  hideHeading = false,
}: TransactionDatesFieldsProps): React.ReactElement {
  return (
    <div className="space-y-6">
      <div>
        {/* BACKLOG-334 (founder QA 2026-09-19): title left, button right,
            the same header row the emails/texts tabs use —
            TransactionEmailsTab.tsx:667 (container) and :675 (button
            group). The button is shown only with saved defaults. */}
        {(!hideHeading || headerAction) && (
          <div className="flex justify-between items-center mb-4">
            {!hideHeading && (
              <h4 className="text-lg font-semibold text-gray-900">
                {VERIFY_TRANSACTION_DETAILS_TITLE}
              </h4>
            )}
            {headerAction}
          </div>
        )}
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
            <FieldLabel text="Start Date *" help={TRANSACTION_DATE_HELP.startDate} />
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
        </div>

        {/* Closing Date (optional) */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <FieldLabel text="Closing Date" help={TRANSACTION_DATE_HELP.closingDate} />
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
        </div>

        {/* End Date */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <FieldLabel text="End Date *" help={TRANSACTION_DATE_HELP.endDate} />
          </div>
          <input
            type="date"
            value={dates.endDate}
            onChange={(e) => onDateChange("endDate", e.target.value)}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 text-gray-900 bg-white min-h-[44px]"
          />
        </div>
      </div>
    </div>
  );
}

export default TransactionDatesFields;
