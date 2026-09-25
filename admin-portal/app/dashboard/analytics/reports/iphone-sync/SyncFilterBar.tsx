'use client';

/**
 * iPhone Sync Performance — the filter row (BACKLOG-3450)
 *
 * The TicketFilters shape: a Filter icon and a "Filters" label, native
 * `<select>` for the period (one choice), `MultiSelectDropdown` for the three
 * that take several, a search box and a Clear.
 *
 * The PERIOD is the only control here that goes back to the server. It calls
 * `onPeriodChange` with a URL that PRESERVES every other param — see
 * `buildPeriodUrl`.
 */

import { Filter, Search, X } from 'lucide-react';
import { MultiSelectDropdown } from '@/components/shared/MultiSelectDropdown';
import { PERIOD_OPTIONS, type PeriodRange } from '@/lib/reports/period';
import type { RunFilters } from '@/lib/reports/iphone-sync-filters';
import type { SyncType } from '@/lib/reports/iphone-sync';

const SELECT_CLASS =
  'text-sm border border-gray-300 rounded-md px-3 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500';

const TYPE_OPTIONS = [
  { value: 'first', label: 'first' },
  { value: 'incremental', label: 'incremental' },
  { value: 'unknown', label: 'not recorded' },
];

export interface SyncFilterBarProps {
  period: PeriodRange;
  filters: RunFilters;
  outcomeOptions: string[];
  platformOptions: string[];
  hasFilters: boolean;
  onPeriodChange: (period: string, from?: string, to?: string) => void;
  onFiltersChange: (filters: RunFilters) => void;
  onClear: () => void;
  /** The Views dropdown. A slot, so this bar stays free of saved-view state. */
  viewsSlot?: React.ReactNode;
}

export function SyncFilterBar({
  period,
  filters,
  outcomeOptions,
  platformOptions,
  hasFilters,
  onPeriodChange,
  onFiltersChange,
  onClear,
  viewsSlot,
}: SyncFilterBarProps) {
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
        onChange={(e) => onPeriodChange(e.target.value, period.customFrom ?? undefined, period.customTo ?? undefined)}
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
        label="Type"
        options={TYPE_OPTIONS}
        selected={filters.types}
        onChange={(types) => onFiltersChange({ ...filters, types: types as SyncType[] })}
      />
      <MultiSelectDropdown
        label="Outcome"
        options={outcomeOptions.map((value) => ({ value, label: value }))}
        selected={filters.outcomes}
        onChange={(outcomes) => onFiltersChange({ ...filters, outcomes })}
      />
      <MultiSelectDropdown
        label="Platform"
        options={platformOptions.map((value) => ({ value, label: value }))}
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
          aria-label="Search by user"
          placeholder="Search by user"
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

      {viewsSlot ? <div className="ml-auto">{viewsSlot}</div> : null}
    </div>
  );
}
