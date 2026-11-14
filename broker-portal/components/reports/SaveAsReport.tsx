'use client';

/**
 * "Save as report" on New report (the Submissions report) — BACKLOG-3513 PR-3b,
 * renamed in PR-3g.
 *
 * Saves the current filters and sort as a new report owned by the caller, then
 * opens it. Anyone the report gate admits may do this, agents included (founder
 * ruling Q2): an agent's report shows each reader only the rows they can already
 * see. It starts private: broker_report_def_create takes no general-access
 * argument and adds no grants, so only the owner can see it until they share it.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label } from '@keepr/ui';
import { reportDefinitionsApi, type ReportDefinitionsApi } from '@/lib/reports/sharing/definitions-api';
import { writeFailureMessage } from '@/lib/reports/sharing/write-failure';
import { definitionReportPath } from '@/lib/reports/datasets/submissions-filters';
import type { ViewState } from '@/lib/reports/datasets/view-state';

export interface SaveAsReportProps {
  orgId: string;
  /** The page's current filters and sort, as stored in a definition. */
  current: ViewState;
  api?: ReportDefinitionsApi;
}

export function SaveAsReport({ orgId, current, api = reportDefinitionsApi }: SaveAsReportProps) {
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
      console.error('Saving the report failed:', err);
      setError(writeFailureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="primary"
        onClick={() => {
          setName('');
          setError(null);
          setOpen(true);
        }}
      >
        Save as report
      </Button>
      <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save as report</DialogTitle>
            <DialogDescription>Only you can see it until you share it.</DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <Label htmlFor="report-name">Name</Label>
            <Input id="report-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} autoFocus />
            {error ? (
              <p role="alert" className="text-sm text-danger-600">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={!trimmed || busy}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
