'use client';

/**
 * Platform Breakdown — Analytics Dashboard
 *
 * Shows macOS vs Windows (and any other platform) user counts
 * with a horizontal bar visualization.
 */

import { Card } from '@keepr/design-system';
import type { PlatformBreakdown as PlatformBreakdownData } from '@/lib/analytics-queries';

interface Props {
  data: PlatformBreakdownData[];
}

const PLATFORM_COLORS: Record<string, string> = {
  darwin: '#0ea5e9',  // primary-500 (macOS)
  win32: '#8b5cf6',   // purple-500 (Windows)
  linux: '#f59e0b',   // amber-500
  Unknown: '#9ca3af', // gray-400
};

const PLATFORM_LABELS: Record<string, string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
  Unknown: 'Unknown',
};

export function PlatformBreakdown({ data }: Props) {
  if (data.length === 0) {
    return (
      <Card>
        <h3 className="text-lg font-semibold text-gray-900 mb-4">
          Platform Breakdown
        </h3>
        <p className="text-sm text-gray-500">
          No device data available.
        </p>
      </Card>
    );
  }

  const totalUsers = data.reduce((sum, d) => sum + d.user_count, 0);

  return (
    <Card>
      <h3 className="text-lg font-semibold text-gray-900 mb-4">
        Platform Breakdown
      </h3>
      <p className="text-sm text-gray-500 mb-6">
        Active devices by operating system
      </p>

      {/* Stacked progress bar */}
      <div className="flex h-4 rounded-full overflow-hidden bg-gray-100 mb-6">
        {data.map((entry) => (
          <div
            key={entry.platform}
            className="h-full transition-all duration-300"
            style={{
              width: `${entry.pct}%`,
              backgroundColor:
                PLATFORM_COLORS[entry.platform] ?? PLATFORM_COLORS.Unknown,
              minWidth: entry.pct > 0 ? '4px' : '0',
            }}
            title={`${PLATFORM_LABELS[entry.platform] ?? entry.platform}: ${entry.pct}%`}
          />
        ))}
      </div>

      {/* Legend & counts */}
      <div className="space-y-3">
        {data.map((entry) => {
          const color =
            PLATFORM_COLORS[entry.platform] ?? PLATFORM_COLORS.Unknown;
          const label =
            PLATFORM_LABELS[entry.platform] ?? entry.platform;

          return (
            <div key={entry.platform} className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span
                  className="w-3 h-3 rounded-full"
                  style={{ backgroundColor: color }}
                />
                <span className="text-sm font-medium text-gray-700">
                  {label}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm text-gray-600">
                  {entry.user_count.toLocaleString()} user{entry.user_count !== 1 ? 's' : ''}
                </span>
                <span className="text-sm font-semibold text-gray-900 w-12 text-right">
                  {totalUsers > 0
                    ? Math.round((entry.user_count / totalUsers) * 100)
                    : 0}
                  %
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
