'use client';

/**
 * TaskStatsCards - PM Dashboard
 *
 * Displays key backlog metrics: Total Open, Pending, In Progress, Blocked, Active Sprints.
 * Optionally renders custom gauge cards from pinned saved views.
 */

import { useEffect, useState } from 'react';
import { Inbox, Clock, PlayCircle, AlertTriangle, Layers, Gauge } from 'lucide-react';
import { getStats } from '@/lib/pm-queries';
import type { PmStats } from '@/lib/pm-types';

export interface CustomGauge {
  id: string;
  name: string;
  count: number;
  filterKey: string;
}

interface TaskStatsCardsProps {
  onCardClick?: (cardKey: string) => void;
  activeCard?: string;
  customGauges?: CustomGauge[];
  onGaugeClick?: (gauge: CustomGauge) => void;
}

export function TaskStatsCards({ onCardClick, activeCard, customGauges, onGaugeClick }: TaskStatsCardsProps) {
  const [stats, setStats] = useState<PmStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadStats();
  }, []);

  async function loadStats() {
    try {
      const data = await getStats();
      setStats(data);
    } catch (err) {
      console.error('Failed to load PM stats:', err);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 lg:grid-cols-5 mb-6">
        {[1, 2, 3, 4, 5].map((i) => (
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
      key: 'total_open',
      label: 'Total Open',
      value: stats?.total_open ?? 0,
      icon: Inbox,
      color: 'text-blue-600 bg-blue-50',
    },
    {
      key: 'pending',
      label: 'Pending',
      value: stats?.by_status?.pending ?? 0,
      icon: Clock,
      color: 'text-gray-600 bg-gray-50',
    },
    {
      key: 'in_progress',
      label: 'In Progress',
      value: stats?.by_status?.in_progress ?? 0,
      icon: PlayCircle,
      color: 'text-blue-600 bg-blue-50',
    },
    {
      key: 'blocked',
      label: 'Blocked',
      value: stats?.by_status?.blocked ?? 0,
      icon: AlertTriangle,
      color: 'text-red-600 bg-red-50',
    },
    {
      key: 'active_sprints',
      label: 'Active Sprints',
      value: stats?.active_sprints ?? 0,
      icon: Layers,
      color: 'text-green-600 bg-green-50',
    },
  ];

  return (
    <div className="mb-6 space-y-4">
      {/* Standard stats cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {cards.map((card) => {
          const Icon = card.icon;
          const isActive = activeCard === card.key;
          return (
            <div
              key={card.key}
              role={onCardClick ? 'button' : undefined}
              tabIndex={onCardClick ? 0 : undefined}
              onClick={() => onCardClick?.(card.key)}
              onKeyDown={(e) => {
                if (onCardClick && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  onCardClick(card.key);
                }
              }}
              className={`bg-white rounded-lg border p-4 transition-all ${
                onCardClick ? 'cursor-pointer hover:border-primary-300 hover:shadow-sm' : ''
              } ${
                isActive
                  ? 'border-primary-500 ring-2 ring-primary-200'
                  : 'border-gray-200'
              }`}
            >
              <p className="text-sm font-medium text-gray-500 mb-2 truncate">{card.label}</p>
              <div className="flex items-center gap-3">
                <div className={`rounded-lg p-2.5 ${card.color}`}>
                  <Icon className="h-5 w-5" />
                </div>
                <p className="text-2xl font-semibold text-gray-900">{card.value}</p>
              </div>
            </div>
          );
        })}
      </div>

      {/* Custom gauge cards from pinned saved views */}
      {customGauges && customGauges.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          {customGauges.map((gauge) => {
            const isActive = activeCard === `gauge_${gauge.id}`;
            return (
              <div
                key={gauge.id}
                role={onGaugeClick ? 'button' : undefined}
                tabIndex={onGaugeClick ? 0 : undefined}
                onClick={() => onGaugeClick?.(gauge)}
                onKeyDown={(e) => {
                  if (onGaugeClick && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault();
                    onGaugeClick(gauge);
                  }
                }}
                className={`rounded-lg border-2 border-dashed p-4 transition-all ${
                  onGaugeClick ? 'cursor-pointer hover:border-primary-300 hover:shadow-sm' : ''
                } ${
                  isActive
                    ? 'border-primary-500 ring-2 ring-primary-200 bg-primary-50/30'
                    : 'border-gray-300 bg-gray-50/50'
                }`}
              >
                <p className="text-sm font-medium text-gray-500 mb-2 truncate" title={gauge.name}>
                  {gauge.name}
                </p>
                <div className="flex items-center gap-3">
                  <div className="rounded-lg p-2.5 text-indigo-600 bg-indigo-50">
                    <Gauge className="h-5 w-5" />
                  </div>
                  <p className="text-2xl font-semibold text-gray-900">{gauge.count}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
