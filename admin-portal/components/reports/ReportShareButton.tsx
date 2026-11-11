'use client';

/**
 * Share a report (BACKLOG-4144): an owner (Super Admin) grants or removes access to the open report.
 *
 * Uses the kit SharingDialog with report copy (BACKLOG-3513 PR-4). The picker is
 * `report_access_candidates` output and nothing else; grants come from `report_access_list`; writes
 * are `report_access_set` / `report_access_remove`, always with the open report's key.
 *
 * No owner row (every owner is a Super Admin) and no Make owner. People only. A level change is ONE
 * `report_access_set` (an upsert), never remove + grant; Share loops the same upsert once per person
 * picked, then re-reads once.
 *
 * Shown only to owners, and hidden for good once any of the functions answers "no such function"
 * (a database without them). Presentation only: the server functions are the access guard.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { Share2 } from 'lucide-react';
import { Button, SharingDialog, type SharingLevelOption } from '@keepr/ui';
import { canGrantReportAccess } from '@/lib/reports/report-access';
import { useOpenReport } from '@/lib/reports/report-access-context';
import { reportAccessApi, type ReportAccessApi } from '@/lib/reports/report-access-api';
import { isMissingFunctionError, type ShareCandidate, type ShareGrant } from '@/lib/reports/report-share-api';
import { throwFirstRejection, toEntries, toPrincipals } from '@/lib/reports/use-report-view-sharing';
import { writeFailureMessage } from '@/lib/reports/report-views';

/** The line under each level. */
export interface ShareRoleDescriptions {
  viewer: string;
  editor: string;
}

export const REPORT_SHARE_DESCRIPTION = 'People you add can open this report.';
export const REPORT_SHARE_ROLE_DESCRIPTIONS: ShareRoleDescriptions = {
  viewer: 'Opens the report',
  editor: 'Also shares saved views on it',
};

export function ReportShareButton({
  api = reportAccessApi,
  roleDescriptions = REPORT_SHARE_ROLE_DESCRIPTIONS,
}: {
  api?: ReportAccessApi;
  /** The line under each role. Defaults to the report copy; a page whose editor has no extra power overrides it (BACKLOG-4186). */
  roleDescriptions?: ShareRoleDescriptions;
}) {
  const report = useOpenReport();
  const [missing, setMissing] = useState(false);
  const [open, setOpen] = useState(false);
  const [candidates, setCandidates] = useState<ShareCandidate[] | null>(null);
  const [grants, setGrants] = useState<ShareGrant[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // One number per opening. A reply from an earlier opening (closed, or closed and opened again
  // before it returned) is discarded, so the dialog never shows a stale list.
  const session = useRef(0);
  const reportKey = report?.reportKey ?? '';

  const noteFailure = useCallback((err: unknown) => {
    if (isMissingFunctionError(err)) setMissing(true);
    console.error('Report sharing failed:', err);
    setError(writeFailureMessage(err));
  }, []);

  // Latest read wins (BACKLOG-3513 PR-6): a reply from a read older than the newest one sent is
  // dropped, so a slow earlier re-read can never bring back a row a later write removed.
  const readSeq = useRef(0);

  const read = useCallback(
    (id: number) => {
      const seq = ++readSeq.current;
      const current = () => session.current === id && readSeq.current === seq;
      api.candidates(reportKey).then(
        (rows) => current() && setCandidates(rows),
        (err) => {
          if (!current()) return;
          setCandidates(null);
          noteFailure(err);
        }
      );
      api.grants(reportKey).then(
        (rows) => current() && setGrants(rows),
        (err) => {
          if (!current()) return;
          setGrants(null);
          noteFailure(err);
        }
      );
    },
    [api, reportKey, noteFailure]
  );

  // The kit confirms a remove or level change by content, not by array identity; keeping the
  // same arrays between reads only saves re-renders.
  const principals = useMemo(() => toPrincipals(candidates), [candidates]);
  const entries = useMemo(() => toEntries(grants), [grants]);

  if (!report || !canGrantReportAccess(report.access) || missing) return null;

  const levels: SharingLevelOption[] = [
    { value: 'viewer', label: 'Can view', description: roleDescriptions.viewer },
    { value: 'editor', label: 'Can edit', description: roleDescriptions.editor },
  ];

  /**
   * Re-read after a write, show a refusal. Returns `op` itself so the dialog can show the row as in
   * flight and apply a success at once (BACKLOG-3513 PR-6); the re-read stays the source of truth.
   */
  function afterWrite(op: Promise<unknown>): Promise<unknown> {
    const id = session.current;
    setError(null);
    op.then(
      () => session.current === id && read(id),
      (err) => {
        if (session.current !== id) return;
        noteFailure(err);
        read(id);
      }
    );
    return op;
  }

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        aria-label={`Share ${report.title}`}
        onClick={() => {
          session.current += 1;
          setCandidates(null);
          setGrants(null);
          setError(null);
          setOpen(true);
          read(session.current);
        }}
      >
        <Share2 className="h-4 w-4" aria-hidden="true" />
        Share
      </Button>
      <SharingDialog
        open={open}
        onOpenChange={(next) => {
          if (!next) {
            session.current += 1;
            setOpen(false);
          }
        }}
        name={report.title}
        description={REPORT_SHARE_DESCRIPTION}
        levels={levels}
        candidates={principals}
        entries={entries}
        error={error}
        onGrant={(principals, level) =>
          // One upsert per person picked (people only), all started now; the re-read waits for every
          // one to settle, then the first refusal, if any, is shown.
          afterWrite(
            Promise.allSettled(principals.filter((p) => p.kind === 'person').map((p) => api.set(reportKey, p.id, level))).then(
              throwFirstRejection
            )
          )
        }
        onChangeLevel={(entry, level) => afterWrite(api.set(reportKey, entry.id, level))}
        onRemove={(entry) => afterWrite(api.remove(reportKey, entry.id))}
      />
    </>
  );
}
