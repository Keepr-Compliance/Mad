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
 * BACKLOG-3966: the private checklist ("My items") is no exception — adding,
 * renaming, reordering or removing one of the agent's own items is refused on a
 * locked deal too (SR plan review ruling 4: locked means locked).
 */
import { dbGet } from "./db/core/dbConnection";
import {
  TRANSACTION_SUBMISSION_STATUS_SQL,
  COMMUNICATION_TRANSACTION_ID_SQL,
  MESSAGE_TRANSACTION_ID_SQL,
  CHECKLIST_ITEM_TRANSACTION_ID_SQL,
  CHECKLIST_LINK_TRANSACTION_ID_SQL,
} from "./db/core/transactionEligibilitySql";
import { isPrivateChecklist } from "./db/checklistPrivacy";
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
  // BACKLOG-3966: the private checklist's own item edits.
  | "add-my-item"
  | "rename-my-item"
  | "reorder-my-items"
  | "remove-my-item"
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

/**
 * Where a checklist item or evidence group sits: its deal (for the lock) and
 * whether its checklist is the private one (for the per-checklist plan gate,
 * BACKLOG-3966). Null when the id names no row.
 */
export interface ChecklistTargetScope {
  transactionId: string;
  isPrivate: boolean;
}

function toScope(
  row: { transaction_id: string | null; template_id: string | null } | undefined,
): ChecklistTargetScope | null {
  if (!row?.transaction_id) return null;
  return { transactionId: row.transaction_id, isPrivate: isPrivateChecklist(row.template_id) };
}

/** BACKLOG-3910 (slice d) / BACKLOG-3966: a checklist item's deal and privacy, or null. */
export function getChecklistItemScope(itemId: string): ChecklistTargetScope | null {
  return toScope(
    dbGet<{ transaction_id: string | null; template_id: string | null }>(
      CHECKLIST_ITEM_TRANSACTION_ID_SQL,
      [itemId],
    ),
  );
}

/** BACKLOG-3910 (slice d) / BACKLOG-3966: a checklist evidence group's deal and privacy, or null. */
export function getChecklistLinkScope(linkId: string): ChecklistTargetScope | null {
  return toScope(
    dbGet<{ transaction_id: string | null; template_id: string | null }>(
      CHECKLIST_LINK_TRANSACTION_ID_SQL,
      [linkId],
    ),
  );
}
