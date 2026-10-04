'use client';

/**
 * Google Messages Sync Performance — the composition shell (BACKLOG-3671 P2).
 *
 * The iPhone report's pieces, shared: SyncFilterBar (Type = the run kind),
 * SyncCharts (the same day buckets) and RunTable (its own columns: chats,
 * messages, hidden %, p90 per chat, failure code). The open row shows each
 * stage's time, counts and size.
 *
 * As on the iPhone page, the tiles, the charts, the failure breakdown and
 * the table all read ONE filtered set. Navigation is a prop (no useRouter),
 * so this renders in a plain test.
 */

import { useMemo, useState } from 'react';
import type { PeriodRange } from '@/lib/reports/period';
import { bucketByDay } from '@/lib/reports/iphone-sync-charts';
import { buildPeriodUrl } from '@/lib/reports/report-url';
import {
  applyGmFilters,
  countLabel,
  failureBreakdown,
  GM_EMPTY_FILTERS,
  GM_RUN_KIND_OPTIONS,
  GM_SORT_SPECS,
  mbLabel,
  msLabel,
  sortGmRuns,
  type GmFilters,
  type GmSortKey,
  type GmSyncReportModel,
  type GmSyncRun,
} from '@/lib/reports/google-messages-sync';
import { SyncCharts } from '../iphone-sync/SyncCharts';
import { SyncFilterBar } from '../iphone-sync/SyncFilterBar';
import { RunTable, type RunTableColumn } from '../iphone-sync/SyncRunTable';
import { OutcomeChip } from '../iphone-sync/RunCard';

const NUM = 'py-2 px-3 text-right tabular-nums text-gray-700';
const TXT = 'py-2 px-3 text-gray-700';

export const GM_COLUMNS: RunTableColumn<GmSyncRun, GmSortKey>[] = [
  { key: 'when', label: GM_SORT_SPECS.when.label, align: 'left', cell: (r) => <td className="whitespace-nowrap py-2 px-3 text-gray-700">{r.whenUtc}</td> },
  { key: 'user', label: GM_SORT_SPECS.user.label, align: 'left', cell: (r) => <td className="py-2 px-3 text-gray-900">{r.userLabel}</td> },
  { key: 'version', label: GM_SORT_SPECS.version.label, align: 'left', cell: (r) => <td className={TXT}>{r.appVersion}</td> },
  {
    key: 'outcome',
    label: GM_SORT_SPECS.outcome.label,
    align: 'left',
    cell: (r) => (
      <td className="py-2 px-3">
        <OutcomeChip run={r} />
      </td>
    ),
  },
  { key: 'duration', label: GM_SORT_SPECS.duration.label, align: 'right', cell: (r) => <td className={NUM}>{r.durationLabel}</td> },
  { key: 'chats', label: GM_SORT_SPECS.chats.label, align: 'right', cell: (r) => <td className={NUM}>{countLabel(r.chats)}</td> },
  { key: 'messages', label: GM_SORT_SPECS.messages.label, align: 'right', cell: (r) => <td className={NUM}>{countLabel(r.messages)}</td> },
  { key: 'hidden', label: GM_SORT_SPECS.hidden.label, align: 'right', cell: (r) => <td className={NUM}>{r.hiddenPct === null ? '—' : `${r.hiddenPct}%`}</td> },
  { key: 'p90', label: GM_SORT_SPECS.p90.label, align: 'right', cell: (r) => <td className={NUM}>{msLabel(r.perChatP90Ms)}</td> },
  {
    key: 'failure',
    label: GM_SORT_SPECS.failure.label,
    align: 'left',
    cell: (r) => (
      <td className={TXT} title={r.reasonLine ?? undefined}>
        {r.reasonCode ?? '—'}
      </td>
    ),
  },
];

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 text-sm">
      <dt className="text-gray-500">{label}</dt>
      <dd className="tabular-nums text-gray-900">{value}</dd>
    </div>
  );
}

