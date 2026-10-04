import { getAuthenticatedUser } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
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
import { SubmissionsReportClient } from './SubmissionsReportClient';

export const dynamic = 'force-dynamic';

/**
 * Submissions report — Admin Portal (BACKLOG-3715)
 *
 * Server component: authorises (internal role + analytics.view), resolves the
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
  const { supabase, user } = await getAuthenticatedUser();

  if (!user) {
    redirect('/login');
  }

  const { data: internalRole } = await supabase
    .from('internal_roles')
    .select('role_id')
    .eq('user_id', user.id)
    .single();

  if (!internalRole) {
    redirect('/login?error=not_authorized');
  }

  const { data: hasPerm } = await supabase.rpc('has_permission', {
    check_user_id: user.id,
    required_permission: 'analytics.view',
  });
  if (!hasPerm) {
    redirect('/dashboard?error=insufficient_permissions');
  }

  const params = await searchParams;
  const now = new Date();
  const period = resolvePeriod(
    {
      period: typeof params.period === 'string' ? params.period : undefined,
      from: typeof params.from === 'string' ? params.from : undefined,
      to: typeof params.to === 'string' ? params.to : undefined,
    },
    now
  );

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
      />
    </div>
  );
}
