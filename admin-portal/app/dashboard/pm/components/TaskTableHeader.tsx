'use client';

/**
 * TaskTableHeader -- Sortable column headers and read-only badge components
 * for the TaskTable.
 *
 * Contains:
 * - SortIcon: Directional sort indicator
 * - SortableHeader: Clickable sortable column header
 * - StatusBadge, PriorityBadge, TypeBadge: Read-only badge components
 * - formatDate: Date formatting helper
 */

import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';
import type { ItemStatus, ItemPriority, ItemType, SortableColumn, SortDirection } from '@/lib/pm-types';
import {
  STATUS_LABELS,
  STATUS_COLORS,
  PRIORITY_LABELS,
  PRIORITY_COLORS,
  TYPE_LABELS,
  TYPE_COLORS,
} from '@/lib/pm-types';

// ---------------------------------------------------------------------------
// Sort icons and headers
// ---------------------------------------------------------------------------

interface SortIconProps {
  column: SortableColumn;
  currentSort: SortableColumn | null | undefined;
  currentDir: SortDirection | undefined;
}

export function SortIcon({ column, currentSort, currentDir }: SortIconProps) {
  if (currentSort !== column) {
    return <ChevronsUpDown className="h-3.5 w-3.5 text-gray-400 ml-1" />;
  }
  if (currentDir === 'asc') {
    return <ChevronUp className="h-3.5 w-3.5 text-primary-600 ml-1" />;
  }
  return <ChevronDown className="h-3.5 w-3.5 text-primary-600 ml-1" />;
}

interface SortableHeaderProps {
  column: SortableColumn;
  label: string;
  sortBy: SortableColumn | null | undefined;
  sortDir: SortDirection | undefined;
  onSort?: (column: SortableColumn) => void;
}

export function SortableHeader({ column, label, sortBy, sortDir, onSort }: SortableHeaderProps) {
  const isActive = sortBy === column;

  return (
    <th
      className={`px-4 py-3 text-left text-xs font-medium uppercase tracking-wider cursor-pointer select-none hover:bg-gray-100 transition-colors ${
        isActive ? 'text-primary-600' : 'text-gray-500'
      }`}
      onClick={() => onSort?.(column)}
    >
      <div className="inline-flex items-center">
        {label}
        <SortIcon column={column} currentSort={sortBy} currentDir={sortDir} />
      </div>
    </th>
  );
}

// ---------------------------------------------------------------------------
// Read-only badges (kept for fallback when no onItemUpdated)
// ---------------------------------------------------------------------------

export function StatusBadge({ status }: { status: ItemStatus }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

export function PriorityBadge({ priority }: { priority: ItemPriority }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${PRIORITY_COLORS[priority]}`}
    >
      {PRIORITY_LABELS[priority]}
    </span>
  );
}

export function TypeBadge({ type }: { type: ItemType }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${TYPE_COLORS[type]}`}
    >
      {TYPE_LABELS[type]}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffHours < 1) return 'Just now';
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
