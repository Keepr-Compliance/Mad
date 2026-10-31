'use client';

import * as React from 'react';
import { Bookmark, ChevronDown, Pin, PinOff, Save, Star, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useClickOutside } from '../../lib/use-click-outside';
import type { SavedViewItem, SavedViewsProps } from './types';

/**
 * SavedViews (BACKLOG-4083): the report "Views" button and panel.
 *
 * Lists the user's saved views for one report, applies one, deletes one,
 * marks one as the default, and saves the current state under a name. It is
 * storage-agnostic: no network calls and no browser storage. The adopter owns
 * the store and the blob (filters plus the time range), so there is no period
 * prop; the adopter's `onApply` restores both.
 *
 * Inline popover, no portal (same model as Dropdown): a `relative` wrapper
 * and an `absolute z-50` panel under the trigger, right-aligned, `w-80`
 * capped at `calc(100vw - 2rem)` so it fits a 375px screen. The panel holds a
 * text field, so it is a non-modal dialog (aria-haspopup="dialog"), not a
 * listbox.
 *
 * Keyboard map (WAI-ARIA APG disclosure + non-modal dialog):
 * - Trigger: Enter, Space or ArrowDown opens and focuses the active view's
 *   row (else the first row, else "Save current view"); ArrowUp opens on the
 *   last row. A click opens the same way.
 * - Rows: one Tab stop (roving tabindex). ArrowDown / ArrowUp move one row
 *   and stop at the ends (no wrap); Home / End go to the first / last row.
 *   Enter or Space applies the row, closes, and returns focus to the trigger.
 * - Row actions (Default toggle, Pin, Delete) are native buttons reached by
 *   Tab after their row, each labelled with the view's name. The Delete KEY
 *   on a row is RESERVED (see types.ts).
 * - Save form: Enter in the name field saves. An empty name shows
 *   "Give the view a name." and calls nothing.
 * - Escape: the first Escape while the save form is open cancels the form;
 *   the next closes the panel and returns focus to the trigger. Escape is
 *   caught by a window keydown listener in CAPTURE phase that exists ONLY
 *   while the panel is open, so a closed SavedViews never swallows Escape
 *   meant for a parent (a kit Dialog, a page shortcut).
 * - A pointerdown outside closes WITHOUT moving focus, so the user's click
 *   target keeps it. Tabbing out of the panel closes it.
 */
