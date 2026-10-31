import { getAuthenticatedUser } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft, Filter } from 'lucide-react';
import { computeFunnel } from '@/lib/funnel-analytics';
import { getFunnelEvents } from '@/lib/reports/funnel-queries';
import { MAX_PAGES, PAGE_SIZE } from '@/lib/reports/fetch-all-pages';
import { resolveFunnelPeriod } from '@/lib/reports/funnel-period';
import { FUNNEL_REPORT_KEY, funnelViews } from '@/lib/reports/period-only-views';
import { REPORTS_BASE_PATH } from '@/lib/reports/registry';
import type { ParamRecord } from '@/lib/reports/report-url';
import { FunnelReportClient } from './FunnelReportClient';

export const dynamic = 'force-dynamic';

/**
 * Paywall Funnel report — Admin Portal (BACKLOG-2014, report kit BACKLOG-3722)
 *
 * Server component: authorises (internal role + analytics.view), resolves the
 * funnel's own period, reads the funnel events from `analytics_events` —
 * paged — and hands the `computeFunnel` result to the client shell, so the
 * founder can tell a PRICE problem (drop at unlock clicked -> payment) from
 * PAYWALL CONFUSION (drop at paywall viewed -> unlock clicked) from a BROKEN
 * CHECKOUT (drop at payment succeeded despite unlock clicks).
 */
export default async function FunnelPage({
  searchParams,
}: {
  searchParams: Promise<ParamRecord>;
}) {
  const { supabase, user } = await getAuthenticatedUser();

  if (!user) {
    redirect('/login');
  }

  // Verify internal role.
  const { data: internalRole } = await supabase
    .from('internal_roles')
    .select('role_id')
    .eq('user_id', user.id)
    .single();

  if (!internalRole) {
    redirect('/login?error=not_authorized');
  }

  // Defense-in-depth: verify page-level permission (reuses analytics.view).
  const { data: hasPerm } = await supabase.rpc('has_permission', {
    check_user_id: user.id,
    required_permission: 'analytics.view',
  });
  if (!hasPerm) {
    redirect('/dashboard?error=insufficient_permissions');
  }

  const params = await searchParams;
  // A bare URL opens the user's default view (its time range); any period
  // param in the URL wins and the views are not read here at all (BACKLOG-4084).
  const { periodInput } = await funnelViews.resolveInitial(params, async () => {
    const { data, error } = await supabase.rpc('report_list_saved_views', { p_report_key: FUNNEL_REPORT_KEY });
    if (error) {
      // The message names the stage only; the error text can carry user data.
      console.error('[funnel] saved views read failed; opening without a default view');
      throw error;
    }
    return data;
  });
  const period = resolveFunnelPeriod(periodInput, new Date());

  const events = await getFunnelEvents(supabase, period);
  const funnel = computeFunnel(events.rows);

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div>
        <Link
          href={REPORTS_BASE_PATH}
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900"
        >
          <ChevronLeft className="h-4 w-4" />
          All reports
        </Link>
        <div className="mt-2 flex items-center gap-3">
          <Filter className="h-7 w-7 text-primary-600" />
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Paywall Funnel</h1>
            <p className="text-sm text-gray-500">
              Paywall viewed &rarr; unlock clicked &rarr; payment succeeded &rarr; export completed. Where do
              users drop off?
            </p>
          </div>
        </div>
      </div>

      <FunnelReportClient
        funnel={funnel}
        period={period}
        failed={events.failed}
        truncated={events.truncated}
        rowCap={PAGE_SIZE * MAX_PAGES}
      />
    </div>
  );
}
