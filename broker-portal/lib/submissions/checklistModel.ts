/**
 * The review page's view of a submission's checklists — BACKLOG-3477.
 *
 * Pure: no Supabase, safe for client components. Rows are the frozen copy
 * tables written by snapshot_submission_checklists (desktop, at submit) and
 * add_submission_checklist_at_review (portal, at review).
 *
 * COUNTS ARE THE AGENT'S TICKS. "x of y required" counts `is_checked` on
 * `is_required` items — what the agent submitted — not the reviewer's layer
 * (mock v4: Contract "4 of 6 required"; an added section "0 of 2").
 */

export interface ChecklistLinkMember {
  kind: 'attachment' | 'email' | string;
  submissionAttachmentId: string | null;
  submissionMessageId: string | null;
}

export interface ChecklistLink {
  id: string;
  kind: 'attachment' | 'email' | string;
  label: string;
  members: ChecklistLinkMember[];
}

export interface ChecklistItemView {
  id: string;
  title: string;
  description: string | null;
  isRequired: boolean;
  /** The agent's tick, frozen at submit. Read-only here. */
  isChecked: boolean;
  /** The agent's note, frozen at submit. Read-only here. */
  note: string | null;
  reviewerChecked: boolean;
  reviewerCheckedBy: string | null;
  reviewerCheckedAt: string | null;
  links: ChecklistLink[];
}

export interface ChecklistSectionView {
  id: string;
  templateId: string | null;
  name: string;
  /** Set when a reviewer added this checklist at review. */
  addedAtReviewBy: string | null;
  addedAtReviewAt: string | null;
  items: ChecklistItemView[];
}

export interface RequiredCount {
  done: number;
  total: number;
}

export function requiredCount(items: ChecklistItemView[]): RequiredCount {
  let done = 0;
  let total = 0;
  for (const item of items) {
    if (!item.isRequired) continue;
    total += 1;
    if (item.isChecked) done += 1;
  }
  return { done, total };
}

export function overallRequiredCount(sections: ChecklistSectionView[]): RequiredCount {
  return sections.reduce<RequiredCount>(
    (acc, section) => {
      const c = requiredCount(section.items);
      return { done: acc.done + c.done, total: acc.total + c.total };
    },
    { done: 0, total: 0 }
  );
}

export function formatRequired(count: RequiredCount): string {
  return `${count.done} of ${count.total} required`;
}

/** Statuses in which the tick RPC accepts a change (§7 of the migration). */
export const TICK_OPEN_STATUSES: readonly string[] = ['submitted', 'resubmitted', 'under_review', 'needs_changes'];
/** Statuses in which the add RPC accepts a checklist (§8 of the migration). */
export const ADD_OPEN_STATUSES: readonly string[] = ['submitted', 'resubmitted', 'under_review'];
/**
 * Statuses in which a review decision (Approve, Request Changes, Reject) is
 * still a live choice: the version has not been sent back already
 * (needs_changes) and is not decided (approved, rejected). BACKLOG-3592: the
 * one source of truth for the review bar, the Request Changes hint, the
 * checklist banner, and the WHERE on the decision write.
 */
export const DECISION_OPEN_STATUSES: readonly string[] = ['submitted', 'resubmitted', 'under_review'];

/** Whether a version in this status is open for a review decision. */
export function isOpenForDecision(status: string): boolean {
  return DECISION_OPEN_STATUSES.includes(status);
}

/**
 * Whether this viewer is actually offered Request Changes on this submission
 * (coordinator ruling on the added-at-review banner, BACKLOG-3477 fix round).
 * `canDecide` is false for a tick-only reviewer (it_admin) and during support
 * impersonation.
 */
export function requestChangesAvailable(status: string, canDecide: boolean): boolean {
  return canDecide && isOpenForDecision(status);
}

/**
 * Whether a row carries the reviewer pill (ruling bf8c39b4, Q7): required
 * rows and rows the agent checked. Never in a checklist added at review — its
 * items are for the agent's next version and the tick RPC refuses them.
 */
export function showsReviewerPill(section: ChecklistSectionView, item: ChecklistItemView): boolean {
  if (section.addedAtReviewBy) return false;
  return item.isRequired || item.isChecked;
}

export interface TemplateOption {
  id: string;
  name: string;
}
