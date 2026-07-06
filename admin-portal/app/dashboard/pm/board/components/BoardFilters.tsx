'use client';

/**
 * BoardFilters -- Header bar for the Kanban board page.
 *
 * Contains:
 * - Sprint selector dropdown (searchable)
 * - Swim lane toggle
 * - Compact card toggle
 * - Refresh button
 * - Backlog toggle button
 */

import { useState, useMemo } from 'react';
import { KanbanSquare, ChevronDown, RefreshCw, List } from 'lucide-react';
import { SwimLaneSelector, type SwimLaneMode } from '../../components/SwimLaneSelector';
import type { PmSprint } from '@/lib/pm-types';

interface BoardFiltersProps {
  sprints: PmSprint[];
  selectedSprintId: string;
  onSprintChange: (sprintId: string) => void;
  swimLane: SwimLaneMode;
  onSwimLaneChange: (mode: SwimLaneMode) => void;
  compactCards: boolean;
  onCompactToggle: () => void;
  refreshing: boolean;
  onRefresh: () => void;
  backlogOpen: boolean;
  onBacklogToggle: () => void;
}

export function BoardFilters({
  sprints,
  selectedSprintId,
  onSprintChange,
  swimLane,
  onSwimLaneChange,
  compactCards,
  onCompactToggle,
  refreshing,
  onRefresh,
  backlogOpen,
  onBacklogToggle,
}: BoardFiltersProps) {
  const [sprintDropdownOpen, setSprintDropdownOpen] = useState(false);
  const [sprintSearch, setSprintSearch] = useState('');

  const filteredSprints = useMemo(() => {
    if (!sprintSearch.trim()) return sprints;
    const q = sprintSearch.toLowerCase();
    return sprints.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.legacy_id && s.legacy_id.toLowerCase().includes(q))
    );
  }, [sprints, sprintSearch]);

  const selectedSprint = sprints.find((s) => s.id === selectedSprintId);

  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-white flex-shrink-0">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <KanbanSquare className="h-5 w-5 text-gray-400" />
          <h1 className="text-lg font-semibold text-gray-900">Board</h1>
        </div>

        {/* Sprint selector dropdown (searchable) */}
        <div className="relative">
          <button
            onClick={() => {
              setSprintDropdownOpen(!sprintDropdownOpen);
              if (sprintDropdownOpen) setSprintSearch('');
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-200 rounded-lg bg-white hover:bg-gray-50 transition-colors text-gray-900"
          >
            {selectedSprint
              ? `${selectedSprint.legacy_id ? `${selectedSprint.legacy_id} — ` : ''}${selectedSprint.name}`
              : 'Select Sprint'}
            <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
          </button>

          {sprintDropdownOpen && (
            <>
              {/* Backdrop to close dropdown */}
              <div
                className="fixed inset-0 z-10"
                onClick={() => {
                  setSprintDropdownOpen(false);
                  setSprintSearch('');
                }}
              />
              <div className="absolute top-full left-0 mt-1 w-72 bg-white border border-gray-200 rounded-lg shadow-lg z-20">
                {/* Search input */}
                <input
                  type="text"
                  value={sprintSearch}
                  onChange={(e) => setSprintSearch(e.target.value)}
                  placeholder="Search sprints..."
                  className="w-full px-3 py-2 border-b border-gray-200 text-sm text-gray-900 bg-white placeholder-gray-400 focus:outline-none rounded-t-lg"
                  autoFocus
                />
                {/* Sprint list */}
                <div className="max-h-60 overflow-y-auto">
                  {filteredSprints.length === 0 ? (
                    <div className="p-3 text-sm text-gray-400">
                      No sprints found
                    </div>
                  ) : (
                    filteredSprints.map((sprint) => (
                      <button
                        key={sprint.id}
                        onClick={() => {
                          onSprintChange(sprint.id);
                          setSprintDropdownOpen(false);
                          setSprintSearch('');
                        }}
                        className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 transition-colors ${
                          sprint.id === selectedSprintId
                            ? 'bg-primary-50 text-primary-700 font-medium'
                            : 'text-gray-700'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex flex-col min-w-0 mr-2">
                            <span className="truncate">{sprint.name}</span>
                            {sprint.legacy_id && (
                              <span className="text-xs text-gray-400">
                                {sprint.legacy_id}
                              </span>
                            )}
                          </div>
                          <span
                            className={`text-xs px-1.5 py-0.5 rounded flex-shrink-0 ${
                              sprint.status === 'active'
                                ? 'bg-green-100 text-green-700'
                                : sprint.status === 'planned'
                                  ? 'bg-gray-100 text-gray-600'
                                  : sprint.status === 'completed'
                                    ? 'bg-blue-100 text-blue-600'
                                    : 'bg-red-100 text-red-600'
                            }`}
                          >
                            {sprint.status}
                          </span>
                        </div>
                        {sprint.total_items != null && (
                          <span className="text-xs text-gray-400">
                            {sprint.total_items} items
                          </span>
                        )}
                      </button>
                    ))
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Swim lane toggle */}
        <SwimLaneSelector
          value={swimLane}
          onChange={onSwimLaneChange}
        />

        {/* Compact card toggle */}
        <button
          onClick={onCompactToggle}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-sm border rounded-lg transition-colors ${
            compactCards
              ? 'bg-primary-50 border-primary-200 text-primary-700'
              : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
          }`}
        >
          <List className="h-3.5 w-3.5" />
          Compact
        </button>
      </div>

      {/* Right side: refresh + backlog toggle */}
      <div className="flex items-center gap-2">
        <button
          onClick={onRefresh}
          disabled={refreshing}
          className="p-1.5 text-gray-400 hover:text-gray-600 transition-colors disabled:opacity-50"
          title="Refresh board"
        >
          <RefreshCw
            className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`}
          />
        </button>
        <button
          onClick={onBacklogToggle}
          className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
            backlogOpen
              ? 'bg-primary-50 border-primary-200 text-primary-700'
              : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
          }`}
        >
          Backlog
        </button>
      </div>
    </div>
  );
}
