'use client';

/**
 * "Save as shared report" on the Submissions report — BACKLOG-3513 PR-3b.
 *
 * Saves the current filters and sort as a new shared report owned by the
 * caller, then opens it. Anyone the report gate admits may do this, agents
 * included (founder ruling Q2): an agent's report shows each reader only the
 * rows they can already see. It starts private ("Only people added").
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label } from '@keepr/ui';
import { reportDefinitionsApi, type ReportDefinitionsApi } from '@/lib/reports/sharing/definitions-api';
import { writeFailureMessage } from '@/lib/reports/sharing/write-failure';
import { definitionReportPath } from '@/lib/reports/datasets/submissions-filters';
import type { ViewState } from '@/lib/reports/datasets/view-state';

export interface SaveAsSharedReportProps {
  orgId: string;
  /** The page's current filters and sort, as stored in a definition. */
  current: ViewState;
  api?: ReportDefinitionsApi;
}

export function SaveAsSharedReport({ orgId, current, api = reportDefinitionsApi }: SaveAsSharedReportProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();

  async function save() {
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const id = await api.create({ orgId, name: trimmed, definition: current });
      setOpen(false);
      router.push(definitionReportPath(id));
    } catch (err) {
      console.error('Saving the shared report failed:', err);
      setError(writeFailureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        onClick={() => {
          setName('');
          setError(null);
          setOpen(true);
        }}
      >
        Save as shared report
      </Button>
      <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save as shared report</DialogTitle>
            <DialogDescription>Saves these filters. Share it when you are ready.</DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <Label htmlFor="shared-report-name">Name</Label>
            <Input id="shared-report-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} autoFocus />
            {error ? (
              <p role="alert" className="text-sm text-danger-600">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={!trimmed || busy}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
