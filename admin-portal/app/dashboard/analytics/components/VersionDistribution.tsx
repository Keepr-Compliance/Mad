'use client';

/**
 * Version Distribution — Analytics Dashboard
 *
 * Shows active users by app version with a bar chart
 * and a data table with counts and adoption percentages.
 * Clicking a version reveals the users on that version.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import { ChevronDown, ChevronRight, User } from 'lucide-react';
import { Card, Badge } from '@keepr/design-system';
import type { VersionDistribution as VersionDistributionData } from '@/lib/analytics-queries';

interface Props {
  data: VersionDistributionData[];
  activePeriod: number;
}

const PERIODS = [
  { days: 1, label: '24h' },
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
] as const;

const COLORS = [
  '#0ea5e9', // primary-500
  '#0284c7', // primary-600
  '#0369a1', // primary-700
  '#075985', // primary-800
  '#38bdf8', // primary-400
  '#7dd3fc', // primary-300
];

export function VersionDistribution({ data, activePeriod }: Props) {
  const [expandedVersion, setExpandedVersion] = useState<string | null>(null);
  const router = useRouter();
  const searchParams = useSearchParams();

  const setPeriod = (days: number) => {
    const params = new URLSearchParams(searchParams.toString());
    if (days === 30) {
      params.delete('period');
    } else {
      params.set('period', String(days));
    }
    router.push(`?${params.toString()}`, { scroll: false });
  };

  if (data.length === 0) {
    return (
      <Card>
        <h3 className="text-lg font-semibold text-gray-900 mb-4">
          Active Users by App Version
        </h3>
        <p className="text-sm text-gray-500">
          No device data available. Version distribution will appear once
          devices report their app version.
        </p>
      </Card>
    );
  }

  const handleBarClick = (entry: VersionDistributionData) => {
    setExpandedVersion(
      expandedVersion === entry.app_version ? null : entry.app_version
    );
  };

  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900">
          Active Users by App Version
        </h3>
        <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-0.5">
          {PERIODS.map((p) => (
            <button
              key={p.days}
              type="button"
              onClick={() => setPeriod(p.days)}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                activePeriod === p.days
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <p className="text-sm text-gray-500 mb-6">
        Based on active devices seen in the last {activePeriod === 1 ? '24 hours' : `${activePeriod} days`}. Click a bar or row to see users.
      </p>

      {/* Bar Chart */}
      <div className="h-64 mb-6">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis
              dataKey="app_version"
              tick={{ fontSize: 12, fill: '#6b7280' }}
            />
            <YAxis tick={{ fontSize: 12, fill: '#6b7280' }} allowDecimals={false} />
            <Tooltip
              contentStyle={{
                backgroundColor: '#fff',
                border: '1px solid #e5e7eb',
                borderRadius: '8px',
                fontSize: '13px',
              }}
              formatter={(value) => [Number(value) || 0, 'Users']}
            />
            <Bar
              dataKey="user_count"
              radius={[4, 4, 0, 0]}
              cursor="pointer"
              onClick={(_data, index) => {
                if (typeof index === 'number') handleBarClick(data[index]);
              }}
            >
              {data.map((entry, index) => (
                <Cell
                  key={`cell-${index}`}
                  fill={expandedVersion === entry.app_version
                    ? '#1d4ed8'
                    : COLORS[index % COLORS.length]}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Data Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200">
              <th className="text-left py-2 px-3 text-gray-500 font-medium">
                Version
              </th>
              <th className="text-right py-2 px-3 text-gray-500 font-medium">
                Users
              </th>
              <th className="text-right py-2 px-3 text-gray-500 font-medium">
                Adoption
              </th>
            </tr>
          </thead>
          <tbody>
            {data.map((row) => {
              const isExpanded = expandedVersion === row.app_version;
              return (
                <tr key={row.app_version} className="group">
                  <td colSpan={3} className="p-0">
                    {/* Clickable row */}
                    <button
                      type="button"
                      onClick={() => handleBarClick(row)}
                      className="w-full flex items-center border-b border-gray-100 last:border-0 hover:bg-gray-50 transition-colors"
                    >
                      <span className="flex items-center gap-1.5 py-2 px-3 font-mono text-gray-900 flex-1 text-left">
                        {isExpanded
                          ? <ChevronDown className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                          : <ChevronRight className="h-3.5 w-3.5 text-gray-400 shrink-0" />}
                        {row.app_version}
                      </span>
                      <span className="py-2 px-3 text-gray-700 text-right w-20">
                        {row.user_count}
                      </span>
                      <span className="py-2 px-3 text-right w-24">
                        <Badge hue="primary" size="sm">
                          {row.adoption_pct}%
                        </Badge>
                      </span>
                    </button>

                    {/* Expanded user list */}
                    {isExpanded && (
                      <div className="bg-gray-50 border-b border-gray-100 px-6 py-3">
                        <p className="text-xs font-medium text-gray-500 mb-2">
                          Users on {row.app_version}
                        </p>
                        {row.users.length === 0 ? (
                          <p className="text-xs text-gray-400">No user details available</p>
                        ) : (
                          <div className="space-y-1">
                            {row.users.map((u) => (
                              <Link
                                key={u.id}
                                href={`/dashboard/users/${u.id}`}
                                className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-100 transition-colors group/user"
                              >
                                <User className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                                <span className="text-sm text-gray-900 group-hover/user:text-primary-700">
                                  {u.display_name ?? u.email ?? 'Unknown User'}
                                </span>
                                {u.display_name && u.email && (
                                  <span className="text-xs text-gray-400">
                                    {u.email}
                                  </span>
                                )}
                              </Link>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
