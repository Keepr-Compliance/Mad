'use client';

/**
 * Views dropdown for the iPhone Sync report (BACKLOG-3450)
 *
 * The `SavedViewSelector` PATTERN, not the component. That one is hardcoded to
 * the `pm_*` RPCs, to `PmSavedView`, and to a `displayAsGauge` flag hidden
 * inside `filters`; it also has no column-and-function picker, which this needs.
 * The markup, the count badge and the click-outside close are borrowed; the
 * data layer is this report's own.
 *
 * FAILS CLOSED. `views === null` means the list could not be read — which is
 * the normal state between this PR merging and the founder applying its
 * migration. The dropdown says so and renders no cards; every chart and row on
 * the page keeps working.
 */

import { useRef, useState } from 'react';
import { Bookmark, ChevronDown, Pin, PinOff, Save, X } from 'lucide-react';
import { useClickOutside } from '@/hooks/useClickOutside';
import {
  functionsFor,
  METRIC_COLUMNS,
  METRIC_FUNCTIONS,
  MAX_PINNED,
  type MetricColumn,
  type MetricFunction,
  type ReportSavedView,
  type ViewMetric,
} from '@/lib/reports/report-views';

const FIELD_CLASS =
  'text-sm border border-gray-300 rounded px-2 py-1 text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-primary-500';

export interface ReportViewSelectorProps {
  /** Null when the views could not be read — see the file header. */
  views: ReportSavedView[] | null;
  loading: boolean;
  /** Which view, if any, the page's current filters match. */
  activeViewId: string | null;
  /**
   * What the DATABASE said when it refused the last write, or null. REQUIRED,
   * not optional: a parent that forgets to wire it is a parent that swallows
   * the refusal again, and that must be a type error rather than a silence.
   */
  writeError: string | null;
  onApply: (view: ReportSavedView) => void;
  onTogglePin: (view: ReportSavedView) => void;
  onDelete: (view: ReportSavedView) => void;
  onSave: (name: string, metric: ViewMetric, pinned: boolean) => void;
}

export function ReportViewSelector({
  views,
  loading,
  activeViewId,
  writeError,
  onApply,
  onTogglePin,
  onDelete,
  onSave,
}: ReportViewSelectorProps) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [col, setCol] = useState<MetricColumn>('runs');
  const [fn, setFn] = useState<MetricFunction>('count');
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useClickOutside(containerRef, () => setOpen(false), open);

  const unavailable = views === null;
  // One slot, two sources. The local refusal is raised synchronously and is
  // always the more specific of the two, so it wins; the server's arrives later
  // and only when this tab never refused the write itself.
  const message = error ?? writeError;
  const list = views ?? [];
  const pinnedCount = list.filter((v) => v.pinned).length;
  const allowedFunctions = functionsFor(col);

  function chooseColumn(next: MetricColumn) {
    setCol(next);
    // `runs` offers count only, so a stale "average" would be unreachable.
    const allowed = functionsFor(next);
    if (!allowed.includes(fn)) setFn(allowed[0]);
  }

  function handleSave() {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError('Give the view a name.');
      return;
    }
    if (pinnedCount >= MAX_PINNED) {
      setError(`At most ${MAX_PINNED} pinned cards. Unpin one first.`);
      return;
    }
    setError(null);
    onSave(trimmed, { col, fn }, true);
    setName('');
    setSaving(false);
  }

  function handleTogglePin(view: ReportSavedView) {
    if (!view.pinned && pinnedCount >= MAX_PINNED) {
      setError(`At most ${MAX_PINNED} pinned cards. Unpin one first.`);
      return;
    }
    setError(null);
    onTogglePin(view);
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-2 px-3 py-1.5 text-sm border border-gray-300 rounded-md bg-white text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-500"
      >
        <Bookmark className="h-4 w-4" aria-hidden="true" />
        Views
        {pinnedCount > 0 ? (
          <span className="inline-flex items-center justify-center h-4 min-w-[1rem] px-1 text-xs font-medium bg-primary-100 text-primary-700 rounded-full">
            {pinnedCount}
          </span>
        ) : null}
        <ChevronDown
          className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>

      {open ? (
        <div className="absolute right-0 z-20 mt-1 w-80 rounded-lg border border-gray-200 bg-white shadow-lg">
          <div className="border-b border-gray-100 p-2">
            <p className="px-2 py-1 text-xs font-medium uppercase text-gray-500">Saved views</p>
          </div>

          {unavailable ? (
            <div className="p-4 text-center text-sm text-gray-500">
              Saved views are not available yet.
            </div>
          ) : loading ? (
            <div className="p-4 text-center text-sm text-gray-400">Loading…</div>
          ) : list.length === 0 ? (
            <div className="p-4 text-center text-sm text-gray-400">No saved views yet</div>
          ) : (
            <ul className="max-h-56 overflow-y-auto py-1">
              {list.map((view) => (
                <li key={view.id} className="flex items-center gap-1 px-1">
                  <button
                    type="button"
                    onClick={() => {
                      onApply(view);
                      setOpen(false);
                    }}
                    aria-pressed={view.id === activeViewId}
                    className={`flex-1 truncate rounded px-2 py-2 text-left text-sm hover:bg-gray-50 ${
                      view.id === activeViewId ? 'text-primary-700 font-medium' : 'text-gray-700'
                    }`}
                  >
                    {view.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleTogglePin(view)}
                    title={view.pinned ? `Unpin ${view.name}` : `Pin ${view.name} as a card`}
                    aria-label={view.pinned ? `Unpin ${view.name}` : `Pin ${view.name} as a card`}
                    className={`p-1 ${
                      view.pinned
                        ? 'text-primary-500 hover:text-primary-700'
                        : 'text-gray-400 hover:text-primary-500'
                    }`}
                  >
                    {view.pinned ? (
                      <PinOff className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : (
                      <Pin className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(view)}
                    title={`Delete ${view.name}`}
                    aria-label={`Delete ${view.name}`}
                    className="p-1 text-gray-400 hover:text-red-500"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {message ? (
            <p role="status" className="px-3 pb-1 text-xs text-red-600">
              {message}
            </p>
          ) : null}

          {unavailable ? null : (
            <div className="border-t border-gray-100 p-2">
              {saving ? (
                <div className="space-y-2">
                  <input
                    type="text"
                    aria-label="View name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Card name…"
                    className={`${FIELD_CLASS} w-full`}
                  />
                  <div className="flex gap-2">
                    <select
                      aria-label="Column"
                      value={col}
                      onChange={(e) => chooseColumn(e.target.value as MetricColumn)}
                      className={`${FIELD_CLASS} flex-1`}
                    >
                      {METRIC_COLUMNS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label="Function"
                      value={fn}
                      onChange={(e) => setFn(e.target.value as MetricFunction)}
                      className={`${FIELD_CLASS} flex-1`}
                    >
                      {METRIC_FUNCTIONS.filter((f) => allowedFunctions.includes(f.value)).map((f) => (
                        <option key={f.value} value={f.value}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <p className="px-0.5 text-xs text-gray-500">
                    Saves the Type, Outcome, Platform, search and Stalled filters you have now — not
                    the period. The card follows whichever period is selected.
                  </p>
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setSaving(false);
                        setError(null);
                        setName('');
                      }}
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
                      Save and pin
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setSaving(true);
                    setError(null);
                  }}
                  className="flex w-full items-center gap-2 rounded px-3 py-2 text-sm text-primary-600 hover:bg-primary-50"
                >
                  <Save className="h-4 w-4" aria-hidden="true" />
                  Save current view as a card
                </button>
              )}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
