'use client';

/**
 * useEpicDragDrop -- Drag-and-drop logic for the project detail "Epics" view
 * (BACKLOG-2386). Twin of useProjectDragDrop, but re-files tasks by changing
 * their PARENT (epic) rather than their sprint.
 *
 * Handles:
 * - DnD sensor configuration (PointerSensor 8px + KeyboardSensor)
 * - Drag start/end event handlers
 * - Optimistic local state update via moveItemParent callback
 * - Backlog task -> epic assignment
 * - Epic task -> different epic reassignment
 * - Epic task -> backlog un-filing (parent_id = null)
 * - No-op on same-container drops
 * - Falls back to full refresh if the reorder RPC fails
 *
 * NOTE: sprint_id is orthogonal and left untouched here. Moving a task between
 * epics only changes parent_id (via pm_reorder_item / reorderItem).
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
import { reorderItem } from '@/lib/pm-queries';
import type { PmBacklogItem } from '@/lib/pm-types';

/** Droppable id for the "no epic" side backlog in the Epics view. */
export const EPIC_BACKLOG_DROPPABLE_ID = 'epic-backlog';

interface UseEpicDragDropParams {
  /** Optimistic local state update: set an item's parent (or null for backlog). */
  moveItemParent: (itemId: string, parentId: string | null) => void;
  /** Full refresh fallback — called only when the RPC fails, to revert to server state. */
  onRefreshFallback: () => void;
}

export function useEpicDragDrop({ moveItemParent, onRefreshFallback }: UseEpicDragDropParams) {
  const [activeDragItem, setActiveDragItem] = useState<PmBacklogItem | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(KeyboardSensor)
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const data = event.active.data.current;
    if (data?.item) {
      setActiveDragItem(data.item as PmBacklogItem);
    }
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      setActiveDragItem(null);

      if (!over) return;

      const data = active.data.current;
      if (!data?.item) return;

      const item = data.item as PmBacklogItem;
      const sourceContainerId = data.containerId as string;
      const targetContainerId = over.id as string;

      // No-op: dropped on same container
      if (sourceContainerId === targetContainerId) return;

      // Backlog droppable => detach from epic (parent_id null); otherwise the
      // target container id IS the epic's id.
      const targetParentId =
        targetContainerId === EPIC_BACKLOG_DROPPABLE_ID ? null : targetContainerId;

      // Optimistic update: re-file item locally before the RPC completes.
      moveItemParent(item.id, targetParentId);

      // Fire the reorder RPC in the background — only refresh on failure to
      // revert to server state. sprint_id is untouched.
      reorderItem(item.id, targetParentId).catch(() => {
        onRefreshFallback();
      });
    },
    [moveItemParent, onRefreshFallback]
  );

  return {
    sensors,
    activeDragItem,
    handleDragStart,
    handleDragEnd,
  };
}
