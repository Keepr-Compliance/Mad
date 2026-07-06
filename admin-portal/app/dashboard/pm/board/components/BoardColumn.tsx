'use client';

/**
 * BoardColumn -- Swim lane grid rendering and droppable cell components.
 *
 * Contains:
 * - SwimLaneCell: A single droppable cell in the swim lane grid
 * - SwimLaneGrid: The full swim lane grid view with header + rows
 * - groupItemsByDimension: Groups items by project/area/assignee
 */

import { useCallback, useMemo } from 'react';
import Link from 'next/link';
import { ArrowUpRight, ChevronDown, ChevronRight } from 'lucide-react';
import { useDroppable } from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { KanbanCard } from '../../components/KanbanCard';
import { KanbanQuickAdd } from '../../components/KanbanQuickAdd';
import { COLUMN_ORDER } from '../../components/KanbanBoard';
import {
  SWIM_LANE_NEW_PROJECT_ID,
  buildSwimLaneCellId,
} from '../lib/swim-lane-ids';
import type { PmBacklogItem, PmLabel, BoardColumns, ItemStatus } from '@/lib/pm-types';
import { STATUS_LABELS, STATUS_COLORS } from '@/lib/pm-types';
import type { AssignableUser } from '../../components/KanbanCard';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Group items by a dimension, returning Map<groupKey, BoardColumns>. */
export function groupItemsByDimension(
  columns: BoardColumns,
  dimension: 'project' | 'area' | 'assignee'
): Map<string, BoardColumns> {
  const groups = new Map<string, BoardColumns>();

  function ensureGroup(key: string): BoardColumns {
    if (!groups.has(key)) {
      groups.set(key, {
        pending: [],
        in_progress: [],
        testing: [],
        waiting_for_user: [],
        completed: [],
        blocked: [],
        deferred: [],
        obsolete: [],
        reopened: [],
      });
    }
    return groups.get(key)!;
  }

  for (const [status, items] of Object.entries(columns)) {
    for (const item of items as PmBacklogItem[]) {
      let groupKey: string;
      switch (dimension) {
        case 'project':
          groupKey = item.project_id || 'No Project';
          break;
        case 'area':
          groupKey = item.area || 'No Area';
          break;
        case 'assignee':
          groupKey = item.assignee_id || 'Unassigned';
          break;
      }
      const group = ensureGroup(groupKey);
      (group[status as keyof BoardColumns] as PmBacklogItem[]).push(item);
    }
  }

  return groups;
}

