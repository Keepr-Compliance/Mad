'use client';

import * as React from 'react';
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
  results?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}

export function PhoneFilterBar({ search, filters, results, children, className }: PhoneFilterBarProps) {
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
      <div className="mt-2 grid grid-cols-2 gap-2">
        <FilterSelectButton {...filters[0]} />
        <FilterSelectButton {...filters[1]} />
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
