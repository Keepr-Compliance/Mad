'use client';

/**
 * Submissions report controls — BACKLOG-3513 PR-3a.
 *
 * Status, agent (full roles only), date range and sort, plus the Views panel
 * (ReportSavedViews, BACKLOG-3514). Every change pushes a new URL; the server
 * page reads the URL and asks the database again. Nothing is filtered here.
 */

import { useRouter } from 'next/navigation';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@keepr/ui';
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
  /** Where the controls push to. Default: the Submissions report. A shared report passes its own page. */
  basePath?: string;
  /** Keep `status` in the URL (a shared report: see buildSubmissionsReportUrl). */
  explicit?: boolean;
  /** The saved-views key. Default: the report's slug. */
  viewsKey?: string;
}

const FIELD = 'rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900';
/** The kit Select trigger, sized for a filter row (BACKLOG-3513 PR-3c). */
const TRIGGER = 'h-8 min-w-[10rem] text-sm';
/**
 * The "All agents" choice. A kit (Radix) SelectItem cannot carry an empty value, so this stands in
 * for "no agent filter" and is mapped back to null before anything is sent or put in the URL.
 */
export const ALL_AGENTS = '__all__';

export function SubmissionsReportFilters({
  orgId,
  report,
  filters,
  showAgent,
  agents,
  basePath,
  explicit = false,
  viewsKey,
}: SubmissionsReportFiltersProps) {
  const router = useRouter();
  const go = (next: Filters) => router.push(buildSubmissionsReportUrl({ ...next, page: 1 }, basePath, explicit));
  const set = (patch: Partial<Filters>) => go({ ...filters, ...patch });

  return (
    <div className="flex flex-col gap-3" data-testid="submissions-report-filters">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1 text-xs text-gray-600">
          <span aria-hidden="true">Status</span>
          <Select value={filters.status} onValueChange={(v) => set({ status: parseStatusParam(v) })}>
            <SelectTrigger aria-label="Status" className={TRIGGER}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SUBMISSIONS_STATUS_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {showAgent ? (
          <div className="flex flex-col gap-1 text-xs text-gray-600">
            <span aria-hidden="true">Agent</span>
            <Select
              value={filters.agent ?? ALL_AGENTS}
              onValueChange={(v) => set({ agent: v === ALL_AGENTS ? null : v })}
            >
              <SelectTrigger aria-label="Agent" className={TRIGGER}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_AGENTS}>All agents</SelectItem>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
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
        <div className="flex flex-col gap-1 text-xs text-gray-600">
          <span aria-hidden="true">Sort</span>
          <Select value={filters.sort} onValueChange={(v) => set({ sort: parseSubmissionsSort(v) })}>
            <SelectTrigger aria-label="Sort" className={TRIGGER}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SUBMISSIONS_SORT_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <ReportSavedViews
        orgId={orgId}
        report={report}
        current={filtersToViewState(filters)}
        onApply={(view) => go(viewStateToFilters(view))}
        onClear={() => go(DEFAULT_SUBMISSIONS_FILTERS)}
        reportKey={viewsKey}
      />
    </div>
  );
}
