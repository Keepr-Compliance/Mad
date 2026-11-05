/**
 * Email Sync Timing — the report body (BACKLOG-4130).
 *
 * Server-renderable: no hooks, no router. The period picker is plain links, so
 * the page needs no client shell.
 */

import Link from 'next/link';
import { formatCount, formatDuration } from '@/lib/reports/iphone-sync';
import { EP_BUCKETS, type EpCell, type EpReportModel } from '@/lib/reports/email-precache';
import { PERIOD_OPTIONS, type PeriodRange } from '@/lib/reports/period';

export interface EmailPrecacheReportProps {
  report: EpReportModel;
  period: PeriodRange;
  truncated: boolean;
  rowCap: number;
  basePath: string;
}

function CellView({ cell }: { cell: EpCell }) {
  if (cell.n === 0) {
    return <span className="text-gray-400">—</span>;
  }
  return (
    <div className="space-y-0.5">
      <div className="font-medium text-gray-900">
        median {formatDuration(cell.medianMs)} · p90 {formatDuration(cell.p90Ms)}
      </div>
      <div className="text-xs text-gray-500">
        min {formatDuration(cell.minMs)} · max {formatDuration(cell.maxMs)}
      </div>
      <div className="text-xs text-gray-500" data-cell-n={cell.n}>
        N = {formatCount(cell.n)}
      </div>
    </div>
  );
}

export function EmailPrecacheReport({ report, period, truncated, rowCap, basePath }: EmailPrecacheReportProps) {
  return (
    <div className="space-y-6">
      <nav aria-label="Period" className="flex flex-wrap gap-2">
        {PERIOD_OPTIONS.filter((o) => o.value !== 'custom').map((o) => (
          <Link
            key={o.value}
            href={`${basePath}?period=${o.value}`}
            aria-current={period.key === o.value ? 'page' : undefined}
            className={
              period.key === o.value
                ? 'rounded-md bg-primary-600 px-3 py-1 text-sm text-white'
                : 'rounded-md border border-gray-300 px-3 py-1 text-sm text-gray-700 hover:bg-gray-50'
            }
          >
            {o.label}
          </Link>
        ))}
      </nav>

      <p className="text-sm text-gray-600">
        {period.label}: {formatCount(report.totalRuns)} email syncs.
      </p>

      {truncated ? (
        <div
          data-notice="truncated"
          className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
        >
          Only the newest {formatCount(rowCap)} syncs in this period are shown. Every number below is over those
          syncs, not the whole period. Pick a shorter period for complete numbers.
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full text-sm" data-table="timing">
          <thead className="bg-gray-50 text-left text-gray-600">
            <tr>
              <th className="px-4 py-3 font-medium">Mail fetched</th>
              {report.kinds.map((k) => (
                <th key={k.kind} className="px-4 py-3 font-medium" data-kind={k.kind}>
                  <div>{k.label}</div>
                  <div className="text-xs font-normal text-gray-500">by {k.countLabel}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {EP_BUCKETS.map((b) => (
              <tr key={b.key} data-bucket={b.key}>
                <th scope="row" className="px-4 py-3 text-left font-medium text-gray-700">
                  {b.label}
                </th>
                {report.kinds.map((k) => (
                  <td key={k.kind} className="px-4 py-3 align-top">
                    <CellView cell={k.cells[b.key]} />
                  </td>
                ))}
              </tr>
            ))}
            <tr data-row="outcomes">
              <th scope="row" className="px-4 py-3 text-left font-medium text-gray-700">
                All runs
              </th>
              {report.kinds.map((k) => (
                <td key={k.kind} className="px-4 py-3 align-top text-xs text-gray-600">
                  {formatCount(k.total)} runs: {formatCount(k.complete)} completed, {formatCount(k.error)} failed,{' '}
                  {formatCount(k.cancelled)} cancelled
                  {k.backfilled > 0 ? (
                    <div>{formatCount(k.backfilled)} also fetched older mail after the history window was widened</div>
                  ) : null}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      <p className="text-xs text-gray-500">
        Times are for completed syncs only. First sync and forced re-sync are grouped by the emails fetched across the
        whole history window; incremental sync by the new messages fetched since the last sync, not mailbox size.
        {report.unknownKind > 0 ? ` ${formatCount(report.unknownKind)} runs had no sync type and are not shown.` : ''}
      </p>
    </div>
  );
}
