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

interface HeaderRow {
  id: string;
  template_id: string | null;
  template_name: string;
  sort_order: number;
  added_at_review_by: string | null;
  added_at_review_at: string | null;
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
      links: linksByItem.get(i.id) ?? [],
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
    }));
}

export async function loadSubmissionChecklists(
  client: SupabaseClient,
  submissionId: string
): Promise<SubmissionChecklistsResult> {
  const [headers, items, links, members] = await Promise.all([
    client
      .from('submission_checklists')
      .select('id, template_id, template_name, sort_order, added_at_review_by, added_at_review_at')
      .eq('submission_id', submissionId),
    client
      .from('submission_checklist_items')
      .select(
        'id, submission_checklist_id, title, description, is_required, is_checked, note, sort_order, reviewer_checked, reviewer_checked_by, reviewer_checked_at'
      )
      .eq('submission_id', submissionId),
    client
      .from('submission_checklist_links')
      .select('id, submission_checklist_item_id, kind, label, sort_order')
      .eq('submission_id', submissionId),
    client
      .from('submission_checklist_link_members')
      .select('link_id, kind, submission_attachment_id, submission_message_id')
      .eq('submission_id', submissionId),
  ]);

  for (const r of [headers, items, links, members]) {
    if (r.error || !Array.isArray(r.data)) {
      console.error('[submissions] checklist read failed:', r.error?.message);
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

/** The organization's templates a reviewer may add (archived ones excluded). */
export async function loadAddableTemplates(
  client: SupabaseClient,
  organizationId: string
): Promise<TemplateOption[]> {
  const { data, error } = await client
    .from('checklist_templates')
    .select('id, name, sort_order')
    .eq('organization_id', organizationId)
    .is('archived_at', null)
    .order('sort_order', { ascending: true });
  if (error || !Array.isArray(data)) {
    console.error('[submissions] checklist templates unavailable:', error?.message);
    return [];
  }
  return (data as { id: string; name: string }[]).map((t) => ({ id: t.id, name: t.name }));
}