/** The open row: each stage's time, counts and size. */
export function GmRunDetail({ run }: { run: GmSyncRun }) {
  const f = run.finding;
  const r = run.reading;
  const s = run.saving;
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm" data-testid="gm-run-detail">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm text-gray-600">
        <OutcomeChip run={run} />
        <span>{run.runKindLabel}</span>
        <span>· Keepr {run.appVersion} · extension {run.extensionVersion} · Chrome {run.chromeVersion} · {run.platform}</span>
        {run.isDevBuild ? (
          <span className="rounded-full border border-gray-200 bg-gray-50 px-2.5 py-0.5 text-xs font-medium text-gray-600">dev build</span>
        ) : null}
      </div>
      {run.reasonLine ? (
        <p className="mb-3 text-sm text-gray-700">
          {run.reasonLine} <span className="text-gray-400">({run.reasonCode})</span>
        </p>
      ) : null}
      <div className="grid gap-6 md:grid-cols-3">
        <section data-stage="finding">
          <h4 className="mb-2 text-sm font-semibold text-gray-900">Finding · {msLabel(f.ms)}</h4>
          <dl className="space-y-1">
            <Stat label="Chats found" value={countLabel(f.chatsFound)} />
            <Stat label="In range" value={countLabel(f.chatsInRange)} />
            <Stat label="Skipped (hidden)" value={countLabel(f.chatsSkippedHidden)} />
            <Stat label="Skipped (switched off)" value={countLabel(f.chatsSkippedDisabled)} />
          </dl>
        </section>
        <section data-stage="reading">
          <h4 className="mb-2 text-sm font-semibold text-gray-900">Reading · {msLabel(r.ms)}</h4>
          <dl className="space-y-1">
            <Stat label="Chats read" value={countLabel(r.chatsRead)} />
            <Stat label="Skipped / failed" value={`${countLabel(r.chatsSkipped)} / ${countLabel(r.chatsFailed)}`} />
            <Stat label="Already saved" value={countLabel(r.chatsAlreadySaved)} />
            <Stat label="Messages read" value={countLabel(r.messagesRead)} />
            <Stat label="Photos read" value={`${countLabel(r.photosRead)} · ${mbLabel(r.bytesRead)}`} />
            <Stat label="Per chat p50 / p90" value={`${msLabel(r.perChatP50Ms)} / ${msLabel(r.perChatP90Ms)}`} />
            <Stat label="Slowest chat" value={`${msLabel(r.perChatSlowestMs)} (of ${countLabel(r.perChatCount)})`} />
          </dl>
        </section>
        <section data-stage="saving">
          <h4 className="mb-2 text-sm font-semibold text-gray-900">Saving · {msLabel(s.ms)}</h4>
          <dl className="space-y-1">
            <Stat label="Messages saved" value={countLabel(s.messagesSaved)} />
            <Stat label="New messages" value={countLabel(s.messagesNew)} />
            <Stat label="Photos saved" value={`${countLabel(s.photosSaved)} · ${mbLabel(s.bytesSaved)}`} />
          </dl>
        </section>
      </div>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5 text-left">
      <p className="text-sm font-medium text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-gray-900">{value}</p>
    </div>
  );
}

export interface GoogleMessagesSyncReportProps {
  report: GmSyncReportModel;
  period: PeriodRange;
  truncated?: boolean;
  rowCap: number;
  onNavigate?: (url: string) => void;
}

