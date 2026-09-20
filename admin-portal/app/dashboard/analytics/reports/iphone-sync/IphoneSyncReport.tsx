'use client';

/**
 * iPhone Sync Performance — the composition shell (BACKLOG-3441, BACKLOG-3450)
 *
 * Owns the client state (filters, sort, how many rows, which row is open) and
 * composes the filter bar, the tiles, both charts, the table and the how-to.
 *
 * IT DOES NOT USE `useRouter`. Navigation arrives as the `onNavigate` prop from
 * a thin wrapper, so this component renders under `renderToStaticMarkup` with
 * no App Router context and every render control stays a plain function call.
 *
 * THE ONE INVARIANT: the tiles, both charts and the table all read
 * `filteredRuns`. `report.counts` is the whole-period count and is deliberately
 * NOT used for the tiles — wiring them to it is the shortest path to a page
 * that looks finished while every card quietly contradicts the table beside it.
 */

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { IphoneSyncReportModel } from '@/lib/reports/iphone-sync';
import type { PeriodRange } from '@/lib/reports/period';
import {
  activeFilterNames,
  applyFilters,
  computeCounts,
  defaultDirectionFor,
  hasActiveFilters,
  INITIAL_VISIBLE_ROWS,
  nextVisibleCount,
  sortRuns,
  type RunFilters,
  type SortKey,
} from '@/lib/reports/iphone-sync-filters';
import { bucketByDay } from '@/lib/reports/iphone-sync-charts';
import {
  applyClientState,
  buildPeriodUrl,
  DEFAULT_CLIENT_STATE,
  type ClientState,
} from '@/lib/reports/report-url';
import { HowToUse } from './HowToUse';
import { SyncCharts } from './SyncCharts';
import { SyncFilterBar } from './SyncFilterBar';
import { SyncRunTable } from './SyncRunTable';

function Tile({
  label,
  value,
  active,
  onClick,
  tone,
}: {
  label: string;
  value: number;
  active?: boolean;
  onClick?: () => void;
  tone?: 'critical';
}) {
  const base = 'rounded-lg border bg-white p-5 text-left';
  const classes = onClick
    ? `${base} cursor-pointer transition ${
        active
          ? 'border-primary-500 ring-2 ring-primary-200 bg-primary-50/30'
          : 'border-gray-200 hover:border-gray-300'
      }`
    : `${base} border-gray-200`;

  const body = (
    <>
      <p className="flex items-center gap-1.5 text-sm font-medium text-gray-500">
        {tone === 'critical' ? (
          <AlertTriangle className="h-3.5 w-3.5 text-red-600" aria-hidden="true" />
        ) : null}
        {label}
      </p>
      <p
        className={`mt-1 text-2xl font-semibold tabular-nums ${
          tone === 'critical' && value > 0 ? 'text-red-700' : 'text-gray-900'
        }`}
      >
        {value}
      </p>
    </>
  );

  if (!onClick) return <div className={classes}>{body}</div>;
  return (
    <button type="button" onClick={onClick} className={classes} aria-pressed={active ? true : false}>
      {body}
    </button>
  );
}

export interface IphoneSyncReportProps {
  report: IphoneSyncReportModel;
  period: PeriodRange;
  truncated?: boolean;
  /** The query's row cap — named in the truncation notice. */
  rowCap: number;
  initialState?: ClientState;
  /** Supplied by the wrapper that owns the router. Absent under a static render. */
  onNavigate?: (url: string) => void;
}

