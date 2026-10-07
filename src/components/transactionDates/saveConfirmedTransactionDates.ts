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
import type { CommissionUpdate } from "./commission";

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
} & Partial<CommissionUpdate>;

/**
 * BACKLOG-3683 — the confirmed dates as the row stores them. The ONE place the
 * form's dates become `started_at` / `closed_at`: the save below sends this,
 * and the submit summary's scope preview sends the same object's two dates,
 * so the preview counts exactly the window the submission will read back.
 */
export function confirmedDatesUpdate(dates: ConfirmedTransactionDates): {
  started_at: string;
  closing_deadline: string | null;
  closed_at: string;
  closing_date_verified: 1;
} {
  return {
    started_at: dates.startDate,
    closing_deadline: dates.closingDate || null,
    closed_at: dates.endDate,
    closing_date_verified: 1,
  };
}

export async function saveConfirmedTransactionDates(
  transactionId: string,
  dates: ConfirmedTransactionDates,
  /**
   * BACKLOG-3520 — the commission figures from the same step, saved in the SAME
   * update so the dates and the figures land together or not at all. Omit for a
   * host that captures no commission (the payload is then unchanged).
   */
  commission?: CommissionUpdate | null,
): Promise<ApiResult> {
  const update: ConfirmedDatesUpdate = {
    ...confirmedDatesUpdate(dates),
    ...(commission ?? {}),
  };
  return transactionService.update(transactionId, update);
}
