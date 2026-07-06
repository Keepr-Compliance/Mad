'use client';

/**
 * TaskDescription - PM Item Detail
 *
 * Displays the item's description (short text, click-to-edit) and body
 * (long preformatted text, read-only for v1).
 * On blur or Ctrl+Enter in edit mode, calls updateItemField to persist.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { Pencil } from 'lucide-react';
import { updateItemField } from '@/lib/pm-queries';

interface TaskDescriptionProps {
  itemId: string;
  description: string | null;
  body: string | null;
  onUpdate: () => void;
}

export function TaskDescription({ itemId, description, body, onUpdate }: TaskDescriptionProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(description || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Sync draft when description changes externally
  useEffect(() => {
    if (!editing) {
      setDraft(description || '');
    }
  }, [description, editing]);

  // Auto-focus textarea when entering edit mode
  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.selectionStart = textareaRef.current.value.length;
    }
  }, [editing]);

  const handleSave = useCallback(async () => {
    const trimmed = draft.trim();
    if (trimmed === (description || '').trim()) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateItemField(itemId, 'description', trimmed || null);
      setEditing(false);
      onUpdate();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update description');
    } finally {
      setSaving(false);
    }
  }, [draft, description, itemId, onUpdate]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        handleSave();
      }
      if (e.key === 'Escape') {
        setDraft(description || '');
        setEditing(false);
      }
    },
    [handleSave, description],
  );

  return (
    <div className="space-y-4">
      {/* Description (editable) */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-medium text-gray-700">Description</h3>
          {!editing && (
            <button
              onClick={() => setEditing(true)}
              className="inline-flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 transition-colors"
            >
              <Pencil className="h-3 w-3" />
              Edit
            </button>
          )}
        </div>

        {editing ? (
          <div>
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={handleSave}
              onKeyDown={handleKeyDown}
              rows={3}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-primary-500 resize-none"
              placeholder="Add a description..."
              disabled={saving}
            />
            {error && <div className="mt-1 text-xs text-red-600">{error}</div>}
            <div className="mt-1 text-xs text-gray-400">
              Ctrl+Enter to save, Escape to cancel
            </div>
          </div>
        ) : (
          <div
            onClick={() => setEditing(true)}
            className="text-sm text-gray-700 cursor-pointer hover:bg-gray-50 rounded-md px-3 py-2 min-h-[2rem] transition-colors"
          >
            {description || (
              <span className="text-gray-400 italic">No description</span>
            )}
          </div>
        )}
      </div>

      {/* Body (read-only preformatted) */}
      {body && (
        <div>
          <h3 className="text-sm font-medium text-gray-700 mb-1">Details</h3>
          <div className="text-sm text-gray-700 whitespace-pre-wrap bg-gray-50 rounded-md px-3 py-2 border border-gray-100">
            {body}
          </div>
        </div>
      )}
    </div>
  );
}
