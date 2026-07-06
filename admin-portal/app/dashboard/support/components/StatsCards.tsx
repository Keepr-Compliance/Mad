'use client';

/**
 * StatsCards - Support Dashboard
 *
 * Displays key ticket metrics: Open, Unassigned, Urgent counts.
 */

import { useEffect, useState } from 'react';
import { Inbox, UserX, AlertTriangle } from 'lucide-react';
import { StatCard } from '@keepr/design-system';
import { getTicketStats } from '@/lib/support-queries';
import type { TicketStats } from '@/lib/support-types';

export function StatsCards() {
  const [stats, setStats] = useState<TicketStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadStats();
  }, []);

  async function loadStats() {
    try {
      const data = await getTicketStats();
      setStats(data);
    } catch (err) {
      console.error('Failed to load ticket stats:', err);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 mb-6">
        {[1, 2, 3].map((i) => (
          <div key={i} className="bg-white rounded-lg border border-gray-200 p-5 animate-pulse">
            <div className="h-4 bg-gray-200 rounded w-24 mb-3" />
            <div className="h-8 bg-gray-200 rounded w-12" />
          </div>
        ))}
      </div>
    );
  }

  const cards = [
    {
      label: 'Open Tickets',
      value: stats?.total_open ?? 0,
      icon: Inbox,
      hue: 'blue' as const,
    },
    {
      label: 'Unassigned',
      value: stats?.unassigned ?? 0,
      icon: UserX,
      hue: 'yellow' as const,
    },
    {
      label: 'Urgent',
      value: stats?.by_priority?.urgent ?? 0,
      icon: AlertTriangle,
      hue: 'red' as const,
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 mb-6">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <StatCard
            key={card.label}
            label={card.label}
            value={card.value}
            icon={<Icon className="h-5 w-5" />}
            hue={card.hue}
          />
        );
      })}
    </div>
  );
}
