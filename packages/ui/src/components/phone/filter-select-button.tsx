'use client';

import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../lib/cn';

/**
 * Phone kit — two-line filter control: a small label over the current value
 * ("Status" / "Pending"), with a chevron. Opens a BottomSheet; several sit
 * side by side in a grid row. Its accessible name says both lines, so a
 * screen reader hears "Status: Pending" rather than an icon.
 *
 * Use `FilterButton` when one icon button stands for every filter; use this
 * when each filter needs its current value visible.
 *
 * Consumer: BACKLOG-3904 (broker submissions).
 * Forwards its ref to the button, so a BottomSheet can take it as `returnFocusRef`.
 */
export interface FilterSelectButtonProps {
  /** Top line, e.g. "Status". */
  label: string;
  /** Current value, e.g. "Pending" or "All agents". */
  value: string;
  onClick: () => void;
  /** Whether the sheet it opens is open. */
  expanded?: boolean;
  /** A non-default value is selected: highlights the control. */
  active?: boolean;
  className?: string;
}

export const FilterSelectButton = React.forwardRef<HTMLButtonElement, FilterSelectButtonProps>(function FilterSelectButton(
  { label, value, onClick, expanded = false, active = false, className },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-label={`${label}: ${value}`}
      data-active={active ? 'true' : undefined}
      className={cn(
        'flex min-h-11 w-full min-w-0 items-center justify-between gap-1.5 rounded-md border px-3 py-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
        active
          ? 'border-primary-600 bg-primary-50'
          : 'border-gray-300 bg-white [@media(hover:hover)]:hover:bg-gray-50',
        className
      )}
    >
      <span className="flex min-w-0 flex-col leading-tight" aria-hidden="true">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-600">{label}</span>
        <span className="truncate text-sm font-semibold text-gray-900">{value}</span>
      </span>
      <ChevronDown className="h-4 w-4 shrink-0 text-gray-500" aria-hidden="true" />
    </button>
  );
});
