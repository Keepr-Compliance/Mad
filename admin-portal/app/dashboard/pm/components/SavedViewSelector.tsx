'use client';

/**
 * SavedViewSelector - PM Backlog
 *
 * Dropdown for loading, saving, and deleting filter configurations.
 * Uses pm_list_saved_views, pm_save_view, pm_delete_saved_view RPCs.
 *
 * Supports "Pin as Gauge" — toggling displayAsGauge in the view's filters
 * JSONB so that the backlog page can render pinned views as stat cards.
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { Bookmark, X, Save, ChevronDown, Pin, PinOff } from 'lucide-react';
import { listSavedViews, saveView, deleteSavedView } from '@/lib/pm-queries';
import type { PmSavedView } from '@/lib/pm-types';

const MAX_GAUGES = 5;

interface SavedViewSelectorProps {
  currentFilters: Record<string, unknown>;
  onLoadView: (filters: Record<string, unknown>) => void;
  /** Called whenever the views list changes (load, save, delete, toggle gauge). */
  onViewsChanged?: (views: PmSavedView[]) => void;
}

export function SavedViewSelector({
  currentFilters,
  onLoadView,
  onViewsChanged,
}: SavedViewSelectorProps) {
  const [views, setViews] = useState<PmSavedView[]>([]);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newName, setNewName] = useState('');
  const [loading, setLoading] = useState(true);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close dropdown on click outside
  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const loadViews = useCallback(async () => {
    try {
      const data = await listSavedViews();
      setViews(data);
      onViewsChanged?.(data);
    } catch (err) {
      console.error('Failed to load saved views:', err);
    } finally {
      setLoading(false);
    }
  }, [onViewsChanged]);

  useEffect(() => {
    loadViews();
  }, [loadViews]);

  async function handleSave() {
    if (!newName.trim()) return;
    try {
      await saveView(newName.trim(), currentFilters);
      setNewName('');
      setSaving(false);
      await loadViews();
    } catch (err) {
      console.error('Failed to save view:', err);
    }
  }

  async function handleDelete(viewId: string, e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await deleteSavedView(viewId);
      await loadViews();
    } catch (err) {
      console.error('Failed to delete view:', err);
    }
  }

  function handleLoadView(view: PmSavedView) {
    // Strip displayAsGauge from filters before applying
    const { displayAsGauge: _, ...cleanFilters } = view.filters;
    onLoadView(cleanFilters);
    setOpen(false);
  }

  /**
   * Toggle "Pin as Gauge" for a saved view.
   * Since there is no update RPC, we delete + recreate with the updated filters.
   */
  async function handleToggleGauge(view: PmSavedView, e: React.MouseEvent) {
    e.stopPropagation();

    const currentlyPinned = !!view.filters.displayAsGauge;

    // Check gauge limit before pinning
    if (!currentlyPinned) {
      const pinnedCount = views.filter((v) => !!v.filters.displayAsGauge).length;
      if (pinnedCount >= MAX_GAUGES) {
        alert(`Maximum ${MAX_GAUGES} gauge cards allowed. Unpin an existing gauge first.`);
        return;
      }
    }

    setTogglingId(view.id);
    try {
      // Build updated filters
      const updatedFilters = { ...view.filters };
      if (currentlyPinned) {
        delete updatedFilters.displayAsGauge;
      } else {
        updatedFilters.displayAsGauge = true;
      }

      // Delete old view, then recreate with updated filters
      await deleteSavedView(view.id);
      await saveView(view.name, updatedFilters, view.is_shared);
      await loadViews();
    } catch (err) {
      console.error('Failed to toggle gauge:', err);
    } finally {
      setTogglingId(null);
    }
  }

  const pinnedCount = views.filter((v) => !!v.filters.displayAsGauge).length;

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-2 px-3 py-1.5 text-sm border border-gray-300 rounded-md bg-white text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-500"
      >
        <Bookmark className="h-4 w-4" />
        Saved Views
        {pinnedCount > 0 && (
          <span className="inline-flex items-center justify-center h-4 min-w-[1rem] px-1 text-xs font-medium bg-primary-100 text-primary-700 rounded-full">
            {pinnedCount}
          </span>
        )}
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute right-0 mt-1 w-72 bg-white rounded-lg border border-gray-200 shadow-lg z-20">
          <div className="p-2 border-b border-gray-100">
            <p className="text-xs font-medium text-gray-500 uppercase px-2 py-1">
              Saved Views
            </p>
          </div>

          {loading ? (
            <div className="p-4 text-center text-sm text-gray-400">Loading...</div>
          ) : views.length === 0 ? (
            <div className="p-4 text-center text-sm text-gray-400">No saved views yet</div>
          ) : (
            <ul className="max-h-48 overflow-y-auto py-1">
              {views.map((view) => {
                const isPinned = !!view.filters.displayAsGauge;
                const isToggling = togglingId === view.id;
                return (
                  <li key={view.id}>
                    <button
                      onClick={() => handleLoadView(view)}
                      className="w-full flex items-center justify-between px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                    >
                      <span className="truncate flex-1 text-left">{view.name}</span>
                      <div className="flex items-center gap-1 ml-2 shrink-0">
                        {view.is_shared && (
                          <span className="text-xs text-gray-400">shared</span>
                        )}
                        {view.is_own && (
                          <button
                            onClick={(e) => handleToggleGauge(view, e)}
                            disabled={isToggling}
                            className={`p-0.5 transition-colors ${
                              isPinned
                                ? 'text-primary-500 hover:text-primary-700'
                                : 'text-gray-400 hover:text-primary-500'
                            } ${isToggling ? 'opacity-50' : ''}`}
                            title={isPinned ? 'Unpin from gauges' : 'Pin as gauge card'}
                          >
                            {isPinned ? (
                              <PinOff className="h-3.5 w-3.5" />
                            ) : (
                              <Pin className="h-3.5 w-3.5" />
                            )}
                          </button>
                        )}
                        {view.is_own && (
                          <button
                            onClick={(e) => handleDelete(view.id, e)}
                            className="p-0.5 text-gray-400 hover:text-red-500"
                            title="Delete view"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="border-t border-gray-100 p-2">
            {saving ? (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSave();
                    if (e.key === 'Escape') setSaving(false);
                  }}
                  placeholder="View name..."
                  className="flex-1 text-sm border border-gray-300 rounded px-2 py-1 text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-primary-500"
                  autoFocus
                />
                <button
                  onClick={handleSave}
                  disabled={!newName.trim()}
                  className="p-1 text-primary-600 hover:text-primary-700 disabled:opacity-50"
                  title="Save"
                >
                  <Save className="h-4 w-4" />
                </button>
                <button
                  onClick={() => setSaving(false)}
                  className="p-1 text-gray-400 hover:text-gray-600"
                  title="Cancel"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <button
                onClick={() => setSaving(true)}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-primary-600 hover:bg-primary-50 rounded"
              >
                <Save className="h-4 w-4" />
                Save Current View
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
