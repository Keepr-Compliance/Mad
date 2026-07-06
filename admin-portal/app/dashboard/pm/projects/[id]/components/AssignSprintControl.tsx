'use client';

/**
 * AssignSprintControl (BACKLOG-1664)
 *
 * Modal picker used by the project detail page to assign N selected backlog
 * items to a sprint — or create a new standalone sprint and auto-assign
 * the same items into it.
 *
 * Parity notes:
 * - Search UX mirrors the searchable sprint dropdown in
 *   `admin-portal/app/dashboard/pm/board/components/BoardFilters.tsx`.
 * - Sprint creation defers to the global `CreateSprintDialog` (which already
 *   creates sprints with `project_id=null` — see BACKLOG-1664 product decision
 *   to deprecate `pm_sprints.project_id`).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Search, Plus } from 'lucide-react';
import { assignToSprint, listSprints } from '@/lib/pm-queries';
import type { PmSprint } from '@/lib/pm-types';
import {
  SPRINT_STATUS_LABELS,
  SPRINT_STATUS_COLORS,
} from '@/lib/pm-types';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { CreateSprintDialog } from '../../../components/CreateSprintDialog';

interface AssignSprintControlProps {
  open: boolean;
  onClose: () => void;
  /** Items to assign when the user picks a sprint. */
  itemIds: string[];
  /**
   * Called after a successful assignment (existing sprint) OR after a
   * successful create + auto-assign flow. The caller is expected to refresh
   * its view and clear the selection.
   */
  onAssigned: () => void;
}

export function AssignSprintControl({
  open,
  onClose,
  itemIds,
  onAssigned,
}: AssignSprintControlProps) {
  const [sprints, setSprints] = useState<PmSprint[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  // a11y: keep keyboard focus inside the modal while it's open. Disable the
  // trap whenever a nested dialog (CreateSprintDialog) is showing so the
  // child modal can manage its own focus.
  useFocusTrap(dialogRef, open && !createOpen);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    listSprints()
      .then((data) => setSprints(Array.isArray(data) ? data : []))
      .catch((err) => {
        console.error('Failed to load sprints:', err);
        setError('Failed to load sprints');
      })
      .finally(() => setLoading(false));
  }, [open]);

  const filtered = useMemo(() => {
    if (!search.trim()) return sprints;
    const q = search.toLowerCase();
    return sprints.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.legacy_id && s.legacy_id.toLowerCase().includes(q))
    );
  }, [sprints, search]);

  async function handleAssign(sprintId: string) {
    if (itemIds.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      await assignToSprint(itemIds, sprintId);
      onAssigned();
      onClose();
    } catch (err) {
      console.error('Failed to assign items to sprint:', err);
      setError(err instanceof Error ? err.message : 'Failed to assign');
    } finally {
      setSubmitting(false);
    }
  }

  // After a new sprint is created via the dialog, the onCreated callback
  // fires with the new sprint's id (BACKLOG-1668). Previously we had to
  // re-fetch the list and diff to find the new row, which raced with
  // concurrent creates; now we use the id directly and refresh the local
  // list so the UI reflects the new sprint if the user cancels out.
  async function handleAfterCreate(newSprintId: string) {
    if (itemIds.length > 0) {
      await handleAssign(newSprintId);
      return;
    }
    // No items to assign — just refresh the list so the new sprint shows up.
    try {
      const fresh = await listSprints();
      setSprints(Array.isArray(fresh) ? fresh : []);
    } catch (err) {
      console.error('Failed to refresh sprints after create:', err);
    }
    onAssigned();
  }

  if (!open) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center"
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
      >
        {/* Backdrop */}
        <div className="fixed inset-0 bg-black/50" onClick={onClose} />

        {/* Dialog */}
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Assign to Sprint"
          className="relative bg-white rounded-lg shadow-xl w-full max-w-md mx-4 max-h-[80vh] flex flex-col"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
            <div>
              <h2 className="text-base font-semibold text-gray-900">
                Assign to Sprint
              </h2>
              <p className="text-xs text-gray-500 mt-0.5">
                {itemIds.length} {itemIds.length === 1 ? 'task' : 'tasks'} selected
              </p>
            </div>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Search */}
          <div className="px-5 py-3 border-b border-gray-100">
            <div className="relative">
              <Search className="absolute left-2.5 top-2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search sprints..."
                className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-300 rounded-md text-gray-900 bg-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
                // Initial focus target for the focus trap; mirrors the
                // previous autoFocus behavior while letting useFocusTrap own
                // the focus lifecycle.
                data-autofocus
              />
            </div>
          </div>

          {/* Sprint list */}
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <p className="px-5 py-6 text-sm text-gray-400 text-center">
                Loading sprints...
              </p>
            ) : filtered.length === 0 ? (
              <p className="px-5 py-6 text-sm text-gray-400 text-center">
                {search ? 'No sprints match your search.' : 'No sprints available.'}
              </p>
            ) : (
              <ul className="divide-y divide-gray-100">
                {filtered.map((sprint) => (
                  <li key={sprint.id}>
                    <button
                      type="button"
                      disabled={submitting}
                      onClick={() => handleAssign(sprint.id)}
                      className="w-full text-left px-5 py-2.5 hover:bg-gray-50 focus:bg-gray-50 focus:outline-none transition-colors disabled:opacity-50"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex flex-col min-w-0">
                          <span className="text-sm font-medium text-gray-900 truncate">
                            {sprint.name}
                          </span>
                          {sprint.legacy_id && (
                            <span className="text-xs text-gray-400 truncate">
                              {sprint.legacy_id}
                            </span>
                          )}
                        </div>
                        <span
                          className={`text-xs px-1.5 py-0.5 rounded flex-shrink-0 ${SPRINT_STATUS_COLORS[sprint.status]}`}
                        >
                          {SPRINT_STATUS_LABELS[sprint.status]}
                        </span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {error && (
            <div className="px-5 py-2 border-t border-red-100 bg-red-50">
              <p className="text-xs text-red-700">{error}</p>
            </div>
          )}

          {/* Footer: "New sprint" action */}
          <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-gray-200 bg-gray-50 rounded-b-lg">
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-primary-700 bg-white border border-primary-200 rounded-md hover:bg-primary-50 transition-colors"
            >
              <Plus className="h-4 w-4" />
              New sprint
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>

      {/* Nested CreateSprintDialog -- creates a standalone sprint and
          auto-assigns the currently selected items to it. */}
      <CreateSprintDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={handleAfterCreate}
      />
    </>
  );
}
