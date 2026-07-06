import { getAuthenticatedUser } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { BarChart3, Clock } from 'lucide-react';
import { Card } from '@keepr/design-system';
import {
  getVersionDistribution,
  getSystemCounts,
  getPlatformBreakdown,
  getLicenseUtilization,
  getPhoneTypeBreakdown,
} from '@/lib/analytics-queries';
import { VersionDistribution } from './components/VersionDistribution';
import { SystemCounts } from './components/SystemCounts';
import { PlatformBreakdown } from './components/PlatformBreakdown';
import { LicenseUtilization } from './components/LicenseUtilization';
import { PhoneTypeBreakdown } from './components/PhoneTypeBreakdown';

export const dynamic = 'force-dynamic';

/**
 * Analytics Dashboard — Admin Portal
 *
 * Server component that fetches system-wide analytics data
 * and renders the dashboard sections.
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

  // Parse version period filter from searchParams
  const params = await searchParams;
  const VALID_PERIODS: Record<string, number> = { '1': 1, '7': 7, '30': 30, '90': 90 };
  const versionDays = VALID_PERIODS[params.period ?? ''] ?? 30;

  // Fetch all analytics data in parallel
  const [versionData, systemCounts, platformData, licenseData, phoneTypeData] =
    await Promise.all([
      getVersionDistribution(supabase, versionDays),
      getSystemCounts(supabase),
      getPlatformBreakdown(supabase),
      getLicenseUtilization(supabase),
      getPhoneTypeBreakdown(supabase),
    ]);

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Page Header */}
      <div className="flex items-center gap-3">
        <BarChart3 className="h-7 w-7 text-primary-600" />
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Analytics</h1>
          <p className="text-sm text-gray-500">
            System-wide metrics and adoption data
          </p>
        </div>
      </div>

      {/* Section 1: System Counts */}
      <SystemCounts data={systemCounts} />

      {/* Section 2: Version Distribution */}
      <VersionDistribution data={versionData} activePeriod={versionDays} />

      {/* Section 3: Two-column layout for Platform + Phone Type */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <PlatformBreakdown data={platformData} />
        <PhoneTypeBreakdown data={phoneTypeData} />
      </div>

      {/* Section 4: License Utilization */}
      <LicenseUtilization data={licenseData} />

      {/* Section 4: Error Rate by Version (Sentry) — graceful placeholder */}
      <Card>
        <h3 className="text-lg font-semibold text-gray-900 mb-2">
          Error Rate by Version
        </h3>
        <p className="text-sm text-gray-500">
          Sentry integration is not yet configured. Once a Sentry API token is
          provided via the <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">SENTRY_API_TOKEN</code> environment
          variable, error rates per app version will appear here.
        </p>
      </Card>

      {/* Section 5: Version Adoption Over Time — Coming Soon */}
      <Card>
        <div className="flex items-center gap-2 mb-2">
          <Clock className="h-5 w-5 text-gray-400" />
          <h3 className="text-lg font-semibold text-gray-900">
            Version Adoption Over Time
          </h3>
        </div>
        <p className="text-sm text-gray-500">
          Coming soon. This chart requires historical version snapshot data that
          is not yet being collected. A scheduled job will be added in a future
          sprint to capture daily version distribution.
        </p>
      </Card>
    </div>
  );
}
