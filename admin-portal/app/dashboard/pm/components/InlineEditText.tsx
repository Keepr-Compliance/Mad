'use client';

/**
 * InlineEditText - Reusable click-to-edit component
 *
 * Click text to show an input (single line) or textarea (multiline).
 * Save on blur or Enter (single line) / Ctrl+Enter (multiline).
 * Cancel on Escape. Shows a subtle pencil icon on hover.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { Pencil, Loader2 } from 'lucide-react';

interface InlineEditTextProps {
  /** Current value to display */
  value: string | null;
  /** Placeholder when value is empty */
  placeholder?: string;
  /** Called with new value when user saves */
  onSave: (newValue: string | null) => Promise<void>;
  /** Use textarea for multiline editing */
  multiline?: boolean;
  /** CSS classes for the display text */
  displayClassName?: string;
  /** CSS classes for the input/textarea */
  inputClassName?: string;
  /** Number of rows for textarea (default 3) */
  rows?: number;
  /** Whether the field is currently editable */
  disabled?: boolean;
}

export function InlineEditText({
  value,
  placeholder = 'Click to edit...',
  onSave,
  multiline = false,
  displayClassName = 'text-sm text-gray-700',
  inputClassName = '',
  rows = 3,
  disabled = false,
}: InlineEditTextProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Sync draft when value changes externally
  useEffect(() => {
    if (!editing) {
      setDraft(value || '');
    }
  }, [value, editing]);

  // Auto-focus when entering edit mode
  useEffect(() => {
    if (editing) {
      const el = multiline ? textareaRef.current : inputRef.current;
      if (el) {
        el.focus();
        el.selectionStart = el.value.length;
        el.selectionEnd = el.value.length;
      }
    }
  }, [editing, multiline]);

  const handleSave = useCallback(async () => {
    // Guard: skip save if the browser tab is hidden (blur fired by tab switch,
    // not by the user intentionally leaving the field)
    if (document.hidden) return;

    const trimmed = draft.trim();
    const oldTrimmed = (value || '').trim();

    if (trimmed === oldTrimmed) {
      setEditing(false);
      setError(null);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onSave(trimmed || null);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, [draft, value, onSave]);

  const handleCancel = useCallback(() => {
    setDraft(value || '');
    setEditing(false);
    setError(null);
  }, [value]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleCancel();
        return;
      }
      if (multiline) {
        // Ctrl/Cmd+Enter to save for multiline
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          handleSave();
        }
      } else {
        // Enter to save for single line
        if (e.key === 'Enter') {
          e.preventDefault();
          handleSave();
        }
      }
    },
    [handleSave, handleCancel, multiline],
  );

  if (disabled) {
    return (
      <span className={displayClassName}>
        {value || <span className="text-gray-400 italic">{placeholder}</span>}
      </span>
    );
  }

  if (editing) {
    const baseInputClass =
      'w-full border border-gray-300 rounded-md px-3 py-1.5 text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-primary-500';

    return (
      <div className="inline-edit-active">
        {multiline ? (
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={handleSave}
            onKeyDown={handleKeyDown}
            rows={rows}
            className={`${baseInputClass} resize-none text-sm ${inputClassName}`}
            placeholder={placeholder}
            disabled={saving}
          />
        ) : (
          <input
            ref={inputRef}
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={handleSave}
            onKeyDown={handleKeyDown}
            className={`${baseInputClass} text-sm ${inputClassName}`}
            placeholder={placeholder}
            disabled={saving}
          />
        )}
        {saving && (
          <div className="flex items-center gap-1 mt-1 text-xs text-gray-400">
            <Loader2 className="h-3 w-3 animate-spin" />
            Saving...
          </div>
        )}
        {error && <div className="mt-1 text-xs text-red-600">{error}</div>}
        <div className="mt-1 text-xs text-gray-400">
          {multiline ? 'Ctrl+Enter to save' : 'Enter to save'}, Escape to cancel
        </div>
      </div>
    );
  }

  return (
    <span
      onClick={() => setEditing(true)}
      className={`group/inline-edit cursor-pointer inline-flex items-center gap-1.5 hover:bg-gray-50 rounded-md px-1 -mx-1 transition-colors ${displayClassName}`}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setEditing(true);
        }
      }}
    >
      {value || <span className="text-gray-400 italic">{placeholder}</span>}
      <Pencil className="h-3 w-3 text-gray-300 group-hover/inline-edit:text-gray-500 transition-colors shrink-0" />
    </span>
  );
}
