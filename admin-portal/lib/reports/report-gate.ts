/**
 * The one server-side gate for the report pages and the Reports index (BACKLOG-4144).
 *
 * Every report page calls `requireReportAccess(<its key>)` instead of checking analytics.view. No
 * access, or an answer that cannot be read, is `notFound()`: the page does not say the report exists.
 * The index calls `requireMyReports()` and lists only what it returns.
 *
 * The middleware keeps its coarse analytics.view check on /dashboard/reports: the server grants
 * report access only to users whose role has analytics.view, so that check refuses nobody this gate
 * would let in.
 *
 * The server functions are the access guard; this gate decides only what the page renders.
 */

import { notFound, redirect } from 'next/navigation';
import { getAuthenticatedUser } from '@/lib/supabase/server';
import { parseMyReports, parseReportAccess, type MyReport, type ReportAccess } from './report-access';

type Authenticated = Awaited<ReturnType<typeof getAuthenticatedUser>>;
type Supabase = Authenticated['supabase'];

/** Signed in with an internal role, else the same redirects the pages used before. */
// Middleware stays coarse (analytics.view): _report_access_role admits only users passing _report_share_eligible, the same analytics.view join.
async function requireInternalUser(): Promise<{ supabase: Supabase; user: NonNullable<Authenticated['user']> }> {
  const { supabase, user } = await getAuthenticatedUser();
  if (!user) redirect('/login');

  const { data: internalRole } = await supabase
    .from('internal_roles')
    .select('role_id')
    .eq('user_id', user.id)
    .single();
  if (!internalRole) redirect('/login?error=not_authorized');

  return { supabase, user };
}

/** The caller's access to one report, or `notFound()`. */
export async function requireReportAccess(reportKey: string): Promise<{
  supabase: Supabase;
  user: NonNullable<Authenticated['user']>;
  access: ReportAccess;
}> {
  const { supabase, user } = await requireInternalUser();
  const { data, error } = await supabase.rpc('report_my_access', { p_key: reportKey });
  const access = error ? null : parseReportAccess(data);
  if (!access) notFound();
  return { supabase, user, access };
}

/** The reports the caller may open. An empty or unreadable list is `notFound()`. */
export async function requireMyReports(): Promise<{ supabase: Supabase; reports: MyReport[] }> {
  const { supabase } = await requireInternalUser();
  const { data, error } = await supabase.rpc('report_list_my_reports');
  const reports = error ? [] : parseMyReports(data);
  if (reports.length === 0) notFound();
  return { supabase, reports };
}
