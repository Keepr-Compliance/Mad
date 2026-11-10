'use client';

/**
 * Share a report (BACKLOG-4144): an owner (Super Admin) grants or removes access to the open report.
 *
 * Reuses the kit ShareDialog with report copy. The picker is `report_access_candidates` output and
 * nothing else; grants come from `report_access_list`; writes are `report_access_set` /
 * `report_access_remove`, always with the open report's key.
 *
 * Shown only to owners, and hidden for good once any of the functions answers "no such function"
 * (a database without them). Presentation only: the server functions are the access guard.
 */

import { useCallback, useRef, useState } from 'react';
import { Share2 } from 'lucide-react';
import { Button, ShareDialog, type ShareDialogProps, type ShareRoleDescriptions } from '@keepr/ui';
import { canGrantReportAccess } from '@/lib/reports/report-access';
import { useOpenReport } from '@/lib/reports/report-access-context';
import { reportAccessApi, type ReportAccessApi } from '@/lib/reports/report-access-api';
import { isMissingFunctionError } from '@/lib/reports/report-share-api';
import { writeFailureMessage } from '@/lib/reports/report-views';

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
  const [candidates, setCandidates] = useState<ShareDialogProps['candidates']>(null);
  const [grants, setGrants] = useState<ShareDialogProps['grants']>(null);
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

  const read = useCallback(
    (id: number) => {
      const current = () => session.current === id;
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

  if (!report || !canGrantReportAccess(report.access) || missing) return null;

  function afterWrite(op: Promise<unknown>) {
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
      <ShareDialog
        open={open}
        onOpenChange={(next) => {
          if (!next) {
            session.current += 1;
            setOpen(false);
          }
        }}
        viewName={report.title}
        description={REPORT_SHARE_DESCRIPTION}
        roleDescriptions={roleDescriptions}
        candidates={candidates}
        grants={grants}
        error={error}
        onGrant={(userId, role) => afterWrite(api.set(reportKey, userId, role))}
        onRemove={(grant) => afterWrite(api.remove(reportKey, grant.userId))}
      />
    </>
  );
}
