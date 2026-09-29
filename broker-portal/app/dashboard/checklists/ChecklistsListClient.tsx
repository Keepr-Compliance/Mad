'use client';

/**
 * Checklist template list — BACKLOG-3474.
 *
 * Layout transcribed from the signed-off mock (BACKLOG-3480): a table in a
 * scrolling container, Seeded badge on templates copied from the starter
 * catalogue, Active/Archived status, Edit + Archive (or Restore) per row.
 * Archiving asks first with a non-destructive dialog: transactions that already
 * use a template keep their own copy.
 *
 * "Last edited" shows date + time once mounted in the browser (PR 4):
 * TableContainer already scrolls horizontally, so the wider text costs
 * nothing, and it matches the editor header rather than needing a
 * separate tooltip for the time.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Badge,
  ConfirmationDialog,
  Table,
  TableBody,
  TableContainer,
  TableHead,
  Td,
  Th,
  Tr,
} from '@keepr/design-system';
import { archiveChecklistTemplate, restoreChecklistTemplate } from '@/lib/actions/checklists';
import type { ChecklistListRow } from '@/lib/checklists/listRows';
import { formatAuditDate, formatAuditDateTime } from '@/lib/checklists/audit';

export default function ChecklistsListClient({ rows }: { rows: ChecklistListRow[] }) {
  const router = useRouter();
  const [archiveTarget, setArchiveTarget] = useState<ChecklistListRow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Same reasoning as ChecklistEditorClient: local time needs the browser's
  // timezone, so show the date alone until mounted, then date + time.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const active = rows.filter((r) => !r.archived).length;

  async function run(id: string, action: typeof archiveChecklistTemplate) {
    setBusyId(id);
    setError(null);
    try {
      const result = await action(id);
      if (!result.ok) setError(result.message);
      else router.refresh();
    } catch {
      setError('The template could not be updated. Try again.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      {error && (
        <p role="alert" className="mb-4 text-sm text-red-600">
          {error}
        </p>
      )}
      <TableContainer scrollX>
        <Table>
          <TableHead>
            <tr>
              <Th scope="col">Template</Th>
              <Th scope="col" className="text-right">Items</Th>
              <Th scope="col" className="text-right">Required</Th>
              <Th scope="col">Last edited</Th>
              <Th scope="col">Status</Th>
              <Th scope="col">
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </TableHead>
          <TableBody>
            {rows.map((row) => (
              <Tr key={row.id} data-testid="checklist-row">
                <Td>
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/dashboard/checklists/${row.id}`}
                      className="text-sm font-medium text-gray-900 hover:text-primary-600"
                    >
                      {row.name}
                    </Link>
                    {row.seeded && <Badge hue="blue">Seeded</Badge>}
                  </div>
                  {row.description && (
                    <p className="mt-0.5 text-xs text-gray-500 whitespace-normal">{row.description}</p>
                  )}
                </Td>
                <Td className="text-right tabular-nums">{row.itemCount}</Td>
                <Td className="text-right tabular-nums">{row.requiredCount}</Td>
                <Td>
                  {mounted ? formatAuditDateTime(row.updatedAt) : formatAuditDate(row.updatedAt)}
                  {row.updatedBy && <p className="mt-0.5 text-xs text-gray-500">by {row.updatedBy}</p>}
                </Td>
                <Td>
                  {row.archived ? <Badge hue="gray">Archived</Badge> : <Badge hue="green">Active</Badge>}
                </Td>
                <Td className="text-right space-x-4">
                  <Link
                    href={`/dashboard/checklists/${row.id}`}
                    className="text-sm text-primary-600 hover:text-primary-800"
                    aria-label={`Edit ${row.name}`}
                  >
                    Edit
                  </Link>
                  {row.archived ? (
                    <button
                      type="button"
                      className="text-sm text-gray-500 hover:text-gray-700 disabled:opacity-50"
                      disabled={busyId !== null}
                      onClick={() => run(row.id, restoreChecklistTemplate)}
                      aria-label={`Restore ${row.name}`}
                    >
                      Restore
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="text-sm text-gray-500 hover:text-gray-700 disabled:opacity-50"
                      disabled={busyId !== null}
                      onClick={() => setArchiveTarget(row)}
                      aria-label={`Archive ${row.name}`}
                    >
                      Archive
                    </button>
                  )}
                </Td>
              </Tr>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      <p className="mt-4 text-sm text-gray-500">
        Showing {rows.length} {rows.length === 1 ? 'template' : 'templates'} · {active} active
      </p>

      <ConfirmationDialog
        open={archiveTarget !== null}
        title={archiveTarget ? `Archive “${archiveTarget.name}”?` : 'Archive template?'}
        description="Transactions that already use this checklist keep their own copy — nothing changes for work in progress, and submitted checklists are untouched. New transactions will no longer see this template. You can restore it later."
        confirmLabel="Archive template"
        isDestructive={false}
        loading={busyId !== null}
        onCancel={() => setArchiveTarget(null)}
        onConfirm={async () => {
          const target = archiveTarget;
          if (!target) return;
          await run(target.id, archiveChecklistTemplate);
          setArchiveTarget(null);
        }}
      />
    </div>
  );
}
