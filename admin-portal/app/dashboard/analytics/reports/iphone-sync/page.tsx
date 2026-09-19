import { getAuthenticatedUser } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft, Smartphone } from 'lucide-react';
import { getIphoneSyncRuns } from '@/lib/reports/iphone-sync-queries';
import { buildIphoneSyncReport } from '@/lib/reports/iphone-sync';
import { REPORTS_BASE_PATH } from '@/lib/reports/registry';
import { IphoneSyncReport } from './IphoneSyncReport';

export const dynamic = 'force-dynamic';

/**
 * iPhone Sync Performance report — Admin Portal (BACKLOG-3441)
 *
 * Server component: authorises, fetches, then hands a plain view model to a
 * synchronous presentational component.
 */
export default async function IphoneSyncReportPage() {
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

  const { rows, users, failed } = await getIphoneSyncRuns(supabase);
  const report = buildIphoneSyncReport(rows, users);

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
          <Smartphone className="h-7 w-7 text-primary-600" />
          <div>
            <h1 className="text-2xl font-bold text-gray-900">iPhone Sync Performance</h1>
            <p className="text-sm text-gray-500">
              Every iPhone sync that reported an outcome, newest first, with the per-phase timings
              that show where the time went.
            </p>
          </div>
        </div>
      </div>

      {failed ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-5 text-sm text-amber-900">
          The sync data could not be read. This is a query failure, not an empty table — the numbers
          below are not a true zero.
        </div>
      ) : null}

      <IphoneSyncReport report={report} />
    </div>
  );
}