export function GoogleMessagesSyncReport({ report, period, truncated = false, rowCap, onNavigate }: GoogleMessagesSyncReportProps) {
  const [filters, setFilters] = useState<GmFilters>(GM_EMPTY_FILTERS);
  const [sortKey, setSortKey] = useState<GmSortKey>('when');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [visibleCount, setVisibleCount] = useState(5);
  const [openRunId, setOpenRunId] = useState<string | null>(null);

  // THE shared set: tiles, charts, failure breakdown and table all read it.
  const filtered = useMemo(() => applyGmFilters(report.runs, filters), [report.runs, filters]);
  const buckets = useMemo(() => bucketByDay(filtered, period), [filtered, period]);
  const failures = useMemo(() => failureBreakdown(filtered), [filtered]);
  const tableRuns = useMemo(() => sortGmRuns(filtered, sortKey, sortDirection), [filtered, sortKey, sortDirection]);
  const counts = {
    finished: filtered.length,
    complete: filtered.filter((r) => r.outcome === 'complete').length,
    cancelled: filtered.filter((r) => r.outcome === 'cancelled').length,
    error: filtered.filter((r) => r.outcome === 'error').length,
  };
  const outcomeOptions = useMemo(() => [...new Set(report.runs.map((r) => r.outcome))].sort(), [report.runs]);
  const platformOptions = useMemo(() => [...new Set(report.runs.map((r) => r.platform))].sort(), [report.runs]);
  const hasFilters = filters.types.length + filters.outcomes.length + filters.platforms.length > 0 || filters.search.trim() !== '';

  function updateFilters(next: GmFilters) {
    setFilters(next);
    setVisibleCount(5);
    setOpenRunId(null);
  }

  return (
    <div className="space-y-6">
      <SyncFilterBar<GmFilters>
        period={period}
        filters={filters}
        typeOptions={GM_RUN_KIND_OPTIONS}
        outcomeOptions={outcomeOptions}
        platformOptions={platformOptions}
        hasFilters={hasFilters}
        onPeriodChange={(p, from, to) => {
          const search = typeof window === 'undefined' ? '' : window.location.search.replace(/^\?/, '');
          onNavigate?.(buildPeriodUrl(search, p, from, to));
        }}
        onFiltersChange={updateFilters}
        onClear={() => updateFilters(GM_EMPTY_FILTERS)}
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Tile label="Finished" value={counts.finished} />
        <Tile label="Completed" value={counts.complete} />
        <Tile label="Cancelled" value={counts.cancelled} />
        <Tile label="Errored" value={counts.error} />
      </div>

      <SyncCharts buckets={buckets} />

      <section data-testid="gm-failure-breakdown">
        <h2 className="mb-3 text-base font-semibold text-gray-900">Why runs did not complete</h2>
        {failures.length === 0 ? (
          <p className="rounded-lg border border-gray-200 bg-white p-5 text-sm text-gray-500">
            Every run in this view completed.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-gray-500">
                  <th className="py-2 px-3 font-medium">What the user saw</th>
                  <th className="py-2 px-3 font-medium">Code</th>
                  <th className="py-2 px-3 text-right font-medium">Runs</th>
                </tr>
              </thead>
              <tbody>
                {failures.map((f) => (
                  <tr key={f.code} className="border-b border-gray-100 last:border-0" data-code={f.code}>
                    <td className="py-2 px-3 text-gray-900">{f.line}</td>
                    <td className="py-2 px-3 text-gray-500">{f.code}</td>
                    <td className="py-2 px-3 text-right tabular-nums text-gray-900">{f.runs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <RunTable<GmSyncRun, GmSortKey>
        runs={tableRuns}
        columns={GM_COLUMNS}
        renderDetail={(run) => <GmRunDetail run={run} />}
        visibleCount={visibleCount}
        sortKey={sortKey}
        sortDirection={sortDirection}
        openRunId={openRunId}
        truncated={truncated}
        rowCap={rowCap}
        periodLabel={period.label}
        onSort={(key) => {
          if (key === sortKey) setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
          else {
            setSortKey(key);
            setSortDirection(GM_SORT_SPECS[key].numeric ? 'desc' : 'asc');
          }
        }}
        onShowMore={() => setVisibleCount(visibleCount + 5)}
        onShowAll={() => setVisibleCount(tableRuns.length)}
        onToggleRow={(id) => setOpenRunId(openRunId === id ? null : id)}
      />
    </div>
  );
}
