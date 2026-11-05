import { requireReportAccess } from '@/lib/reports/report-gate';
import { ReportAccessProvider } from '@/lib/reports/report-access-context';
import Link from 'next/link';
import { ChevronLeft, Mail } from 'lucide-react';
import { getSyncRuns } from '@/lib/reports/iphone-sync-queries';
import {
  buildEmailPrecacheReport,
  EP_EXTRA_COLUMNS,
  EP_RUN_LIMIT,
  EP_SOURCE,
  type EpSyncOutcomeRow,
} from '@/lib/reports/email-precache';
import { EP_REPORT_KEY } from '@/lib/reports/email-precache-key';
import { reportHref, REPORTS_BASE_PATH } from '@/lib/reports/registry';
import { resolvePeriod } from '@/lib/reports/period';
import type { ParamRecord } from '@/lib/reports/report-url';
import { EmailPrecacheReport } from './EmailPrecacheReport';

export const dynamic = 'force-dynamic';

function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Email Sync Timing — Admin Portal (BACKLOG-4130).
 *
 * Server component: authorises (internal role + report access, BACKLOG-4144), resolves the
 * period, reads that period's rows of source 'email-precache' under this
 * report's own cap (dev builds left out), and renders the timing table.
 */
export default async function EmailPrecacheReportPage({
  searchParams,
}: {
  searchParams: Promise<ParamRecord>;
}) {
  const { supabase, access } = await requireReportAccess(EP_REPORT_KEY);

  const params = await searchParams;
  const period = resolvePeriod(
    {
      period: firstParam(params.period),
      from: firstParam(params.from),
      to: firstParam(params.to),
    },
    new Date()
  );

  const { rows, failed, truncated } = await getSyncRuns<EpSyncOutcomeRow>(supabase, period, {
    source: EP_SOURCE,
    limit: EP_RUN_LIMIT,
    extraColumns: EP_EXTRA_COLUMNS,
  });
  const report = buildEmailPrecacheReport(rows);

  return (
    <ReportAccessProvider reportKey={EP_REPORT_KEY} title="Email Sync Timing" access={access}>
      <div className="max-w-7xl mx-auto space-y-6">
        <div>
          <Link href={REPORTS_BASE_PATH} className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900">
            <ChevronLeft className="h-4 w-4" />
            All reports
          </Link>
          <div className="mt-2 flex items-center gap-3">
            <Mail className="h-7 w-7 text-primary-600" />
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Email Sync Timing</h1>
              <p className="text-sm text-gray-500">
                How long email syncs took in the selected period, by sync type and by how much mail they fetched. Dev
                builds are left out; a sync still running is not counted.
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

        <EmailPrecacheReport
          report={report}
          period={period}
          truncated={truncated}
          rowCap={EP_RUN_LIMIT}
          basePath={reportHref(EP_REPORT_KEY)}
        />
      </div>
    </ReportAccessProvider>
  );
}
