import type { ReactNode } from 'react';
import { cn } from '../cn';

export type StatCardHue = 'primary' | 'blue' | 'green' | 'yellow' | 'red' | 'gray' | 'indigo' | 'orange';

const ICON_TILE_CLASSES: Record<StatCardHue, string> = {
  primary: 'text-primary-600 bg-primary-50',
  blue: 'text-blue-600 bg-blue-50',
  green: 'text-green-600 bg-green-50',
  yellow: 'text-yellow-600 bg-yellow-50',
  red: 'text-red-600 bg-red-50',
  gray: 'text-gray-600 bg-gray-50',
  indigo: 'text-indigo-600 bg-indigo-50',
  orange: 'text-orange-600 bg-orange-50',
};

export interface StatCardProps {
  label: ReactNode;
  value: ReactNode;
  /** lucide icon element, typically `<Icon className="h-5 w-5" />`. */
  icon?: ReactNode;
  hue?: StatCardHue;
  /** Optional trend chip, e.g. "+12%". */
  trend?: ReactNode;
  trendDirection?: 'up' | 'down' | 'neutral';
  className?: string;
}

/** KPI/stat card: white bordered card with colored icon tile, label and value. */
export function StatCard({ label, value, icon, hue = 'primary', trend, trendDirection = 'neutral', className }: StatCardProps) {
  return (
    <div className={cn('bg-white rounded-lg border border-gray-200 p-5 flex items-center gap-4', className)}>
      {icon && <div className={cn('rounded-lg p-3', ICON_TILE_CLASSES[hue])}>{icon}</div>}
      <div className="min-w-0">
        <p className="text-sm font-medium text-gray-500 truncate">{label}</p>
        <div className="flex items-baseline gap-2">
          <p className="text-2xl font-semibold text-gray-900">{value}</p>
          {trend && (
            <span
              className={cn(
                'text-xs font-medium',
                trendDirection === 'up' && 'text-green-600',
                trendDirection === 'down' && 'text-red-600',
                trendDirection === 'neutral' && 'text-gray-500'
              )}
            >
              {trend}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
