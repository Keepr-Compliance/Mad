/**
 * Card Components
 *
 * Thin re-exports of the @keepr/design-system Card family, plus
 * broker-specific StatsCard/ListCard built on the same primitives.
 */

import { ReactNode } from 'react';
import {
  Card,
  CardHeader,
  CardTitle,
  StatCard,
} from '@keepr/design-system';

export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '@keepr/design-system';

/**
 * Stats Card
 */
export function StatsCard({
  label,
  value,
  trend,
  trendDirection,
  icon,
  className,
}: {
  label: string;
  value: string | number;
  trend?: string;
  trendDirection?: 'up' | 'down' | 'neutral';
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <StatCard
      label={label}
      value={value}
      icon={icon}
      trend={trendDirection ? trend : undefined}
      trendDirection={trendDirection}
      className={className}
    />
  );
}

/**
 * List Card - for displaying lists within a card
 */
export function ListCard({
  title,
  items,
  emptyMessage = 'No items',
  className,
}: {
  title: string;
  items: Array<{ id: string; label: string; subLabel?: string; action?: ReactNode }>;
  emptyMessage?: string;
  className?: string;
}) {
  return (
    <Card padding="none" className={className}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      {items.length === 0 ? (
        <div className="px-6 py-8 text-center text-sm text-gray-500">{emptyMessage}</div>
      ) : (
        <ul className="divide-y divide-gray-200">
          {items.map((item) => (
            <li
              key={item.id}
              className="px-6 py-4 flex items-center justify-between hover:bg-gray-50"
            >
              <div>
                <p className="text-sm font-medium text-gray-900">{item.label}</p>
                {item.subLabel && (
                  <p className="text-sm text-gray-500">{item.subLabel}</p>
                )}
              </div>
              {item.action}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
