import { getAuthenticatedUser } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft, Activity } from 'lucide-react';
import {
  getActivityDevices,
  getActivityEvents,
  getActivityMemberships,
  getActivityOrgs,
  getActivityUsers,
  getStaffIds,
  MAX_PAGES,
  PAGE_SIZE,
} from '@/lib/reports/user-activity-queries';
import { buildUserActivityReport } from '@/lib/reports/user-activity';
import { REPORTS_BASE_PATH } from '@/lib/reports/registry';
import { resolvePeriod } from '@/lib/reports/period';
import type { ParamRecord } from '@/lib/reports/report-url';
import { resolveUserActivityInitial, USER_ACTIVITY_REPORT_KEY } from '@/lib/reports/user-activity-views';
import { UserActivityReportClient } from './UserActivityReportClient';

export const dynamic = 'force-dynamic';

/**
 * User Activity report — Admin Portal (BACKLOG-3720)
 *
 * Server component: authorises (internal role + analytics.view), resolves the
 * period, reads users, devices, memberships, organizations, internal staff and
 * the period's audit events through the authenticated client — every read
 * paged — and hands a plain view model to the client shell.
 */
export default async function UserActivityReportPage({
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
  // A bare URL opens the user's default view (filters + time range); any period
  // param in the URL wins and the views are not read here at all (BACKLOG-4084).
  const { initialView, periodInput } = await resolveUserActivityInitial(params, async () => {
    const { data, error } = await supabase.rpc('report_list_saved_views', {
      p_report_key: USER_ACTIVITY_REPORT_KEY,
    });
    if (error) {
      // The message names the stage only; the error text can carry user data.
      console.error('[user-activity] saved views read failed; opening without a default view');
      throw error;
    }
    return data;
  });
  const period = resolvePeriod(periodInput, now);

  const [events, users, devices, memberships, orgs, staff] = await Promise.all([
    getActivityEvents(supabase, period),
    getActivityUsers(supabase),
    getActivityDevices(supabase),
    getActivityMemberships(supabase),
    getActivityOrgs(supabase),
    getStaffIds(supabase, user.id),
  ]);

  const report = buildUserActivityReport({
    users: users.rows,
    devices: devices.rows,
    events: events.rows,
    memberships: memberships.rows,
    orgs: orgs.rows,
    staffIds: staff.staffIds,
  });

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
          <Activity className="h-7 w-7 text-primary-600" />
          <div>
            <h1 className="text-2xl font-bold text-gray-900">User Activity</h1>
            <p className="text-sm text-gray-500">
              One row per customer: when they last signed in and were last seen, their devices, and
              how many transactions, submissions and exports they ran in the selected period.
            </p>
          </div>
        </div>
      </div>

      <UserActivityReportClient
        report={report}
        period={period}
        eventsFailed={events.failed}
        lookupsFailed={users.failed || devices.failed || memberships.failed || orgs.failed}
        truncated={events.truncated}
        rowCap={PAGE_SIZE * MAX_PAGES}
        staffExclusionIncomplete={!staff.complete}
        initialView={initialView}
      />
    </div>
  );
}
