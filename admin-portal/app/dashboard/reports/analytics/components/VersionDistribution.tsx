'use client';

/**
 * Version Distribution — Analytics report
 *
 * Shows active users by app version with a bar chart
 * and a data table with counts and adoption percentages.
 * Clicking a version reveals the users on that version.
 *
 * BACKLOG-3723: the period buttons moved to the report's PeriodPicker; this
 * section only reads the resolved period's label. A failed read shows a
 * banner, never the empty text.
 */

import { useState } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight, User } from 'lucide-react';
import { Card, Badge } from '@keepr/design-system';
import type { VersionDistribution as VersionDistributionData } from '@/lib/reports/analytics';
import { VersionChart } from './VersionChart';
import { SectionFailed } from './SectionFailed';

export const VERSIONS_EMPTY_TEXT =
  'No device data available. Version distribution will appear once devices report their app version.';
export const NAMES_FAILED_TEXT = 'User names could not be loaded.';

interface Props {
  data: VersionDistributionData[];
  /** The resolved period, e.g. "Last 7 days" or "All time". */
  periodLabel: string;
  failed?: boolean;
  namesFailed?: boolean;
}

export function VersionDistribution({ data, periodLabel, failed = false, namesFailed = false }: Props) {
  const [expandedVersion, setExpandedVersion] = useState<string | null>(null);

  if (failed || data.length === 0) {
    return (
      <Card>
        <h3 className="text-lg font-semibold text-gray-900 mb-4">
          Active Users by App Version
        </h3>
        {failed ? (
          <SectionFailed section="versions" />
        ) : (
          <p className="text-sm text-gray-500">{VERSIONS_EMPTY_TEXT}</p>
        )}
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
      <h3 className="text-lg font-semibold text-gray-900 mb-4">
        Active Users by App Version
      </h3>
      <p className="text-sm text-gray-500 mb-6">
        Based on active devices seen {periodLabel === 'All time' ? 'at any time' : `in the ${periodLabel.toLowerCase()}`}. Click a bar or row to see users.
      </p>

      {/* Bar Chart */}
      <VersionChart data={data} expandedVersion={expandedVersion} onBarClick={handleBarClick} />

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
                        {namesFailed ? (
                          <p data-notice="names-failed" className="text-xs text-amber-700 mb-2">
                            {NAMES_FAILED_TEXT}
                          </p>
                        ) : null}
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
