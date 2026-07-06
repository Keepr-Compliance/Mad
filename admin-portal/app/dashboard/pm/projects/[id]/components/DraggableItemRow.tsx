'use client';

/**
 * DraggableItemRow -- Flex-based draggable card for project detail page.
 *
 * Uses useDraggable (NOT useSortable) since items are dragged between
 * containers (backlog <-> sprints), not sorted within a list.
 *
 * Layout: item_number | title | status badge | priority badge
 * Visual: opacity-50 when dragging, cursor-grab
 */

import { useDraggable } from '@dnd-kit/core';
import Link from 'next/link';
import { Checkbox } from '@keepr/design-system';
import type { PmBacklogItem } from '@/lib/pm-types';
import {
  STATUS_LABELS,
  STATUS_COLORS,
  PRIORITY_LABELS,
  PRIORITY_COLORS,
} from '@/lib/pm-types';

interface DraggableItemRowProps {
  item: PmBacklogItem;
  projectId: string;
  /** The container this item belongs to (sprint id or 'backlog-panel') */
  containerId: string;
  /** Render as overlay (no draggable bindings) */
  isDragOverlay?: boolean;
  /** BACKLOG-1664: whether this row is currently multi-selected */
  selected?: boolean;
  /** BACKLOG-1664: toggle selection for this item (bulk-assign flow) */
  onToggleSelect?: (itemId: string) => void;
}

export function DraggableItemRow({
  item,
  projectId,
  containerId,
  isDragOverlay = false,
  selected = false,
  onToggleSelect,
}: DraggableItemRowProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: item.id,
    data: { item, containerId },
    disabled: isDragOverlay,
  });

  const itemUrl = `/dashboard/pm/tasks/${item.id}?from=project&projectId=${projectId}`;

  return (
    <div
      ref={!isDragOverlay ? setNodeRef : undefined}
      {...(!isDragOverlay ? attributes : {})}
      {...(!isDragOverlay ? listeners : {})}
      className={`flex items-center gap-3 px-3 py-2 rounded-md border bg-white transition-all ${
        isDragging ? 'opacity-50' : ''
      } ${
        isDragOverlay
          ? 'shadow-lg rotate-1 border-primary-300'
          : selected
            ? 'border-primary-400 ring-1 ring-primary-200 cursor-grab active:cursor-grabbing'
            : 'border-gray-200 hover:border-primary-300 cursor-grab active:cursor-grabbing'
      }`}
    >
      {/* Selection checkbox (BACKLOG-1664) */}
      {onToggleSelect && !isDragOverlay && (
        <Checkbox
          checked={selected}
          onChange={() => onToggleSelect(item.id)}
          // Stop pointer/drag events from leaking into dnd-kit listeners,
          // otherwise clicking the checkbox would start a drag.
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
          onPointerDown={(e: React.PointerEvent) => e.stopPropagation()}
          className="shrink-0 cursor-pointer"
          aria-label={`Select ${item.title}`}
        />
      )}

      {/* Item number */}
      <span className="text-xs text-gray-400 font-mono whitespace-nowrap">
        #{item.item_number}
      </span>

      {/* Title */}
      <Link
        href={itemUrl}
        className="flex-1 text-sm text-gray-900 font-medium truncate hover:text-primary-600 hover:underline"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
        onPointerDown={(e: React.PointerEvent) => e.stopPropagation()}
      >
        {item.title}
      </Link>

      {/* Status badge */}
      <span
        className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium shrink-0 ${STATUS_COLORS[item.status]}`}
      >
        {STATUS_LABELS[item.status]}
      </span>

      {/* Priority badge */}
      <span
        className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium shrink-0 ${PRIORITY_COLORS[item.priority]}`}
      >
        {PRIORITY_LABELS[item.priority]}
      </span>
    </div>
  );
}
