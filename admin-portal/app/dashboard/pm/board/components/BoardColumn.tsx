'use client';

/**
 * BoardColumn -- Swim lane grid rendering and droppable cell components.
 *
 * Contains:
 * - SwimLaneCell: A single droppable cell in the swim lane grid
 * - SwimLaneGrid: The full swim lane grid view with header + rows (area/assignee)
 * - EpicLaneGrid: Project mode, one row per epic + "No epic" (BACKLOG-4176)
 * - groupItemsByDimension: Groups items by project/area/assignee
 */

import { useCallback, useMemo } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useDroppable } from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { KanbanCard } from '../../components/KanbanCard';
import { KanbanQuickAdd } from '../../components/KanbanQuickAdd';
import { COLUMN_ORDER } from '../../components/KanbanBoard';
import { buildSwimLaneCellId, NO_EPIC_KEY } from '../lib/swim-lane-ids';
import { groupColumnsByEpic, type EpicLane } from '../lib/epic-lanes';
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

/**
 * Column header pill. Pending gets its own white pill (BACKLOG-4176): the
 * shared STATUS_COLORS.pending is gray-100, the same as this header's
 * background, so the pill disappeared. Cards and other screens keep
 * STATUS_COLORS unchanged.
 */
export const PENDING_HEADER_PILL = 'bg-white text-gray-700 ring-1 ring-inset ring-gray-300';

export function headerPillClass(status: ItemStatus): string {
  return status === 'pending' ? PENDING_HEADER_PILL : STATUS_COLORS[status];
}

