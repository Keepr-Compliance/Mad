'use client';

/**
 * KanbanQuickAdd -- Inline "Add item" input at the bottom of a column.
 *
 * Shows an "Add item" button that expands to a title input + submit.
 * Calls the onAdd callback with the entered title on submit.
 */

import { useState } from 'react';
import { Plus, X } from 'lucide-react';

interface KanbanQuickAddProps {
  onAdd: (title: string) => Promise<void>;
  /** If provided, component renders in always-open mode (no toggle button). */
  onCancel?: () => void;
}

export function KanbanQuickAdd({ onAdd, onCancel }: KanbanQuickAddProps) {
  const [isOpen, setIsOpen] = useState(!!onCancel);
  const [title, setTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    const trimmed = title.trim();
    if (!trimmed) return;
    setSubmitting(true);
    try {
      await onAdd(trimmed);
      setTitle('');
      setIsOpen(false);
    } catch (err) {
      console.error('Failed to add item:', err);
    } finally {
      setSubmitting(false);
    }
  }

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="mt-2 flex items-center gap-1 text-sm text-gray-400 hover:text-gray-600 py-1 w-full"
      >
        <Plus className="h-4 w-4" />
        Add item
      </button>
    );
  }

  return (
    <div className="mt-2 bg-white rounded-lg border border-gray-200 p-2">
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleSubmit();
          if (e.key === 'Escape') {
            setIsOpen(false);
            setTitle('');
            onCancel?.();
          }
        }}
        placeholder="Enter title..."
        autoFocus
        className="w-full text-sm border-none focus:outline-none focus:ring-0 p-1 text-gray-900 bg-white placeholder-gray-400"
        disabled={submitting}
      />
      <div className="flex items-center gap-2 mt-1">
        <button
          onClick={handleSubmit}
          disabled={submitting || !title.trim()}
          className="px-2 py-1 text-xs font-medium text-white bg-primary-600 rounded hover:bg-primary-700 disabled:opacity-50"
        >
          Add
        </button>
        <button
          onClick={() => {
            setIsOpen(false);
            setTitle('');
            onCancel?.();
          }}
          className="p-1 text-gray-400 hover:text-gray-600"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
