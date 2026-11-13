'use client';

/**
 * Submissions report controls — BACKLOG-3513 PR-3a.
 *
 * Status, agent (full roles only), date range and sort. Every change pushes a
 * new URL; the server page reads the URL and asks the database again. Nothing
 * is filtered here.
 *
 * Founder ruling "A" (BACKLOG-3513 PR-3c): one concept, views (the shared
 * report definitions). The personal saved-views panel (ReportSavedViews,
 * BACKLOG-3514) is no longer mounted here; its database side is unchanged.
 *
 * BACKLOG-3513 PR-3c (founder QA): the design-system controls, as the admin
 * report filter bars use them: the kit Dropdown in its 'filter' variant
 * (admin-portal/app/dashboard/organizations/components/OrganizationsTable.tsx:146,
 * single choice; admin-portal/app/dashboard/reports/submissions/SubmissionFilterBar.tsx:71)
 * and the kit DateRangePicker (the range pill of the kit PeriodPicker,
 * packages/ui/src/components/report/period-picker.tsx:107). Values, URL params
 * and the "all" handling are unchanged.
 */

import { useRouter } from 'next/navigation';
import { Button, DateRangePicker, Dropdown } from '@keepr/ui';
import type { AgentOption } from '@/lib/reports/datasets/submissions';
import {
  SUBMISSIONS_SORT_OPTIONS,
  SUBMISSIONS_STATUS_OPTIONS,
  buildSubmissionsReportUrl,
  parseDateParam,
  parseStatusParam,
  parseSubmissionsSort,
  type SubmissionsReportFilters as Filters,
} from '@/lib/reports/datasets/submissions-filters';

export interface SubmissionsReportFiltersProps {
  filters: Filters;
  /** Shown only to a full role; an agent's report is their own rows. */
  showAgent: boolean;
  agents: AgentOption[];
  /** Where the controls push to. Default: the Submissions report. A shared report passes its own page. */
  basePath?: string;
  /** Keep `status` in the URL (a shared report: see buildSubmissionsReportUrl). */
  explicit?: boolean;
}

/**
 * The "All agents" choice. It stands for "no agent filter" and is mapped back to null before
 * anything is sent or put in the URL.
 */
export const ALL_AGENTS = '__all__';

export function SubmissionsReportFilters({ filters, showAgent, agents, basePath, explicit = false }: SubmissionsReportFiltersProps) {
  const router = useRouter();
  const go = (next: Filters) => router.push(buildSubmissionsReportUrl({ ...next, page: 1 }, basePath, explicit));
  const set = (patch: Partial<Filters>) => go({ ...filters, ...patch });
  const agentOptions = [{ value: ALL_AGENTS, label: 'All agents' }, ...agents.map((a) => ({ value: a.id, label: a.label }))];
  const hasDates = Boolean(filters.from || filters.to);

  return (
    <div className="flex flex-col gap-3" data-testid="submissions-report-filters">
      <div className="flex flex-wrap items-center gap-2">
        <Dropdown
          variant="filter"
          ariaLabel="Status"
          searchable={false}
          options={SUBMISSIONS_STATUS_OPTIONS}
          value={filters.status}
          onChange={(v) => set({ status: parseStatusParam(v) })}
        />
        {showAgent ? (
          <Dropdown
            variant="filter"
            ariaLabel="Agent"
            searchable={agentOptions.length > 8}
            options={agentOptions}
            value={filters.agent ?? ALL_AGENTS}
            onChange={(v) => set({ agent: v === ALL_AGENTS ? null : v })}
          />
        ) : null}
        <DateRangePicker
          ariaLabel="Date range"
          value={{ from: filters.from ?? undefined, to: filters.to ?? undefined }}
          onChange={({ from, to }) => set({ from: parseDateParam(from), to: parseDateParam(to) })}
        />
        {hasDates ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => set({ from: null, to: null })}>
            Clear dates
          </Button>
        ) : null}
        <Dropdown
          variant="filter"
          ariaLabel="Sort"
          searchable={false}
          options={SUBMISSIONS_SORT_OPTIONS}
          value={filters.sort}
          onChange={(v) => set({ sort: parseSubmissionsSort(v) })}
        />
      </div>
    </div>
  );
}
