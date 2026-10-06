/**
 * Read a submission's checklists for the review page — BACKLOG-3477.
 *
 * Four reads of the copy tables (RLS: submitter, or can_review_submission of
 * the submission's organization) plus the organization's non-archived
 * templates for the Add picker. Any read error fails the whole section: the
 * page says the checklists could not be loaded rather than rendering a
 * partial list that looks complete.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ChecklistItemView,
  ChecklistLink,
  ChecklistSectionView,
  TemplateOption,
} from './checklistModel';
import { readAllRows } from '@/lib/supabase/readAllRows';

interface HeaderRow {
  id: string;
  template_id: string | null;
  template_name: string;
  sort_order: number;
  added_at_review_by: string | null;
  added_at_review_at: string | null;
  /** BACKLOG-3607 columns; absent until that migration is applied. */
  removed_at_review_by?: string | null;
  removed_at_review_at?: string | null;
  restored_from_checklist_id?: string | null;
}

interface ItemRow {
  id: string;
  submission_checklist_id: string;
  title: string;
  description: string | null;
  is_required: boolean;
  is_checked: boolean;
  note: string | null;
  sort_order: number;
  reviewer_checked: boolean;
  reviewer_checked_by: string | null;
  reviewer_checked_at: string | null;
  /** BACKLOG-3596 columns; absent until that migration is applied. */
  cleared_reviewer_id?: string | null;
  cleared_at?: string | null;
  /** BACKLOG-3607 column; absent until that migration is applied. */
  restored_from_item_id?: string | null;
}

interface LinkRow {
  id: string;
  submission_checklist_item_id: string;
  kind: string;
  label: string;
  sort_order: number;
}

interface MemberRow {
  link_id: string;
  kind: string;
  submission_attachment_id: string | null;
  submission_message_id: string | null;
}

export type SubmissionChecklistsResult =
  | { ok: true; sections: ChecklistSectionView[] }
  | { ok: false };

export function assembleSections(
  headers: HeaderRow[],
  items: ItemRow[],
  links: LinkRow[],
  members: MemberRow[]
): ChecklistSectionView[] {
  const membersByLink = new Map<string, MemberRow[]>();
  for (const m of members) {
    const list = membersByLink.get(m.link_id) ?? [];
    list.push(m);
    membersByLink.set(m.link_id, list);
  }

  const linksByItem = new Map<string, ChecklistLink[]>();
  for (const l of [...links].sort((a, b) => a.sort_order - b.sort_order)) {
    const list = linksByItem.get(l.submission_checklist_item_id) ?? [];
    list.push({
      id: l.id,
      kind: l.kind,
      label: l.label,
      members: (membersByLink.get(l.id) ?? []).map((m) => ({
        kind: m.kind,
        submissionAttachmentId: m.submission_attachment_id,
        submissionMessageId: m.submission_message_id,
      })),
    });
    linksByItem.set(l.submission_checklist_item_id, list);
  }

  const itemsByHeader = new Map<string, ChecklistItemView[]>();
  for (const i of [...items].sort((a, b) => a.sort_order - b.sort_order)) {
    const list = itemsByHeader.get(i.submission_checklist_id) ?? [];
    list.push({
      id: i.id,
      title: i.title,
      description: i.description,
      isRequired: i.is_required,
      isChecked: i.is_checked,
      note: i.note,
      reviewerChecked: i.reviewer_checked,
      reviewerCheckedBy: i.reviewer_checked_by,
      reviewerCheckedAt: i.reviewer_checked_at,
      clearedReviewerId: i.cleared_reviewer_id ?? null,
      clearedAt: i.cleared_at ?? null,
      links: linksByItem.get(i.id) ?? [],
      // BACKLOG-3607: only when the column was read.
      ...(i.restored_from_item_id !== undefined ? { restoredFromItemId: i.restored_from_item_id } : {}),
    });
    itemsByHeader.set(i.submission_checklist_id, list);
  }

  return [...headers]
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((h) => ({
      id: h.id,
      templateId: h.template_id,
      name: h.template_name,
      addedAtReviewBy: h.added_at_review_by,
      addedAtReviewAt: h.added_at_review_at,
      items: itemsByHeader.get(h.id) ?? [],
      // BACKLOG-3607: only when the columns were read.
      ...(h.removed_at_review_by !== undefined
        ? {
            removedAtReviewBy: h.removed_at_review_by,
            removedAtReviewAt: h.removed_at_review_at ?? null,
            restoredFromChecklistId: h.restored_from_checklist_id ?? null,
          }
        : {}),
    }));
}

const ITEM_COLUMNS =
  'id, submission_checklist_id, title, description, is_required, is_checked, note, sort_order, reviewer_checked, reviewer_checked_by, reviewer_checked_at';
/** BACKLOG-3596: read when the migration is live. */
const CLEARED_COLUMNS = ', cleared_reviewer_id, cleared_at';

/**
 * PostgREST's answer to a select naming a column the table does not have
 * (transcribed 2026-09-28 from the live API, before the 3596 migration):
 * {"code":"42703","message":"column submission_checklist_items.cleared_reviewer_id does not exist"}
 */
