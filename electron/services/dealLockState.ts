/**
 * BACKLOG-3910 (slice b): read a deal's locked state from the database.
 *
 * The rule (which statuses lock, and why) is `dealLockReason` in
 * `transactionEligibility.ts`; this module only reads the column it needs.
 * Used as the backstop at every AUTOMATIC writer of a deal link or a Needs
 * Review row, so a caller nobody enumerated still cannot add to a locked deal.
 *
 * `refuseIfDealLocked` is the gate on the USER edits the founder ruled out on a
 * locked deal (2026-10-11): a locked deal is fully read-only. Both lock reasons
 * refuse adding or removing a contact, attaching or removing emails and texts,
 * restoring a removed item, and approving or rejecting a Needs Review item.
 */
import { dbGet } from "./db/core/dbConnection";
import {
  TRANSACTION_SUBMISSION_STATUS_SQL,
  COMMUNICATION_TRANSACTION_ID_SQL,
  MESSAGE_TRANSACTION_ID_SQL,
} from "./db/core/transactionEligibilitySql";
import { dealLockReason, type DealLockReason } from "./transactionEligibility";

export function getDealLockReason(transactionId: string): DealLockReason | null {
  const row = dbGet<{ submission_status: string | null }>(
    TRANSACTION_SUBMISSION_STATUS_SQL,
    [transactionId],
  );
  return dealLockReason(row?.submission_status);
}

/** The user edits a locked deal refuses (BACKLOG-3910, founder 2026-10-11). */
export type DealLockedEdit =
  | "add-contact"
  | "remove-contact"
  | "attach-emails"
  | "remove-emails"
  | "attach-texts"
  | "remove-texts"
  | "approve-review"
  | "reject-review";

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

/** Same gate over several deals; the first locked one refuses the whole call. */
export function refuseIfAnyDealLocked(
  transactionIds: readonly (string | null | undefined)[],
  edit: DealLockedEdit,
): ReturnType<typeof refuseIfDealLocked> {
  for (const id of new Set(transactionIds)) {
    if (!id) continue;
    const refusal = refuseIfDealLocked(id, edit);
    if (refusal) return refusal;
  }
  return null;
}

/** The deal a linked communication (email) row belongs to, or null. */
export function getCommunicationTransactionId(communicationId: string): string | null {
  const row = dbGet<{ transaction_id: string | null }>(COMMUNICATION_TRANSACTION_ID_SQL, [
    communicationId,
  ]);
  return row?.transaction_id ?? null;
}

/** The deals these text messages are linked to. */
export function getMessageTransactionIds(messageIds: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of messageIds) {
    const row = dbGet<{ transaction_id: string | null }>(MESSAGE_TRANSACTION_ID_SQL, [id]);
    if (row?.transaction_id) out.push(row.transaction_id);
  }
  return out;
}
