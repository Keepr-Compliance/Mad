/**
 * The review page's view of a submission's checklists — BACKLOG-3477.
 *
 * Pure: no Supabase, safe for client components. Rows are the frozen copy
 * tables written by snapshot_submission_checklists (desktop, at submit) and
 * add_submission_checklist_at_review (portal, at review).
 *
 * WHOSE TICKS COUNT DEPENDS ON WHO IS LOOKING (BACKLOG-3596, founder design):
 * the broker page counts and shows the BROKER's ticks (`reviewer_checked`);
 * the agent's own view (My Transactions, BACKLOG-3593) counts and shows the
 * AGENT's ticks (`is_checked`). Neither side sees the other's ticks.
 */

/** Who is looking: the broker review page, or the agent's own view. */
export type ChecklistViewer = 'reviewer' | 'agent';

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
  /** The agent's tick, frozen at submit. Shown only to the agent. */
  isChecked: boolean;
  /** The agent's note, frozen at submit. Read-only here. */
  note: string | null;
  reviewerChecked: boolean;
  reviewerCheckedBy: string | null;
  reviewerCheckedAt: string | null;
  /**
   * BACKLOG-3596: set when a reviewer's tick on the previous version did not
   * carry over because the agent changed the item. null before the 3596
   * migration is applied.
   */
  clearedReviewerId: string | null;
  clearedAt: string | null;
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

/** The tick this viewer sees on an item: the broker's, or the agent's own. */
export function tickFor(item: ChecklistItemView, viewer: ChecklistViewer): boolean {
  return viewer === 'agent' ? item.isChecked : item.reviewerChecked;
}

export function requiredCount(items: ChecklistItemView[], viewer: ChecklistViewer): RequiredCount {
  let done = 0;
  let total = 0;
  for (const item of items) {
    if (!item.isRequired) continue;
    total += 1;
    if (tickFor(item, viewer)) done += 1;
  }
  return { done, total };
}

export function overallRequiredCount(sections: ChecklistSectionView[], viewer: ChecklistViewer): RequiredCount {
  return sections.reduce<RequiredCount>(
    (acc, section) => {
      const c = requiredCount(section.items, viewer);
      return { done: acc.done + c.done, total: acc.total + c.total };
    },
    { done: 0, total: 0 }
  );
}

export function formatRequired(count: RequiredCount): string {
  return `${count.done} of ${count.total} required`;
}

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
 * Whether a section's items carry the broker's checkbox (BACKLOG-3596): every
 * item, except in a checklist added at review — its items are for the agent's
 * next version and the tick RPC refuses them.
 */
export function hasReviewerCheckbox(section: ChecklistSectionView): boolean {
  return !section.addedAtReviewBy;
}

/**
 * Whether the broker can tick on this version (BACKLOG-3596). Only while it is
 * open for a decision, and never once a newer version exists: the tick RPC
 * refuses a superseded version (42501 superseded), and a tick there would never
 * reach the newer version. On needs_changes the version is closed, the same
 * as Add checklist.
 */
export function tickOpenFor(status: string, supersededBy: SupersededBy): boolean {
  return isOpenForDecision(status) && supersededBy === null;
}

/**
 * Whether a newer version of this submission exists: 'newer' when one has
 * arrived, 'uploading' when one is still being sent, null when this is the
 * newest.
 */
export type SupersededBy = 'newer' | 'uploading' | null;

/** Whether an item shows "Changed since you checked" (broker view only). */
export function changedSinceChecked(item: ChecklistItemView): boolean {
  return item.clearedReviewerId !== null && !item.reviewerChecked;
}

export interface TemplateOption {
  id: string;
  name: string;
}
