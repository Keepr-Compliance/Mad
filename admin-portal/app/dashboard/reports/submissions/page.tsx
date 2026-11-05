import { requireReportAccess } from '@/lib/reports/report-gate';
import { ReportAccessProvider } from '@/lib/reports/report-access-context';
import { ReportShareButton } from '@/components/reports/ReportShareButton';
import Link from 'next/link';
import { ChevronLeft, Send } from 'lucide-react';
import {
  getOpenAttempts,
  getSubmissionAttempts,
  getSubmissionLookups,
  OPEN_ATTEMPT_LIMIT,
  SUBMISSION_LIMIT,
} from '@/lib/reports/submissions-queries';
import { buildOpenAttempts, buildSubmissionsReport } from '@/lib/reports/submissions';
import { REPORTS_BASE_PATH } from '@/lib/reports/registry';
import { resolvePeriod } from '@/lib/reports/period';
import type { ParamRecord } from '@/lib/reports/report-url';
import { resolveSubmissionsInitial, SUBMISSIONS_REPORT_KEY } from '@/lib/reports/submissions-views';
import { SubmissionsReportClient } from './SubmissionsReportClient';

export const dynamic = 'force-dynamic';

/**
 * Submissions report — Admin Portal (BACKLOG-3715)
 *
 * Server component: authorises (internal role + report access, BACKLOG-4144), resolves the
 * period, reads the period's attempts and every open attempt through the
 * authenticated client, and hands a plain view model to the client shell.
 * `now` is taken once here so the stall and sweep-window flags agree with the
 * period the server selected.
 */
export default async function SubmissionsReportPage({
  searchParams,
}: {
  searchParams: Promise<ParamRecord>;
}) {
  const { supabase, access } = await requireReportAccess(SUBMISSIONS_REPORT_KEY);

  const params = await searchParams;
  const now = new Date();
  // A bare URL opens the user's default view (filters + time range); any period
  // param in the URL wins and the views are not read here at all (BACKLOG-4084).
  const { initialView, periodInput } = await resolveSubmissionsInitial(params, async () => {
    const { data, error } = await supabase.rpc('report_list_saved_views', {
      p_report_key: SUBMISSIONS_REPORT_KEY,
    });
    if (error) {
      // The message names the stage only; the error text can carry user data.
      console.error('[submissions] saved views read failed; opening without a default view');
      throw error;
    }
    return data;
  });
  const period = resolvePeriod(periodInput, now);

  const [periodResult, openResult] = await Promise.all([
    getSubmissionAttempts(supabase, period),
    getOpenAttempts(supabase),
  ]);
  const { users, orgs } = await getSubmissionLookups(supabase, [
    ...periodResult.rows,
    ...openResult.rows,
  ]);
  const report = buildSubmissionsReport(periodResult.rows, users, orgs, now);
  const openAttempts = buildOpenAttempts(openResult.rows, users, orgs, now);

  return (
    <ReportAccessProvider reportKey={SUBMISSIONS_REPORT_KEY} title="Submissions" access={access}>
      <div className="max-w-7xl mx-auto space-y-6">
        <div>
          <Link
            href={REPORTS_BASE_PATH}
            className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900"
          >
            <ChevronLeft className="h-4 w-4" />
            All reports
          </Link>
          <div className="mt-2 flex items-center gap-3">
            <Send className="h-7 w-7 text-primary-600" />
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Submissions</h1>
              <p className="text-sm text-gray-500">
                Every submit attempt that started in the selected period: which committed, which
                failed and where, and which are still open. Counts and codes only.
              </p>
            </div>
            <div className="ml-auto">
              <ReportShareButton />
            </div>
          </div>
        </div>

        {periodResult.failed ? (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-5 text-sm text-amber-900">
            The submission data could not be read. This is a query failure, not an empty table — the
            numbers below are not a true zero.
          </div>
        ) : null}

        <SubmissionsReportClient
          report={report}
          openAttempts={openAttempts}
          openFailed={openResult.failed}
          openTruncated={openResult.truncated}
          openCap={OPEN_ATTEMPT_LIMIT}
          period={period}
          truncated={periodResult.truncated}
          rowCap={SUBMISSION_LIMIT}
          initialView={initialView}
        />
      </div>
    </ReportAccessProvider>
  );
}
