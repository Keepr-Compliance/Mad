/**
 * BACKLOG-3910 (slice b): read a deal's locked state from the database.
 *
 * The rule (which statuses lock, and why) is `dealLockReason` in
 * `transactionEligibility.ts`; this module only reads the column it needs.
 * Used as the backstop at every AUTOMATIC writer of a deal link or a Needs
 * Review row, so a caller nobody enumerated still cannot add to a locked deal.
 *
 * `refuseIfDealLocked` is the gate on the USER edits the founder ruled out on a
 * locked deal (2026-10-11): adding a contact, and attaching emails or texts by
 * hand. Both lock reasons are read-only for those edits. Approving or
 * restoring a Needs Review item does not ask.
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

/** The user edits a locked deal refuses (BACKLOG-3910, founder 2026-10-11). */
export type DealLockedEdit = "add-contact" | "attach-emails" | "attach-texts";

const REFUSAL_TEXT: Readonly<Record<DealLockReason, string>> = {
  submitted: "This deal is with your broker for review, so it can't be changed until it's returned to you.",
  sealed: "This deal is sealed, so it can't be changed.",
};

/**
 * The handler-level gate. Returns the response to send back when the deal is
 * locked (submitted or sealed), or `null` when the edit may go ahead.
 */
export function refuseIfDealLocked(
  transactionId: string,
  edit: DealLockedEdit,
): { success: false; error: string; dealLocked: DealLockReason; refusedEdit: DealLockedEdit } | null {
  const reason = getDealLockReason(transactionId);
  if (reason === null) return null;
  return { success: false, error: REFUSAL_TEXT[reason], dealLocked: reason, refusedEdit: edit };
}
