import { requireReportAccess } from '@/lib/reports/report-gate';
import { ReportAccessProvider } from '@/lib/reports/report-access-context';
import { ReportShareButton } from '@/components/reports/ReportShareButton';
import Link from 'next/link';
import { BarChart3, ChevronLeft } from 'lucide-react';
import { getAnalyticsData } from '@/lib/reports/analytics-queries';
import { resolveAnalyticsPeriod } from '@/lib/reports/analytics-period';
import { ANALYTICS_REPORT_KEY, analyticsViews } from '@/lib/reports/period-only-views';
import type { ParamRecord } from '@/lib/reports/report-url';
import { MAX_PAGES, PAGE_SIZE } from '@/lib/reports/fetch-all-pages';
import { REPORTS_BASE_PATH } from '@/lib/reports/registry';
import { AnalyticsReportClient } from './AnalyticsReportClient';

export const dynamic = 'force-dynamic';

/**
 * Analytics Dashboard — Admin Portal
 *
 * Server component: authorises (internal role + report access, BACKLOG-4144), resolves the
 * period (BACKLOG-3723: it drives the Active Users / Active Devices tiles and
 * the app-version section only), runs every read — paged — in parallel, and
 * hands the sections, each with its own failed / truncated flags, to the
 * report-kit shell.
 */
export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<ParamRecord>;
}) {
  const { supabase, access } = await requireReportAccess(ANALYTICS_REPORT_KEY);

  const params = await searchParams;
  // A bare URL opens the user's default view (its time range); any period
  // param in the URL wins and the views are not read here at all (BACKLOG-4084).
  const { periodInput } = await analyticsViews.resolveInitial(params, async () => {
    const { data, error } = await supabase.rpc('report_list_saved_views', { p_report_key: ANALYTICS_REPORT_KEY });
    if (error) {
      // The message names the stage only; the error text can carry user data.
      console.error('[analytics] saved views read failed; opening without a default view');
      throw error;
    }
    return data;
  });
  const period = resolveAnalyticsPeriod({ period: periodInput.period }, new Date());
  const data = await getAnalyticsData(supabase, period.fromIso);

  return (
    <ReportAccessProvider reportKey={ANALYTICS_REPORT_KEY} title="Analytics" access={access}>
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
            <BarChart3 className="h-7 w-7 text-primary-600" />
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Analytics</h1>
              <p className="text-sm text-gray-500">
                System-wide metrics and adoption data
              </p>
            </div>
            <div className="ml-auto">
              <ReportShareButton />
            </div>
          </div>
        </div>

        <AnalyticsReportClient data={data} period={period} rowCap={PAGE_SIZE * MAX_PAGES} />
      </div>
    </ReportAccessProvider>
  );
}
