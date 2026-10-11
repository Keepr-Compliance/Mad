'use client';

import * as React from 'react';
import { Search, SlidersHorizontal } from 'lucide-react';
import { cn } from '../../lib/cn';

/**
 * Phone kit — search field. `text-base` (16px) at every width so iOS Safari
 * does not zoom on focus; 44px tall; visually hidden label. Deliberately not
 * built on `Input` (which is `text-sm`).
 *
 * Consumers: BACKLOG-3898 (support queue), BACKLOG-3901 (plans).
 */
export interface SearchFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  id?: string;
  className?: string;
}

export function SearchField({ label, value, onChange, placeholder, id, className }: SearchFieldProps) {
  const autoId = React.useId();
  const inputId = id ?? autoId;
  return (
    <div className={cn('relative', className)}>
      <label htmlFor={inputId} className="sr-only">
        {label}
      </label>
      <Search
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
        aria-hidden="true"
      />
      <input
        id={inputId}
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="h-11 w-full rounded-md border border-gray-300 bg-white pl-9 pr-3 text-base text-gray-900 placeholder:text-gray-400 focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500"
      />
    </div>
  );
}

/**
 * Phone kit — filter button that opens a BottomSheet. Shows an active-filter
 * count badge (hidden at 0) and says the count in its accessible name.
 *
 * Consumer: BACKLOG-3898 (support queue).
 */
export interface FilterButtonProps {
  count: number;
  onClick: () => void;
  /** Whether the filter sheet is open. */
  expanded?: boolean;
  label?: string;
  className?: string;
}

export function FilterButton({ count, onClick, expanded = false, label = 'Filters', className }: FilterButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-label={count > 0 ? `${label}, ${count} active` : label}
      className={cn(
        'relative flex h-11 min-w-11 items-center justify-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 [@media(hover:hover)]:hover:bg-gray-50',
        className
      )}
    >
      <SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
      {count > 0 ? (
        <span
          data-slot="filter-count"
          aria-hidden="true"
          className="rounded-full bg-primary-600 px-1.5 text-xs font-medium text-white"
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}
