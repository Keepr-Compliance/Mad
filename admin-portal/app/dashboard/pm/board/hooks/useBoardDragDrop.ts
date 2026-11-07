'use client';

/**
 * useBoardDragDrop -- Encapsulates drag-and-drop logic for the Kanban board.
 *
 * Handles:
 * - DnD sensor configuration (pointer + keyboard)
 * - Drag start/end event handlers
 * - Board card lookup across columns
 * - Backlog item drag-to-board assignment
 * - Board card drag-to-backlog unassignment
 * - Status changes on column drop
 * - Project mode (BACKLOG-4176): drop into another epic row re-parents
 * - Label mode (BACKLOG-4196): cards are lane copies with ids
 *   `card:<itemId>:lane=<key>`; active and over ids are turned back into
 *   item ids first. A drop changes status only, never labels.
 */

import { useState, useCallback } from 'react';
import {
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import { resolveColumnStatus } from '../../components/KanbanBoard';
import { itemIdFromSortableId, parseSwimLaneCellId } from '../lib/swim-lane-ids';
import {
  collectEpicIds,
  laneKeyForItem,
  resolveEpicDrop,
  type EpicDropPlan,
} from '../lib/epic-lanes';
import {
  updateItemStatus,
  updateItemField,
  assignToSprint,
} from '@/lib/pm-queries';
import type { PmBacklogItem, ItemStatus, BoardColumns } from '@/lib/pm-types';
import type { SwimLaneMode } from '../../components/SwimLaneSelector';

interface UseBoardDragDropParams {
  columns: BoardColumns;
  selectedSprintId: string;
  swimLane: SwimLaneMode;
  loadBoardData: () => Promise<void>;
  loadBacklogItems: (search?: string) => Promise<void>;
  handleStatusChange: (itemId: string, newStatus: ItemStatus) => Promise<void>;
  handleEpicMove: (item: PmBacklogItem, plan: EpicDropPlan) => Promise<void>;
}

export function useBoardDragDrop({
  columns,
  selectedSprintId,
  swimLane,
  loadBoardData,
  loadBacklogItems,
  handleStatusChange,
  handleEpicMove,
}: UseBoardDragDropParams) {
  const [activeDragItem, setActiveDragItem] = useState<PmBacklogItem | null>(null);
  const [activeDragIsBacklog, setActiveDragIsBacklog] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(KeyboardSensor)
  );

  /** Find a board item across all columns. */
  const findBoardItem = useCallback(
    (id: string): PmBacklogItem | undefined => {
      for (const items of Object.values(columns)) {
        const item = (items as PmBacklogItem[]).find((i) => i.id === id);
        if (item) return item;
      }
      return undefined;
    },
    [columns]
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const { active } = event;
      const data = active.data.current;

      if (data?.type === 'backlog-item') {
        setActiveDragItem(data.item as PmBacklogItem);
        setActiveDragIsBacklog(true);
      } else {
        const item = findBoardItem(itemIdFromSortableId(active.id as string));
        if (item) {
          setActiveDragItem(item);
          setActiveDragIsBacklog(false);
        }
      }
    },
    [findBoardItem]
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      setActiveDragItem(null);
      setActiveDragIsBacklog(false);

      if (!over) return;

      const data = active.data.current;
      // Label mode lane copies carry `card:<itemId>:lane=<key>` ids; every
      // lookup below wants the item id. Other ids pass through unchanged.
      const activeId = itemIdFromSortableId(active.id as string);
      const overId = itemIdFromSortableId(over.id as string);

      // Board card dropped onto backlog panel -> unassign from sprint
      if (overId === 'backlog-panel') {
        if (data?.type === 'backlog-item' || swimLane === 'project') return;
        const itemId = activeId;
        try {
          await updateItemField(itemId, 'sprint_id', null);
          await loadBoardData();
          await loadBacklogItems();
        } catch (err) {
          console.error('Failed to unassign item from sprint:', err);
        }
        return;
      }

      const targetStatus = resolveColumnStatus(overId, columns);
      if (!targetStatus) return;

      // Project mode: rows are epics. A drop changes status and/or parent.
      if (swimLane === 'project') {
        if (data?.type === 'backlog-item') return; // backlog panel is hidden here
        const itemId = activeId;
        let currentStatus: ItemStatus | null = null;
        let currentItem: PmBacklogItem | null = null;
        for (const [status, items] of Object.entries(columns)) {
          const found = (items as PmBacklogItem[]).find((i) => i.id === itemId);
          if (found) {
            currentStatus = status as ItemStatus;
            currentItem = found;
            break;
          }
        }
        if (!currentItem || !currentStatus) return;

        const epicIds = collectEpicIds(columns);
        // Target row: the cell's key, or the row of the card dropped onto.
        const parsedCell = parseSwimLaneCellId(overId);
        let targetLaneKey: string | null = null;
        if (parsedCell) {
          if (parsedCell.dimension !== 'epic') return;
          targetLaneKey = parsedCell.groupKey;
        } else {
          const overItem = findBoardItem(overId);
          if (overItem) targetLaneKey = laneKeyForItem(overItem, epicIds);
        }
        if (!targetLaneKey) return;

        const plan = resolveEpicDrop({
          item: currentItem,
          currentStatus,
          targetLaneKey,
          targetStatus,
          epicIds,
        });
        if (!plan) return;
        if (!plan.parent && plan.status) {
          // Same row: keep the optimistic status path.
          await handleStatusChange(itemId, plan.status);
          return;
        }
        await handleEpicMove(currentItem, plan);
        return;
      }

      if (data?.type === 'backlog-item') {
        const item = data.item as PmBacklogItem;
        if (!selectedSprintId) return;

        try {
          await assignToSprint([item.id], selectedSprintId);
          if (targetStatus !== 'pending') {
            await updateItemStatus(item.id, targetStatus);
          }
          await loadBoardData();
          await loadBacklogItems();
        } catch (err) {
          console.error('Failed to assign backlog item to board:', err);
        }
      } else {
        const itemId = activeId;

        // Find the current item to compare current project + status.
        let currentStatus: ItemStatus | null = null;
        let currentItem: PmBacklogItem | null = null;
        for (const [status, items] of Object.entries(columns)) {
          const found = (items as PmBacklogItem[]).find((i) => i.id === itemId);
          if (found) {
            currentStatus = status as ItemStatus;
            currentItem = found;
            break;
          }
        }
        if (!currentItem || !currentStatus) return;
        if (currentStatus === targetStatus) return;

        try {
          // Preserve optimistic-update behavior via handleStatusChange.
          await handleStatusChange(itemId, targetStatus);
        } catch (err) {
          console.error('Failed to apply drag update:', err);
          // Error path: reload to revert any partial optimistic state.
          await loadBoardData();
        }
      }
    },
    [
      columns,
      selectedSprintId,
      swimLane,
      findBoardItem,
      loadBoardData,
      loadBacklogItems,
      handleStatusChange,
      handleEpicMove,
    ]
  );

  return {
    sensors,
    activeDragItem,
    activeDragIsBacklog,
    handleDragStart,
    handleDragEnd,
  };
}
