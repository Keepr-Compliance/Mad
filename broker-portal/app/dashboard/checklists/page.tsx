/**
 * Checklists route — server-side gate and template list. BACKLOG-3474,
 * BACKLOG-3618.
 *
 * The sidebar entry is a render decision, not a gate. This server component is
 * the refusal that holds: anyone the database admits neither as an editor of
 * the organization's templates nor as a member who may keep their own
 * (lib/checklist-access.ts), or who is in a support session, gets notFound()
 * before any checklist markup exists.
 *
 * Two shapes:
 * - Editor (broker / admin / it_admin, or a solo user on their personal
 *   organization): one list of the organization's templates, as before. A solo
 *   user keeps ONE list.
 * - Brokerage agent: "My checklists" (their own, editable) and the
 *   brokerage's active templates, read-only.
 * Nobody sees another user's own templates: RLS returns none, and
 * splitTemplateRecords drops any that arrive.
 *
 * The list is read with the caller's own client (RLS applies) and scoped to the
 * organization the gate resolved.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ClipboardList, Plus } from 'lucide-react';
import { Card, PageHeader, buttonClasses } from '@keepr/design-system';
import { EmptyState } from '@/components/ui/EmptyState';
import { requireChecklistAccess, type ChecklistAccess } from '@/lib/checklist-access';
import {
  CHECKLIST_LIST_SELECT,
  splitTemplateRecords,
  toListRows,
  type TemplateListRecord,
} from '@/lib/checklists/listRows';
import { auditUserIds, resolveAuditNames } from '@/lib/checklists/audit';
import ChecklistsListClient from './ChecklistsListClient';

function NewTemplateLink({ label = 'New template' }: { label?: string }) {
  return (
    <Link href="/dashboard/checklists/new" className={buttonClasses('primary', 'md')}>
      <Plus className="h-4 w-4" aria-hidden="true" />
      {label}
    </Link>
  );
}

function LoadError() {
  return (
    <Card>
      <p role="alert" className="text-sm text-red-600">
        Checklist templates could not be loaded. Reload the page to try again.
      </p>
    </Card>
  );
}

export default async function ChecklistsPage() {
  let access: ChecklistAccess;
  try {
    access = await requireChecklistAccess();
  } catch {
    notFound();
  }

  const { data: templates, error } = await access.supabase
    .from('checklist_templates')
    .select(CHECKLIST_LIST_SELECT)
    .eq('organization_id', access.organizationId);

  const failed = Boolean(error) || !Array.isArray(templates);
  const split = splitTemplateRecords(failed ? [] : (templates as unknown as TemplateListRecord[]), access.userId);

  if (!access.canEditOrg) {
    const brokerageActive = split.brokerage.filter((r) => r.archived_at === null);
    const names = await resolveAuditNames(
      access.supabase,
      auditUserIds(...[...split.mine, ...brokerageActive].map((r) => r.updated_by))
    );
    const mine = toListRows(split.mine, names);
    const brokerage = toListRows(brokerageActive, names);
    return (
      <div className="space-y-6">
        <PageHeader title="Checklists" subtitle="Your own checklists, and the ones your brokerage uses" />
        {failed ? (
          <LoadError />
        ) : (
          <>
            <section aria-labelledby="my-checklists" className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 id="my-checklists" className="text-lg font-semibold text-gray-900">
                  My checklists
                </h2>
                {mine.length > 0 && <NewTemplateLink label="New checklist" />}
              </div>
              {mine.length === 0 ? (
                <Card>
                  <EmptyState
                    icon={<ClipboardList className="w-12 h-12 text-gray-300" aria-hidden="true" />}
                    title="No checklists of your own yet"
                    description="Make a list of things you want to keep track of on a transaction. Only you can see and change it."
                    action={<NewTemplateLink label="New checklist" />}
                  />
                </Card>
              ) : (
                <ChecklistsListClient rows={mine} />
              )}
            </section>
            <section aria-labelledby="brokerage-checklists" className="space-y-3">
              <div>
                <h2 id="brokerage-checklists" className="text-lg font-semibold text-gray-900">
                  Brokerage checklists
                </h2>
                <p className="mt-1 text-sm text-gray-500">Set by your brokerage. Only your broker or an admin can change them.</p>
              </div>
              {brokerage.length === 0 ? (
                <Card>
                  <p className="text-sm text-gray-500">Your brokerage has no checklists yet.</p>
                </Card>
              ) : (
                <ChecklistsListClient rows={brokerage} readOnly />
              )}
            </section>
          </>
        )}
      </div>
    );
  }

  // Editors: the organization's templates. A solo user's personal organization
  // keeps one list, own rows included (BACKLOG-3618 C8).
  const records = access.personalOrg ? [...split.brokerage, ...split.mine] : split.brokerage;
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
        <LoadError />
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
