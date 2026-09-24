/**
 * Checklists route — server-side gate. BACKLOG-3474.
 *
 * The sidebar entry is a render decision, not a gate. This server component is
 * the refusal that holds: anyone who is not a broker/admin/it_admin of a
 * brokerage with transaction_checklists enabled, or who is in a support
 * session, gets notFound() before any checklist markup exists. Same shape as
 * app/dashboard/settings/scim/page.tsx.
 *
 * This first cut shows the empty state. The template list and the editor
 * arrive with the save function in the follow-up change.
 */

import { notFound } from 'next/navigation';
import { ClipboardList } from 'lucide-react';
import { Card, PageHeader } from '@keepr/design-system';
import { EmptyState } from '@/components/ui/EmptyState';
import {
  requireChecklistEditorAccess,
  type ChecklistEditorAccess,
} from '@/lib/checklist-access';

export default async function ChecklistsPage() {
  let access: ChecklistEditorAccess;
  try {
    access = await requireChecklistEditorAccess();
  } catch {
    notFound();
  }

  const { data: templates, error } = await access.supabase
    .from('checklist_templates')
    .select('id')
    .eq('organization_id', access.organizationId);

  return (
    <div>
      <PageHeader
        title="Checklists"
        subtitle="Templates your brokerage applies to transactions"
      />
      <Card>
        {error || !Array.isArray(templates) ? (
          <p role="alert" className="text-sm text-red-600">
            Checklist templates could not be loaded. Reload the page to try again.
          </p>
        ) : templates.length === 0 ? (
          <EmptyState
            icon={<ClipboardList className="w-12 h-12 text-gray-300" aria-hidden="true" />}
            title="No checklist templates yet"
            description="A template is the list of items an agent ticks off on a transaction in the Keepr desktop app. Agents choose one per transaction and see only active templates."
          />
        ) : (
          <p className="text-sm text-gray-700">
            {templates.length} {templates.length === 1 ? 'template' : 'templates'}
          </p>
        )}
      </Card>
    </div>
  );
}
