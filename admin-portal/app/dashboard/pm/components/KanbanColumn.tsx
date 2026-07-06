'use client';

/**
 * KanbanColumn -- A droppable column representing a single board status.
 *
 * Uses @dnd-kit/core's useDroppable to accept dragged cards.
 * Renders a SortableContext for within-column ordering and a
 * KanbanQuickAdd at the bottom for inline item creation.
 */

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useDroppable } from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import type { PmBacklogItem, ItemStatus, PmLabel } from '@/lib/pm-types';
import { STATUS_LABELS, STATUS_COLORS } from '@/lib/pm-types';
import { KanbanCard, type AssignableUser } from './KanbanCard';
import { KanbanQuickAdd } from './KanbanQuickAdd';

interface KanbanColumnProps {
  status: ItemStatus;
  items: PmBacklogItem[];
  onQuickAdd?: (title: string) => Promise<void>;
  selectedIds?: Set<string>;
  onToggleSelect?: (itemId: string) => void;
  onItemUpdated?: () => void;
  users?: AssignableUser[];
  allLabels?: PmLabel[];
  compact?: boolean;
}

export function KanbanColumn({
  status,
  items,
  onQuickAdd,
  selectedIds,
  onToggleSelect,
  onItemUpdated,
  users,
  allLabels,
  compact,
}: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const [showTopAdd, setShowTopAdd] = useState(false);

  return (
    <div
      ref={setNodeRef}
      className={`min-w-[280px] flex-1 bg-gray-50 rounded-lg p-3 flex flex-col ${
        isOver ? 'ring-2 ring-primary-400 bg-primary-50' : ''
      }`}
    >
      {/* Column header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[status]}`}
          >
            {STATUS_LABELS[status]}
          </span>
          <span className="text-xs text-gray-400">{items.length}</span>
        </div>
        {onQuickAdd && (
          <button
            onClick={() => setShowTopAdd(true)}
            className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-200 rounded"
            title="Add item"
          >
            <Plus className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Top quick add (triggered by header +) */}
      {showTopAdd && onQuickAdd && (
        <KanbanQuickAdd
          onAdd={async (title) => {
            await onQuickAdd(title);
            setShowTopAdd(false);
          }}
          onCancel={() => setShowTopAdd(false)}
        />
      )}

      {/* Cards */}
      <SortableContext
        items={items.map((i) => i.id)}
        strategy={verticalListSortingStrategy}
      >
        <div className="flex-1 space-y-2 min-h-[8rem]">
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

      {/* Quick add at bottom */}
      {onQuickAdd && <KanbanQuickAdd onAdd={onQuickAdd} />}
    </div>
  );
}
