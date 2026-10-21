'use client';

/**
 * Submissions report — filter row (BACKLOG-3715). Same shape as the iPhone
 * Sync filter bar. Only the period goes back to the server; every other
 * filter applies to the period's rows in the browser. The shell, period
 * picker and multi-selects come from the @keepr/ui report kit (BACKLOG-3502a).
 */

import { Search } from 'lucide-react';
import { FilterBar, MultiSelect, PeriodPicker } from '@keepr/ui';
import { PERIOD_OPTIONS, type PeriodKey, type PeriodRange } from '@/lib/reports/period';
import type { SubmissionFilters } from '@/lib/reports/submissions';

const SELECT_CLASS =
  'text-sm border border-gray-300 rounded-md px-3 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500';

export interface FilterOption {
  value: string;
  label: string;
}

export interface SubmissionFilterBarProps {
  period: PeriodRange;
  filters: SubmissionFilters;
  statusOptions: FilterOption[];
  orgOptions: FilterOption[];
  agentOptions: FilterOption[];
  reasonOptions: FilterOption[];
  platformOptions: FilterOption[];
  hasFilters: boolean;
  onPeriodChange: (period: string, from?: string, to?: string) => void;
  onFiltersChange: (filters: SubmissionFilters) => void;
  onClear: () => void;
}

export function SubmissionFilterBar({
  period,
  filters,
  statusOptions,
  orgOptions,
  agentOptions,
  reasonOptions,
  platformOptions,
  hasFilters,
  onPeriodChange,
  onFiltersChange,
  onClear,
}: SubmissionFilterBarProps) {
  return (
    <FilterBar hasFilters={hasFilters} onClear={onClear}>
      <PeriodPicker<PeriodKey>
        options={PERIOD_OPTIONS}
        value={period.key}
        customKey="custom"
        from={period.customFrom ?? undefined}
        to={period.customTo ?? undefined}
        onChange={onPeriodChange}
      />

      <MultiSelect
        label="Outcome"
        options={statusOptions}
        selected={filters.statuses}
        onChange={(statuses) => onFiltersChange({ ...filters, statuses })}
      />
      <MultiSelect
        label="Organization"
        options={orgOptions}
        selected={filters.orgs}
        onChange={(orgs) => onFiltersChange({ ...filters, orgs })}
      />
      <MultiSelect
        label="Agent"
        options={agentOptions}
        selected={filters.agents}
        onChange={(agents) => onFiltersChange({ ...filters, agents })}
      />
      <MultiSelect
        label="Reason"
        options={reasonOptions}
        selected={filters.reasons}
        onChange={(reasons) => onFiltersChange({ ...filters, reasons })}
      />
      <MultiSelect
        label="Platform"
        options={platformOptions}
        selected={filters.platforms}
        onChange={(platforms) => onFiltersChange({ ...filters, platforms })}
      />

      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400"
          aria-hidden="true"
        />
        <input
          type="search"
          aria-label="Search by submission id or agent email"
          placeholder="Submission id or agent email"
          value={filters.search}
          onChange={(e) => onFiltersChange({ ...filters, search: e.target.value })}
          className={`${SELECT_CLASS} pl-8`}
        />
      </div>
    </FilterBar>
  );
}
