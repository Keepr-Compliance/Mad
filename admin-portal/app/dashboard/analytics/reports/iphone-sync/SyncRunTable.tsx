'use client';

/**
 * iPhone Sync Performance — the run table (BACKLOG-3450)
 *
 * Ten columns, every one sortable both ways. Five rows by default, then "Show
 * 5 more" / "Show all". Clicking a row opens the existing `RunCard` BELOW the
 * table — the card is wide and a nested `<tr>` fights the column grid — with a
 * Close button, one row open at a time.
 *
 * The sort itself lives in `lib/reports/iphone-sync-filters`, where it is
 * tested on full id sequences rather than on rendered order.
 */

import { ArrowDown, ArrowUp, ArrowUpDown, X } from 'lucide-react';
import { formatCount, type SyncRun } from '@/lib/reports/iphone-sync';
import {
  defaultDirectionFor,
  SORT_SPECS,
  type SortDirection,
  type SortKey,
} from '@/lib/reports/iphone-sync-filters';
import { OutcomeChip, RunCard, StalledChip } from './RunCard';

const COLUMNS: { key: SortKey; align: 'left' | 'right' }[] = [
  { key: 'when', align: 'left' },
  { key: 'user', align: 'left' },
  { key: 'platform', align: 'left' },
  { key: 'version', align: 'left' },
  { key: 'outcome', align: 'left' },
  { key: 'duration', align: 'right' },
  { key: 'backup', align: 'right' },
  { key: 'rate', align: 'right' },
  { key: 'messages', align: 'right' },
  { key: 'type', align: 'left' },
];

function SortHeader({
  column,
  sortKey,
  sortDirection,
  onSort,
}: {
  column: { key: SortKey; align: 'left' | 'right' };
  sortKey: SortKey;
  sortDirection: SortDirection;
  onSort: (key: SortKey) => void;
}) {
  const active = sortKey === column.key;
  const Icon = !active ? ArrowUpDown : sortDirection === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th
      scope="col"
      aria-sort={active ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={`py-2 px-3 font-medium text-gray-500 ${column.align === 'right' ? 'text-right' : 'text-left'}`}
    >
      <button
        type="button"
        onClick={() => onSort(column.key)}
        className={`inline-flex items-center gap-1 hover:text-gray-900 ${active ? 'text-gray-900' : ''}`}
      >
        {SORT_SPECS[column.key].label}
        <Icon className="h-3 w-3" aria-hidden="true" />
      </button>
    </th>
  );
}

export interface SyncRunTableProps {
  runs: SyncRun[];
  visibleCount: number;
  sortKey: SortKey;
  sortDirection: SortDirection;
  openRunId: string | null;
  truncated: boolean;
  /** The query's row cap, so the notice can name the real number. */
  rowCap: number;
  periodLabel: string;
  onSort: (key: SortKey) => void;
  onShowMore: () => void;
  onShowAll: () => void;
  onToggleRow: (id: string) => void;
}

export function SyncRunTable({
  runs,
  visibleCount,
  sortKey,
  sortDirection,
  openRunId,
  truncated,
  rowCap,
  periodLabel,
  onSort,
  onShowMore,
  onShowAll,
  onToggleRow,
}: SyncRunTableProps) {
  const visible = runs.slice(0, visibleCount);
  const openRun = runs.find((r) => r.id === openRunId) ?? null;
  const more = runs.length - visible.length;

  return (
    <section>
      <h2 className="mb-3 text-base font-semibold text-gray-900">Runs in this period</h2>

      {truncated ? (
        <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <strong>This period holds more runs than are shown.</strong> The query returns at most{' '}
          {rowCap} rows and {periodLabel.toLowerCase()} reached that cap — every count, chart and
          average on this page is therefore a floor, not a total. Narrow the period to see all of
          it.
        </div>
      ) : null}

      {runs.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-10 text-center shadow-sm">
          <p className="font-medium text-gray-900">No finished runs in this period</p>
          <p className="mx-auto mt-1 max-w-xl text-sm text-gray-500">
            Nothing matched {periodLabel.toLowerCase()} with the filters you have set. That is a
            real zero, not a failure to read — widen the period or clear a filter.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200">
                {COLUMNS.map((column) => (
                  <SortHeader
                    key={column.key}
                    column={column}
                    sortKey={sortKey}
                    sortDirection={sortDirection}
                    onSort={onSort}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((run) => (
                <tr
                  key={run.id}
                  data-run-id={run.id}
                  onClick={() => onToggleRow(run.id)}
                  className={`cursor-pointer border-b border-gray-100 last:border-0 hover:bg-gray-50 ${
                    openRunId === run.id ? 'bg-primary-50' : ''
                  }`}
                >
                  <td className="whitespace-nowrap py-2 px-3 text-gray-700">{run.whenUtc}</td>
                  <td className="py-2 px-3 text-gray-900">{run.userLabel}</td>
                  <td className="py-2 px-3 text-gray-700">{run.platform}</td>
                  <td className="py-2 px-3 text-gray-700">{run.appVersion}</td>
                  <td className="py-2 px-3">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <OutcomeChip run={run} />
                      {run.stalled ? <StalledChip /> : null}
                    </span>
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums text-gray-700">
                    {run.durationLabel}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums text-gray-700">
                    {run.backupUnmeasured
                      ? 'not measured'
                      : run.backupGb == null
                        ? '—'
                        : `${run.backupGb.toFixed(1)} GB`}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums text-gray-700">{run.rateLabel}</td>
                  <td className="py-2 px-3 text-right tabular-nums text-gray-700">
                    {run.messagesExtracted == null || run.messagesExtracted === 0
                      ? 'none'
                      : formatCount(run.messagesExtracted)}
                  </td>
                  <td className="py-2 px-3 text-gray-700">{run.syncTypeLabel}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {runs.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p className="text-sm text-gray-500">
            Showing {visible.length} of {runs.length}{' '}
            {runs.length === 1 ? 'finished run' : 'finished runs'}, newest first
          </p>
          {more > 0 ? (
            <>
              <button
                type="button"
                onClick={onShowMore}
                className="text-sm font-medium text-primary-600 hover:text-primary-800"
              >
                Show {Math.min(5, more)} more
              </button>
              <button
                type="button"
                onClick={onShowAll}
                className="text-sm font-medium text-primary-600 hover:text-primary-800"
              >
                Show all
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      {openRun ? (
        <div className="mt-4" data-run-detail={openRun.id}>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-900">
              {openRun.userLabel} · {openRun.whenUtc}
            </h3>
            <button
              type="button"
              onClick={() => onToggleRow(openRun.id)}
              className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              Close
            </button>
          </div>
          <RunCard run={openRun} />
        </div>
      ) : null}
    </section>
  );
}

export { defaultDirectionFor };
