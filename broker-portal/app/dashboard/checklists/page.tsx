/**
 * Checklists route — server-side gate and template list. BACKLOG-3474.
 *
 * The sidebar entry is a render decision, not a gate. This server component is
 * the refusal that holds: anyone who is not a broker/admin/it_admin of a
 * brokerage with transaction_checklists enabled, or who is in a support
 * session, gets notFound() before any checklist markup exists. Same shape as
 * app/dashboard/settings/scim/page.tsx.
 *
 * The list is read with the caller's own client (RLS applies) and scoped to the
 * organization the gate resolved.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ClipboardList, Plus } from 'lucide-react';
import { Card, PageHeader, buttonClasses } from '@keepr/design-system';
import { EmptyState } from '@/components/ui/EmptyState';
import {
  requireChecklistEditorAccess,
  type ChecklistEditorAccess,
} from '@/lib/checklist-access';
import {
  CHECKLIST_LIST_SELECT,
  toListRows,
  type TemplateListRecord,
} from '@/lib/checklists/listRows';
import { auditUserIds, resolveAuditNames } from '@/lib/checklists/audit';
import ChecklistsListClient from './ChecklistsListClient';

function NewTemplateLink() {
  return (
    <Link href="/dashboard/checklists/new" className={buttonClasses('primary', 'md')}>
      <Plus className="h-4 w-4" aria-hidden="true" />
      New template
    </Link>
  );
}

export default async function ChecklistsPage() {
  let access: ChecklistEditorAccess;
  try {
    access = await requireChecklistEditorAccess();
  } catch {
    notFound();
  }

  const { data: templates, error } = await access.supabase
    .from('checklist_templates')
    .select(CHECKLIST_LIST_SELECT)
    .eq('organization_id', access.organizationId);

  const failed = Boolean(error) || !Array.isArray(templates);
  const records = failed ? [] : (templates as unknown as TemplateListRecord[]);
  const names = await resolveAuditNames(access.supabase, auditUserIds(...records.map((r) => r.updated_by)));
  const rows = toListRows(records, names);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Checklists"
        subtitle="Templates your brokerage applies to transactions"
        actions={!failed && rows.length > 0 ? <NewTemplateLink /> : undefined}
      />
      {failed ? (
        <Card>
          <p role="alert" className="text-sm text-red-600">
            Checklist templates could not be loaded. Reload the page to try again.
          </p>
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ClipboardList className="w-12 h-12 text-gray-300" aria-hidden="true" />}
            title="No checklist templates yet"
            description="A template is the list of items an agent ticks off on a transaction in the Keepr desktop app. Agents choose one per transaction and see only active templates."
            action={<NewTemplateLink />}
          />
        </Card>
      ) : (
        <ChecklistsListClient rows={rows} />
      )}
    </div>
  );
}
