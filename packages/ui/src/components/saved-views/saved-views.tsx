'use client';

import * as React from 'react';
import { Bookmark, ChevronDown, LogOut, Pin, PinOff, RefreshCw, Save, Share2, Star, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useClickOutside } from '../../lib/use-click-outside';
import type { SavedViewItem, SavedViewsProps } from './types';

/** A missing `access` is the user's own view (BACKLOG-4087). Gate on THIS, never on `access === 'viewer'`. */
export function isOwnView(view: SavedViewItem): boolean {
  return (view.access ?? 'owner') === 'owner';
}

/** Own rows first, then shared rows; the order inside each group is the adopter's. */
function ownFirst<V extends SavedViewItem>(views: V[]): V[] {
  const own = views.filter(isOwnView);
  return own.length === views.length ? views : [...own, ...views.filter((v) => !isOwnView(v))];
}

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
 * - Save rows: "Save current view". With `pinning` (BACKLOG-4132) a second
 *   row follows it, "Save current view as a card"; both are plain Tab stops
 *   in that order. The plain save never pins and is not capped; the card
 *   save shows the hint and `saveFields`, says "Save and pin", and is
 *   refused at the pin cap.
 * - Save form: Enter in the name field saves. An empty name shows
 *   "Give the view a name." and calls nothing. Cancel returns focus to the
 *   row that opened the form.
 * - Escape: the first Escape while the save form is open cancels the form;
 *   the next closes the panel and returns focus to the trigger. Escape is
 *   caught by a window keydown listener in CAPTURE phase that exists ONLY
 *   while the panel is open, so a closed SavedViews never swallows Escape
 *   meant for a parent (a kit Dialog, a page shortcut).
 * - A pointerdown outside closes WITHOUT moving focus, so the user's click
 *   target keeps it. Tabbing out of the panel closes it.
 *
 * Applied-view chip (BACKLOG-4121): with `onClear` set and `activeViewId`
 * matching a listed view, the trigger shows that view's name (truncated) in
 * the Dropdown filter-chip style, without the chevron, and its accessible
 * name is "Views: <name>". A sibling X button ("Clear view <name>") calls
 * `onClear`, leaves the panel closed and returns focus to the trigger.
 * Without `onClear`, the trigger is the plain "Views" button.
 *
 * Sharing (BACKLOG-4087): rows whose `access` is 'editor' or 'viewer' are
 * listed under a "Shared with you" heading after the user's own rows. They
 * carry no Default, Pin or Delete button, never count toward the pin badge,
 * and their accessible name is "<name> shared by <ownerName>" (the owner name
 * is truncated, with the full name in a title attribute). With `sharing`:
 * own rows get "Share <name>" when `onShare` is given (closes the panel, then
 * `onShare`; BACKLOG-4144: absent for a report viewer); editor rows
 * get "Update <name> with the current filters" (`onUpdate` with exactly the
 * filters and metric from `current()`); every shared row gets "Leave <name>",
 * which asks first in the panel (Cancel / Leave view) and calls `onLeave`
 * only on the confirm. Escape cancels an open Leave confirm before it closes
 * the panel. All of this is presentation: the server enforces access.
 * Without any `access` set, the panel renders exactly as before.
 */
type SaveMode = 'view' | 'card';

