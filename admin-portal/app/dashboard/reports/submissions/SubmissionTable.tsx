'use client';

/**
 * Submissions report — attempt table (BACKLOG-3715)
 *
 * Every column sortable both ways. Ten rows, then "Show more". Clicking a row
 * opens the detail card below the table, one at a time. Header, row-cap
 * notice and footer come from the @keepr/ui report kit (BACKLOG-3502a).
 */

import { X } from 'lucide-react';
import { ShowMoreFooter, SortableTh, TruncationNotice } from '@keepr/ui';
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

export interface SubmissionTableProps {
  rows: Submission[];
  visibleCount: number;
  sortKey: SubmissionSortKey;
  sortDirection: SortDirection;
  openRowId: string | null;
  truncated: boolean;
  rowCap: number;
  periodLabel: string;
  /** Rows each "Show more" adds; the button names it. */
  showMoreStep: number;
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
  showMoreStep,
  onSort,
  onShowMore,
  onToggleRow,
}: SubmissionTableProps) {
  const visible = rows.slice(0, visibleCount);
  const openRow = rows.find((r) => r.id === openRowId) ?? null;

  return (
    <section>
      <h2 className="mb-3 text-base font-semibold text-gray-900">Attempts in this period</h2>

      {truncated ? (
        <TruncationNotice
          noun="attempts"
          capPhrase={`at most ${rowCap} rows`}
          periodLabel={periodLabel}
          scope="every count and chart"
        />
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
                  <SortableTh
                    key={column.key}
                    sortKey={column.key}
                    activeKey={sortKey}
                    direction={sortDirection}
                    onSort={onSort}
                    align={column.align}
                    className="whitespace-nowrap"
                  >
                    {SUBMISSION_SORT_SPECS[column.key].label}
                  </SortableTh>
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

      <ShowMoreFooter
        shown={visible.length}
        total={rows.length}
        noun={{ one: 'attempt', other: 'attempts' }}
        step={showMoreStep}
        onShowMore={onShowMore}
      />

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
