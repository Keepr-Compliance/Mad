'use client';

/**
 * Platform Breakdown — Analytics Dashboard
 *
 * Shows macOS vs Windows (and any other platform) user counts
 * with a horizontal bar visualization.
 */

import { Card } from '@keepr/design-system';
import type {
  CountMode,
  PlatformBreakdown as PlatformBreakdownData,
} from '@/lib/analytics-queries';
import { CountModeToggle, countModeCaption } from './CountModeToggle';

interface Props {
  data: PlatformBreakdownData[];
  activeMode: CountMode;
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

export function PlatformBreakdown({ data, activeMode }: Props) {
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

  return (
    <Card>
      <h3 className="text-lg font-semibold text-gray-900 mb-4">
        Platform Breakdown
      </h3>
      <p className="text-sm text-gray-500 mb-6">
        Active users by operating system
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

      {/*
        Count-mode toggle — founder-specified placement: directly above the
        legend list, the Platform card's equivalent of the Version card's table
        header. The stacked bar above and this list render from the same `data`
        prop, so the toggle moves both together.
      */}
      <div className="mb-4">
        <CountModeToggle activeMode={activeMode} />
        <p className="text-xs text-gray-500 mt-2">
          {countModeCaption(activeMode, 'platform')}
        </p>
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
                {/*
                  `entry.pct` and not a locally recomputed share: the stacked bar
                  above sizes its segments from `entry.pct`, and the previous
                  local `user_count / sum(user_count)` renormalised to 100%, so
                  the bar and this number disagreed the moment any user spanned
                  two platforms — exactly the case this card exists to show.
                */}
                <span className="text-sm font-semibold text-gray-900 w-12 text-right">
                  {entry.pct}%
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
