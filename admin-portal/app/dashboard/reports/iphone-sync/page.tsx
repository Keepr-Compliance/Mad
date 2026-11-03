import { getAuthenticatedUser } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft, Smartphone } from 'lucide-react';
import { getIphoneSyncRuns, RUN_LIMIT } from '@/lib/reports/iphone-sync-queries';
import { buildIphoneSyncReport } from '@/lib/reports/iphone-sync';
import { REPORTS_BASE_PATH } from '@/lib/reports/registry';
import { resolvePeriod } from '@/lib/reports/period';
import { parseClientState, type ParamRecord } from '@/lib/reports/report-url';
import { IPHONE_SYNC_URL_KEYS } from '@/lib/reports/default-view';
import { resolveInitialSavedView } from '@/lib/reports/initial-saved-view';
import { parseSavedViews, REPORT_KEY } from '@/lib/reports/report-views';
import { IphoneSyncReportClient } from './IphoneSyncReportClient';

export const dynamic = 'force-dynamic';

/**
 * iPhone Sync Performance report — Admin Portal (BACKLOG-3441, BACKLOG-3450)
 *
 * Server component: authorises, resolves the period, fetches THE ROWS OF THAT
 * PERIOD, then hands a plain view model to the client shell.
 *
 * The resolved range goes to the client as an object, not as a label. The
 * client must never call `resolvePeriod` itself: it would do so against the
 * browser's clock and timezone, and the chart's day axis would then disagree
 * with the rows the server actually selected.
 */
export default async function IphoneSyncReportPage({
  searchParams,
}: {
  searchParams: Promise<ParamRecord>;
}) {
  const { supabase, user } = await getAuthenticatedUser();

  if (!user) {
    redirect('/login');
  }

  // Verify internal role
  const { data: internalRole } = await supabase
    .from('internal_roles')
    .select('role_id')
    .eq('user_id', user.id)
    .single();

  if (!internalRole) {
    redirect('/login?error=not_authorized');
  }

  // Defense-in-depth: verify page-level permission
  const { data: hasPerm } = await supabase.rpc('has_permission', {
    check_user_id: user.id,
    required_permission: 'analytics.view',
  });
  if (!hasPerm) {
    redirect('/dashboard?error=insufficient_permissions');
  }

  const params = await searchParams;
  // A bare URL opens the user's default view: its filters and its time range.
  // Any period or filter key in the URL wins, and the views are not read here
  // at all (BACKLOG-4084).
  const { initialView, periodInput } = await resolveInitialSavedView({
    params,
    reportKeys: IPHONE_SYNC_URL_KEYS,
    parse: parseSavedViews,
    listViews: async () => {
      const { data, error } = await supabase.rpc('report_list_saved_views', {
        p_report_key: REPORT_KEY,
      });
      if (error) {
        // The message names the stage only; the error text can carry user data.
        console.error('[iphone-sync] saved views read failed; opening without a default view');
        throw error;
      }
      return data;
    },
  });
  const period = resolvePeriod(periodInput, new Date());
  const fromUrl = parseClientState(params);
  const initialState = initialView
    ? { ...fromUrl, filters: initialView.filters, stalledOnly: initialView.stalledOnly }
    : fromUrl;

  const { rows, users, failed, truncated } = await getIphoneSyncRuns(supabase, period);
  const report = buildIphoneSyncReport(rows, users);

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
          <Smartphone className="h-7 w-7 text-primary-600" />
          <div>
            <h1 className="text-2xl font-bold text-gray-900">iPhone Sync Performance</h1>
            <p className="text-sm text-gray-500">
              Every iPhone sync that finished in the selected period, with the per-phase timings
              that show where the time went. A sync still running is not counted here.
            </p>
          </div>
        </div>
      </div>

      {failed ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-5 text-sm text-amber-900">
          The sync data could not be read. This is a query failure, not an empty table — the numbers
          below are not a true zero.
        </div>
      ) : null}

      <IphoneSyncReportClient
        report={report}
        period={period}
        truncated={truncated}
        rowCap={RUN_LIMIT}
        initialState={initialState}
      />
    </div>
  );
}
