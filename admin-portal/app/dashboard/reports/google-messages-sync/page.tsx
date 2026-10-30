import { getAuthenticatedUser } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft, MessageSquare } from 'lucide-react';
import { getSyncRuns, RUN_LIMIT } from '@/lib/reports/iphone-sync-queries';
import {
  buildGoogleMessagesSyncReport,
  GM_EXTRA_COLUMNS,
  GM_SOURCE,
  type GmSyncOutcomeRow,
} from '@/lib/reports/google-messages-sync';
import { REPORTS_BASE_PATH } from '@/lib/reports/registry';
import { resolvePeriod } from '@/lib/reports/period';
import type { ParamRecord } from '@/lib/reports/report-url';
import { GoogleMessagesSyncReportClient } from './GoogleMessagesSyncReportClient';

export const dynamic = 'force-dynamic';

/**
 * Google Messages Sync Performance — Admin Portal (BACKLOG-3671 P2).
 *
 * Server component, as the iPhone report: authorises, resolves the period,
 * reads THAT period's rows of source 'google-messages' (own 200 cap, dev
 * builds left out), hands a plain model to the client shell.
 */
export default async function GoogleMessagesSyncReportPage({
  searchParams,
}: {
  searchParams: Promise<ParamRecord>;
}) {
  const { supabase, user } = await getAuthenticatedUser();
  if (!user) redirect('/login');

  const { data: internalRole } = await supabase.from('internal_roles').select('role_id').eq('user_id', user.id).single();
  if (!internalRole) redirect('/login?error=not_authorized');

  const { data: hasPerm } = await supabase.rpc('has_permission', {
    check_user_id: user.id,
    required_permission: 'analytics.view',
  });
  if (!hasPerm) redirect('/dashboard?error=insufficient_permissions');

  const params = await searchParams;
  const period = resolvePeriod(
    {
      period: typeof params.period === 'string' ? params.period : undefined,
      from: typeof params.from === 'string' ? params.from : undefined,
      to: typeof params.to === 'string' ? params.to : undefined,
    },
    new Date()
  );

  const { rows, users, failed, truncated } = await getSyncRuns<GmSyncOutcomeRow>(supabase, period, {
    source: GM_SOURCE,
    extraColumns: GM_EXTRA_COLUMNS,
  });
  const report = buildGoogleMessagesSyncReport(rows, users);

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div>
        <Link href={REPORTS_BASE_PATH} className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900">
          <ChevronLeft className="h-4 w-4" />
          All reports
        </Link>
        <div className="mt-2 flex items-center gap-3">
          <MessageSquare className="h-7 w-7 text-primary-600" />
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Google Messages Sync Performance</h1>
            <p className="text-sm text-gray-500">
              Every Google Messages Sync that finished in the selected period: time per stage, chats, messages and why
              a run did not complete. Dev builds are left out; a Sync still running is not counted.
            </p>
          </div>
        </div>
      </div>

      {failed ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-5 text-sm text-amber-900">
          The sync data could not be read. This is a query failure, not an empty table — the numbers below are not a
          true zero.
        </div>
      ) : null}

      <GoogleMessagesSyncReportClient report={report} period={period} truncated={truncated} rowCap={RUN_LIMIT} />
    </div>
  );
}
