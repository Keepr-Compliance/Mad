'use client';

/**
 * Submissions report controls — BACKLOG-3513 PR-3a.
 *
 * Status, agent (full roles only), date range and sort. Every change pushes a
 * new URL; the server page reads the URL and asks the database again. Nothing
 * is filtered here.
 *
 * Founder ruling "A" (BACKLOG-3513 PR-3c): one concept, views (the shared
 * report definitions). The personal saved-views panel (BACKLOG-3514) was
 * removed from the broker portal; its database side is unchanged.
 *
 * BACKLOG-3513 PR-3c (founder QA): the design-system controls, as the admin
 * report filter bars use them: the kit Dropdown in its 'filter' variant
 * (admin-portal/app/dashboard/organizations/components/OrganizationsTable.tsx:146,
 * single choice; admin-portal/app/dashboard/reports/submissions/SubmissionFilterBar.tsx:71)
 * and the kit DateRangePicker (the range pill of the kit PeriodPicker,
 * packages/ui/src/components/report/period-picker.tsx:107).
 *
 * BACKLOG-3513 PR-3h: Status and Agent are the kit Dropdown in multi mode with its
 * own clear X (onClear), as admin-portal ExportFilterBar.tsx and OrganizationsTable.tsx
 * use it. Nothing picked = no filter ("All statuses" / "All agents").
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, DateRangePicker, Dropdown } from '@keepr/ui';
import type { AgentOption } from '@/lib/reports/datasets/submissions';
import {
  SUBMISSIONS_SORT_OPTIONS,
  SUBMISSIONS_STATUS_OPTIONS,
  buildSubmissionsReportUrl,
  parseAgentsParam,
  parseDateParam,
  parseStatusesParam,
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
 * A multi-select value that follows each toggle at once. `filters` is a server prop that stays
 * stale until the new URL's server response arrives, so two quick toggles read from it would
 * drop the first. The local copy starts from the prop and starts over whenever the prop changes.
 */
function usePendingList(server: string[]): [string[], (_next: string[]) => void] {
  const key = server.join(',');
  const [pending, setPending] = useState<{ key: string; value: string[] }>({ key, value: server });
  const value = pending.key === key ? pending.value : server;
  return [value, (next) => setPending({ key, value: next })];
}

export function SubmissionsReportFilters({ filters, showAgent, agents, basePath, explicit = false }: SubmissionsReportFiltersProps) {
  const router = useRouter();
  const [statuses, setStatuses] = usePendingList(filters.statuses);
  const [agentIds, setAgentIds] = usePendingList(filters.agents);
  const current: Filters = { ...filters, statuses, agents: agentIds };
  const go = (next: Filters, scroll?: false) => {
    const url = buildSubmissionsReportUrl({ ...next, page: 1 }, basePath, explicit);
    if (scroll === false) router.push(url, { scroll: false });
    else router.push(url);
  };
  const set = (patch: Partial<Filters>) => go({ ...current, ...patch });
  // A list change keeps the panel open and the page where it is.
  const setStatusList = (next: string[]) => {
    const value = parseStatusesParam(next);
    setStatuses(value);
    go({ ...current, statuses: value }, false);
  };
  const setAgentList = (next: string[]) => {
    // Every agent picked is no agent filter (Select all, and the URL's agent cap).
    const value = agents.length > 0 && agents.every((a) => next.includes(a.id)) ? [] : parseAgentsParam(next);
    setAgentIds(value);
    go({ ...current, agents: value }, false);
  };
  const agentOptions = agents.map((a) => ({ value: a.id, label: a.label }));
  const hasDates = Boolean(filters.from || filters.to);

  return (
    <div className="flex flex-col gap-3" data-testid="submissions-report-filters">
      <div className="flex flex-wrap items-center gap-2">
        <Dropdown
          mode="multi"
          variant="filter"
          ariaLabel="Status"
          placeholder="All statuses"
          searchable={false}
          options={SUBMISSIONS_STATUS_OPTIONS}
          value={statuses}
          onChange={setStatusList}
          onClear={() => setStatusList([])}
        />
        {showAgent ? (
          <Dropdown
            mode="multi"
            variant="filter"
            ariaLabel="Agent"
            placeholder="All agents"
            searchable={agentOptions.length > 8}
            options={agentOptions}
            value={agentIds}
            onChange={setAgentList}
            onClear={() => setAgentList([])}
          />
        ) : null}
        <DateRangePicker
          ariaLabel="Date range"
          value={{ from: filters.from ?? undefined, to: filters.to ?? undefined }}
          onChange={({ from, to }) => set({ from: parseDateParam(from), to: parseDateParam(to) })}
        />
        {hasDates ? (
          <Button type="button" variant="secondary" size="sm" onClick={() => set({ from: null, to: null })}>
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
