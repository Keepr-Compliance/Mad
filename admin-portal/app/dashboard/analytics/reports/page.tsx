import { getAuthenticatedUser } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ChevronRight, FileBarChart2 } from 'lucide-react';
import { REPORTS, reportHref } from '@/lib/reports/registry';

export const dynamic = 'force-dynamic';

/**
 * Reports index — Admin Portal (BACKLOG-3441)
 *
 * Lists every registered report. New reports are added to
 * `lib/reports/registry.ts`; the sidebar does not change.
 */
export default async function ReportsIndexPage() {
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

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <FileBarChart2 className="h-7 w-7 text-primary-600" />
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Reports</h1>
          <p className="text-sm text-gray-500">
            Focused views over production data, built to answer one question each.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {REPORTS.map((report) => (
          <Link
            key={report.slug}
            href={reportHref(report.slug)}
            className="group rounded-lg border border-gray-200 bg-white p-6 shadow-sm transition-all hover:border-gray-300 hover:shadow-md"
          >
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-lg font-semibold text-gray-900">{report.title}</h2>
              <ChevronRight className="h-5 w-5 shrink-0 text-gray-400 group-hover:text-gray-900" />
            </div>
            <p className="mt-2 text-sm text-gray-600">{report.description}</p>
            <p className="mt-3 text-xs text-gray-400">
              Source: <code className="text-xs">{report.source}</code>
            </p>
          </Link>
        ))}
      </div>
    </div>
  );
}
