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
  /**
   * BACKLOG-3607 fields on checklist_added / checklist_removed. History is
   * written by the agent too (the carry runs as the agent), so every value
   * is checked before use; none is trusted to have the type written here.
   */
  source?: unknown;
  checklist_key?: unknown;
  from_version?: unknown;
  removed_checklist_id?: unknown;
  added_at_review?: unknown;
  after_broker_removal?: unknown;
  replaced?: unknown;
  parent_had_none?: unknown;
  readded?: unknown;
  restored?: unknown;
  restored_from_version?: unknown;
  ticks_restored?: unknown;
  linked_documents?: unknown;
  linked_emails?: unknown;
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
      return describeChecklistAdded(entry);
    case 'checklist_removed':
      return describeChecklistRemoved(entry);
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

/** A whole count from an entry, or null when absent or not a count. */
function countField(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** The previous version's number on a version entry, or null. */
function fromVersion(entry: StatusHistoryEntry): number | null {
  const n = countField(entry.from_version);
  return n !== null && n >= 1 ? n : null;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "3 documents and 2 emails", "1 document", "2 emails", or null for none. */
export function linkedPhrase(documents: number, emails: number): string | null {
  const parts: string[] = [];
  if (documents > 0) parts.push(plural(documents, 'document', 'documents'));
  if (emails > 0) parts.push(plural(emails, 'email', 'emails'));
  return parts.length > 0 ? parts.join(' and ') : null;
}

/**
 * BACKLOG-3607, checklist_added:
 *   source 'version'  written by the carry as the agent: the checklist is on
 *                     the new version and was not on the previous one
 *   restored          the broker added back a checklist the agent removed
 *   readded           the broker undid their own removal on this version
 *   otherwise         the broker added one at review (BACKLOG-3477, unchanged)
 */
function describeChecklistAdded(entry: StatusHistoryEntry): string {
  const name = entry.checklist_name || 'Checklist';
  if (entry.source === 'version') {
    const from = fromVersion(entry);
    const onNew = from !== null ? `version ${from + 1}` : 'the new version';
    if (entry.parent_had_none === true) {
      // The previous version had no checklist at all: an older desktop may
      // not have sent any, so this makes no claim that the agent added it.
      return from !== null
        ? `${name} — on version ${from + 1}, not on version ${from}`
        : `${name} — on this version, not on the previous one`;
    }
    if (entry.after_broker_removal === true) return `${name} is on ${onNew} although it was removed at review`;
    if (entry.replaced === true) return `Checklist added again in ${onNew}, with different items: ${name}`;
    return `Checklist added in ${onNew}: ${name}`;
  }
  if (entry.restored === true) {
    // ticks_restored is absent on the agent's timeline (withoutBrokerReviewEntries).
    const ticks = countField(entry.ticks_restored);
    if (ticks === null) return `Checklist added back: ${name}`;
    if (ticks === 0) return `Checklist added back: ${name} (no earlier checks to restore)`;
    return `Checklist added back: ${name} (${plural(ticks, 'earlier check', 'earlier checks')} restored)`;
  }
  if (entry.readded === true) return `Checklist removal undone: ${name}`;
  return `Checklist added: ${name}`;
}

/**
 * BACKLOG-3607, checklist_removed:
 *   source 'version'  written by the carry as the agent: the checklist was on
 *                     the previous version and is not on the new one
 *   source 'review'   the broker removed it at review
 */
function describeChecklistRemoved(entry: StatusHistoryEntry): string {
  const name = entry.checklist_name || 'Checklist';
  if (entry.source === 'version') {
    const from = fromVersion(entry);
    const onNew = from !== null ? `version ${from + 1}` : 'the new version';
    if (entry.added_at_review === true) return `${name}, added at review, is not on ${onNew}`;
    if (entry.replaced === true) return `Checklist removed in ${onNew}, then added again with different items: ${name}`;
    return `Checklist removed in ${onNew}: ${name}`;
  }
  const linked = linkedPhrase(countField(entry.linked_documents) ?? 0, countField(entry.linked_emails) ?? 0);
  return linked ? `Checklist removed: ${name} (${linked} linked)` : `Checklist removed: ${name}`;
}

/**
 * Whether the timeline names who wrote this entry ("by <name>"). A cleared
 * line names the agent in its sentence; a neutral "not on version N" line
 * (parent_had_none) makes no claim about who added the checklist.
 */
export function showsActor(entry: StatusHistoryEntry): boolean {
  if (entry.type === 'checklist_review_cleared') return false;
  if (entry.type === 'checklist_added' && entry.source === 'version' && entry.parent_had_none === true) return false;
  return true;
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

/**
 * The timeline the agent sees: everything except the broker's review marks.
 * BACKLOG-3607: an "added back" entry keeps its line but loses its count of
 * the broker's restored ticks, which the agent does not see (D4).
 */
export function withoutBrokerReviewEntries(entries: StatusHistoryEntry[]): StatusHistoryEntry[] {
  return entries
    .filter((entry) => !(isTypedEntry(entry) && BROKER_REVIEW_ENTRY_TYPES.includes(entry.type as string)))
    .map((entry) => {
      if (!('ticks_restored' in entry)) return entry;
      const { ticks_restored: _hidden, ...rest } = entry;
      void _hidden;
      return rest;
    });
}

/** Replace raw changed_by ids with display names. */
export function resolveHistoryActors(entries: StatusHistoryEntry[], names: NameMap): StatusHistoryEntry[] {
  return entries.map((entry) => ({ ...entry, changed_by: actorName(entry.changed_by, names) }));
}
