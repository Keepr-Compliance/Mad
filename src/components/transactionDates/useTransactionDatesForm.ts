/**
 * BACKLOG-3498 — form state and validation for the "Verify Transaction Dates"
 * step, shared by ExportModal and SubmitForReviewModal.
 *
 * Moved out of ExportModal unchanged: the initial values (ExportModal.tsx:37-55
 * at develop 5177d9bed) and the date rule (`datesAreValid`, :196-208).
 */
import { useCallback, useState } from "react";
import type { Transaction } from "@/types";
import type { ConfirmedTransactionDates } from "./saveConfirmedTransactionDates";

/** The row's stored value as a YYYY-MM-DD input value. Timestamps keep their date part. */
function datePart(value: string | null | undefined): string {
  return value ? value.split("T")[0] : "";
}

export function initialTransactionDates(
  transaction: Pick<Transaction, "started_at" | "closing_deadline" | "closed_at">,
): ConfirmedTransactionDates {
  return {
    startDate: datePart(transaction.started_at),
    closingDate: datePart(transaction.closing_deadline),
    endDate: datePart(transaction.closed_at),
  };
}

/**
 * Returns the error to show, or null when the dates can be used.
 *
 * Start and End are required. The End rule compares YYYY-MM-DD strings, so an
 * End Date EQUAL to the Start Date passes; only an End Date before it fails.
 * The message reads "after" for historical reasons and is kept verbatim.
 */
export function validateTransactionDates(
  dates: Pick<ConfirmedTransactionDates, "startDate" | "endDate">,
): string | null {
  if (!dates.startDate || !dates.endDate) {
    return "Please provide Start Date and End Date to continue";
  }
  if (dates.startDate > dates.endDate) {
    return "End Date must be after Start Date";
  }
  return null;
}

export type TransactionDateField = keyof ConfirmedTransactionDates;

export interface TransactionDatesForm {
  dates: ConfirmedTransactionDates;
  setDate: (field: TransactionDateField, value: string) => void;
}

/** Initialised once from the row; later changes to the prop do not reset what was typed. */
export function useTransactionDatesForm(
  transaction: Pick<Transaction, "started_at" | "closing_deadline" | "closed_at">,
): TransactionDatesForm {
  const [dates, setDates] = useState<ConfirmedTransactionDates>(() =>
    initialTransactionDates(transaction),
  );
  const setDate = useCallback((field: TransactionDateField, value: string) => {
    setDates((prev) => ({ ...prev, [field]: value }));
  }, []);
  return { dates, setDate };
}
