/**
 * Checklist link helpers — BACKLOG-3476.
 *
 * Pure functions the Checklist tab and its link picker share. Nothing here
 * decides whether evidence may be linked — main does that, all-or-nothing, in
 * `addChecklistLink`. These only decide what the renderer OFFERS, and every
 * rule below can only offer less than main would accept, never more.
 */
import type {
  ChecklistDetail,
  ChecklistLink,
  ChecklistLinkMember,
} from "../../../../electron/types/checklist";
import type { UnifiedAttachment } from "../hooks/useTransactionAllAttachments";
import type { Communication } from "../types";
import {
  processEmailThreads,
  threadMatchReason,
  type EmailThread,
} from "../components/EmailThreadCard";

/**
 * Attachments the picker may offer.
 *
 * `getTransactionAllAttachments` has a third arm that reaches a legacy text
 * attachment through `external_message_id` alone — its `message_id` and
 * `email_id` are both NULL. Main's membership check
 * (`electron/services/db/checklistSql.ts`, `targetsInTransactionSql`) has no
 * such arm, so offering the row would only lead to a refusal. The current
 * schema's CHECK forbids the shape, so these rows exist only in databases
 * created before it, and `attachmentDbService` back-fills `message_id` when the
 * fallback read runs.
 */
export function linkableAttachments(attachments: UnifiedAttachment[]): UnifiedAttachment[] {
  return attachments.filter((a) => a.email_id !== null || a.message_id !== null);
}

/**
 * Email threads the picker may offer: exactly the Emails tab's "Linked
 * emails" list (SR condition 12).
 *
 * Traced, not assumed:
 * - `transactions:getCommunications(txn, "email")` reads
 *   `getCommunicationsWithMessages` (`communicationDbService.ts:824`), which
 *   selects from `communications` only. Emails found by the scan and waiting
 *   for review live in the review queue's own table (the three-table note at
 *   `reviewStateSql.ts:13-15`), so they are never in this list.
 * - The review queue's LEGACY arm — linked rows the matcher could not justify
 *   by address — IS in this list. The Emails tab drops threads made only of
 *   those with `threadMatchReason(t) !== "needs_review"`
 *   (`TransactionEmailsTab.tsx:352-355`), and so does this.
 *
 * Both stores are described in prose, not named: the review state has one
 * read path, and `reviewStateService.singleReadPath-2791.test.ts` fails any
 * other shipped file that spells the table or the predicate.
 *
 * Grouping is the tab's own (`processEmailThreads`): `thread_id` first, the
 * normalized subject when it is NULL, one group per email otherwise.
 */
export function linkableThreads(emailCommunications: Communication[]): EmailThread[] {
  return processEmailThreads(emailCommunications).filter(
    (t) => threadMatchReason(t) !== "needs_review",
  );
}

/** How an evidence group reads on the checklist. */
export interface ChipState {
  /** Nothing in the group is still on this transaction. */
  stale: boolean;
  /** Members no longer on the transaction (0 when fully live). */
  staleCount: number;
  /** Where "Open in …" goes: the first member still on the transaction. */
  jumpTarget: ChecklistLinkMember | null;
}

/**
 * A group is stale only when NO member is still on the transaction (SR
 * condition 7). A thread with one of three emails unlinked still has two
 * pieces of evidence, and its jump goes to the first of them.
 */
export function chipState(link: ChecklistLink): ChipState {
  const live = link.members.filter((m) => m.inTransaction);
  return {
    stale: live.length === 0,
    staleCount: link.members.length - live.length,
    jumpTarget: live[0] ?? null,
  };
}

/** What a change of template would clear, counted from the current detail. */
export interface ChecklistLoss {
  ticked: number;
  notes: number;
  links: number;
}

export function checklistLoss(detail: ChecklistDetail): ChecklistLoss {
  return {
    ticked: detail.items.filter((i) => i.isChecked).length,
    notes: detail.items.filter((i) => (i.note ?? "").trim().length > 0).length,
    links: Object.values(detail.linksByItemId).reduce((n, links) => n + links.length, 0),
  };
}

export function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
