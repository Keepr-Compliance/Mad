/**
 * Status History entries — BACKLOG-3477.
 *
 * transaction_submissions.status_history holds two kinds of entry:
 *
 *   status entries  written by the trigger track_submission_status_changes:
 *                   {status, changed_at, changed_by (uuid or null), notes}
 *   typed entries   written by the reviewer RPCs in
 *                   20260925073000_backlog_3477_submission_checklist_review.sql:
 *                   {type, changed_at, changed_by (uuid), ...}, never a `status`
 *                   key (the shared shape ruled in pm_comments bf8c39b4, Q1).
 *                   BACKLOG-3596 adds two, written by the carry-over when a
 *                   new version arrives (changed_by = the resubmitting agent):
 *                     checklist_review_cleared      {reason 'edited'|'removed'
 *                       |'not_carried' (a ticked item of a checklist added at
 *                       review that has no match on the new version),
 *                       item_id, cleared_from_item_id, item_title,
 *                       checklist_name, cleared_reviewer_id,
 *                       cleared_reviewer_checked_at}
 *                     checklist_review_unavailable  {reason 'unmatched_client'
 *                       | 'no_previous_copy'}
 *
 * A typed entry is a muted line in the timeline. It never becomes the
 * "Current" status and never moves the status pill: only status entries do.
 */

export interface StatusHistoryEntry {
  status?: string;
  type?: string;
  changed_at: string;
  /** Raw user id as stored; replaced by a display name before rendering. */
  changed_by?: string | null;
  notes?: string | null;
  reason?: string | null;
  field?: string;
  from?: unknown;
  to?: unknown;
  item_id?: string;
  item_title?: string;
  checklist_name?: string;
  checklist_id?: string;
  template_id?: string;
  cleared_from_item_id?: string;
  cleared_reviewer_id?: string;
  cleared_reviewer_checked_at?: string;
  parentSubmissionId?: string;
}

/** The fallback for an actor who no longer resolves (ruling bf8c39b4, Q4). */
export const FORMER_MEMBER = 'a former member';
export const FORMER_MEMBER_STANDALONE = 'A former member';

export function isTypedEntry(entry: StatusHistoryEntry): boolean {
  return typeof entry.type === 'string' && entry.type.length > 0 && typeof entry.status !== 'string';
}

export function isStatusEntry(entry: StatusHistoryEntry): boolean {
  return typeof entry.status === 'string' && entry.status.length > 0;
}

function tickWord(value: unknown): string {
  return value === true ? 'checked' : 'unchecked';
}

/** Optional cause on a checklist_review_unavailable entry, in plain words. */
const UNAVAILABLE_CAUSES: Record<string, string> = {
  unmatched_client: 'the agent sent it from an older version of Keepr',
  no_previous_copy: 'the previous version’s checklists were not saved',
};

/**
 * The one-line text of a typed entry, e.g. "Title commitment — unchecked → checked".
 * Call it on entries whose changed_by is already a display name
 * (resolveHistoryActors): the carry-over lines name the agent in the sentence.
 */
export function describeTypedEntry(entry: StatusHistoryEntry): string {
  switch (entry.type) {
    case 'checklist_review': {
      const title = entry.item_title || 'Checklist item';
      return `${title} — ${tickWord(entry.from)} → ${tickWord(entry.to)}`;
    }
    case 'checklist_added':
      return `Checklist added: ${entry.checklist_name || 'Checklist'}`;
    case 'checklist_review_cleared': {
      const title = entry.item_title || 'Checklist item';
      const who = entry.changed_by || 'the agent';
      if (entry.reason === 'not_carried') {
        return `${title} — unticked automatically: not on ${who}’s new version`;
      }
      const verb = entry.reason === 'removed' ? 'removed' : 'changed';
      return `${title} — unticked automatically: ${verb} by ${who} since your check`;
    }
    case 'checklist_review_unavailable': {
      const cause = entry.reason ? UNAVAILABLE_CAUSES[entry.reason] : undefined;
      return cause
        ? `Previous review marks could not be carried over (${cause})`
        : 'Previous review marks could not be carried over';
    }
    default:
      return humaniseTypeKey(entry.type);
  }
}

