/**
 * BACKLOG-3910 (slice b): read a deal's locked state from the database.
 *
 * The rule (which statuses lock, and why) is `dealLockReason` in
 * `transactionEligibility.ts`; this module only reads the column it needs.
 * Used as the backstop at every AUTOMATIC writer of a deal link or a Needs
 * Review row, so a caller nobody enumerated still cannot add to a locked deal.
 * User actions (manual attach, approving a review item, restoring a rejected
 * one) do not ask.
 */
import { dbGet } from "./db/core/dbConnection";
import { TRANSACTION_SUBMISSION_STATUS_SQL } from "./db/core/transactionEligibilitySql";
import { dealLockReason, type DealLockReason } from "./transactionEligibility";

export function getDealLockReason(transactionId: string): DealLockReason | null {
  const row = dbGet<{ submission_status: string | null }>(
    TRANSACTION_SUBMISSION_STATUS_SQL,
    [transactionId],
  );
  return dealLockReason(row?.submission_status);
}