/** Sticky header row: row-label column + one pill per status column. */
function BoardHeaderRow({ label }: { label: string }) {
  return (
    <div className="flex gap-0 sticky top-0 z-10 border-b border-gray-300">
      <div className="w-[180px] min-w-[180px] bg-gray-100 px-3 py-2 sticky left-0 z-20">
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
          {label}
        </span>
      </div>
      {COLUMN_ORDER.map((status) => (
        <div key={status} className="min-w-[260px] flex-1 bg-gray-100 px-3 py-2">
          <span
            data-testid={`board-header-pill-${status}`}
            className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${headerPillClass(status)}`}
          >
            {STATUS_LABELS[status]}
          </span>
        </div>
      ))}
    </div>
  );
}

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
  quickAddLabel?: string;
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
  quickAddLabel,
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
      {onQuickAdd && <KanbanQuickAdd onAdd={onQuickAdd} label={quickAddLabel} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SwimLaneGrid -- Full swim lane grid with header row + swim lane rows
// ---------------------------------------------------------------------------

interface SwimLaneGridProps {
  columns: BoardColumns;
  swimLane: 'area' | 'assignee';
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
      <BoardHeaderRow label={swimLane === 'area' ? 'Area' : 'Assignee'} />

      {/* Swim lane rows */}
      {Array.from(swimLaneGroups.entries()).map(
        ([groupKey, groupColumns]) => {
          const itemCount = Object.values(groupColumns).reduce(
            (sum, items) => sum + (items as PmBacklogItem[]).length,
            0
          );
          const isCollapsed = collapsedLanes.has(groupKey);
          const displayName = nameMap.get(groupKey) || groupKey;
          return (
            <div key={groupKey} className="flex gap-0 border-b border-gray-200">
              {/* Row name column */}
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
                    <button
                      type="button"
                      onClick={() => onToggleLane(groupKey)}
                      className="text-sm font-semibold text-gray-700 text-left block truncate w-full"
                    >
                      {displayName}
                    </button>
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
    </div>
  );
}


// ---------------------------------------------------------------------------
// EpicLaneGrid -- Project mode: one row per epic, then "No epic" (BACKLOG-4176)
// ---------------------------------------------------------------------------

interface EpicLaneGridProps {
  columns: BoardColumns;
  collapsedLanes: Set<string>;
  onToggleLane: (laneKey: string) => void;
  selectedIds: Set<string>;
  onToggleSelect: (itemId: string) => void;
  onItemUpdated: () => void;
  onQuickAdd: (title: string, status: ItemStatus, groupKey?: string) => Promise<void>;
  onAddEpic: (title: string) => Promise<void>;
  users: AssignableUser[];
  allLabels: PmLabel[];
  compactCards: boolean;
}

function EpicLaneHeader({
  lane,
  itemCount,
  isCollapsed,
  onToggle,
}: {
  lane: EpicLane;
  itemCount: number;
  isCollapsed: boolean;
  onToggle: () => void;
}) {
  const epic = lane.epic;
  return (
    <div className="w-[180px] min-w-[180px] bg-gray-50 px-3 py-3 sticky left-0 z-10 border-r border-gray-200">
      <div className="flex items-start gap-1.5">
        <button
          type="button"
          onClick={onToggle}
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
          {lane.parentEpic && (
            <span className="text-[11px] text-gray-400 block truncate" title={lane.parentEpic.title}>
              ↳ {lane.parentEpic.title}
            </span>
          )}
          <button
            type="button"
            onClick={onToggle}
            title={epic ? epic.title : 'No epic'}
            className="text-sm font-semibold text-gray-700 text-left block w-full line-clamp-2"
          >
            {epic ? epic.title : 'No epic'}
          </button>
          {epic && (
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="text-xs text-gray-400 font-mono">#{epic.item_number}</span>
              <span
                className={`inline-flex items-center px-1.5 py-0 rounded text-[11px] font-medium ${STATUS_COLORS[epic.status]}`}
              >
                {STATUS_LABELS[epic.status]}
              </span>
            </div>
          )}
          <button
            type="button"
            onClick={onToggle}
            className="text-xs text-gray-400 text-left block w-full"
          >
            {itemCount} {itemCount === 1 ? 'item' : 'items'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function EpicLaneGrid({
  columns,
  collapsedLanes,
  onToggleLane,
  selectedIds,
  onToggleSelect,
  onItemUpdated,
  onQuickAdd,
  onAddEpic,
  users,
  allLabels,
  compactCards,
}: EpicLaneGridProps) {
  const lanes = useMemo(() => groupColumnsByEpic(columns), [columns]);

  return (
    <div className="min-w-fit">
      <BoardHeaderRow label="Epic" />

      {lanes.map((lane) => {
        const itemCount = Object.values(lane.columns).reduce(
          (sum, items) => sum + (items as PmBacklogItem[]).length,
          0
        );
        const isCollapsed = collapsedLanes.has(lane.key);
        return (
          <div
            key={lane.key}
            data-testid={`epic-lane-${lane.key === NO_EPIC_KEY ? 'none' : lane.key}`}
            className="flex gap-0 border-b border-gray-200"
          >
            <EpicLaneHeader
              lane={lane}
              itemCount={itemCount}
              isCollapsed={isCollapsed}
              onToggle={() => onToggleLane(lane.key)}
            />
            {isCollapsed ? (
              <div className="flex-1 bg-gray-50 px-3 py-3 flex items-center">
                <span className="text-xs text-gray-400 italic">Collapsed</span>
              </div>
            ) : (
              COLUMN_ORDER.map((status) => (
                <SwimLaneCell
                  key={status}
                  droppableId={buildSwimLaneCellId('epic', lane.key, status)}
                  items={(lane.columns[status] || []) as PmBacklogItem[]}
                  selectedIds={selectedIds}
                  onToggleSelect={onToggleSelect}
                  onItemUpdated={onItemUpdated}
                  onQuickAdd={(title) => onQuickAdd(title, status, lane.key)}
                  quickAddLabel="Add backlog"
                  users={users}
                  allLabels={allLabels}
                  compact={compactCards}
                />
              ))
            )}
          </div>
        );
      })}

      {/* Add epic: creates a new epic in this project, which becomes a row. */}
      <div className="flex gap-0 border-b border-dashed border-gray-300 bg-gray-50/60">
        <div className="w-[180px] min-w-[180px] px-3 py-2 sticky left-0 z-10 border-r border-dashed border-gray-300">
          <KanbanQuickAdd onAdd={onAddEpic} label="Add epic" />
        </div>
        <div className="flex-1" />
      </div>
    </div>
  );
}
