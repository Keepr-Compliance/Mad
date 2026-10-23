'use client';

import * as React from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { cn } from '../../lib/cn';
import type { SortDirection } from './use-sort-state';

/**
 * Report kit — a sortable column header (BACKLOG-3502a).
 *
 * `aria-sort` lives on the `<th scope="col">` (where assistive tech reads it),
 * never on the inner button; a column that is not the active one reads
 * `none`. The button is the click target; the arrow icon is decoration.
 */
export interface SortableThProps<K extends string> {
  /** This column's key. */
  sortKey: K;
  /** The key the table is currently sorted by. */
  activeKey: K;
  direction: SortDirection;
  onSort: (key: K) => void;
  align?: 'left' | 'right';
  children: React.ReactNode;
  className?: string;
}

export function SortableTh<K extends string>({
  sortKey,
  activeKey,
  direction,
  onSort,
  align = 'left',
  children,
  className,
}: SortableThProps<K>) {
  const active = sortKey === activeKey;
  const Icon = !active ? ArrowUpDown : direction === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th
      data-slot="sortable-th"
      scope="col"
      aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={cn(
        'py-2 px-3 font-medium text-gray-500',
        align === 'right' ? 'text-right' : 'text-left',
        className
      )}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn('inline-flex items-center gap-1 hover:text-gray-900', active && 'text-gray-900')}
      >
        {children}
        <Icon className="h-3 w-3" aria-hidden="true" />
      </button>
    </th>
  );
}