type PgError = { code?: string; message?: string } | null;

function isMissingClearedColumn(raw: unknown): boolean {
  const error = raw as PgError;
  return !!error && error.code === '42703' && /cleared_(reviewer_id|at)/.test(error.message ?? '');
}

/** BACKLOG-3607: read when that migration is live. */
const RESTORED_ITEM_COLUMNS = ', restored_from_item_id';
const HEADER_COLUMNS = 'id, template_id, template_name, sort_order, added_at_review_by, added_at_review_at';
const REMOVED_HEADER_COLUMNS = ', removed_at_review_by, removed_at_review_at, restored_from_checklist_id';

/** The same PostgREST 42703 answer, for a 3607 column (named in the message). */
function isMissing3607Column(raw: unknown): boolean {
  const error = raw as PgError;
  return (
    !!error &&
    error.code === '42703' &&
    /removed_at_review_(by|at)|restored_from_(checklist|item)_id/.test(error.message ?? '')
  );
}

/**
 * The items, with the 3596 cleared columns and the 3607 restored column when
 * the database has them. The portal ships before those migrations are applied
 * (release order, SR condition C-11), so a missing column falls back to the
 * columns the database has: no "Changed since you checked" marker without
 * 3596, no "restored" label without 3607, everything else as before. Any
 * other error is returned as is.
 */
async function loadItems(client: SupabaseClient, submissionId: string) {
  const items = (columns: string) => readSubmissionRows(client, 'submission_checklist_items', columns, submissionId, ['id']);
  const full = await items(ITEM_COLUMNS + CLEARED_COLUMNS + RESTORED_ITEM_COLUMNS);
  if (!isMissing3607Column(full.error) && !isMissingClearedColumn(full.error)) return full;
  if (isMissing3607Column(full.error)) {
    const cleared = await items(ITEM_COLUMNS + CLEARED_COLUMNS);
    if (!isMissingClearedColumn(cleared.error)) return cleared;
  }
  return items(ITEM_COLUMNS);
}

/** The headers, with the 3607 removal / restore columns when the database has them. */
async function loadHeaders(client: SupabaseClient, submissionId: string) {
  const headers = (columns: string) => readSubmissionRows(client, 'submission_checklists', columns, submissionId, ['id']);
  const full = await headers(HEADER_COLUMNS + REMOVED_HEADER_COLUMNS);
  if (!isMissing3607Column(full.error)) return full;
  return headers(HEADER_COLUMNS);
}

/**
 * Every row of one copy table for this submission, in blocks (BACKLOG-3607
 * N-3): a single select stops at PostgREST's max-rows, and the Remove
 * confirmation counts from these rows. `orderBy` must make the order total.
 */
function readSubmissionRows(
  client: SupabaseClient,
  table: string,
  columns: string,
  submissionId: string,
  orderBy: string[]
) {
  return readAllRows<unknown>((from, to) => {
    let q = client.from(table).select(columns, { count: 'exact' }).eq('submission_id', submissionId);
    for (const column of orderBy) q = q.order(column);
    return q.range(from, to);
  });
}

export async function loadSubmissionChecklists(
  client: SupabaseClient,
  submissionId: string
): Promise<SubmissionChecklistsResult> {
  const [headers, items, links, members] = await Promise.all([
    loadHeaders(client, submissionId),
    loadItems(client, submissionId),
    readSubmissionRows(client, 'submission_checklist_links', 'id, submission_checklist_item_id, kind, label, sort_order', submissionId, ['id']),
    readSubmissionRows(
      client,
      'submission_checklist_link_members',
      'link_id, kind, submission_attachment_id, submission_message_id',
      submissionId,
      ['id']
    ),
  ]);

  for (const r of [headers, items, links, members]) {
    if (r.error || !Array.isArray(r.data)) {
      console.error('[submissions] checklist read failed:', (r.error as PgError)?.message);
      return { ok: false };
    }
  }

  return {
    ok: true,
    sections: assembleSections(
      headers.data as HeaderRow[],
      items.data as ItemRow[],
      links.data as LinkRow[],
      members.data as MemberRow[]
    ),
  };
}

/**
 * The organization's templates a reviewer may add (archived ones excluded).
 * BACKLOG-3618: brokerage templates only (owner_user_id NULL), never anyone's
 * own; ordered by sort_order, then name, then id, so ties sort the same way
 * every time.
 */
export async function loadAddableTemplates(
  client: SupabaseClient,
  organizationId: string
): Promise<TemplateOption[]> {
  const { data, error } = await client
    .from('checklist_templates')
    .select('id, name, sort_order, owner_user_id')
    .eq('organization_id', organizationId)
    .is('archived_at', null)
    .is('owner_user_id', null)
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true })
    .order('id', { ascending: true });
  if (error || !Array.isArray(data)) {
    console.error('[submissions] checklist templates unavailable:', error?.message);
    return [];
  }
  return (data as { id: string; name: string }[]).map((t) => ({ id: t.id, name: t.name }));
}
