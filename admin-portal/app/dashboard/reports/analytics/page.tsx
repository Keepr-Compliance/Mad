import { getAuthenticatedUser } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { BarChart3, ChevronLeft } from 'lucide-react';
import { getAnalyticsData } from '@/lib/reports/analytics-queries';
import { resolveAnalyticsPeriod } from '@/lib/reports/analytics-period';
import { MAX_PAGES, PAGE_SIZE } from '@/lib/reports/fetch-all-pages';
import { REPORTS_BASE_PATH } from '@/lib/reports/registry';
import { AnalyticsReportClient } from './AnalyticsReportClient';

export const dynamic = 'force-dynamic';

/**
 * Analytics Dashboard — Admin Portal
 *
 * Server component: authorises (internal role + analytics.view), resolves the
 * period (BACKLOG-3723: it drives the Active Users / Active Devices tiles and
 * the app-version section only), runs every read — paged — in parallel, and
 * hands the sections, each with its own failed / truncated flags, to the
 * report-kit shell.
 */
export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
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
  const period = resolveAnalyticsPeriod(
    { period: typeof params.period === 'string' ? params.period : undefined },
    new Date()
  );
  const data = await getAnalyticsData(supabase, period.fromIso);

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
          <BarChart3 className="h-7 w-7 text-primary-600" />
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Analytics</h1>
            <p className="text-sm text-gray-500">
              System-wide metrics and adoption data
            </p>
          </div>
        </div>
      </div>

      <AnalyticsReportClient data={data} period={period} rowCap={PAGE_SIZE * MAX_PAGES} />
    </div>
  );
}
