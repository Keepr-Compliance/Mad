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
 * Slice d (founder 2026-10-12): also every checklist edit (add or take off a
 * checklist, tick, note, link or unlink evidence, include outside the dates)
 * and every deal-detail edit through `transactions:update`.
 */
import { dbGet } from "./db/core/dbConnection";
import {
  TRANSACTION_SUBMISSION_STATUS_SQL,
  COMMUNICATION_TRANSACTION_ID_SQL,
  MESSAGE_TRANSACTION_ID_SQL,
  CHECKLIST_ITEM_TRANSACTION_ID_SQL,
  CHECKLIST_LINK_TRANSACTION_ID_SQL,
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
  | "reject-review"
  | "hide-text"
  | "unhide-text"
  // Slice d (founder 2026-10-12): checklists and deal details.
  | "add-checklist"
  | "take-off-checklist"
  | "tick-checklist-item"
  | "edit-checklist-note"
  | "link-checklist-item"
  | "unlink-checklist-item"
  | "include-outside-dates"
  | "edit-deal-details"
  | "change-status";

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

/**
 * Founder 2026-10-12: an approved deal can still be CLOSED. This is the one
 * allowance on a locked deal, and it is narrow: the deal's submission status is
 * `approved` (so not submitted, under review or resubmitted) and the change is
 * the deal status set to `closed`, nothing else.
 */
function isCloseOfApprovedDeal(transactionId: string, status: unknown): boolean {
  if (status !== "closed") return false;
  const row = dbGet<{ submission_status: string | null }>(
    TRANSACTION_SUBMISSION_STATUS_SQL,
    [transactionId],
  );
  return row?.submission_status === "approved";
}

/** `transactions:update` gate: locked deals refuse everything except a status-only close of an approved deal. */
export function refuseUpdateIfDealLocked(
  transactionId: string,
  updates: unknown,
): ReturnType<typeof refuseIfDealLocked> {
  const refusal = refuseIfDealLocked(transactionId, "edit-deal-details");
  if (refusal === null) return null;
  const record = updates && typeof updates === "object" ? (updates as Record<string, unknown>) : {};
  const keys = Object.keys(record);
  if (keys.length === 1 && keys[0] === "status" && isCloseOfApprovedDeal(transactionId, record.status)) {
    return null;
  }
  return refusal;
}

/** `transactions:bulk-update-status` gate, per deal: same rule as `refuseUpdateIfDealLocked`. */
export function refuseStatusChangeIfDealLocked(
  transactionId: string,
  status: unknown,
): ReturnType<typeof refuseIfDealLocked> {
  const refusal = refuseIfDealLocked(transactionId, "change-status");
  if (refusal === null) return null;
  return isCloseOfApprovedDeal(transactionId, status) ? null : refusal;
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

/** BACKLOG-3910 (slice d): the deal a checklist item belongs to, or null. */
export function getChecklistItemTransactionId(itemId: string): string | null {
  const row = dbGet<{ transaction_id: string | null }>(CHECKLIST_ITEM_TRANSACTION_ID_SQL, [itemId]);
  return row?.transaction_id ?? null;
}

/** BACKLOG-3910 (slice d): the deal a checklist evidence group belongs to, or null. */
export function getChecklistLinkTransactionId(linkId: string): string | null {
  const row = dbGet<{ transaction_id: string | null }>(CHECKLIST_LINK_TRANSACTION_ID_SQL, [linkId]);
  return row?.transaction_id ?? null;
}
