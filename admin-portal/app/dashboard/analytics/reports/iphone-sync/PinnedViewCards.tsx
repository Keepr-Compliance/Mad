'use client';

/**
 * Pinned view cards (BACKLOG-3450)
 *
 * The dashed-gauge card style from `TaskStatsCards` — which is NOT reusable as
 * a component: it fetches its own numbers in its own effect and owns its own
 * loading state. Only the classes transfer. This one takes everything as props
 * and computes nothing, so it renders identically in a test and on the page.
 *
 * Each card shows its own metric over THE PERIOD'S ROWS with ITS OWN saved
 * filters — never the page's current filters. Clicking one applies its filters
 * to the page; clicking the active one puts the page back.
 */

import { Gauge } from 'lucide-react';
import { formatMetricValue, metricLabel, type ReportSavedView } from '@/lib/reports/report-views';

export interface PinnedCard {
  view: ReportSavedView;
  value: number | null;
  active: boolean;
}

export interface PinnedViewCardsProps {
  cards: PinnedCard[];
  periodLabel: string;
  onToggle: (view: ReportSavedView) => void;
}

export function PinnedViewCards({ cards, periodLabel, onToggle }: PinnedViewCardsProps) {
  if (cards.length === 0) return null;

  return (
    <div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        {cards.map(({ view, value, active }) => (
          <button
            key={view.id}
            type="button"
            data-view-id={view.id}
            onClick={() => onToggle(view)}
            aria-pressed={active}
            className={`rounded-lg border-2 border-dashed p-4 text-left transition-all hover:border-primary-300 hover:shadow-sm ${
              active
                ? 'border-primary-500 ring-2 ring-primary-200 bg-primary-50/30'
                : 'border-gray-300 bg-gray-50/50'
            }`}
          >
            <p className="mb-2 truncate text-sm font-medium text-gray-500" title={view.name}>
              {view.name}
            </p>
            <div className="flex items-center gap-3">
              <div className="rounded-lg bg-indigo-50 p-2.5 text-indigo-600">
                <Gauge className="h-5 w-5" aria-hidden="true" />
              </div>
              <p
                data-card-value={view.id}
                className="text-2xl font-semibold tabular-nums text-gray-900"
              >
                {formatMetricValue(value, view.metric)}
              </p>
            </div>
            <p className="mt-2 truncate text-xs text-gray-400">{metricLabel(view.metric)}</p>
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-gray-500">
        Your cards keep their own saved filters and follow the period above: {periodLabel}. Click one
        to apply its filters to the page; click it again to put the page back.
      </p>
    </div>
  );
}
