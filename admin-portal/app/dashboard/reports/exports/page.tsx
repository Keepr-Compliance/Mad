import { getAuthenticatedUser } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft, Download } from 'lucide-react';
import { EXPORT_LIMIT, getExportEvents, getExportLookups } from '@/lib/reports/exports-queries';
import { buildExportsReport } from '@/lib/reports/exports';
import { REPORTS_BASE_PATH } from '@/lib/reports/registry';
import { resolvePeriod } from '@/lib/reports/period';
import type { ParamRecord } from '@/lib/reports/report-url';
import { ExportsReportClient } from './ExportsReportClient';

export const dynamic = 'force-dynamic';

/**
 * Exports report — Admin Portal (BACKLOG-4004)
 *
 * Server component: authorises (internal role + analytics.view), resolves the
 * period, reads the period's export-completed events and their users'
 * names and organizations through the authenticated client, and hands a plain
 * view model to the client shell.
 */
export default async function ExportsReportPage({
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
  const period = resolvePeriod(
    {
      period: typeof params.period === 'string' ? params.period : undefined,
      from: typeof params.from === 'string' ? params.from : undefined,
      to: typeof params.to === 'string' ? params.to : undefined,
    },
    new Date()
  );

  const result = await getExportEvents(supabase, period);
  const lookups = await getExportLookups(supabase, result.rows);
  const report = buildExportsReport(result.rows, lookups);

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
          <Download className="h-7 w-7 text-primary-600" />
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Exports</h1>
            <p className="text-sm text-gray-500">
              How many exports each user ran in the selected period, how many were unique exports
              (each user and deal counted once), in which formats, and when.
            </p>
          </div>
        </div>
      </div>

      {result.failed ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-5 text-sm text-amber-900">
          The export data could not be read. This is a query failure, not an empty table — the numbers
          below are not a true zero.
        </div>
      ) : null}

      <ExportsReportClient
        report={report}
        period={period}
        truncated={result.truncated}
        rowCap={EXPORT_LIMIT}
      />
    </div>
  );
}
