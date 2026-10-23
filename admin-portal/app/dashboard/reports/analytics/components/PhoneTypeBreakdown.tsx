'use client';

/**
 * Phone Type Breakdown — Analytics Dashboard
 *
 * Shows iPhone vs Android (and unset) user counts
 * from user_preferences.phone_type.
 */

import { Smartphone } from 'lucide-react';
import { Card } from '@keepr/design-system';
import type { PhoneTypeBreakdown as PhoneTypeData } from '@/lib/analytics-queries';

interface Props {
  data: PhoneTypeData[];
}

const TYPE_COLORS: Record<string, string> = {
  iphone: '#3b82f6',   // blue-500
  android: '#22c55e',  // green-500
  'Not set': '#9ca3af', // gray-400
};

const TYPE_LABELS: Record<string, string> = {
  iphone: 'iPhone',
  android: 'Android',
  'Not set': 'Not set',
};

export function PhoneTypeBreakdown({ data }: Props) {
  if (data.length === 0) {
    return (
      <Card>
        <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <Smartphone className="h-5 w-5 text-gray-400" />
          Phone Type
        </h3>
        <p className="text-sm text-gray-500">No phone type data available.</p>
      </Card>
    );
  }

  const totalUsers = data.reduce((sum, d) => sum + d.user_count, 0);

  return (
    <Card>
      <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
        <Smartphone className="h-5 w-5 text-gray-400" />
        Phone Type
      </h3>
      <p className="text-sm text-gray-500 mb-6">
        Message sync source by phone type
      </p>

      {/* Stacked progress bar */}
      <div className="flex h-4 rounded-full overflow-hidden bg-gray-100 mb-6">
        {data.map((entry) => (
          <div
            key={entry.phone_type}
            className="h-full transition-all duration-300"
            style={{
              width: `${entry.pct}%`,
              backgroundColor:
                TYPE_COLORS[entry.phone_type] ?? TYPE_COLORS['Not set'],
              minWidth: entry.pct > 0 ? '4px' : '0',
            }}
            title={`${TYPE_LABELS[entry.phone_type] ?? entry.phone_type}: ${entry.pct}%`}
          />
        ))}
      </div>

      {/* Legend & counts */}
      <div className="space-y-3">
        {data.map((entry) => {
          const color =
            TYPE_COLORS[entry.phone_type] ?? TYPE_COLORS['Not set'];
          const label =
            TYPE_LABELS[entry.phone_type] ?? entry.phone_type;

          return (
            <div key={entry.phone_type} className="flex items-center justify-between">
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