export function IphoneSyncReport({
  report,
  period,
  truncated = false,
  rowCap,
  initialState = DEFAULT_CLIENT_STATE,
  onNavigate,
}: IphoneSyncReportProps) {
  const [filters, setFilters] = useState<RunFilters>(initialState.filters);
  const [sortKey, setSortKey] = useState<SortKey>(initialState.sortKey);
  const [sortDirection, setSortDirection] = useState(initialState.sortDirection);
  const [stalledOnly, setStalledOnly] = useState(initialState.stalledOnly);
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_ROWS);
  const [openRunId, setOpenRunId] = useState<string | null>(null);

  // Mirror the client state into the URL WITHOUT a navigation. With
  // `force-dynamic` a router.push here would be a database round trip per
  // checkbox; replaceState keeps the URL the one source of truth for free.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = applyClientState(new URLSearchParams(window.location.search), {
      filters,
      sortKey,
      sortDirection,
      stalledOnly,
    });
    const query = params.toString();
    window.history.replaceState(null, '', query.length > 0 ? `?${query}` : window.location.pathname);
  }, [filters, sortKey, sortDirection, stalledOnly]);

  // THE shared set. Everything below reads this and nothing else.
  const filteredRuns = useMemo(() => applyFilters(report.runs, filters), [report.runs, filters]);
  const counts = useMemo(() => computeCounts(filteredRuns), [filteredRuns]);
  const buckets = useMemo(() => bucketByDay(filteredRuns, period), [filteredRuns, period]);

  // The stalled tile narrows the TABLE only — the tiles and both charts above
  // must say the same thing before and after it is clicked.
  const tableRuns = useMemo(() => {
    const rows = stalledOnly ? filteredRuns.filter((r) => r.stalled) : filteredRuns;
    return sortRuns(rows, sortKey, sortDirection);
  }, [filteredRuns, stalledOnly, sortKey, sortDirection]);

  const outcomeOptions = useMemo(
    () => [...new Set(report.runs.map((r) => r.outcome))].sort(),
    [report.runs]
  );
  const platformOptions = useMemo(
    () => [...new Set(report.runs.map((r) => r.platform))].sort(),
    [report.runs]
  );

  function navigateToPeriod(nextPeriod: string, from?: string, to?: string) {
    const search = typeof window === 'undefined' ? '' : window.location.search.replace(/^\?/, '');
    onNavigate?.(buildPeriodUrl(search, nextPeriod, from, to));
  }

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDirection(defaultDirectionFor(key));
    }
  }

  function updateFilters(next: RunFilters) {
    setFilters(next);
    setVisibleCount(INITIAL_VISIBLE_ROWS);
    setOpenRunId(null);
  }

  function clearFilters() {
    updateFilters({ types: [], outcomes: [], platforms: [], search: '' });
    setStalledOnly(false);
  }

  const filterNames = activeFilterNames(filters);
  const caption = `Every card, chart and row below follows the filters: ${period.label}${
    filterNames.length > 0 ? ` · ${filterNames.join(' · ')}` : ' · no other filters'
  }`;

  return (
    <div className="space-y-6">
      <HowToUse baseline={report.baseline} totalRuns={counts.finished} />

      <SyncFilterBar
        period={period}
        filters={filters}
        outcomeOptions={outcomeOptions}
        platformOptions={platformOptions}
        hasFilters={hasActiveFilters(filters) || stalledOnly}
        onPeriodChange={navigateToPeriod}
        onFiltersChange={updateFilters}
        onClear={clearFilters}
      />

      <div>
        <p className="mb-2 text-xs text-gray-500">{caption}</p>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          <Tile label="Finished" value={counts.finished} />
          <Tile label="Completed" value={counts.complete} />
          <Tile label="Cancelled" value={counts.cancelled} />
          <Tile label="Errored" value={counts.error} />
          <Tile
            label="Stalled"
            value={counts.stalled}
            tone="critical"
            active={stalledOnly}
            onClick={() => {
              setStalledOnly(!stalledOnly);
              setVisibleCount(INITIAL_VISIBLE_ROWS);
              setOpenRunId(null);
            }}
          />
        </div>
      </div>

      <SyncCharts buckets={buckets} />

      <SyncRunTable
        runs={tableRuns}
        visibleCount={visibleCount}
        sortKey={sortKey}
        sortDirection={sortDirection}
        openRunId={openRunId}
        truncated={truncated}
        rowCap={rowCap}
        periodLabel={period.label}
        onSort={handleSort}
        onShowMore={() => setVisibleCount(nextVisibleCount(visibleCount))}
        onShowAll={() => setVisibleCount(tableRuns.length)}
        onToggleRow={(id) => setOpenRunId(openRunId === id ? null : id)}
      />
    </div>
  );
}
