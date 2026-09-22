/**
 * BACKLOG-3498 — the ONE renderer writer of `closing_date_verified: 1`.
 *
 * Both routes that ask an agent to confirm a transaction's dates save them
 * here: ExportModal's Export press and SubmitForReviewModal's Submit press.
 * Keeping a single writer is the point — a second copy of this payload is how
 * the two flows would drift apart without any test noticing.
 *
 * The payload is transcribed from ExportModal.handleExport as it stood before
 * the extraction (develop 5177d9bed, ExportModal.tsx:323-328).
 */
import { transactionService } from "../../services";
import type { ApiResult } from "../../services/transactionService";

/** The three dates the "Verify Transaction Details" step collects. */
export interface ConfirmedTransactionDates {
  /** Start Date → `started_at`. YYYY-MM-DD. Required. */
  startDate: string;
  /** Closing Date → `closing_deadline`. YYYY-MM-DD, or "" when not given. */
  closingDate: string;
  /** End Date → `closed_at`. YYYY-MM-DD. Required. */
  endDate: string;
}

/**
 * The exact update this writer sends. A `type` (not an `interface`) so it is
 * assignable to `TransactionUpdatePayload`'s index signature, and so a
 * misspelled key is a compile error here — `transactionService.update` itself
 * accepts `[key: string]: unknown` and cannot catch one.
 */
type ConfirmedDatesUpdate = {
  started_at: string;
  closing_deadline: string | null;
  closed_at: string;
  closing_date_verified: 1;
};

export async function saveConfirmedTransactionDates(
  transactionId: string,
  dates: ConfirmedTransactionDates,
): Promise<ApiResult> {
  const update: ConfirmedDatesUpdate = {
    started_at: dates.startDate,
    closing_deadline: dates.closingDate || null,
    closed_at: dates.endDate,
    closing_date_verified: 1,
  };
  return transactionService.update(transactionId, update);
}
