'use client';

/**
 * KanbanCardActions -- Compact card layout for Kanban cards.
 *
 * Single-row title-only view used when "Compact" mode is active.
 * Includes priority dot, item number, and truncated title link.
 */

import Link from 'next/link';
import type { DraggableAttributes } from '@dnd-kit/core';
import type { SyntheticListenerMap } from '@dnd-kit/core/dist/hooks/utilities';
import type { PmBacklogItem, ItemPriority } from '@/lib/pm-types';

/** Priority dot colors for compact mode. */
export const PRIORITY_DOT_COLORS: Record<ItemPriority, string> = {
  low: 'bg-gray-300',
  medium: 'bg-blue-400',
  high: 'bg-orange-400',
  critical: 'bg-red-500',
};

interface CompactKanbanCardProps {
  item: PmBacklogItem;
  isDragOverlay?: boolean;
  isSelected?: boolean;
  /** Sortable ref/style/attributes from useSortable -- passed through from parent. */
  sortableRef?: (node: HTMLElement | null) => void;
  sortableStyle?: React.CSSProperties;
  sortableAttributes?: DraggableAttributes;
  sortableListeners?: SyntheticListenerMap;
}

export function CompactKanbanCard({
  item,
  isDragOverlay = false,
  isSelected = false,
  sortableRef,
  sortableStyle,
  sortableAttributes,
  sortableListeners,
}: CompactKanbanCardProps) {
  return (
    <div
      ref={!isDragOverlay ? sortableRef : undefined}
      style={!isDragOverlay ? sortableStyle : undefined}
      {...(!isDragOverlay ? sortableAttributes : {})}
      {...(!isDragOverlay ? sortableListeners : {})}
      className={`bg-white rounded border px-2 py-1.5 cursor-grab active:cursor-grabbing hover:bg-gray-50 transition-colors flex items-center gap-2 ${
        isSelected
          ? 'ring-2 ring-primary-500 border-primary-300'
          : 'border-gray-200'
      } ${isDragOverlay ? 'shadow-lg rotate-2' : ''}`}
    >
      {/* Priority dot */}
      <div
        className={`w-2 h-2 rounded-full flex-shrink-0 ${PRIORITY_DOT_COLORS[item.priority]}`}
      />
      {/* ID */}
      <span className="text-[10px] text-gray-400 font-mono flex-shrink-0">
        #{item.item_number}
      </span>
      {/* Title */}
      <Link
        href={`/dashboard/pm/tasks/${item.id}?from=board`}
        className="text-xs text-gray-800 truncate flex-1"
        onClick={(e) => e.stopPropagation()}
      >
        {item.title}
      </Link>
    </div>
  );
}
