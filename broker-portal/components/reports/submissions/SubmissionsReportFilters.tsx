'use client';

/**
 * Submissions report controls — BACKLOG-3513 PR-3a.
 *
 * Status, agent (full roles only), date range and sort, plus the Views panel
 * (ReportSavedViews, BACKLOG-3514). Every change pushes a new URL; the server
 * page reads the URL and asks the database again. Nothing is filtered here.
 */

import { useRouter } from 'next/navigation';
import { ReportSavedViews } from '@/components/reports/ReportSavedViews';
import type { ReportDefinition } from '@/lib/reports/registry';
import type { AgentOption } from '@/lib/reports/datasets/submissions';
import {
  DEFAULT_SUBMISSIONS_FILTERS,
  SUBMISSIONS_SORT_OPTIONS,
  SUBMISSIONS_STATUS_OPTIONS,
  buildSubmissionsReportUrl,
  filtersToViewState,
  parseDateParam,
  parseStatusParam,
  parseSubmissionsSort,
  viewStateToFilters,
  type SubmissionsReportFilters as Filters,
} from '@/lib/reports/datasets/submissions-filters';

export interface SubmissionsReportFiltersProps {
  orgId: string;
  report: ReportDefinition;
  filters: Filters;
  /** Shown only to a full role; an agent's report is their own rows. */
  showAgent: boolean;
  agents: AgentOption[];
}

const FIELD = 'rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900';

export function SubmissionsReportFilters({ orgId, report, filters, showAgent, agents }: SubmissionsReportFiltersProps) {
  const router = useRouter();
  const go = (next: Filters) => router.push(buildSubmissionsReportUrl({ ...next, page: 1 }));
  const set = (patch: Partial<Filters>) => go({ ...filters, ...patch });

  return (
    <div className="flex flex-col gap-3" data-testid="submissions-report-filters">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-gray-600">
          Status
          <select
            aria-label="Status"
            className={FIELD}
            value={filters.status}
            onChange={(e) => set({ status: parseStatusParam(e.target.value) })}
          >
            {SUBMISSIONS_STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {showAgent ? (
          <label className="flex flex-col gap-1 text-xs text-gray-600">
            Agent
            <select
              aria-label="Agent"
              className={FIELD}
              value={filters.agent ?? ''}
              onChange={(e) => set({ agent: e.target.value || null })}
            >
              <option value="">All agents</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="flex flex-col gap-1 text-xs text-gray-600">
          From
          <input
            type="date"
            aria-label="From"
            className={FIELD}
            value={filters.from ?? ''}
            onChange={(e) => set({ from: parseDateParam(e.target.value) })}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-600">
          To
          <input
            type="date"
            aria-label="To"
            className={FIELD}
            value={filters.to ?? ''}
            onChange={(e) => set({ to: parseDateParam(e.target.value) })}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-600">
          Sort
          <select
            aria-label="Sort"
            className={FIELD}
            value={filters.sort}
            onChange={(e) => set({ sort: parseSubmissionsSort(e.target.value) })}
          >
            {SUBMISSIONS_SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ReportSavedViews
        orgId={orgId}
        report={report}
        current={filtersToViewState(filters)}
        onApply={(view) => go(viewStateToFilters(view))}
        onClear={() => go(DEFAULT_SUBMISSIONS_FILTERS)}
      />
    </div>
  );
}
