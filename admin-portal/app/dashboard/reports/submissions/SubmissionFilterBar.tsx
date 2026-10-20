'use client';

/**
 * Submissions report — filter row (BACKLOG-3715). Same shape as the iPhone
 * Sync filter bar. Only the period goes back to the server; every other
 * filter applies to the period's rows in the browser.
 */

import { Filter, Search, X } from 'lucide-react';
import { MultiSelectDropdown } from '@/components/shared/MultiSelectDropdown';
import { PERIOD_OPTIONS, type PeriodRange } from '@/lib/reports/period';
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
  const custom = period.key === 'custom';

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-1.5 text-gray-500">
        <Filter className="h-4 w-4" aria-hidden="true" />
        <span className="text-sm font-medium">Filters</span>
      </div>

      <select
        aria-label="Period"
        value={period.key}
        onChange={(e) =>
          onPeriodChange(e.target.value, period.customFrom ?? undefined, period.customTo ?? undefined)
        }
        className={SELECT_CLASS}
      >
        {PERIOD_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      {custom ? (
        <span className="flex items-center gap-2">
          <input
            type="date"
            aria-label="From"
            value={period.customFrom ?? ''}
            onChange={(e) => onPeriodChange('custom', e.target.value, period.customTo ?? undefined)}
            className={SELECT_CLASS}
          />
          <span className="text-sm text-gray-400">to</span>
          <input
            type="date"
            aria-label="To"
            value={period.customTo ?? ''}
            onChange={(e) => onPeriodChange('custom', period.customFrom ?? undefined, e.target.value)}
            className={SELECT_CLASS}
          />
        </span>
      ) : null}

      <MultiSelectDropdown
        label="Outcome"
        options={statusOptions}
        selected={filters.statuses}
        onChange={(statuses) => onFiltersChange({ ...filters, statuses })}
      />
      <MultiSelectDropdown
        label="Organization"
        options={orgOptions}
        selected={filters.orgs}
        onChange={(orgs) => onFiltersChange({ ...filters, orgs })}
      />
      <MultiSelectDropdown
        label="Agent"
        options={agentOptions}
        selected={filters.agents}
        onChange={(agents) => onFiltersChange({ ...filters, agents })}
      />
      <MultiSelectDropdown
        label="Reason"
        options={reasonOptions}
        selected={filters.reasons}
        onChange={(reasons) => onFiltersChange({ ...filters, reasons })}
      />
      <MultiSelectDropdown
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

      {hasFilters ? (
        <button
          type="button"
          onClick={onClear}
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
          Clear filters
        </button>
      ) : null}
    </div>
  );
}
