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

/** The one-line text of a typed entry, e.g. "Title commitment — unchecked → checked". */
export function describeTypedEntry(entry: StatusHistoryEntry): string {
  switch (entry.type) {
    case 'checklist_review': {
      const title = entry.item_title || 'Checklist item';
      return `${title} — ${tickWord(entry.from)} → ${tickWord(entry.to)}`;
    }
    case 'checklist_added':
      return `Checklist added: ${entry.checklist_name || 'Checklist'}`;
    default:
      return 'Submission updated';
  }
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

/** Replace raw changed_by ids with display names. */
export function resolveHistoryActors(entries: StatusHistoryEntry[], names: NameMap): StatusHistoryEntry[] {
  return entries.map((entry) => ({ ...entry, changed_by: actorName(entry.changed_by, names) }));
}
