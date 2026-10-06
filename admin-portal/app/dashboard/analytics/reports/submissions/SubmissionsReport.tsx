'use client';

/**
 * Submissions report — composition shell (BACKLOG-3715)
 *
 * Owns the client state (filters, sort, rows shown, open row) and composes the
 * filter bar, tiles, open-attempts panel, charts and table.
 *
 * THE ONE INVARIANT: the period tiles, both charts and the table all read
 * `filtered`. The "Stalled now" tile reads the open-attempts set instead —
 * the same set and the same 30-minute rule as the panel beside it, so the two
 * can never disagree. It is labelled as not following the period.
 *
 * The open-attempts panel renders whether or not the period has rows.
 */

import { useMemo, useState } from 'react';
import type { PeriodRange } from '@/lib/reports/period';
import { buildPeriodUrl } from '@/lib/reports/report-url';
import {
  activeFilterNames,
  applySubmissionFilters,
  bucketSubmissionsByDay,
  computeCounts,
  defaultSubmissionDirection,
  EMPTY_SUBMISSION_FILTERS,
  hasActiveFilters,
  INITIAL_VISIBLE_SUBMISSIONS,
  NO_REASON,
  reasonLabel,
  sortSubmissions,
  STALL_MINUTES,
  STATUS_LABELS,
  SUBMISSION_SHOW_MORE_STEP,
  type SortDirection,
  type Submission,
  type SubmissionFilters,
  type SubmissionSortKey,
  type SubmissionsReportModel,
} from '@/lib/reports/submissions';
import { OpenAttemptsPanel } from './OpenAttemptsPanel';
import { SubmissionCharts } from './SubmissionCharts';
import { SubmissionFilterBar, type FilterOption } from './SubmissionFilterBar';
import { SubmissionTable } from './SubmissionTable';

function Tile({
  label,
  value,
  sub,
  tone,
  testId,
}: {
  label: string;
  value: number;
  sub?: string;
  tone?: 'critical';
  testId: string;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5" data-tile={testId}>
      <p className="text-sm font-medium text-gray-500">{label}</p>
      <p
        className={`mt-1 text-2xl font-semibold tabular-nums ${
          tone === 'critical' && value > 0 ? 'text-red-700' : 'text-gray-900'
        }`}
        data-tile-value={testId}
      >
        {value}
      </p>
      {sub ? <p className="mt-0.5 text-xs text-gray-500">{sub}</p> : null}
    </div>
  );
}

export interface SubmissionsReportProps {
  report: SubmissionsReportModel;
  openAttempts: Submission[];
  openFailed?: boolean;
  openTruncated?: boolean;
  openCap: number;
  period: PeriodRange;
  truncated?: boolean;
  rowCap: number;
  onNavigate?: (url: string) => void;
}

