'use client';

/**
 * Submissions report — attempt table (BACKLOG-3715)
 *
 * Every column sortable both ways. Ten rows, then "Show more". Clicking a row
 * opens the detail card below the table, one at a time. The sort header
 * pattern is copied from the iPhone Sync table, whose header is bound to its
 * own sort keys.
 */

import { ArrowDown, ArrowUp, ArrowUpDown, X } from 'lucide-react';
import {
  formatCountCell,
  SUBMISSION_SORT_SPECS,
  type SortDirection,
  type Submission,
  type SubmissionSortKey,
} from '@/lib/reports/submissions';
import { StatusChip, SubmissionCard } from './SubmissionCard';

const COLUMNS: { key: SubmissionSortKey; align: 'left' | 'right' }[] = [
  { key: 'started', align: 'left' },
  { key: 'agent', align: 'left' },
  { key: 'org', align: 'left' },
  { key: 'outcome', align: 'left' },
  { key: 'stage', align: 'left' },
  { key: 'reason', align: 'left' },
  { key: 'retries', align: 'right' },
  { key: 'duration', align: 'right' },
  { key: 'messages', align: 'right' },
  { key: 'files', align: 'right' },
  { key: 'notIncluded', align: 'right' },
  { key: 'resubmit', align: 'left' },
  { key: 'version', align: 'left' },
  { key: 'id', align: 'left' },
];

function SortHeader({
  column,
  sortKey,
  sortDirection,
  onSort,
}: {
  column: { key: SubmissionSortKey; align: 'left' | 'right' };
  sortKey: SubmissionSortKey;
  sortDirection: SortDirection;
  onSort: (key: SubmissionSortKey) => void;
}) {
  const active = sortKey === column.key;
  const Icon = !active ? ArrowUpDown : sortDirection === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th
      scope="col"
      aria-sort={active ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={`whitespace-nowrap py-2 px-3 font-medium text-gray-500 ${column.align === 'right' ? 'text-right' : 'text-left'}`}
    >
      <button
        type="button"
        onClick={() => onSort(column.key)}
        className={`inline-flex items-center gap-1 hover:text-gray-900 ${active ? 'text-gray-900' : ''}`}
      >
        {SUBMISSION_SORT_SPECS[column.key].label}
        <Icon className="h-3 w-3" aria-hidden="true" />
      </button>
    </th>
  );
}

export interface SubmissionTableProps {
  rows: Submission[];
  visibleCount: number;
  sortKey: SubmissionSortKey;
  sortDirection: SortDirection;
  openRowId: string | null;
  truncated: boolean;
  rowCap: number;
  periodLabel: string;
  onSort: (key: SubmissionSortKey) => void;
  onShowMore: () => void;
  onToggleRow: (id: string) => void;
}

export function SubmissionTable({
  rows,
  visibleCount,
  sortKey,
  sortDirection,
  openRowId,
  truncated,
  rowCap,
  periodLabel,
  onSort,
  onShowMore,
  onToggleRow,
}: SubmissionTableProps) {
  const visible = rows.slice(0, visibleCount);
  const openRow = rows.find((r) => r.id === openRowId) ?? null;
  const more = rows.length - visible.length;

  return (
    <section>
      <h2 className="mb-3 text-base font-semibold text-gray-900">Attempts in this period</h2>

      {truncated ? (
        <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <strong>This period holds more attempts than are shown.</strong> The query returns at most{' '}
          {rowCap} rows and {periodLabel.toLowerCase()} reached that cap — every count and chart on
          this page is therefore a floor, not a total. Narrow the period to see all of it.
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-10 text-center shadow-sm">
          <p className="font-medium text-gray-900">No submit attempts in this period</p>
          <p className="mx-auto mt-1 max-w-xl text-sm text-gray-500">
            Nothing matched {periodLabel.toLowerCase()} with the filters you have set. That is a real
            zero, not a failure to read — widen the period or clear a filter.
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
              {visible.map((s) => (
                <tr
                  key={s.id}
                  data-submission-row={s.submissionId}
                  onClick={() => onToggleRow(s.id)}
                  className={`cursor-pointer border-b border-gray-100 last:border-0 hover:bg-gray-50 ${
                    openRowId === s.id ? 'bg-primary-50' : ''
                  }`}
                >
                  <td className="whitespace-nowrap py-2 px-3 text-gray-700">{s.whenUtc}</td>
                  <td className="py-2 px-3 text-gray-900">{s.agentLabel}</td>
                  <td className="py-2 px-3 text-gray-700">{s.orgLabel}</td>
                  <td className="py-2 px-3">
                    <StatusChip submission={s} />
                  </td>
                  <td className="py-2 px-3 text-gray-700">{s.stageLabel}</td>
                  <td className="py-2 px-3 text-gray-700">{s.reasonLabel}</td>
                  <td className="py-2 px-3 text-right tabular-nums text-gray-700">{s.retryCount}</td>
                  <td className="whitespace-nowrap py-2 px-3 text-right tabular-nums text-gray-700">
                    {s.durationLabel}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums text-gray-700" data-cell="messages">
                    {formatCountCell(s.messages)}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums text-gray-700" data-cell="files">
                    {formatCountCell(s.files)}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums text-gray-700" data-cell="not-included">
                    {formatCountCell(s.notIncluded)}
                  </td>
                  <td className="py-2 px-3 text-gray-700">{s.isResubmit ? 'Yes' : 'No'}</td>
                  <td className="whitespace-nowrap py-2 px-3 text-gray-700">
                    {s.appVersion} · {s.platform}
                  </td>
                  <td className="py-2 px-3 font-mono text-xs text-gray-700">{s.shortId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p className="text-sm text-gray-500">
            Showing {visible.length} of {rows.length} {rows.length === 1 ? 'attempt' : 'attempts'}
          </p>
          {more > 0 ? (
            <button
              type="button"
              onClick={onShowMore}
              className="text-sm font-medium text-primary-600 hover:text-primary-800"
            >
              Show more
            </button>
          ) : null}
        </div>
      ) : null}

      {openRow ? (
        <div className="mt-4" data-submission-detail={openRow.submissionId}>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-900">
              {openRow.agentLabel} · {openRow.whenUtc}
            </h3>
            <button
              type="button"
              onClick={() => onToggleRow(openRow.id)}
              className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              Close
            </button>
          </div>
          <SubmissionCard submission={openRow} />
        </div>
      ) : null}
    </section>
  );
}
