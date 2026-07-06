'use client';

/**
 * DualProgressBar - Toggleable Status/Effort progress bar
 *
 * Status mode: Segmented bar where each status gets a colored segment
 * proportional to its item count. Segments are hoverable (tooltip) and
 * clickable (filters the sprint table to that status).
 *
 * Effort mode: Single bar showing actual vs estimated token consumption.
 */

import { useState, useMemo } from 'react';
import type { ItemStatus } from '@/lib/pm-types';
import { STATUS_LABELS, SEGMENT_COLORS } from '@/lib/pm-types';
import { formatTokens } from '@/lib/pm-utils';

// Render order for segments (left → right)
const STATUS_ORDER: Record<string, number> = {
  pending: 0,
  in_progress: 1,
  testing: 2,
  waiting_for_user: 3,
  reopened: 4,
  blocked: 5,
  completed: 6,
  deferred: 7,
  obsolete: 8,
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface DualProgressBarProps {
  completed: number;
  total: number;
  byStatus?: Record<string, number>;

  estTokens: number;
  actualTokens: number;

  defaultMode?: 'status' | 'effort';
  showToggle?: boolean;
  showLegend?: boolean;
  className?: string;

  /** Called when user clicks a segment to filter by status (null = clear). */
  onStatusFilter?: (status: ItemStatus | null) => void;
  /** Currently active status filter (for visual highlight). */
  activeFilter?: ItemStatus | null;
}

export function DualProgressBar({
  completed,
  total,
  byStatus,
  estTokens,
  actualTokens,
  defaultMode = 'status',
  showToggle = true,
  showLegend = true,
  className,
  onStatusFilter,
  activeFilter,
}: DualProgressBarProps) {
  const [mode, setMode] = useState<'status' | 'effort'>(defaultMode);

  const effortPct =
    estTokens > 0 ? Math.round((actualTokens / estTokens) * 100) : 0;
  const isOverBudget = actualTokens > estTokens && estTokens > 0;

  // Build sorted segment data from byStatus counts
  const segments = useMemo(() => {
    if (!byStatus) return [];
    return Object.entries(byStatus)
      .filter(([, count]) => count > 0)
      .sort(([a], [b]) => (STATUS_ORDER[a] ?? 99) - (STATUS_ORDER[b] ?? 99))
      .map(([status, count]) => ({
        status: status as ItemStatus,
        count,
        pct: total > 0 ? (count / total) * 100 : 0,
      }));
  }, [byStatus, total]);

  const handleSegmentClick = (status: ItemStatus) => {
    if (!onStatusFilter) return;
    onStatusFilter(activeFilter === status ? null : status);
  };

  return (
    <div className={className}>
      {/* Toggle */}
      {showToggle && (
        <div className="flex items-center gap-1 mb-2">
          <button
            onClick={() => setMode('status')}
            className={`px-2 py-0.5 text-xs rounded-l-md border ${
              mode === 'status'
                ? 'bg-primary-50 border-primary-300 text-primary-700'
                : 'bg-white border-gray-300 text-gray-500'
            }`}
          >
            Status
          </button>
          <button
            onClick={() => setMode('effort')}
            className={`px-2 py-0.5 text-xs rounded-r-md border border-l-0 ${
              mode === 'effort'
                ? 'bg-primary-50 border-primary-300 text-primary-700'
                : 'bg-white border-gray-300 text-gray-500'
            }`}
          >
            Effort
          </button>
        </div>
      )}

      {/* Bar */}
      {mode === 'status' ? (
        <>
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="text-gray-500">Progress</span>
            <span className="font-medium text-gray-700">
              {completed}/{total} completed
            </span>
          </div>

          {/*
            Segmented bar — note: we deliberately do NOT use overflow-hidden
            here, because the per-segment hover tooltip is positioned above
            the bar (bottom-full) and would otherwise be clipped.
            Rounded corners on the first/last segments preserve the pill shape.
          */}
          <div className="h-3 bg-gray-100 rounded-full flex">
            {segments.length === 0 ? (
              <div className="h-full w-full rounded-full" />
            ) : (
              segments.map(({ status, count, pct }, idx) => {
                const isFirst = idx === 0;
                const isLast = idx === segments.length - 1;
                const cornerClasses = `${isFirst ? 'rounded-l-full' : ''} ${isLast ? 'rounded-r-full' : ''}`;
                return (
                  <div
                    key={status}
                    className={`relative h-full transition-all ${SEGMENT_COLORS[status]} ${cornerClasses} ${
                      onStatusFilter ? 'cursor-pointer' : ''
                    } ${
                      activeFilter && activeFilter !== status ? 'opacity-40' : ''
                    } ${
                      activeFilter === status ? 'ring-2 ring-offset-1 ring-gray-800 z-10' : ''
                    } group/seg`}
                    style={{ width: `${pct}%`, minWidth: pct > 0 ? '4px' : '0' }}
                    onClick={() => handleSegmentClick(status)}
                  >
                    {/* Tooltip — rendered above the bar; parent must not clip */}
                    <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-1 text-xs text-white bg-gray-800 rounded whitespace-nowrap opacity-0 group-hover/seg:opacity-100 transition-opacity pointer-events-none z-20">
                      {STATUS_LABELS[status]}: {count} item{count !== 1 ? 's' : ''}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="text-gray-500">Effort</span>
            <span
              className={`font-medium ${isOverBudget ? 'text-red-600' : 'text-gray-700'}`}
            >
              {formatTokens(actualTokens)} / {formatTokens(estTokens)} (
              {effortPct}%)
            </span>
          </div>
          <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${isOverBudget ? 'bg-red-500' : 'bg-blue-500'}`}
              style={{ width: `${Math.min(effortPct, 100)}%` }}
            />
          </div>
        </>
      )}

      {/* Legend */}
      {showLegend && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-xs text-gray-500">
          {mode === 'status' &&
            segments.map(({ status, count }) => (
              <button
                key={status}
                type="button"
                onClick={() => handleSegmentClick(status)}
                className={`inline-flex items-center gap-1 hover:text-gray-900 transition-colors ${
                  activeFilter === status ? 'text-gray-900 font-medium' : ''
                } ${activeFilter && activeFilter !== status ? 'opacity-50' : ''}`}
              >
                <span
                  className={`inline-block w-2 h-2 rounded-full ${SEGMENT_COLORS[status]}`}
                />
                {STATUS_LABELS[status]}: {count}
              </button>
            ))}
          {mode === 'effort' && (
            <>
              <span>Est: {formatTokens(estTokens)}</span>
              <span>Actual: {formatTokens(actualTokens)}</span>
              <span
                className={isOverBudget ? 'text-red-500' : 'text-green-600'}
              >
                Variance:{' '}
                {estTokens > 0
                  ? `${((actualTokens - estTokens) / estTokens * 100).toFixed(0)}%`
                  : 'N/A'}
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
