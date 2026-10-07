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
  /**
   * BACKLOG-3607: set on an item of a checklist the broker added back; its
   * reviewer tick (if any) was restored from the previous version.
   */
  restoredFromItemId?: string | null;
}

export interface ChecklistSectionView {
  id: string;
  templateId: string | null;
  name: string;
  /** Set when a reviewer added this checklist at review. */
  addedAtReviewBy: string | null;
  addedAtReviewAt: string | null;
  items: ChecklistItemView[];
  /**
   * BACKLOG-3607: set when a reviewer removed this checklist at review. The
   * rows stay (the record of what the agent sent); the section is shown as
   * removed and counts toward nothing. Absent before the 3607 migration.
   */
  removedAtReviewBy?: string | null;
  removedAtReviewAt?: string | null;
  /** BACKLOG-3607: the previous version's checklist this one was added back from. */
  restoredFromChecklistId?: string | null;
}

/** Whether a section was removed at review (BACKLOG-3607). */
export function isRemovedSection(section: ChecklistSectionView): boolean {
  return !!section.removedAtReviewBy;
}

/**
 * The key the server matches checklists on across versions (the carry's and
 * the restore's): the template id, or the name for a checklist with no template.
 */
export function sectionKey(section: ChecklistSectionView): string {
  return section.templateId ?? `name:${section.name}`;
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

/** The overall count. A checklist removed at review counts toward nothing (BACKLOG-3607). */
export function overallRequiredCount(sections: ChecklistSectionView[], viewer: ChecklistViewer): RequiredCount {
  return sections.reduce<RequiredCount>(
    (acc, section) => {
      if (isRemovedSection(section)) return acc;
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

/** Documents and emails linked to one checklist on this version (BACKLOG-3607). */
export interface LinkedCounts {
  documents: number;
  emails: number;
}

/**
 * What the broker's Remove confirmation states, counted by the same rule as
 * remove_submission_checklist_at_review (migration 20260929120000 §6): per
 * link member, the local id of its upload or message; a member with no local
 * id is not counted; distinct ids per member kind. One file uploaded twice is
 * one document. The maps are id -> local id from the page's UNGATED
 * submission_attachments / submission_messages rows.
 */
export function linkedEvidenceCounts(
  section: ChecklistSectionView,
  localIdByAttachment: ReadonlyMap<string, string | null>,
  localIdByMessage: ReadonlyMap<string, string | null>
): LinkedCounts {
  const documents = new Set<string>();
  const emails = new Set<string>();
  for (const item of section.items) {
    for (const link of item.links) {
      for (const m of link.members) {
        const key =
          (m.submissionAttachmentId ? localIdByAttachment.get(m.submissionAttachmentId) : null) ??
          (m.submissionMessageId ? localIdByMessage.get(m.submissionMessageId) : null) ??
          null;
        if (!key) continue;
        if (m.kind === 'attachment') documents.add(key);
        else if (m.kind === 'email') emails.add(key);
      }
    }
  }
  return { documents: documents.size, emails: emails.size };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One checklist the agent removed between versions, read from THIS version's history. */
export interface AgentRemoval {
  key: string;
  name: string;
  /** Raw id of who wrote the entry (the agent); resolve to a name before showing. */
  changedBy: string | null;
  /** The removed checklist had been added at review on the previous version. */
  addedAtReview: boolean;
  /**
   * The previous version's checklist id, passed to the restore RPC. Read from
   * history the agent can write (SR R-5): untrusted; the RPC re-validates it.
   * null when absent or not an id: the page offers no "Add it back".
   */
  removedChecklistId: string | null;
}

/**
 * The agent's removals recorded on THIS version (entries checklist_removed,
 * source 'version', written by the carry). Only this version's own
 * status_history: the parent chain's entries are earlier versions' removals.
 * A 'replaced' removal is not listed: the checklist is on this version again.
 */
export function agentRemovals(history: unknown): AgentRemoval[] {
  if (!Array.isArray(history)) return [];
  const out: AgentRemoval[] = [];
  const seen = new Set<string>();
  for (const e of history as Record<string, unknown>[]) {
    if (!e || typeof e !== 'object') continue;
    if (e.type !== 'checklist_removed' || e.source !== 'version' || e.replaced === true) continue;
    if (typeof e.checklist_key !== 'string' || e.checklist_key === '' || seen.has(e.checklist_key)) continue;
    seen.add(e.checklist_key);
    out.push({
      key: e.checklist_key,
      name: typeof e.checklist_name === 'string' && e.checklist_name !== '' ? e.checklist_name : 'Checklist',
      changedBy: typeof e.changed_by === 'string' ? e.changed_by : null,
      addedAtReview: e.added_at_review === true,
      removedChecklistId:
        typeof e.removed_checklist_id === 'string' && UUID_RE.test(e.removed_checklist_id) ? e.removed_checklist_id : null,
    });
  }
  return out;
}