function uniqueOptions(subs: Submission[], pick: (s: Submission) => FilterOption | null): FilterOption[] {
  const map = new Map<string, string>();
  for (const s of subs) {
    const o = pick(s);
    if (o && !map.has(o.value)) map.set(o.value, o.label);
  }
  return [...map.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function SubmissionsReport({
  report,
  openAttempts,
  openFailed = false,
  openTruncated = false,
  openCap,
  period,
  truncated = false,
  rowCap,
  onNavigate,
}: SubmissionsReportProps) {
  const [filters, setFilters] = useState<SubmissionFilters>(EMPTY_SUBMISSION_FILTERS);
  const [sortKey, setSortKey] = useState<SubmissionSortKey>('started');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_SUBMISSIONS);
  const [openRowId, setOpenRowId] = useState<string | null>(null);

  // THE shared set: tiles, charts and table all read this.
  const filtered = useMemo(
    () => applySubmissionFilters(report.submissions, filters),
    [report.submissions, filters]
  );
  const counts = useMemo(() => computeCounts(filtered), [filtered]);
  const buckets = useMemo(() => bucketSubmissionsByDay(filtered, period), [filtered, period]);
  const tableRows = useMemo(
    () => sortSubmissions(filtered, sortKey, sortDirection),
    [filtered, sortKey, sortDirection]
  );
  const stalledNow = openAttempts.filter((s) => s.status === 'stalled').length;

  const all = report.submissions;
  const statusOptions = uniqueOptions(all, (s) => ({ value: s.status, label: s.statusLabel }));
  const orgOptions = uniqueOptions(all, (s) => ({ value: s.orgId ?? '', label: s.orgLabel }));
  const agentOptions = uniqueOptions(all, (s) => ({ value: s.userId ?? '', label: s.agentLabel }));
  const reasonOptions = uniqueOptions(all, (s) => ({
    value: s.reason ?? NO_REASON,
    label: s.reason ? reasonLabel(s.reason) : 'No reason',
  }));
  const platformOptions = uniqueOptions(all, (s) => ({ value: s.platform, label: s.platform }));

  function updateFilters(next: SubmissionFilters) {
    setFilters(next);
    setVisibleCount(INITIAL_VISIBLE_SUBMISSIONS);
    setOpenRowId(null);
  }

  function handleSort(key: SubmissionSortKey) {
    if (key === sortKey) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDirection(defaultSubmissionDirection(key));
    }
  }

  function navigateToPeriod(nextPeriod: string, from?: string, to?: string) {
    const search = typeof window === 'undefined' ? '' : window.location.search.replace(/^\?/, '');
    onNavigate?.(buildPeriodUrl(search, nextPeriod, from, to));
  }

  const filterNames = activeFilterNames(filters);
  const caption = `Cards, charts and rows follow the filters: ${period.label}${
    filterNames.length > 0 ? ` · ${filterNames.join(' · ')}` : ' · no other filters'
  }`;

  return (
    <div className="space-y-6">
      <SubmissionFilterBar
        period={period}
        filters={filters}
        statusOptions={statusOptions}
        orgOptions={orgOptions}
        agentOptions={agentOptions}
        reasonOptions={reasonOptions}
        platformOptions={platformOptions}
        hasFilters={hasActiveFilters(filters)}
        onPeriodChange={navigateToPeriod}
        onFiltersChange={updateFilters}
        onClear={() => updateFilters(EMPTY_SUBMISSION_FILTERS)}
      />

      <div>
        <p className="mb-2 text-xs text-gray-500">{caption}</p>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-6">
          <Tile testId="attempts" label="Attempts" value={counts.attempts} sub="Includes attempts still open" />
          <Tile
            testId="committed"
            label={STATUS_LABELS.committed}
            value={counts.committed}
            sub={counts.committedPct == null ? 'No attempts' : `${counts.committedPct}% of attempts`}
          />
          <Tile testId="failed" label="Failed" value={counts.failed} sub="Includes outcome unknown" />
          <Tile testId="did-not-finish" label={STATUS_LABELS.abandoned} value={counts.didNotFinish} />
          <Tile testId="cancelled" label={STATUS_LABELS.cancelled} value={counts.cancelled} />
          <Tile
            testId="stalled-now"
            label="Stalled now"
            value={stalledNow}
            tone="critical"
            sub={`Open ${STALL_MINUTES} min or more, any start date. Not filtered.`}
          />
        </div>
      </div>

      <OpenAttemptsPanel
        attempts={openAttempts}
        failed={openFailed}
        truncated={openTruncated}
        cap={openCap}
      />

      <SubmissionCharts buckets={buckets} />

      <SubmissionTable
        rows={tableRows}
        visibleCount={visibleCount}
        sortKey={sortKey}
        sortDirection={sortDirection}
        openRowId={openRowId}
        truncated={truncated}
        rowCap={rowCap}
        periodLabel={period.label}
        onSort={handleSort}
        onShowMore={() => setVisibleCount(visibleCount + SUBMISSION_SHOW_MORE_STEP)}
        onToggleRow={(id) => setOpenRowId(openRowId === id ? null : id)}
      />
    </div>
  );
}
