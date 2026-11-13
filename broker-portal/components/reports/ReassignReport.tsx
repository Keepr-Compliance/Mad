'use client';

/**
 * Reassign a shared report whose owner is gone — BACKLOG-3513 PR-3f.
 *
 * Founder ruling (2026-11-13, "Reassign ... A"): when a report's owner is
 * deactivated or removed, an active IT admin of the brokerage (or an active
 * admin when the brokerage has no active IT admin) picks the new owner: any
 * active member, agents included. Nobody else sees it.
 *
 * The database decides: broker_report_def_get.reassign_available says whether
 * THIS caller may reassign THIS report now, broker_report_reassign_candidates
 * lists who it can go to, and broker_report_reassign makes the change
 * (migration 20261112220000). The page only hides what the caller may not do.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Dropdown,
  type SharingPrincipal,
} from '@keepr/ui';
import { reportDefinitionsApi, type ReportDefinitionsApi } from '@/lib/reports/sharing/definitions-api';
import { writeFailureMessage } from '@/lib/reports/sharing/write-failure';
import type { ReportCallerKind } from '@/lib/reports/report-gate';

/** Reassign is offered only to a full-portal caller the database says may reassign this report. */
export function canReassign(input: { kind: ReportCallerKind; reassignAvailable: boolean }): boolean {
  return input.kind === 'full' && input.reassignAvailable;
}

export interface ReassignReportProps {
  defId: string;
  name: string;
  kind: ReportCallerKind;
  reassignAvailable: boolean;
  api?: ReportDefinitionsApi;
}

export function ReassignReport({ defId, name, kind, reassignAvailable, api = reportDefinitionsApi }: ReassignReportProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [people, setPeople] = useState<SharingPrincipal[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canReassign({ kind, reassignAvailable })) return null;

  async function openDialog() {
    setOpen(true);
    setPicked(null);
    setError(null);
    setPeople(null);
    try {
      setPeople(await api.reassignCandidates(defId));
    } catch (err) {
      console.error('Loading the people to reassign to failed:', err);
      setPeople([]);
      setError(writeFailureMessage(err));
    }
  }

  async function confirm() {
    if (!picked || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.reassign(defId, picked);
      setOpen(false);
      router.refresh();
    } catch (err) {
      console.error('Reassigning the report failed:', err);
      setError(writeFailureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="status"
      data-testid="report-reassign"
      className="flex flex-wrap items-center gap-3 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-800"
    >
      <span>The owner of this report is no longer active.</span>
      <Button type="button" variant="secondary" onClick={() => void openDialog()}>
        Reassign
      </Button>
      <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{`Reassign “${name}”`}</DialogTitle>
            <DialogDescription>The new owner can edit, share and delete it.</DialogDescription>
          </DialogHeader>
          <Dropdown
            label="New owner"
            placeholder={people === null ? 'Loading…' : 'Choose a person'}
            disabled={people === null || busy}
            searchPlaceholder="Search people"
            emptyText="No one found"
            options={(people ?? []).map((p) => ({ value: p.id, label: p.name, description: p.detail }))}
            value={picked}
            onChange={(v: string) => setPicked(v)}
          />
          {error ? (
            <p role="alert" className="text-sm text-danger-600">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" disabled={!picked || busy} onClick={() => void confirm()}>
              Reassign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
