'use client';

/**
 * InlineStatusPicker -- Shared inline dropdown for changing item status.
 *
 * Used by both TaskTable and KanbanCard. Shows only valid status transitions
 * based on the ALLOWED_TRANSITIONS map.
 */

import { useState, useEffect, useRef } from 'react';
import { Check } from 'lucide-react';
import type { ItemStatus } from '@/lib/pm-types';
import {
  STATUS_LABELS,
  STATUS_COLORS,
  ALLOWED_TRANSITIONS,
} from '@/lib/pm-types';
import { updateItemStatus } from '@/lib/pm-queries';

interface InlineStatusPickerProps {
  itemId: string;
  status: ItemStatus;
  onUpdated: () => void;
}

export function InlineStatusPicker({
  itemId,
  status,
  onUpdated,
}: InlineStatusPickerProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const validTransitions = ALLOWED_TRANSITIONS[status] || [];

  async function handleSelect(newStatus: ItemStatus) {
    setOpen(false);
    setError(null);
    if (newStatus === status) return;
    try {
      await updateItemStatus(itemId, newStatus);
      onUpdated();
    } catch (err) {
      console.error('Failed to update status:', err);
      setError('Failed to update status');
    }
  }

  return (
    <div ref={ref} className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={(e) => {
          e.preventDefault();
          if (validTransitions.length > 0) setOpen(!open);
        }}
        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium cursor-pointer ${STATUS_COLORS[status]} ${
          validTransitions.length > 0 ? 'hover:ring-2 hover:ring-offset-1 hover:ring-gray-300' : ''
        }`}
        title={validTransitions.length === 0 ? 'No transitions available' : 'Click to change status'}
      >
        {STATUS_LABELS[status]}
      </button>
      {error && (
        <span className="absolute top-full left-0 mt-1 text-xs text-red-500 whitespace-nowrap">
          {error}
        </span>
      )}
      {open && validTransitions.length > 0 && (
        <div className="absolute left-0 top-full mt-1 bg-white border rounded-md shadow-lg z-20 py-1 w-36">
          {validTransitions.map((s) => (
            <button
              key={s}
              onClick={() => handleSelect(s)}
              className="w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 flex items-center gap-2"
            >
              <span
                className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[s]}`}
              >
                {STATUS_LABELS[s]}
              </span>
              {s === status && <Check className="h-3 w-3 text-primary-600" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