/** UUID v1-v5 matcher used to guard the project detail link. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// SwimLaneCell -- A single droppable cell in the swim lane grid
// ---------------------------------------------------------------------------

interface SwimLaneCellProps {
  droppableId: string;
  items: PmBacklogItem[];
  selectedIds?: Set<string>;
  onToggleSelect?: (itemId: string) => void;
  onItemUpdated?: () => void;
  onQuickAdd?: (title: string) => Promise<void>;
  users?: AssignableUser[];
  allLabels?: PmLabel[];
  compact?: boolean;
}

export function SwimLaneCell({
  droppableId,
  items,
  selectedIds,
  onToggleSelect,
  onItemUpdated,
  onQuickAdd,
  users,
  allLabels,
  compact,
}: SwimLaneCellProps) {
  const { setNodeRef, isOver } = useDroppable({ id: droppableId });
  return (
    <div
      ref={setNodeRef}
      className={`min-w-[260px] flex-1 bg-gray-50 px-2 py-2 min-h-[5rem] ${
        isOver ? 'ring-2 ring-primary-400 ring-inset bg-primary-50' : ''
      }`}
    >
      <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
        <div className="space-y-2">
          {items.map((item) => (
            <KanbanCard
              key={item.id}
              item={item}
              isSelected={selectedIds?.has(item.id)}
              compact={compact}
              onToggleSelect={
                onToggleSelect ? () => onToggleSelect(item.id) : undefined
              }
              onItemUpdated={onItemUpdated}
              users={users}
              allLabels={allLabels}
            />
          ))}
        </div>
      </SortableContext>
      {onQuickAdd && <KanbanQuickAdd onAdd={onQuickAdd} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SwimLaneGrid -- Full swim lane grid with header row + swim lane rows
// ---------------------------------------------------------------------------

interface SwimLaneGridProps {
  columns: BoardColumns;
  swimLane: 'project' | 'area' | 'assignee';
  nameMap: Map<string, string>;
  collapsedLanes: Set<string>;
  onToggleLane: (laneKey: string) => void;
  selectedIds: Set<string>;
  onToggleSelect: (itemId: string) => void;
  onItemUpdated: () => void;
  onQuickAdd: (title: string, status: ItemStatus, groupKey?: string) => Promise<void>;
  users: AssignableUser[];
  allLabels: PmLabel[];
  compactCards: boolean;
}

export function SwimLaneGrid({
  columns,
  swimLane,
  nameMap,
  collapsedLanes,
  onToggleLane,
  selectedIds,
  onToggleSelect,
  onItemUpdated,
  onQuickAdd,
  users,
  allLabels,
  compactCards,
}: SwimLaneGridProps) {
  const swimLaneGroups = useMemo(() => {
    const groups = groupItemsByDimension(columns, swimLane);
    // Sort by group name for stable order (push "No Project"/"Unassigned" to end)
    const sorted = new Map(
      Array.from(groups.entries()).sort(([a], [b]) => {
        const aIsDefault = a.startsWith('No ') || a === 'Unassigned';
        const bIsDefault = b.startsWith('No ') || b === 'Unassigned';
        if (aIsDefault && !bIsDefault) return 1;
        if (!aIsDefault && bIsDefault) return -1;
        return a.localeCompare(b);
      })
    );
    return sorted;
  }, [columns, swimLane]);

  const handleQuickAdd = useCallback(
    (title: string, status: ItemStatus, groupKey: string) => {
      return onQuickAdd(title, status, groupKey);
    },
    [onQuickAdd]
  );

  return (
    <div className="min-w-fit">
      {/* Sticky header row */}
      <div className="flex gap-0 sticky top-0 z-10 border-b border-gray-300">
        {/* Project column header */}
        <div className="w-[180px] min-w-[180px] bg-gray-100 px-3 py-2 sticky left-0 z-20">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
            {swimLane === 'project' ? 'Project' : swimLane === 'area' ? 'Area' : 'Assignee'}
          </span>
        </div>
        {COLUMN_ORDER.map((status) => (
          <div key={status} className="min-w-[260px] flex-1 bg-gray-100 px-3 py-2">
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[status]}`}
            >
              {STATUS_LABELS[status]}
            </span>
          </div>
        ))}
      </div>

      {/* Swim lane rows */}
      {Array.from(swimLaneGroups.entries()).map(
        ([groupKey, groupColumns]) => {
          const itemCount = Object.values(groupColumns).reduce(
            (sum, items) => sum + (items as PmBacklogItem[]).length,
            0
          );
          const isCollapsed = collapsedLanes.has(groupKey);
          const displayName = nameMap.get(groupKey) || groupKey;
          const isLinkableProject =
            swimLane === 'project' && UUID_RE.test(groupKey);
          return (
            <div key={groupKey} className="flex gap-0 border-b border-gray-200">
              {/* Project name column */}
              <div className="w-[180px] min-w-[180px] bg-gray-50 px-3 py-3 sticky left-0 z-10 border-r border-gray-200">
                <div className="flex items-start gap-1.5">
                  <button
                    type="button"
                    onClick={() => onToggleLane(groupKey)}
                    aria-label={isCollapsed ? 'Expand row' : 'Collapse row'}
                    className="flex-shrink-0 mt-0.5"
                  >
                    {isCollapsed ? (
                      <ChevronRight className="h-3.5 w-3.5 text-gray-400" />
                    ) : (
                      <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
                    )}
                  </button>
                  <div className="min-w-0 flex-1">
                    {isLinkableProject ? (
                      <div className="flex items-center gap-1 min-w-0">
                        <Link
                          href={`/dashboard/pm/projects/${groupKey}`}
                          title="Open project page"
                          className="text-sm font-semibold text-gray-700 hover:text-primary-600 hover:underline truncate"
                        >
                          {displayName}
                        </Link>
                        <Link
                          href={`/dashboard/pm/projects/${groupKey}`}
                          title="Open project page"
                          aria-label={`Open ${displayName}`}
                          className="text-gray-400 hover:text-primary-600 flex-shrink-0"
                        >
                          <ArrowUpRight className="h-3.5 w-3.5" />
                        </Link>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onToggleLane(groupKey)}
                        className="text-sm font-semibold text-gray-700 text-left block truncate w-full"
                      >
                        {displayName}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onToggleLane(groupKey)}
                      className="text-xs text-gray-400 text-left block w-full"
                    >
                      {itemCount} {itemCount === 1 ? 'item' : 'items'}
                    </button>
                  </div>
                </div>
              </div>
              {/* Status columns -- hidden when collapsed */}
              {isCollapsed ? (
                <div className="flex-1 bg-gray-50 px-3 py-3 flex items-center">
                  <span className="text-xs text-gray-400 italic">Collapsed</span>
                </div>
              ) : (
                COLUMN_ORDER.map((status) => {
                  const items = (groupColumns[status] || []) as PmBacklogItem[];
                  const droppableId = buildSwimLaneCellId(swimLane, groupKey, status);
                  return (
                    <SwimLaneCell
                      key={status}
                      droppableId={droppableId}
                      items={items}
                      selectedIds={selectedIds}
                      onToggleSelect={onToggleSelect}
                      onItemUpdated={onItemUpdated}
                      onQuickAdd={(title) => handleQuickAdd(title, status, groupKey)}
                      users={users}
                      allLabels={allLabels}
                      compact={compactCards}
                    />
                  );
                })
              )}
            </div>
          );
        }
      )}
      {swimLaneGroups.size === 0 && (
        <div className="flex flex-col items-center justify-center h-32 text-gray-400">
          <p className="text-sm">No items in this sprint</p>
        </div>
      )}
      {/* Ghost "new project" drop row — only in project swim-lane mode.
          Drop here to assign a backlog item whose project isn't yet represented. */}
      {swimLane === 'project' && <GhostNewProjectRow />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// GhostNewProjectRow -- Persistent "drop here to add a new project" drop target
// ---------------------------------------------------------------------------

function GhostNewProjectRow() {
  const { setNodeRef, isOver } = useDroppable({ id: SWIM_LANE_NEW_PROJECT_ID });
  return (
    <div
      ref={setNodeRef}
      className={`flex gap-0 border-b border-dashed ${
        isOver
          ? 'border-primary-400 bg-primary-50'
          : 'border-gray-300 bg-gray-50/60'
      }`}
    >
      <div
        className={`w-[180px] min-w-[180px] px-3 py-4 sticky left-0 z-10 border-r border-dashed ${
          isOver ? 'border-primary-400' : 'border-gray-300'
        }`}
      >
        <span
          className={`text-xs font-medium uppercase tracking-wide ${
            isOver ? 'text-primary-600' : 'text-gray-400'
          }`}
        >
          New project
        </span>
      </div>
      <div
        className={`flex-1 px-4 py-4 italic ${
          isOver ? 'text-primary-600' : 'text-gray-400'
        }`}
      >
        <span className="text-sm">
          Drop tasks here to add a new project to this sprint
        </span>
      </div>
    </div>
  );
}
