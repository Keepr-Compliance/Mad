'use client';

/**
 * Update, Delete and Take over on a shared report — BACKLOG-3513 PR-3b.
 *
 * - UpdateReportButton: owner or editor. Saves the page's current filters and
 *   sort into the report, refused when someone else changed it first.
 * - DeleteReportButton: owner only (founder ruling Q5).
 * - TakeOverNotice: an active broker, admin or IT admin, only when the owner is
 *   gone or deactivated (ruling Q6: a deactivated owner stays owner until
 *   someone takes over).
 * Presentation only: broker_report_def_update / _def_delete / _take_over decide.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, ConfirmationDialog } from '@keepr/ui';
import { reportDefinitionsApi, type ReportDefinitionsApi } from '@/lib/reports/sharing/definitions-api';
import type { ReportLevel, RowScope } from '@/lib/reports/sharing/sharing-api';
import { writeFailureMessage } from '@/lib/reports/saved-views/write-failure';
import type { ViewState } from '@/lib/reports/saved-views/degrade';
import type { ReportCallerKind } from '@/lib/reports/report-gate';

export const REPORTS_INDEX_PATH = '/dashboard/reports';

/** Update: owner or editor. */
export function canUpdate(level: ReportLevel | null | undefined): boolean {
  return level === 'owner' || level === 'editor';
}

/** Delete: owner only. */
export function canDelete(level: ReportLevel | null | undefined): boolean {
  return level === 'owner';
}

/**
 * Take over: a full role (broker, admin, IT admin) who is not the owner, and only
 * when the owner is known to be gone or deactivated.
 */
export function canTakeOver(input: { kind: ReportCallerKind; level: ReportLevel | null; ownerInactive: boolean }): boolean {
  return input.kind === 'full' && input.level !== 'owner' && input.ownerInactive;
}

function useWrite() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(op: () => Promise<void>, after: () => void) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await op();
      after();
    } catch (err) {
      console.error('Shared report change failed:', err);
      setError(writeFailureMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return { router, busy, error, run };
}

export interface UpdateReportButtonProps {
  defId: string;
  name: string;
  description: string | null;
  rowScope: RowScope;
  updatedAt: string;
  level: ReportLevel | null;
  /** The page's current filters and sort. */
  current: ViewState;
  api?: ReportDefinitionsApi;
}

export function UpdateReportButton({ defId, name, description, rowScope, updatedAt, level, current, api = reportDefinitionsApi }: UpdateReportButtonProps) {
  const { router, busy, error, run } = useWrite();
  if (!canUpdate(level)) return null;
  return (
    <span className="flex items-center gap-2">
      <Button
        type="button"
        variant="secondary"
        disabled={busy}
        onClick={() =>
          void run(
            () => api.update({ id: defId, name, description, definition: current, rowScope, expectedUpdatedAt: updatedAt }),
            () => router.refresh()
          )
        }
      >
        Save filters
      </Button>
      {error ? (
        <span role="alert" className="text-sm text-danger-600">
          {error}
        </span>
      ) : null}
    </span>
  );
}

export interface DeleteReportButtonProps {
  defId: string;
  name: string;
  level: ReportLevel | null;
  api?: ReportDefinitionsApi;
}

export function DeleteReportButton({ defId, name, level, api = reportDefinitionsApi }: DeleteReportButtonProps) {
  const { router, busy, error, run } = useWrite();
  const [confirming, setConfirming] = useState(false);
  if (!canDelete(level)) return null;
  return (
    <>
      <Button type="button" variant="secondary" onClick={() => setConfirming(true)}>
        Delete
      </Button>
      <ConfirmationDialog
        open={confirming}
        title={`Delete “${name}”?`}
        description={error ?? 'Everyone loses access to it.'}
        confirmLabel="Delete"
        isDestructive
        loading={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() =>
          void run(
            () => api.remove(defId),
            () => {
              setConfirming(false);
              router.push(REPORTS_INDEX_PATH);
            }
          )
        }
      />
    </>
  );
}

export interface TakeOverNoticeProps {
  defId: string;
  kind: ReportCallerKind;
  level: ReportLevel | null;
  ownerInactive: boolean;
  api?: ReportDefinitionsApi;
}

export function TakeOverNotice({ defId, kind, level, ownerInactive, api = reportDefinitionsApi }: TakeOverNoticeProps) {
  const { router, busy, error, run } = useWrite();
  if (!canTakeOver({ kind, level, ownerInactive })) return null;
  return (
    <div
      role="status"
      data-testid="report-take-over"
      className="flex flex-wrap items-center gap-3 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-800"
    >
      <span>The owner of this report is no longer active.</span>
      <Button type="button" variant="secondary" disabled={busy} onClick={() => void run(() => api.takeOver(defId), () => router.refresh())}>
        Take over
      </Button>
      {error ? (
        <span role="alert" className="text-danger-600">
          {error}
        </span>
      ) : null}
    </div>
  );
}
