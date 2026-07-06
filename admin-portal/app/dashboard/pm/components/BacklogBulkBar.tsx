'use client';

/**
 * BacklogBulkBar - Floating bulk action bar for the backlog table.
 *
 * Appears fixed at the bottom center when items are selected.
 * Provides bulk actions: Change Status, Change Priority, Assign Sprint,
 * Assign Project, Change Area, and Clear Selection.
 *
 * Pattern: Follows existing BulkActionBar (board) with expanded actions.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { X, ChevronUp, Loader2, UserX } from 'lucide-react';
import type { ItemStatus, ItemPriority, PmSprint, PmProject, AssignableUser } from '@/lib/pm-types';
import {
  STATUS_LABELS,
  STATUS_COLORS,
  PRIORITY_LABELS,
  PRIORITY_COLORS,
  SPRINT_STATUS_COLORS,
} from '@/lib/pm-types';
import { bulkUpdate, assignToSprint, assignItem, listSprints, listProjects, listAssignableUsers } from '@/lib/pm-queries';
import { useClickOutside } from '@/hooks/useClickOutside';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_OPTIONS: ItemStatus[] = [
  'pending',
  'in_progress',
  'testing',
  'completed',
  'blocked',
  'deferred',
];

const PRIORITY_OPTIONS: ItemPriority[] = ['low', 'medium', 'high', 'critical'];

const COMMON_AREAS = [
  'auth',
  'broker-portal',
  'desktop',
  'electron',
  'infrastructure',
  'onboarding',
  'pm-module',
  'support',
  'sync',
  'ui',
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DropdownType = 'status' | 'priority' | 'sprint' | 'project' | 'area' | 'assign' | null;

interface BacklogBulkBarProps {
  selectedIds: Set<string>;
  onClearSelection: () => void;
  onComplete: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BacklogBulkBar({
  selectedIds,
  onClearSelection,
  onComplete,
}: BacklogBulkBarProps) {
  const [openDropdown, setOpenDropdown] = useState<DropdownType>(null);
  const [loading, setLoading] = useState(false);
  const [sprints, setSprints] = useState<PmSprint[]>([]);
  const [projects, setProjects] = useState<PmProject[]>([]);
  const [customArea, setCustomArea] = useState('');
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [userSearch, setUserSearch] = useState('');
  const barRef = useRef<HTMLDivElement>(null);

  // -------------------------------------------------------------------------
  // Fetch sprints/projects when those dropdowns open
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (openDropdown === 'sprint' && sprints.length === 0) {
      listSprints()
        .then(setSprints)
        .catch((err) => console.error('Failed to load sprints:', err));
    }
  }, [openDropdown, sprints.length]);

  useEffect(() => {
    if (openDropdown === 'project' && projects.length === 0) {
      listProjects()
        .then(setProjects)
        .catch((err) => console.error('Failed to load projects:', err));
    }
  }, [openDropdown, projects.length]);

  useEffect(() => {
    if (openDropdown === 'assign' && users.length === 0) {
      listAssignableUsers()
        .then(setUsers)
        .catch((err) => console.error('Failed to load users:', err));
    }
    if (openDropdown !== 'assign') {
      setUserSearch('');
    }
  }, [openDropdown, users.length]);

  // -------------------------------------------------------------------------
  // Close dropdown on outside click
  // -------------------------------------------------------------------------

  const closeDropdown = useCallback(() => setOpenDropdown(null), []);
  useClickOutside(barRef, closeDropdown, openDropdown !== null);

  // -------------------------------------------------------------------------
  // Action handlers
  // -------------------------------------------------------------------------

  const ids = Array.from(selectedIds);

  const handleAction = useCallback(
    async (action: () => Promise<unknown>) => {
      setLoading(true);
      try {
        await action();
        setOpenDropdown(null);
        onComplete();
      } catch (err) {
        console.error('Bulk action failed:', err);
      } finally {
        setLoading(false);
      }
    },
    [onComplete]
  );

  const handleStatusChange = useCallback(
    (status: ItemStatus) => handleAction(() => bulkUpdate(ids, { status })),
    [ids, handleAction]
  );

  const handlePriorityChange = useCallback(
    (priority: ItemPriority) => handleAction(() => bulkUpdate(ids, { priority })),
    [ids, handleAction]
  );

  const handleSprintAssign = useCallback(
    (sprintId: string) => handleAction(() => assignToSprint(ids, sprintId)),
    [ids, handleAction]
  );

  const handleProjectAssign = useCallback(
    (projectId: string) => handleAction(() => bulkUpdate(ids, { project_id: projectId })),
    [ids, handleAction]
  );

  const handleAreaChange = useCallback(
    (area: string) => {
      if (!area.trim()) return;
      handleAction(() => bulkUpdate(ids, { area: area.trim() }));
      setCustomArea('');
    },
    [ids, handleAction]
  );

  const handleAssign = useCallback(
    (assigneeId: string | null) =>
      handleAction(() =>
        Promise.all(ids.map((id) => assignItem(id, assigneeId)))
      ),
    [ids, handleAction]
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (selectedIds.size === 0) return null;

  function toggleDropdown(type: DropdownType) {
    setOpenDropdown((prev) => (prev === type ? null : type));
  }

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50" ref={barRef}>
      <div className="flex items-center gap-3 bg-gray-900 text-white rounded-lg shadow-lg px-4 py-2.5">
        {/* Loading overlay */}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900/80 rounded-lg">
            <Loader2 className="h-5 w-5 animate-spin text-white" />
          </div>
        )}

        {/* Selected count */}
        <span className="text-sm font-medium whitespace-nowrap">
          {selectedIds.size} selected
        </span>

        <div className="w-px h-5 bg-gray-700" />

        {/* Status dropdown */}
        <div className="relative">
          <button
            onClick={() => toggleDropdown('status')}
            className="flex items-center gap-1 text-sm text-gray-300 hover:text-white transition-colors whitespace-nowrap"
          >
            <ChevronUp className="h-4 w-4" />
            Status
          </button>
          {openDropdown === 'status' && (
            <div className="absolute bottom-full left-0 mb-2 w-48 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden">
              {STATUS_OPTIONS.map((status) => (
                <button
                  key={status}
                  onClick={() => handleStatusChange(status)}
                  className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors flex items-center gap-2"
                >
                  <span
                    className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[status]}`}
                  >
                    {STATUS_LABELS[status]}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Priority dropdown */}
        <div className="relative">
          <button
            onClick={() => toggleDropdown('priority')}
            className="flex items-center gap-1 text-sm text-gray-300 hover:text-white transition-colors whitespace-nowrap"
          >
            <ChevronUp className="h-4 w-4" />
            Priority
          </button>
          {openDropdown === 'priority' && (
            <div className="absolute bottom-full left-0 mb-2 w-40 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden">
              {PRIORITY_OPTIONS.map((priority) => (
                <button
                  key={priority}
                  onClick={() => handlePriorityChange(priority)}
                  className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors flex items-center gap-2"
                >
                  <span
                    className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${PRIORITY_COLORS[priority]}`}
                  >
                    {PRIORITY_LABELS[priority]}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Sprint dropdown */}
        <div className="relative">
          <button
            onClick={() => toggleDropdown('sprint')}
            className="flex items-center gap-1 text-sm text-gray-300 hover:text-white transition-colors whitespace-nowrap"
          >
            <ChevronUp className="h-4 w-4" />
            Sprint
          </button>
          {openDropdown === 'sprint' && (
            <div className="absolute bottom-full left-0 mb-2 w-56 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden max-h-64 overflow-y-auto">
              {sprints.length === 0 ? (
                <div className="px-3 py-2 text-sm text-gray-400">Loading...</div>
              ) : (
                sprints.map((sprint) => (
                  <button
                    key={sprint.id}
                    onClick={() => handleSprintAssign(sprint.id)}
                    className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors flex items-center gap-2"
                  >
                    <span
                      className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${SPRINT_STATUS_COLORS[sprint.status]}`}
                    >
                      {sprint.status}
                    </span>
                    <span className="truncate">{sprint.name}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        {/* Project dropdown */}
        <div className="relative">
          <button
            onClick={() => toggleDropdown('project')}
            className="flex items-center gap-1 text-sm text-gray-300 hover:text-white transition-colors whitespace-nowrap"
          >
            <ChevronUp className="h-4 w-4" />
            Project
          </button>
          {openDropdown === 'project' && (
            <div className="absolute bottom-full left-0 mb-2 w-56 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden max-h-64 overflow-y-auto">
              {projects.length === 0 ? (
                <div className="px-3 py-2 text-sm text-gray-400">Loading...</div>
              ) : (
                projects.map((project) => (
                  <button
                    key={project.id}
                    onClick={() => handleProjectAssign(project.id)}
                    className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    <span className="truncate">{project.name}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        {/* Area dropdown */}
        <div className="relative">
          <button
            onClick={() => toggleDropdown('area')}
            className="flex items-center gap-1 text-sm text-gray-300 hover:text-white transition-colors whitespace-nowrap"
          >
            <ChevronUp className="h-4 w-4" />
            Area
          </button>
          {openDropdown === 'area' && (
            <div className="absolute bottom-full left-0 mb-2 w-56 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden max-h-64 overflow-y-auto">
              {/* Custom area input */}
              <div className="px-3 py-2 border-b border-gray-100">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleAreaChange(customArea);
                  }}
                >
                  <input
                    type="text"
                    value={customArea}
                    onChange={(e) => setCustomArea(e.target.value)}
                    placeholder="Type custom area..."
                    className="w-full px-2 py-1 text-sm text-gray-900 bg-white border border-gray-300 rounded focus:ring-primary-500 focus:border-primary-500"
                    autoFocus
                  />
                </form>
              </div>
              {/* Common areas list */}
              {COMMON_AREAS.map((area) => (
                <button
                  key={area}
                  onClick={() => handleAreaChange(area)}
                  className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  {area}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Assign dropdown */}
        <div className="relative">
          <button
            onClick={() => toggleDropdown('assign')}
            className="flex items-center gap-1 text-sm text-gray-300 hover:text-white transition-colors whitespace-nowrap"
          >
            <ChevronUp className="h-4 w-4" />
            Assign
          </button>
          {openDropdown === 'assign' && (
            <div className="absolute bottom-full right-0 mb-2 w-64 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden">
              {/* Search input */}
              <div className="px-3 py-2 border-b border-gray-100">
                <input
                  type="text"
                  value={userSearch}
                  onChange={(e) => setUserSearch(e.target.value)}
                  placeholder="Search by name or email..."
                  className="w-full px-2 py-1 text-sm text-gray-900 bg-white border border-gray-300 rounded focus:ring-primary-500 focus:border-primary-500"
                  autoFocus
                />
              </div>
              {/* Unassign option */}
              <button
                onClick={() => handleAssign(null)}
                className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors flex items-center gap-2 border-b border-gray-100"
              >
                <UserX className="h-4 w-4 text-gray-400" />
                <span>Unassign</span>
              </button>
              {/* User list */}
              <div className="max-h-48 overflow-y-auto">
                {users.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-gray-400">Loading...</div>
                ) : (
                  users
                    .filter((u) => {
                      if (!userSearch.trim()) return true;
                      const q = userSearch.toLowerCase();
                      return (
                        (u.display_name?.toLowerCase().includes(q) ?? false) ||
                        u.email.toLowerCase().includes(q)
                      );
                    })
                    .map((user) => (
                      <button
                        key={user.id}
                        onClick={() => handleAssign(user.id)}
                        className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                      >
                        <div className="truncate font-medium">
                          {user.display_name || user.email}
                        </div>
                        {user.display_name && (
                          <div className="truncate text-xs text-gray-400">
                            {user.email}
                          </div>
                        )}
                      </button>
                    ))
                )}
              </div>
            </div>
          )}
        </div>

        <div className="w-px h-5 bg-gray-700" />

        {/* Clear selection */}
        <button
          onClick={onClearSelection}
          className="p-1 text-gray-400 hover:text-white transition-colors"
          title="Clear selection"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
