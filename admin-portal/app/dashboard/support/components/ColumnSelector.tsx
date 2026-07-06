'use client';

/**
 * ColumnSelector - Support Dashboard
 *
 * Dropdown popover with checkboxes for toggling column visibility
 * in the ticket table. Enforces a minimum of 2 visible columns.
 */

import { useRef, useState, useCallback } from 'react';
import { Columns3 } from 'lucide-react';
import { useClickOutside } from '@/hooks/useClickOutside';

export type ColumnKey =
  | 'ticket_number'
  | 'subject'
  | 'status'
  | 'priority'
  | 'category'
  | 'requester'
  | 'created_at'
  | 'assignee'
  | 'description';

export const ALL_COLUMNS: { key: ColumnKey; label: string }[] = [
  { key: 'ticket_number', label: 'Ticket #' },
  { key: 'subject', label: 'Subject' },
  { key: 'status', label: 'Status' },
  { key: 'priority', label: 'Priority' },
  { key: 'category', label: 'Category' },
  { key: 'requester', label: 'Requester' },
  { key: 'created_at', label: 'Created' },
  { key: 'assignee', label: 'Assignee' },
  { key: 'description', label: 'Description' },
];

export const DEFAULT_VISIBLE_COLUMNS: ColumnKey[] = [
  'ticket_number',
  'subject',
  'status',
  'priority',
  'requester',
  'created_at',
];

const MIN_VISIBLE = 2;
const STORAGE_KEY = 'support-ticket-columns';

export function loadColumnPreferences(): ColumnKey[] {
  if (typeof window === 'undefined') return DEFAULT_VISIBLE_COLUMNS;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return DEFAULT_VISIBLE_COLUMNS;
    const parsed = JSON.parse(stored) as ColumnKey[];
    if (!Array.isArray(parsed) || parsed.length < MIN_VISIBLE) return DEFAULT_VISIBLE_COLUMNS;
    // Validate that all stored keys are valid
    const validKeys = new Set<string>(ALL_COLUMNS.map((c) => c.key));
    const filtered = parsed.filter((k) => validKeys.has(k));
    return filtered.length >= MIN_VISIBLE ? filtered : DEFAULT_VISIBLE_COLUMNS;
  } catch {
    return DEFAULT_VISIBLE_COLUMNS;
  }
}

export function saveColumnPreferences(columns: ColumnKey[]): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(columns));
}

interface ColumnSelectorProps {
  visibleColumns: ColumnKey[];
  onColumnsChange: (columns: ColumnKey[]) => void;
}

export function ColumnSelector({ visibleColumns, onColumnsChange }: ColumnSelectorProps) {
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useClickOutside(dropdownRef, () => setOpen(false), open);

  const handleToggle = useCallback(
    (key: ColumnKey) => {
      const isVisible = visibleColumns.includes(key);
      if (isVisible) {
        // Don't allow fewer than MIN_VISIBLE columns
        if (visibleColumns.length <= MIN_VISIBLE) return;
        const next = visibleColumns.filter((k) => k !== key);
        onColumnsChange(next);
      } else {
        // Add column, preserving canonical order
        const allKeys = ALL_COLUMNS.map((c) => c.key);
        const next = allKeys.filter((k) => visibleColumns.includes(k) || k === key);
        onColumnsChange(next);
      }
    },
    [visibleColumns, onColumnsChange]
  );

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setOpen((prev) => !prev)}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
        title="Toggle columns"
      >
        <Columns3 className="h-4 w-4" />
        Columns
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-52 bg-white border border-gray-200 rounded-lg shadow-lg py-1">
          <div className="px-3 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wider border-b border-gray-100">
            Toggle Columns
          </div>
          {ALL_COLUMNS.map((col) => {
            const isVisible = visibleColumns.includes(col.key);
            const isDisabled = isVisible && visibleColumns.length <= MIN_VISIBLE;
            return (
              <label
                key={col.key}
                className={`flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-gray-50 ${
                  isDisabled ? 'opacity-50 cursor-not-allowed' : ''
                }`}
              >
                <input
                  type="checkbox"
                  checked={isVisible}
                  disabled={isDisabled}
                  onChange={() => handleToggle(col.key)}
                  className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                />
                <span className="text-gray-700">{col.label}</span>
              </label>
            );
          })}
          {visibleColumns.length <= MIN_VISIBLE && (
            <div className="px-3 py-1.5 text-xs text-gray-400 border-t border-gray-100">
              Minimum {MIN_VISIBLE} columns required
            </div>
          )}
        </div>
      )}
    </div>
  );
}
