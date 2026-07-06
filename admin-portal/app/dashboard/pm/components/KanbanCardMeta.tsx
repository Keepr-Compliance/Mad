'use client';

/**
 * KanbanCardMeta -- Label picker and label display for Kanban cards.
 *
 * Contains:
 * - LABEL_COLORS: Preset color palette for new labels
 * - InlineLabelPicker: Dropdown for toggling/creating labels on a card
 */

import { useState, useRef, useCallback } from 'react';
import { Check, Plus, Loader2 } from 'lucide-react';
import type { PmLabel } from '@/lib/pm-types';
import { addItemLabel, removeItemLabel, createLabel } from '@/lib/pm-queries';
import { useClickOutside } from '@/hooks/useClickOutside';

/** Preset color palette for new labels. */
const LABEL_COLORS = [
  '#6366f1', // indigo
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#ef4444', // red
  '#f97316', // orange
  '#eab308', // yellow
  '#22c55e', // green
  '#14b8a6', // teal
  '#3b82f6', // blue
  '#6b7280', // gray
];

function pickRandomColor(): string {
  return LABEL_COLORS[Math.floor(Math.random() * LABEL_COLORS.length)];
}

interface InlineLabelPickerProps {
  itemId: string;
  currentLabels: PmLabel[];
  allLabels: PmLabel[];
  onUpdate: () => void;
}

export function InlineLabelPicker({
  itemId,
  currentLabels,
  allLabels,
  onUpdate,
}: InlineLabelPickerProps) {
  const [open, setOpen] = useState(false);
  const [updating, setUpdating] = useState<string | null>(null);
  const [newLabelName, setNewLabelName] = useState('');
  const [creating, setCreating] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useClickOutside(ref, close, open);

  const currentLabelIds = new Set(currentLabels.map((l) => l.id));

  async function handleToggleLabel(label: PmLabel) {
    setUpdating(label.id);
    try {
      if (currentLabelIds.has(label.id)) {
        await removeItemLabel(itemId, label.id);
      } else {
        await addItemLabel(itemId, label.id);
      }
      onUpdate();
    } catch (err) {
      console.error('Failed to toggle label:', err);
    } finally {
      setUpdating(null);
    }
  }

  async function handleCreateLabel() {
    const name = newLabelName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      const color = pickRandomColor();
      const { id: labelId } = await createLabel(name, color);
      await addItemLabel(itemId, labelId);
      setNewLabelName('');
      onUpdate();
    } catch (err) {
      console.error('Failed to create label:', err);
    } finally {
      setCreating(false);
    }
  }

  // Show max 2 labels, then overflow count
  const visibleLabels = currentLabels.slice(0, 2);
  const overflowCount = currentLabels.length - 2;

  return (
    <div ref={ref} className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={(e) => {
          e.preventDefault();
          setOpen(!open);
        }}
        className="flex items-center gap-1 flex-wrap"
      >
        {visibleLabels.length > 0 ? (
          <>
            {visibleLabels.map((label) => (
              <span
                key={label.id}
                className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium"
                style={{
                  backgroundColor: label.color + '20',
                  color: label.color,
                }}
              >
                {label.name}
              </span>
            ))}
            {overflowCount > 0 && (
              <span className="text-[10px] text-gray-400">
                +{overflowCount}
              </span>
            )}
          </>
        ) : (
          <span className="text-[10px] text-gray-400 flex items-center gap-0.5">
            <Plus className="h-3 w-3" />
            Label
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-white border rounded-md shadow-lg z-20 py-1 w-44 max-h-56 overflow-y-auto">
          {allLabels.length === 0 && newLabelName.trim() === '' ? (
            <p className="text-xs text-gray-400 px-3 py-2">No labels yet</p>
          ) : (
            allLabels.map((label) => (
              <button
                key={label.id}
                onClick={() => handleToggleLabel(label)}
                disabled={updating === label.id}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                <span
                  className="h-2.5 w-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: label.color }}
                />
                <span className="truncate flex-1 text-left">{label.name}</span>
                {currentLabelIds.has(label.id) && (
                  <Check className="h-3 w-3 text-primary-600 shrink-0" />
                )}
                {updating === label.id && (
                  <Loader2 className="h-3 w-3 animate-spin shrink-0" />
                )}
              </button>
            ))
          )}
          {/* Create new label input */}
          <div className="border-t mt-1 pt-1 px-2 pb-1">
            <div className="flex items-center gap-1">
              <input
                ref={inputRef}
                type="text"
                value={newLabelName}
                onChange={(e) => setNewLabelName(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleCreateLabel();
                  }
                }}
                onMouseDown={(e) => e.stopPropagation()}
                placeholder="New label..."
                className="flex-1 min-w-0 text-xs px-1.5 py-1 border rounded text-gray-900 bg-white placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-primary-400"
              />
              <button
                onClick={handleCreateLabel}
                disabled={!newLabelName.trim() || creating}
                className="text-xs px-1.5 py-1 rounded bg-primary-50 text-primary-600 hover:bg-primary-100 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-0.5 shrink-0"
              >
                {creating ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Plus className="h-3 w-3" />
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
