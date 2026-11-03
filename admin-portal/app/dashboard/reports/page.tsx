import { getAuthenticatedUser } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { REPORTS } from '@/lib/reports/registry';
import type { ParamRecord } from '@/lib/reports/report-url';
import { ReportsIndex } from './ReportsIndex';
import { REPORTS_VIEW_COOKIE, resolveReportsIndexView } from './reportsIndexView';

export const dynamic = 'force-dynamic';

/**
 * Reports index — Admin Portal (BACKLOG-3441)
 *
 * Lists every registered report. New reports are added to
 * `lib/reports/registry.ts`; the sidebar does not change.
 * Analytics (BACKLOG-3723) and Paywall Funnel (BACKLOG-3722) are registry
 * reports; neither has a sidebar entry of its own (BACKLOG-4005).
 *
 * BACKLOG-4091: Cards | List layout. The starting layout is resolved here,
 * after the gate: ?view first, then the reports-index-view cookie, then Cards.
 */
export default async function ReportsIndexPage({
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
  const cookieStore = await cookies();
  const initialView = resolveReportsIndexView({
    url: params.view,
    cookie: cookieStore.get(REPORTS_VIEW_COOKIE)?.value,
  });

  return <ReportsIndex reports={REPORTS} initialView={initialView} />;
}
