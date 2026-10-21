'use client';

import * as React from 'react';
import { Filter, X } from 'lucide-react';
import { cn } from '../../lib/cn';

/**
 * Report kit — the desktop filter row and its caption (BACKLOG-3502a).
 *
 * `FilterBar` is only the shell: a "Filters" lead, the report's own controls
 * as children, a "Clear filters" button shown ONLY while something is
 * filtered, and an optional trailing slot (e.g. saved views) pushed right.
 *
 * `FilterCaption` is the one sentence under the bar that says what every
 * card, chart and row is following: "<lead>: <period> · <filter> · <filter>",
 * or "<lead>: <period> · no other filters". Which filters count as active
 * stays with each report.
 */
export interface FilterBarProps {
  children: React.ReactNode;
  hasFilters: boolean;
  onClear: () => void;
  /** Lead text. Default "Filters". */
  label?: string;
  /** Clear button text. Default "Clear filters". */
  clearLabel?: string;
  trailing?: React.ReactNode;
  className?: string;
}

export function FilterBar({
  children,
  hasFilters,
  onClear,
  label = 'Filters',
  clearLabel = 'Clear filters',
  trailing,
  className,
}: FilterBarProps) {
  return (
    <div data-slot="filter-bar" className={cn('flex flex-wrap items-center gap-3', className)}>
      <div className="flex items-center gap-1.5 text-gray-500">
        <Filter className="h-4 w-4" aria-hidden="true" />
        <span className="text-sm font-medium">{label}</span>
      </div>

      {children}

      {hasFilters ? (
        <button
          type="button"
          onClick={onClear}
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
          {clearLabel}
        </button>
      ) : null}

      {trailing ? <div className="ml-auto">{trailing}</div> : null}
    </div>
  );
}

export interface FilterCaptionProps {
  /** e.g. "Every card, chart and row below follows the filters". */
  lead: string;
  periodLabel: string;
  /** Human names of the active filters, in display order. */
  filterNames: readonly string[];
  /** Text when no filter is active. Default "no other filters". */
  emptyText?: string;
  className?: string;
}

/** The caption sentence, as a string (exported for reports that need the text). */
export function filterCaptionText({
  lead,
  periodLabel,
  filterNames,
  emptyText = 'no other filters',
}: Omit<FilterCaptionProps, 'className'>): string {
  const rest = filterNames.length > 0 ? filterNames.join(' · ') : emptyText;
  return `${lead}: ${periodLabel} · ${rest}`;
}

export function FilterCaption({ className, ...props }: FilterCaptionProps) {
  return (
    <p data-slot="filter-caption" className={cn('text-sm text-gray-500', className)}>
      {filterCaptionText(props)}
    </p>
  );
}