export function SavedViews<V extends SavedViewItem, F = unknown, M = unknown>({
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
  onClear,
  sharing,
}: SavedViewsProps<V, F, M>) {
  const [open, setOpen] = React.useState(false);
  /** Which save form is open: the plain view save, the card save (pinning only), or none. */
  const [saveMode, setSaveMode] = React.useState<SaveMode | null>(null);
  const saving = saveMode !== null;
  const [name, setName] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [rovingIndex, setRovingIndex] = React.useState(0);
  /** The shared view whose Leave confirm is showing, by id. */
  const [leaveId, setLeaveId] = React.useState<string | null>(null);

  const baseId = React.useId();
  const panelId = `${baseId}-panel`;
  const hintId = `${baseId}-hint`;
  const sharedHeadingId = `${baseId}-shared`;

  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const saveButtonRef = React.useRef<HTMLButtonElement>(null);
  const saveCardButtonRef = React.useRef<HTMLButtonElement>(null);
  const nameRef = React.useRef<HTMLInputElement>(null);
  const leaveCancelRef = React.useRef<HTMLButtonElement>(null);
  const rowRefs = React.useRef<(HTMLButtonElement | null)[]>([]);
  /** What to focus after the next render: a row index, the save button, or the name field. */
  const pendingFocus = React.useRef<number | 'save' | 'saveCard' | 'name' | 'leaveCancel' | null>(null);
  /** The row whose Delete was pressed, kept until the adopter's list no longer holds it (BACKLOG-4095). */
  const removedRow = React.useRef<{ id: string; index: number } | null>(null);

  const unavailable = views === null;
  const list = React.useMemo(() => ownFirst(views ?? []), [views]);
  const ownCount = list.filter(isOwnView).length;
  const showRows = !unavailable && !loading && list.length > 0;
  // Own rows only: a shared view's pin belongs to its owner (BACKLOG-4087).
  const pinnedCount = pinning ? list.filter((v) => isOwnView(v) && v.pinned).length : 0;
  const leaveView = leaveId === null ? null : (list.find((v) => v.id === leaveId && !isOwnView(v)) ?? null);
  // One slot, two sources. The local refusal is raised synchronously and is
  // the more specific of the two, so it wins over the store's.
  const message = error ?? writeError;
  // The hint and the extra fields describe a card when pinning is on, so they
  // belong to the card form only; without pinning the one form keeps them.
  const showCardDetails = !pinning || saveMode === 'card';
  const roving = Math.min(rovingIndex, Math.max(list.length - 1, 0));
  // The applied-view chip (BACKLOG-4121): only for an adopter that can clear,
  // and only while the page matches a listed view. Otherwise the plain
  // "Views" button, unchanged.
  const activeView = onClear ? (list.find((v) => v.id === activeViewId) ?? null) : null;

  React.useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    if (target === 'name') {
      nameRef.current?.focus();
    } else if (target === 'leaveCancel' && leaveCancelRef.current) {
      leaveCancelRef.current.focus();
    } else if (typeof target === 'number' && rowRefs.current[target]) {
      rowRefs.current[target]?.focus();
    } else if (target === 'saveCard' && saveCardButtonRef.current) {
      saveCardButtonRef.current.focus();
    } else if (saveButtonRef.current) {
      saveButtonRef.current.focus();
    } else {
      panelRef.current?.focus();
    }
  });

  // After a Delete (BACKLOG-4095): once the view leaves the list, focus the
  // row that took its place (the next one, or the previous one when the last
  // row went), else the trigger. While the view is still listed (a refused or
  // pending delete) nothing moves, so focus stays on that row's Delete.
  React.useEffect(() => {
    const removed = removedRow.current;
    if (removed === null || list.some((v) => v.id === removed.id)) return;
    removedRow.current = null;
    if (list.length === 0) {
      triggerRef.current?.focus();
      return;
    }
    const next = Math.min(removed.index, list.length - 1);
    setRovingIndex(next);
    rowRefs.current[next]?.focus();
  }, [list]);

  const close = React.useCallback((restoreFocus: boolean) => {
    removedRow.current = null;
    setOpen(false);
    setSaveMode(null);
    setName('');
    setError(null);
    setLeaveId(null);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const closeFromOutside = React.useCallback(() => close(false), [close]);
  useClickOutside(wrapperRef, closeFromOutside, open);

  function cancelForm() {
    pendingFocus.current = saveModeRef.current === 'card' ? 'saveCard' : 'save';
    setSaveMode(null);
    setName('');
    setError(null);
  }

  function openForm(mode: SaveMode) {
    setSaveMode(mode);
    setError(null);
    pendingFocus.current = 'name';
  }

  // Escape: window capture, only while open (see header comment).
  const savingRef = React.useRef(saving);
  savingRef.current = saving;
  const saveModeRef = React.useRef(saveMode);
  saveModeRef.current = saveMode;
  const leaveRef = React.useRef(leaveView);
  leaveRef.current = leaveView;
  const listRef = React.useRef(list);
  listRef.current = list;
  React.useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      if (leaveRef.current) cancelLeave();
      else if (savingRef.current) cancelForm();
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

  function askLeave(view: V) {
    setLeaveId(view.id);
    pendingFocus.current = 'leaveCancel';
  }

  function cancelLeave() {
    const index = listRef.current.findIndex((v) => v.id === leaveRef.current?.id);
    setLeaveId(null);
    pendingFocus.current = index >= 0 ? index : null;
  }

  function confirmLeave() {
    const view = leaveRef.current;
    setLeaveId(null);
    if (view && sharing) sharing.onLeave(view);
    panelRef.current?.focus();
  }

  function handleUpdate(view: V) {
    if (!sharing) return;
    const state = sharing.current();
    // Exactly two fields, picked by name: whatever else `current()` returns never reaches onUpdate.
    sharing.onUpdate(view, { filters: state.filters, metric: state.metric });
  }

  function handleShare(view: V) {
    if (!sharing?.onShare) return;
    // Close first: the panel's capture-phase Escape listener would otherwise eat the dialog's Escape.
    close(false);
    sharing.onShare(view);
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
    const asCard = saveMode === 'card';
    if (asCard && pinning && pinnedCount >= pinning.max) {
      setError(capMessage(pinning.max));
      return;
    }
    setError(null);
    // Without pinning the call is exactly as before 4132: onSave(name).
    if (pinning) onSave(trimmed, { pin: asCard });
    else onSave(trimmed);
    setName('');
    setSaveMode(null);
    pendingFocus.current = asCard ? 'saveCard' : 'save';
  }

  function renderRow(view: V, index: number) {
    const own = isOwnView(view);
    const isActive = view.id === activeViewId;
    // A shared row is never the user's default (the server masks it; the kit does not trust that).
    const isDefault = own && view.id === defaultViewId;
    const ownerLabel = view.ownerName && view.ownerName.length > 0 ? view.ownerName : 'another user';
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
          {own ? null : (
            <>
              <span className="sr-only">shared by </span>
              <span
                data-slot="saved-views-owner"
                title={ownerLabel}
                className="min-w-0 max-w-[7rem] flex-shrink truncate text-xs font-normal text-gray-500"
              >
                {ownerLabel}
              </span>
            </>
          )}
          {isDefault ? (
            <span
              data-slot="saved-views-default-marker"
              className="flex-shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-xs font-normal text-gray-600"
            >
              Default
            </span>
          ) : null}
        </button>
        {own ? (
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
        ) : null}
        {own && pinning ? (
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
        {own && sharing?.onShare ? (
          <button
            type="button"
            aria-label={`Share ${view.name}`}
            title={`Share ${view.name}`}
            onClick={() => handleShare(view)}
            className="p-1 text-gray-400 hover:text-primary-500"
          >
            <Share2 className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ) : null}
        {!own && sharing && view.access === 'editor' ? (
          <button
            type="button"
            aria-label={`Update ${view.name} with the current filters`}
            title={`Update ${view.name} with the current filters`}
            onClick={() => handleUpdate(view)}
            className="p-1 text-gray-400 hover:text-primary-500"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ) : null}
        {!own && sharing ? (
          <button
            type="button"
            aria-label={`Leave ${view.name}`}
            title={`Leave ${view.name}`}
            onClick={() => askLeave(view)}
            className="p-1 text-gray-400 hover:text-danger-600"
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ) : null}
        {own ? (
          <button
            type="button"
            aria-label={`Delete ${view.name}`}
            title={`Delete ${view.name}`}
            onClick={() => {
              removedRow.current = { id: view.id, index };
              onDelete(view);
            }}
            className="p-1 text-gray-400 hover:text-danger-600"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </li>
    );
  }

  function onWrapperBlur(e: React.FocusEvent<HTMLDivElement>) {
    if (!open) return;
    const next = e.relatedTarget as Node | null;
    if (next && wrapperRef.current && !wrapperRef.current.contains(next)) close(false);
  }

  return (
    <div ref={wrapperRef} data-slot="saved-views" className="relative" onBlur={onWrapperBlur}>
      <div className="relative inline-flex">
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => (open ? close(false) : openPanel('initial'))}
          onKeyDown={onTriggerKeyDown}
          className={
            activeView
              ? // The Dropdown filter chip, active state (dropdown.tsx filter trigger).
                'inline-flex items-center gap-1.5 rounded-md border border-primary-300 bg-primary-50 py-1.5 pl-3 pr-7 text-sm text-primary-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500'
              : 'inline-flex items-center gap-2 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-500'
          }
        >
          <Bookmark className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
          {activeView ? (
            <>
              <span className="sr-only">Views: </span>
              <span data-slot="saved-views-active-name" className="max-w-[12rem] truncate">
                {activeView.name}
              </span>
            </>
          ) : (
            'Views'
          )}
          {pinning && pinnedCount > 0 ? (
            <span
              data-slot="saved-views-badge"
              className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-primary-100 px-1 text-xs font-medium text-primary-700"
            >
              {pinnedCount}
            </span>
          ) : null}
          {activeView ? null : (
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} aria-hidden="true" />
          )}
        </button>
        {activeView && onClear ? (
          // A SIBLING of the trigger, never inside it: a button may not hold another button.
          <button
            type="button"
            data-slot="saved-views-clear"
            aria-label={`Clear view ${activeView.name}`}
            onClick={() => {
              close(false);
              onClear();
              triggerRef.current?.focus();
            }}
            className="absolute right-2 top-1/2 inline-flex -translate-y-1/2 items-center rounded p-0.5 text-primary-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </div>

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
            <>
              {ownCount > 0 ? (
                <ul aria-label="Saved views" className="max-h-56 overflow-y-auto py-1">
                  {list.slice(0, ownCount).map((view, i) => renderRow(view, i))}
                </ul>
              ) : null}
              {ownCount < list.length ? (
                <div data-slot="saved-views-shared-group" className="border-t border-gray-100">
                  <p id={sharedHeadingId} className="px-3 pt-2 text-xs font-medium uppercase text-gray-500">
                    Shared with you
                  </p>
                  <ul aria-labelledby={sharedHeadingId} className="max-h-40 overflow-y-auto py-1">
                    {list.slice(ownCount).map((view, i) => renderRow(view, ownCount + i))}
                  </ul>
                </div>
              ) : null}
            </>
          )}

          {leaveView ? (
            <div
              role="group"
              aria-label={`Leave ${leaveView.name}`}
              data-slot="saved-views-leave-confirm"
              className="mx-2 mb-2 rounded border border-gray-200 bg-gray-50 p-2 text-sm text-gray-700"
            >
              <p>Stop seeing {leaveView.name}? Its owner keeps it.</p>
              <div className="mt-2 flex justify-end gap-2">
                <button
                  ref={leaveCancelRef}
                  type="button"
                  onClick={cancelLeave}
                  className="rounded px-2 py-1 text-sm text-gray-500 hover:text-gray-700"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={confirmLeave}
                  className="rounded bg-danger-600 px-2 py-1 text-sm text-white hover:bg-danger-700"
                >
                  Leave view
                </button>
              </div>
            </div>
          ) : null}

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
                    aria-describedby={showCardDetails ? hintId : undefined}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleSave();
                      }
                    }}
                    placeholder={saveMode === 'card' ? 'Card name…' : 'View name…'}
                    className="w-full rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                  {showCardDetails ? (
                    <>
                      {saveFields}
                      <p id={hintId} className="px-0.5 text-xs text-gray-500">
                        {saveHint}
                      </p>
                    </>
                  ) : null}
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
                      {saveMode === 'card' ? 'Save and pin' : 'Save view'}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <button
                    ref={saveButtonRef}
                    type="button"
                    data-slot="saved-views-save"
                    onClick={() => openForm('view')}
                    className="flex w-full items-center gap-2 rounded px-3 py-2 text-sm text-primary-600 hover:bg-primary-50"
                  >
                    <Save className="h-4 w-4" aria-hidden="true" />
                    Save current view
                  </button>
                  {pinning ? (
                    <button
                      ref={saveCardButtonRef}
                      type="button"
                      data-slot="saved-views-save-card"
                      onClick={() => openForm('card')}
                      className="flex w-full items-center gap-2 rounded px-3 py-2 text-sm text-primary-600 hover:bg-primary-50"
                    >
                      <Save className="h-4 w-4" aria-hidden="true" />
                      Save current view as a card
                    </button>
                  ) : null}
                </>
              )}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