/**
 * A typed entry this portal does not know yet (e.g. a later release's
 * `commission_edit`) reads as its own type, "Commission edit" — never as
 * "Submission updated", which would claim the submission itself changed
 * (coordinator C-D, pm_comments b43086bd).
 */
export function humaniseTypeKey(type: string | undefined): string {
  const words = (type ?? '').replace(/[_-]+/g, ' ').trim().replace(/\s+/g, ' ');
  if (!words) return 'Updated';
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

/**
 * Display names for user ids, or null when names cannot be looked up at all
 * (a read error, or an impersonation session whose client only sees the
 * target user). With null, nobody is labelled a former member.
 */
export type NameMap = ReadonlyMap<string, string> | null;

/**
 * The name to show for an actor id.
 *
 * - no id at all        -> undefined (nothing to attribute; today's status
 *                          entries for "submitted" carry null)
 * - names unavailable   -> undefined (never guess "former")
 * - id not in the map   -> "a former member"
 */
export function actorName(id: string | null | undefined, names: NameMap): string | undefined {
  if (!id) return undefined;
  if (!names) return undefined;
  return names.get(id) ?? FORMER_MEMBER;
}

/** Capitalised form for a label standing on its own. */
export function actorLabel(id: string | null | undefined, names: NameMap): string | undefined {
  const name = actorName(id, names);
  if (name === FORMER_MEMBER) return FORMER_MEMBER_STANDALONE;
  return name;
}

/**
 * One top-level line of the timeline (BACKLOG-3477, founder decision in
 * pm_comments 795ff7c5): a status entry carrying the typed entries that
 * preceded it, or the trailing group of typed entries made after the latest
 * status change.
 */
export type HistoryItem =
  | { kind: 'status'; entry: StatusHistoryEntry; changes: StatusHistoryEntry[] }
  | { kind: 'pending'; changes: StatusHistoryEntry[] };

/**
 * Fold a chronologically sorted timeline into top-level items. Display only:
 * nothing is dropped or reordered. Each typed entry attaches to the NEXT
 * non-typed entry after it; typed entries after the last one form a trailing
 * 'pending' item. A non-typed entry (status or legacy) is its own item.
 */
export function groupHistory(sorted: StatusHistoryEntry[]): HistoryItem[] {
  const items: HistoryItem[] = [];
  let buffer: StatusHistoryEntry[] = [];
  for (const entry of sorted) {
    if (isTypedEntry(entry)) {
      buffer.push(entry);
      continue;
    }
    items.push({ kind: 'status', entry, changes: buffer });
    buffer = [];
  }
  if (buffer.length > 0) items.push({ kind: 'pending', changes: buffer });
  return items;
}

/** "1 checklist change" / "N checklist changes". */
export function checklistChangesLabel(count: number): string {
  return `${count} checklist ${count === 1 ? 'change' : 'changes'}`;
}

/** How many top-level items the timeline shows before "Show full history". */
export const VISIBLE_HISTORY_ITEMS = 4;

/**
 * The broker's review marks on the checklist: the broker's own ticks and the
 * carry-over lines about them. BACKLOG-3596 decision 2 / D4: the agent does not
 * see the broker's ticks, so the agent's timeline leaves these out, on every
 * version of the deal.
 */
export const BROKER_REVIEW_ENTRY_TYPES: readonly string[] = [
  'checklist_review',
  'checklist_review_cleared',
  'checklist_review_unavailable',
];

/** The timeline the agent sees: everything except the broker's review marks. */
export function withoutBrokerReviewEntries(entries: StatusHistoryEntry[]): StatusHistoryEntry[] {
  return entries.filter((entry) => !(isTypedEntry(entry) && BROKER_REVIEW_ENTRY_TYPES.includes(entry.type as string)));
}

/** Replace raw changed_by ids with display names. */
export function resolveHistoryActors(entries: StatusHistoryEntry[], names: NameMap): StatusHistoryEntry[] {
  return entries.map((entry) => ({ ...entry, changed_by: actorName(entry.changed_by, names) }));
}
