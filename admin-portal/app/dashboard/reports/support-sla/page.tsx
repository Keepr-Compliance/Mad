import { getAuthenticatedUser } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft, LifeBuoy } from 'lucide-react';
import {
  getAgentUsers,
  getOpenTicketCount,
  getSupportSlaSettings,
  getSupportTickets,
  SUPPORT_TICKET_LIMIT,
} from '@/lib/reports/support-sla-queries';
import {
  buildSupportSlaReport,
  READ_FAILED_MESSAGE,
  SLA_SETTINGS_READ_FAILED_MESSAGE,
} from '@/lib/reports/support-sla';
import { REPORTS_BASE_PATH } from '@/lib/reports/registry';
import { resolvePeriod } from '@/lib/reports/period';
import { SUPPORT_SLA_REPORT_KEY, supportSlaViews } from '@/lib/reports/period-only-views';
import type { ParamRecord } from '@/lib/reports/report-url';
import { SupportSlaReportClient } from './SupportSlaReportClient';

export const dynamic = 'force-dynamic';

/**
 * Support SLA report — Admin Portal (BACKLOG-3721)
 *
 * The former Support → Analytics screen, moved under Reports. Server
 * component: authorises (internal role + analytics.view), resolves the
 * period, reads the period's tickets, the exact open count and the agents'
 * names through the authenticated client, and hands the built report to the
 * client shell. Every number comes from lib/reports/support-sla.ts
 * (BACKLOG-3651).
 *
 * BACKLOG-4086: the SLA targets and business window are read from
 * `support_sla_settings` with the tickets. Every duration is business time.
 * When the settings cannot be read, the durations and target rates show "-"
 * with a notice; no code default stands in for them.
 */
export default async function SupportSlaReportPage({
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
  // A bare URL opens the user's default view (its time range); any period
  // param in the URL wins and the views are not read here at all (BACKLOG-4084).
  const { periodInput } = await supportSlaViews.resolveInitial(params, async () => {
    const { data, error } = await supabase.rpc('report_list_saved_views', { p_report_key: SUPPORT_SLA_REPORT_KEY });
    if (error) {
      // The message names the stage only; the error text can carry user data.
      console.error('[support-sla] saved views read failed; opening without a default view');
      throw error;
    }
    return data;
  });
  const period = resolvePeriod(periodInput, new Date());

  const [tickets, openCount, settings] = await Promise.all([
    getSupportTickets(supabase, period),
    getOpenTicketCount(supabase),
    getSupportSlaSettings(supabase),
  ]);
  const users = tickets.failed ? [] : await getAgentUsers(supabase, tickets.rows);
  const report = tickets.failed
    ? null
    : buildSupportSlaReport(tickets.rows, users, period, openCount, { settings, now: new Date() });

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
          <LifeBuoy className="h-7 w-7 text-primary-600" />
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Support SLA</h1>
            <p className="text-sm text-gray-500">
              How quickly support tickets got a first response and were resolved in the selected
              period, overall and per agent.
            </p>
          </div>
        </div>
      </div>

      {tickets.failed ? (
        <div
          data-notice="read-failed"
          className="rounded-lg border border-amber-300 bg-amber-50 p-5 text-sm text-amber-900"
        >
          {READ_FAILED_MESSAGE}
        </div>
      ) : null}

      {settings === null ? (
        <div
          data-notice="settings-read-failed"
          className="rounded-lg border border-amber-300 bg-amber-50 p-5 text-sm text-amber-900"
        >
          {SLA_SETTINGS_READ_FAILED_MESSAGE}
        </div>
      ) : null}

      <SupportSlaReportClient
        report={report}
        settings={settings}
        period={period}
        truncated={tickets.truncated}
        rowCap={SUPPORT_TICKET_LIMIT}
      />
    </div>
  );
}
