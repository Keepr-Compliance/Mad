'use client';

/**
 * Analytics report — composition shell (BACKLOG-3723)
 *
 * The period picker, the four tiles, the app-version section, Platform and
 * Phone type, Licence utilisation and the two placeholders. Navigation is a
 * prop, so this renders in a plain Node test.
 *
 * The period drives ONLY the Active Users and Active Devices tiles and the
 * app-version section (founder decision, BACKLOG-3723); the caption says so.
 * A failed read shows a banner for its section — never the empty text, and a
 * failed tile shows an em dash, never a 0.
 */

import { FilterBar, FilterCaption, PeriodPicker, SavedViews, StatCard, TruncationNotice } from '@keepr/ui';
import { Building2, Clock, Monitor, UserCheck, Users } from 'lucide-react';
import { Card } from '@keepr/design-system';
import type { AnalyticsData, CountResult } from '@/lib/reports/analytics-queries';
import {
  ANALYTICS_PERIOD_OPTIONS,
  buildAnalyticsPeriodUrl,
  type AnalyticsPeriod,
  type AnalyticsPeriodKey,
} from '@/lib/reports/analytics-period';
import { analyticsViews, type PeriodOnlySavedView } from '@/lib/reports/period-only-views';
import type { PeriodOnlyViewsApi } from '@/lib/reports/period-only-views-api';
import { usePeriodOnlySavedViews } from '@/lib/reports/use-period-only-saved-views';
import { VersionDistribution } from './components/VersionDistribution';
import { PlatformBreakdown } from './components/PlatformBreakdown';
import { PhoneTypeBreakdown } from './components/PhoneTypeBreakdown';
import { LicenseUtilization } from './components/LicenseUtilization';
import { SectionFailed } from './components/SectionFailed';

/** Exactly the sections the period drives (SR R5). */
export const PERIOD_DRIVEN_SECTIONS = ['Active Users', 'Active Devices', 'Active Users by App Version'] as const;

export const FAILED_VALUE = '—';

export interface AnalyticsReportProps {
  data: AnalyticsData;
  period: AnalyticsPeriod;
  rowCap: number;
  onNavigate?: (url: string) => void;
  /** Saved-view storage (BACKLOG-4084). Absent = saved views unavailable (fails closed). */
  viewsApi?: PeriodOnlyViewsApi;
}

function tileValue(c: CountResult): string {
  return c.failed || c.value === null ? FAILED_VALUE : c.value.toLocaleString();
}

export function AnalyticsReport({ data, period, rowCap, onNavigate, viewsApi }: AnalyticsReportProps) {
  const { counts, versions, platform, phone, license } = data;

  function navigateToPeriod(next: AnalyticsPeriodKey) {
    const search = typeof window === 'undefined' ? '' : window.location.search.replace(/^\?/, '');
    onNavigate?.(buildAnalyticsPeriodUrl(search, next));
  }

  // A stored period is checked against ANALYTICS_VIEW_PERIODS, so its key is an Analytics key.
  const savedViews = usePeriodOnlySavedViews(viewsApi, analyticsViews, period, (key) =>
    navigateToPeriod(key as AnalyticsPeriodKey)
  );

  const tiles = [
    { key: 'active_users', label: 'Active Users', subtitle: period.label, icon: UserCheck, hue: 'primary', c: counts.active_users },
    { key: 'total_users', label: 'Total Users', subtitle: 'All time', icon: Users, hue: 'blue', c: counts.total_users },
    { key: 'total_orgs', label: 'Organizations', subtitle: 'Total', icon: Building2, hue: 'green', c: counts.total_orgs },
    { key: 'active_devices', label: 'Active Devices', subtitle: period.label, icon: Monitor, hue: 'yellow', c: counts.active_devices },
  ] as const;
  const anyTileFailed = tiles.some((t) => t.c.failed);

  const notice = (noun: string, scope: string, periodLabel: string) => (
    <TruncationNotice noun={noun} capPhrase={`at most ${rowCap} rows`} periodLabel={periodLabel} scope={scope} />
  );

  return (
    <div className="space-y-6">
      <div>
        <FilterBar
          hasFilters={false}
          onClear={() => undefined}
          trailing={<SavedViews<PeriodOnlySavedView> {...savedViews} />}
        >
          <PeriodPicker<AnalyticsPeriodKey>
            options={ANALYTICS_PERIOD_OPTIONS}
            value={period.key}
            onChange={(next) => navigateToPeriod(next)}
          />
        </FilterBar>
        <FilterCaption
          className="mt-2 text-xs"
          lead={`The period drives ${PERIOD_DRIVEN_SECTIONS.join(', ')} only; every other number is all-time`}
          periodLabel={period.label}
          filterNames={[]}
        />
      </div>

      <div>
        {anyTileFailed ? <SectionFailed section="counts" /> : null}
        {counts.truncated ? notice('devices', 'the Active Users count', period.label) : null}
        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {tiles.map((t) => {
            const Icon = t.icon;
            return (
              <StatCard
                key={t.key}
                data-tile={t.key}
                label={t.label}
                value={tileValue(t.c)}
                subtitle={t.subtitle}
                icon={<Icon className="h-5 w-5" />}
                hue={t.hue}
                valueProps={{ 'data-tile-value': t.key }}
              />
            );
          })}
        </div>
      </div>

      <div>
        {versions.truncated ? notice('devices', 'every version count and adoption percentage', period.label) : null}
        <VersionDistribution
          data={versions.data}
          periodLabel={period.label}
          failed={versions.failed}
          namesFailed={versions.namesFailed}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div>
          {platform.truncated ? notice('devices', 'every platform count and percentage', 'All time') : null}
          <PlatformBreakdown data={platform.data} failed={platform.failed} />
        </div>
        <div>
          {phone.truncated ? notice('preferences', 'every phone type count and percentage', 'All time') : null}
          <PhoneTypeBreakdown data={phone.data} failed={phone.failed} />
        </div>
      </div>

      <div>
        {license.truncated ? notice('organizations or members', 'every seat count', 'All time') : null}
        <LicenseUtilization data={license.data} failed={license.failed} />
      </div>

      {/* Error Rate by Version (Sentry) — graceful placeholder */}
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

      {/* Version Adoption Over Time — Coming Soon */}
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