export function SavedViews<V extends SavedViewItem>({
  views,
  loading,
  activeViewId,
  writeError,
  onApply,
  onDelete,
  onSave,
  saveHint,
  defaultViewId,
  onSetDefault,
  pinning,
  saveFields,
}: SavedViewsProps<V>) {
  const [open, setOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [name, setName] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [rovingIndex, setRovingIndex] = React.useState(0);

  const baseId = React.useId();
  const panelId = `${baseId}-panel`;
  const hintId = `${baseId}-hint`;

  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const saveButtonRef = React.useRef<HTMLButtonElement>(null);
  const nameRef = React.useRef<HTMLInputElement>(null);
  const rowRefs = React.useRef<(HTMLButtonElement | null)[]>([]);
  /** What to focus after the next render: a row index, the save button, or the name field. */
  const pendingFocus = React.useRef<number | 'save' | 'name' | null>(null);

  const unavailable = views === null;
  const list = views ?? [];
  const showRows = !unavailable && !loading && list.length > 0;
  const pinnedCount = pinning ? list.filter((v) => v.pinned).length : 0;
  // One slot, two sources. The local refusal is raised synchronously and is
  // the more specific of the two, so it wins over the store's.
  const message = error ?? writeError;
  const roving = Math.min(rovingIndex, Math.max(list.length - 1, 0));

  React.useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    if (target === 'name') {
      nameRef.current?.focus();
    } else if (typeof target === 'number' && rowRefs.current[target]) {
      rowRefs.current[target]?.focus();
    } else if (saveButtonRef.current) {
      saveButtonRef.current.focus();
    } else {
      panelRef.current?.focus();
    }
  });

  const close = React.useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setSaving(false);
    setName('');
    setError(null);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const closeFromOutside = React.useCallback(() => close(false), [close]);
  useClickOutside(wrapperRef, closeFromOutside, open);

  function cancelForm() {
    setSaving(false);
    setName('');
    setError(null);
    pendingFocus.current = 'save';
  }

  // Escape: window capture, only while open (see header comment).
  const savingRef = React.useRef(saving);
  savingRef.current = saving;
  React.useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      if (savingRef.current) cancelForm();
      else close(true);
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, close]);

  function openPanel(at: 'initial' | 'last') {
    const activeIndex = list.findIndex((v) => v.id === activeViewId);
    const index = at === 'last' ? list.length - 1 : activeIndex >= 0 ? activeIndex : 0;
    setRovingIndex(Math.max(index, 0));
    pendingFocus.current = showRows ? Math.max(index, 0) : 'save';
    setOpen(true);
  }

  function onTriggerKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (open) return;
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPanel('initial');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      openPanel('last');
    }
  }

  function moveTo(index: number) {
    setRovingIndex(index);
    rowRefs.current[index]?.focus();
  }

  function onRowKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = list.length - 1;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveTo(Math.min(index + 1, last));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveTo(Math.max(index - 1, 0));
    } else if (e.key === 'Home') {
      e.preventDefault();
      moveTo(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      moveTo(last);
    }
  }

  function capMessage(max: number) {
    return `At most ${max} pinned cards. Unpin one first.`;
  }

  function handleTogglePin(view: V) {
    if (!pinning) return;
    if (!view.pinned && pinnedCount >= pinning.max) {
      setError(capMessage(pinning.max));
      return;
    }
    setError(null);
    pinning.onTogglePin(view);
  }

  function handleSave() {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError('Give the view a name.');
      return;
    }
    if (pinning && pinnedCount >= pinning.max) {
      setError(capMessage(pinning.max));
      return;
    }
    setError(null);
    onSave(trimmed);
    setName('');
    setSaving(false);
    pendingFocus.current = 'save';
  }

  function onWrapperBlur(e: React.FocusEvent<HTMLDivElement>) {
    if (!open) return;
    const next = e.relatedTarget as Node | null;
    if (next && wrapperRef.current && !wrapperRef.current.contains(next)) close(false);
  }

  return (
    <div ref={wrapperRef} data-slot="saved-views" className="relative" onBlur={onWrapperBlur}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => (open ? close(false) : openPanel('initial'))}
        onKeyDown={onTriggerKeyDown}
        className="inline-flex items-center gap-2 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-500"
      >
        <Bookmark className="h-4 w-4" aria-hidden="true" />
        Views
        {pinning && pinnedCount > 0 ? (
          <span
            data-slot="saved-views-badge"
            className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-primary-100 px-1 text-xs font-medium text-primary-700"
          >
            {pinnedCount}
          </span>
        ) : null}
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} aria-hidden="true" />
      </button>

      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label="Saved views"
          tabIndex={-1}
          className="absolute right-0 z-50 mt-1 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-gray-200 bg-white shadow-lg focus:outline-none"
        >
          <div className="border-b border-gray-100 p-2">
            <p className="px-2 py-1 text-xs font-medium uppercase text-gray-500">Saved views</p>
          </div>

          {unavailable ? (
            <div className="p-4 text-center text-sm text-gray-500">Saved views are not available yet.</div>
          ) : loading ? (
            <div className="p-4 text-center text-sm text-gray-400">Loading…</div>
          ) : list.length === 0 ? (
            <div className="p-4 text-center text-sm text-gray-400">No saved views yet</div>
          ) : (
            <ul aria-label="Saved views" className="max-h-56 overflow-y-auto py-1">
              {list.map((view, index) => {
                const isActive = view.id === activeViewId;
                const isDefault = view.id === defaultViewId;
                return (
                  <li key={view.id} className="flex items-center gap-1 px-1">
                    <button
                      ref={(node) => {
                        rowRefs.current[index] = node;
                      }}
                      type="button"
                      data-slot="saved-views-row"
                      tabIndex={index === roving ? 0 : -1}
                      aria-pressed={isActive}
                      onFocus={() => setRovingIndex(index)}
                      onKeyDown={(e) => onRowKeyDown(e, index)}
                      onClick={() => {
                        onApply(view);
                        close(true);
                      }}
                      className={cn(
                        'flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-500',
                        isActive ? 'font-medium text-primary-700' : 'text-gray-700'
                      )}
                    >
                      <span className="truncate">{view.name}</span>
                      {isDefault ? (
                        <span
                          data-slot="saved-views-default-marker"
                          className="flex-shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-xs font-normal text-gray-600"
                        >
                          Default
                        </span>
                      ) : null}
                    </button>
                    <button
                      type="button"
                      aria-pressed={isDefault}
                      aria-label={isDefault ? `Stop opening ${view.name} by default` : `Make ${view.name} the default`}
                      title={isDefault ? `Stop opening ${view.name} by default` : `Make ${view.name} the default`}
                      onClick={() => onSetDefault(isDefault ? null : view)}
                      className={cn('p-1', isDefault ? 'text-primary-500 hover:text-primary-700' : 'text-gray-400 hover:text-primary-500')}
                    >
                      <Star className={cn('h-3.5 w-3.5', isDefault && 'fill-current')} aria-hidden="true" />
                    </button>
                    {pinning ? (
                      <button
                        type="button"
                        aria-label={view.pinned ? `Unpin ${view.name}` : `Pin ${view.name} as a card`}
                        title={view.pinned ? `Unpin ${view.name}` : `Pin ${view.name} as a card`}
                        onClick={() => handleTogglePin(view)}
                        className={cn('p-1', view.pinned ? 'text-primary-500 hover:text-primary-700' : 'text-gray-400 hover:text-primary-500')}
                      >
                        {view.pinned ? (
                          <PinOff className="h-3.5 w-3.5" aria-hidden="true" />
                        ) : (
                          <Pin className="h-3.5 w-3.5" aria-hidden="true" />
                        )}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      aria-label={`Delete ${view.name}`}
                      title={`Delete ${view.name}`}
                      onClick={() => onDelete(view)}
                      className="p-1 text-gray-400 hover:text-danger-600"
                    >
                      <X className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {message ? (
            <p role="status" className="px-3 pb-1 text-xs text-danger-600">
              {message}
            </p>
          ) : null}

          {unavailable ? null : (
            <div className="border-t border-gray-100 p-2">
              {saving ? (
                <div className="space-y-2">
                  <input
                    ref={nameRef}
                    type="text"
                    aria-label="View name"
                    aria-describedby={hintId}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleSave();
                      }
                    }}
                    placeholder={pinning ? 'Card name…' : 'View name…'}
                    className="w-full rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                  {saveFields}
                  <p id={hintId} className="px-0.5 text-xs text-gray-500">
                    {saveHint}
                  </p>
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={cancelForm}
                      className="rounded px-2 py-1 text-sm text-gray-500 hover:text-gray-700"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleSave}
                      className="inline-flex items-center gap-1 rounded bg-primary-600 px-2 py-1 text-sm text-white hover:bg-primary-700"
                    >
                      <Save className="h-3.5 w-3.5" aria-hidden="true" />
                      {pinning ? 'Save and pin' : 'Save view'}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  ref={saveButtonRef}
                  type="button"
                  onClick={() => {
                    setSaving(true);
                    setError(null);
                    pendingFocus.current = 'name';
                  }}
                  className="flex w-full items-center gap-2 rounded px-3 py-2 text-sm text-primary-600 hover:bg-primary-50"
                >
                  <Save className="h-4 w-4" aria-hidden="true" />
                  {pinning ? 'Save current view as a card' : 'Save current view'}
                </button>
              )}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
