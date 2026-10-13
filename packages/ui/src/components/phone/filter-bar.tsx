'use client';

import * as React from 'react';
import { ArrowUpDown } from 'lucide-react';
import { cn } from '../../lib/cn';
import { SearchField } from './search-field';
import { FilterSelectButton, type FilterSelectButtonProps } from './filter-select-button';

/**
 * Phone kit — the search + two-filter bar shared by the broker Submissions and
 * Users pages (BACKLOG-3904). A search field (with the X when `onClear` is
 * given), then two FilterSelectButtons side by side in a 2-column grid. Generic:
 * the page passes labels, values and handlers and owns the bottom sheets
 * (`children` renders after the bar, for the sheets, which portal out).
 * Pass `results` (a PhoneResultsRow) to sit directly under the grid.
 * Phone only by intent: the page hides it from md up (`className="md:hidden"`).
 */
export type PhoneFilterSpec = Omit<FilterSelectButtonProps, 'className'>;

export interface PhoneFilterBarProps {
  search: {
    label: string;
    placeholder?: string;
    value: string;
    onChange: (value: string) => void;
    onClear?: () => void;
    /** Enter / form submit. */
    onSubmit?: () => void;
    id?: string;
  };
  /** Exactly two filters. */
  filters: readonly [PhoneFilterSpec, PhoneFilterSpec];
  /** Optional square control after the two filters (e.g. PhoneSortButton). Without it the bar is unchanged. */
  trailing?: React.ReactNode;
  results?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}

export function PhoneFilterBar({ search, filters, trailing, results, children, className }: PhoneFilterBarProps) {
  return (
    <div data-slot="phone-filter-bar" className={className}>
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          search.onSubmit?.();
        }}
      >
        <SearchField
          id={search.id}
          label={search.label}
          placeholder={search.placeholder}
          value={search.value}
          onChange={search.onChange}
          onClear={search.onClear}
        />
      </form>
      <div
        className={
          trailing ? 'mt-2 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2.75rem] gap-2' : 'mt-2 grid grid-cols-2 gap-2'
        }
      >
        <FilterSelectButton {...filters[0]} />
        <FilterSelectButton {...filters[1]} />
        {trailing}
      </div>
      {results}
      {children}
    </div>
  );
}

/**
 * Phone kit — the "Showing X of Y <noun>s" row: 44px tall, count on the left,
 * optional right-hand slot (`action`: Clear filters, Invite, ...). The noun is
 * singular and pluralised by Y, as the Users page always did.
 */
export interface PhoneResultsRowProps {
  shown: number;
  total: number;
  /** Singular noun, e.g. "user". */
  noun: string;
  action?: React.ReactNode;
  className?: string;
}

export function PhoneResultsRow({ shown, total, noun, action, className }: PhoneResultsRowProps) {
  return (
    <div
      data-slot="phone-results-row"
      className={cn('flex h-11 items-center justify-between gap-2', className)}
    >
      <span className="min-w-0 text-sm text-gray-500">
        Showing {shown} of {total} {noun}
        {total !== 1 ? 's' : ''}
      </span>
      {action ? <div className="flex shrink-0 items-center gap-1">{action}</div> : null}
    </div>
  );
}

/** Phone kit — "Clear filters" text button, a 44px tap target. */
export function PhoneClearFilters({ onClick, className }: { onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('min-h-11 px-1 text-sm font-semibold text-primary-700', className)}
    >
      Clear filters
    </button>
  );
}

/**
 * Phone kit - the 44x44 square icon button for PhoneFilterBar's `trailing` slot
 * (the sort control, BACKLOG-3904). Same height, radius and active style as
 * FilterSelectButton; opens a BottomSheet.
 */
export interface PhoneSortButtonProps {
  /** Accessible name, e.g. "Sort: Newest first". */
  label: string;
  onClick: () => void;
  expanded?: boolean;
  /** A non-default option is selected: highlights the control. */
  active?: boolean;
  className?: string;
}

export function PhoneSortButton({ label, onClick, expanded = false, active = false, className }: PhoneSortButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-label={label}
      data-active={active ? 'true' : undefined}
      className={cn(
        'flex h-11 w-11 items-center justify-center rounded-md border focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
        active
          ? 'border-primary-600 bg-primary-50 text-primary-700'
          : 'border-gray-300 bg-white text-gray-500 [@media(hover:hover)]:hover:bg-gray-50',
        className
      )}
    >
      <ArrowUpDown className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}
