/**
 * Edit one checklist template — BACKLOG-3474.
 *
 * Same gate as the list (notFound on refusal). The template is read with the
 * caller's client, by id AND the organization the gate resolved, so an id from
 * another organization is a 404 here even before RLS is consulted.
 * `updated_at` is handed to the editor as the text PostgREST returned; the
 * save sends it back unchanged.
 */

import { notFound } from 'next/navigation';
import { Card } from '@keepr/design-system';
import {
  requireChecklistEditorAccess,
  type ChecklistEditorAccess,
} from '@/lib/checklist-access';
import type { TemplateItemRow } from '@/lib/checklists/editorState';
import { auditName, auditUserIds, resolveAuditNames } from '@/lib/checklists/audit';
import ChecklistEditorClient from '../ChecklistEditorClient';

interface PageProps {
  params: Promise<{ id: string }>;
}

const EDITOR_SELECT =
  'id, name, description, created_at, created_by, updated_at, updated_by, archived_at, archived_by, checklist_template_items(id, title, description, is_required, expected_document_type, sort_order)';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface TemplateRecord {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
  archived_at: string | null;
  archived_by: string | null;
  checklist_template_items: TemplateItemRow[] | null;
}

export default async function EditChecklistTemplatePage({ params }: PageProps) {
  let access: ChecklistEditorAccess;
  try {
    access = await requireChecklistEditorAccess();
  } catch {
    notFound();
  }
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const { data, error } = await access.supabase
    .from('checklist_templates')
    .select(EDITOR_SELECT)
    .eq('id', id)
    .eq('organization_id', access.organizationId)
    .maybeSingle();

  if (error) {
    return (
      <Card>
        <p role="alert" className="text-sm text-red-600">
          This template could not be loaded. Reload the page to try again.
        </p>
      </Card>
    );
  }
  if (!data) notFound();

  const template = data as unknown as TemplateRecord;
  const names = await resolveAuditNames(
    access.supabase,
    auditUserIds(template.created_by, template.updated_by, template.archived_by)
  );
  return (
    <ChecklistEditorClient
      key={template.updated_at}
      templateId={template.id}
      updatedAt={template.updated_at}
      archived={template.archived_at !== null}
      audit={{
        created: { at: template.created_at, by: auditName(template.created_by, names) },
        edited: { at: template.updated_at, by: auditName(template.updated_by, names) },
        archived:
          template.archived_at !== null
            ? { at: template.archived_at, by: auditName(template.archived_by, names) }
            : null,
      }}
      template={{ name: template.name, description: template.description }}
      items={Array.isArray(template.checklist_template_items) ? template.checklist_template_items : []}
    />
  );
}
