'use client';

/**
 * InlinePriorityPicker -- Shared inline dropdown for changing item priority.
 *
 * Used by both TaskTable and KanbanCard. Shows all priority options.
 *
 * Two usage modes:
 *   1. "itemId" mode: pass itemId, the component calls updateItemField directly
 *   2. "callback" mode: pass onUpdate callback with the new priority value
 */

import { useState, useEffect, useRef } from 'react';
import { Check } from 'lucide-react';
import type { ItemPriority } from '@/lib/pm-types';
import { PRIORITY_LABELS, PRIORITY_COLORS } from '@/lib/pm-types';
import { updateItemField } from '@/lib/pm-queries';

interface InlinePriorityPickerWithIdProps {
  itemId: string;
  priority: ItemPriority;
  onUpdated: () => void;
  /** Style variant: 'pill' (table style) or 'compact' (card style) */
  variant?: 'pill' | 'compact';
}

interface InlinePriorityPickerWithCallbackProps {
  priority: ItemPriority;
  onUpdate: (p: ItemPriority) => void;
  /** Style variant: 'pill' (table style) or 'compact' (card style) */
  variant?: 'pill' | 'compact';
}

type InlinePriorityPickerProps =
  | InlinePriorityPickerWithIdProps
  | InlinePriorityPickerWithCallbackProps;

function isIdMode(props: InlinePriorityPickerProps): props is InlinePriorityPickerWithIdProps {
  return 'itemId' in props;
}

const ALL_PRIORITIES: ItemPriority[] = ['low', 'medium', 'high', 'critical'];

export function InlinePriorityPicker(props: InlinePriorityPickerProps) {
  const { priority, variant = 'pill' } = props;
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

  async function handleSelect(newPriority: ItemPriority) {
    setOpen(false);
    setError(null);
    if (newPriority === priority) return;
    if (isIdMode(props)) {
      try {
        await updateItemField(props.itemId, 'priority', newPriority);
        props.onUpdated();
      } catch (err) {
        console.error('Failed to update priority:', err);
        setError('Failed to update priority');
      }
    } else {
      props.onUpdate(newPriority);
    }
  }

  const buttonClass =
    variant === 'compact'
      ? `px-1.5 py-0.5 rounded text-xs font-medium ${PRIORITY_COLORS[priority]}`
      : `inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium cursor-pointer hover:ring-2 hover:ring-offset-1 hover:ring-gray-300 ${PRIORITY_COLORS[priority]}`;

  return (
    <div ref={ref} className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={(e) => {
          e.preventDefault();
          setOpen(!open);
        }}
        className={buttonClass}
      >
        {PRIORITY_LABELS[priority]}
      </button>
      {error && (
        <span className="absolute top-full left-0 mt-1 text-xs text-red-500 whitespace-nowrap">
          {error}
        </span>
      )}
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-white border rounded-md shadow-lg z-20 py-1 w-28">
          {ALL_PRIORITIES.map((p) => (
            <button
              key={p}
              onClick={() => handleSelect(p)}
              className={`w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 flex items-center justify-between ${
                p === priority ? 'bg-primary-50' : ''
              }`}
            >
              <span
                className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium ${PRIORITY_COLORS[p]}`}
              >
                {PRIORITY_LABELS[p]}
              </span>
              {p === priority && <Check className="h-3 w-3 text-primary-600" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
