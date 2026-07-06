/**
 * System Counts — Analytics Dashboard
 *
 * Displays total active users, organizations, and devices
 * in a 3-column card grid.
 */

import { Users, Building2, Monitor, UserCheck } from 'lucide-react';
import { Card } from '@keepr/design-system';
import type { SystemCounts as SystemCountsData } from '@/lib/analytics-queries';

interface Props {
  data: SystemCountsData;
}

const cards = [
  {
    key: 'active_users' as const,
    label: 'Active Users',
    subtitle: 'Last 30 days',
    icon: UserCheck,
    color: 'text-primary-600',
    bg: 'bg-primary-50',
  },
  {
    key: 'total_users' as const,
    label: 'Total Users',
    subtitle: 'All time',
    icon: Users,
    color: 'text-blue-600',
    bg: 'bg-blue-50',
  },
  {
    key: 'total_orgs' as const,
    label: 'Organizations',
    subtitle: 'Total',
    icon: Building2,
    color: 'text-success-600',
    bg: 'bg-success-50',
  },
  {
    key: 'active_devices' as const,
    label: 'Active Devices',
    subtitle: 'Last 30 days',
    icon: Monitor,
    color: 'text-warning-600',
    bg: 'bg-warning-50',
  },
];

export function SystemCounts({ data }: Props) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((card) => {
        const Icon = card.icon;
        const value = data[card.key];
        return (
          <Card key={card.key}>
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-lg ${card.bg}`}>
                <Icon className={`h-5 w-5 ${card.color}`} />
              </div>
              <div>
                <p className="text-sm text-gray-500">{card.label}</p>
                <p className="text-2xl font-bold text-gray-900">
                  {value.toLocaleString()}
                </p>
                <p className="text-xs text-gray-400">{card.subtitle}</p>
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
