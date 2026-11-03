'use client';

/**
 * Exports report — filter row (BACKLOG-4004). Same shape as the Submissions
 * filter bar. Only the period goes back to the server; every other filter
 * applies to the period's events in the browser.
 */

import type { ReactNode } from 'react';
import { Filter, Search, X } from 'lucide-react';
import { Dropdown } from '@keepr/ui';
import { MultiSelectDropdown } from '@/components/shared/MultiSelectDropdown';
import { PERIOD_OPTIONS, type PeriodRange } from '@/lib/reports/period';
import type { ExportFilters } from '@/lib/reports/exports';

const SELECT_CLASS =
  'text-sm border border-gray-300 rounded-md px-3 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500';

export interface FilterOption {
  value: string;
  label: string;
}

export interface ExportFilterBarProps {
  period: PeriodRange;
  filters: ExportFilters;
  orgOptions: FilterOption[];
  userOptions: FilterOption[];
  formatOptions: FilterOption[];
  hasFilters: boolean;
  onPeriodChange: (period: string, from?: string, to?: string) => void;
  onFiltersChange: (filters: ExportFilters) => void;
  onClear: () => void;
  /** The Views dropdown, rendered at the end of the row. */
  views?: ReactNode;
}

export function ExportFilterBar({
  period,
  filters,
  orgOptions,
  userOptions,
  formatOptions,
  hasFilters,
  onPeriodChange,
  onFiltersChange,
  onClear,
  views,
}: ExportFilterBarProps) {
  const custom = period.key === 'custom';

  return (
    <div className="flex flex-wrap items-center gap-3" data-filter-bar="exports">
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

      <Dropdown
        mode="multi"
        variant="filter"
        ariaLabel="Organization"
        options={orgOptions}
        value={filters.orgs}
        onChange={(orgs) => onFiltersChange({ ...filters, orgs })}
        onClear={() => onFiltersChange({ ...filters, orgs: [] })}
      />
      <MultiSelectDropdown
        label="User"
        options={userOptions}
        selected={filters.users}
        onChange={(users) => onFiltersChange({ ...filters, users })}
      />
      <MultiSelectDropdown
        label="Format"
        options={formatOptions}
        selected={filters.formats}
        onChange={(formats) => onFiltersChange({ ...filters, formats })}
      />

      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400"
          aria-hidden="true"
        />
        <input
          type="search"
          aria-label="Search by user name or email"
          placeholder="User name or email"
          maxLength={120}
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

      {views ? <div className="ml-auto">{views}</div> : null}
    </div>
  );
}
