/**
 * License Utilization — Analytics Dashboard
 *
 * Displays license seat usage by organization plan (trial / pro / enterprise)
 * with utilization progress bars.
 */

import { Shield } from 'lucide-react';
import { Card } from '@keepr/design-system';
import type { LicenseUtilization as LicenseUtilizationData } from '@/lib/analytics-queries';

interface Props {
  data: LicenseUtilizationData[];
}

const PLAN_STYLES: Record<string, { badge: string; bar: string }> = {
  trial: {
    badge: 'bg-warning-50 text-warning-600',
    bar: 'bg-warning-500',
  },
  pro: {
    badge: 'bg-primary-100 text-primary-800',
    bar: 'bg-primary-500',
  },
  enterprise: {
    badge: 'bg-success-50 text-success-600',
    bar: 'bg-success-500',
  },
};

function getBarColor(pct: number): string {
  if (pct >= 90) return 'bg-danger-500';
  if (pct >= 75) return 'bg-warning-500';
  return '';
}

export function LicenseUtilization({ data }: Props) {
  if (data.length === 0) {
    return (
      <Card>
        <div className="flex items-center gap-2 mb-4">
          <Shield className="h-5 w-5 text-gray-400" />
          <h3 className="text-lg font-semibold text-gray-900">
            License Utilization
          </h3>
        </div>
        <p className="text-sm text-gray-500">
          No organization data available.
        </p>
      </Card>
    );
  }

  const totals = data.reduce(
    (acc, row) => ({
      orgs: acc.orgs + row.org_count,
      seats: acc.seats + row.total_seats,
      active: acc.active + row.active_seats,
    }),
    { orgs: 0, seats: 0, active: 0 }
  );

  const overallPct =
    totals.seats > 0 ? Math.round((totals.active / totals.seats) * 100) : 0;

  return (
    <Card>
      <div className="flex items-center gap-2 mb-1">
        <Shield className="h-5 w-5 text-gray-400" />
        <h3 className="text-lg font-semibold text-gray-900">
          License Utilization
        </h3>
      </div>
      <p className="text-sm text-gray-500 mb-6">
        Seat usage across organization plans
      </p>

      {/* Overall summary */}
      <div className="flex items-baseline gap-2 mb-6">
        <span className="text-3xl font-bold text-gray-900">
          {totals.active}
        </span>
        <span className="text-lg text-gray-400">/</span>
        <span className="text-lg text-gray-500">
          {totals.seats} seats
        </span>
        <span className="ml-auto text-sm font-medium text-gray-600">
          {overallPct}% utilized
        </span>
      </div>

      {/* Overall progress bar */}
      <div className="h-2 rounded-full bg-gray-100 mb-8">
        <div
          className={`h-full rounded-full transition-all duration-300 ${
            getBarColor(overallPct) || 'bg-primary-500'
          }`}
          style={{ width: `${Math.min(overallPct, 100)}%` }}
        />
      </div>

      {/* Per-plan breakdown */}
      <div className="space-y-4">
        {data.map((row) => {
          const styles = PLAN_STYLES[row.plan] ?? PLAN_STYLES.trial;

          return (
            <div
              key={row.plan}
              className="border border-gray-100 rounded-lg p-4"
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold capitalize ${styles.badge}`}
                  >
                    {row.plan}
                  </span>
                  <span className="text-sm text-gray-500">
                    {row.org_count} org{row.org_count !== 1 ? 's' : ''}
                  </span>
                </div>
                <span className="text-sm font-medium text-gray-700">
                  {row.active_seats} / {row.total_seats} seats ({row.utilization_pct}%)
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-gray-100">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    getBarColor(row.utilization_pct) || styles.bar
                  }`}
                  style={{
                    width: `${Math.min(row.utilization_pct, 100)}%`,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
