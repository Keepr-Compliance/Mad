'use client';

/**
 * KanbanCard -- A draggable card representing a single backlog item.
 *
 * Uses @dnd-kit/sortable's useSortable for drag support.
 * Compact 4-row layout:
 *   Row 1: Checkbox + #item_number | Priority pill (inline editable)
 *   Row 2-3: Title (link, line-clamp-2)
 *   Row 4: Assignee avatar+name (inline editable) | Label pills (inline editable)
 */

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import Link from 'next/link';
import type { PmBacklogItem, ItemPriority, PmLabel } from '@/lib/pm-types';
import { updateItemField } from '@/lib/pm-queries';
import { InlinePriorityPicker } from './InlinePriorityPicker';
import { InlineAssigneePicker } from './InlineAssigneePicker';
import type { AssignableUser } from './InlineAssigneePicker';
import { InlineLabelPicker } from './KanbanCardMeta';
import { CompactKanbanCard } from './KanbanCardActions';

// Re-export AssignableUser for backward compatibility
export type { AssignableUser } from './InlineAssigneePicker';

interface KanbanCardProps {
  item: PmBacklogItem;
  isDragOverlay?: boolean;
  isSelected?: boolean;
  compact?: boolean;
  onToggleSelect?: () => void;
  onItemUpdated?: () => void;
  users?: AssignableUser[];
  allLabels?: PmLabel[];
}

export function KanbanCard({
  item,
  isDragOverlay = false,
  isSelected = false,
  compact = false,
  onToggleSelect,
  onItemUpdated,
  users = [],
  allLabels = [],
}: KanbanCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  // -- Inline edit handlers ------------------------------------------------

  async function handlePriorityUpdate(newPriority: ItemPriority) {
    if (newPriority === item.priority) return;
    try {
      await updateItemField(item.id, 'priority', newPriority);
      onItemUpdated?.();
    } catch (err) {
      console.error('Failed to update priority:', err);
    }
  }

  async function handleAssigneeUpdate(userId: string | null) {
    if (userId === item.assignee_id) return;
    onItemUpdated?.();
  }

  function handleLabelUpdate() {
    onItemUpdated?.();
  }

  // -- Compact layout: single-row title-only view ----------------------------
  if (compact) {
    return (
      <CompactKanbanCard
        item={item}
        isDragOverlay={isDragOverlay}
        isSelected={isSelected}
        sortableRef={setNodeRef}
        sortableStyle={style}
        sortableAttributes={attributes}
        sortableListeners={listeners}
      />
    );
  }

  // -- Default layout: full 4-row card ---------------------------------------
  return (
    <div
      ref={!isDragOverlay ? setNodeRef : undefined}
      style={!isDragOverlay ? style : undefined}
      {...(!isDragOverlay ? attributes : {})}
      {...(!isDragOverlay ? listeners : {})}
      className={`bg-white rounded-lg border p-2.5 cursor-grab active:cursor-grabbing shadow-sm hover:shadow-md transition-shadow ${
        isSelected
          ? 'ring-2 ring-primary-500 border-primary-300'
          : 'border-gray-200'
      } ${isDragOverlay ? 'shadow-lg rotate-2' : ''}`}
    >
      {/* Row 1: Checkbox + ID | Priority pill */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {onToggleSelect && (
            <input
              type="checkbox"
              checked={isSelected}
              onChange={(e) => {
                e.stopPropagation();
                onToggleSelect();
              }}
              onClick={(e) => e.stopPropagation()}
              className="h-3.5 w-3.5 rounded border-gray-300 text-primary-600"
            />
          )}
          <span className="text-xs text-gray-400 font-mono">
            #{item.item_number}
          </span>
        </div>
        <InlinePriorityPicker
          priority={item.priority}
          onUpdate={handlePriorityUpdate}
          variant="compact"
        />
      </div>

      {/* Row 2-3: Title */}
      <Link
        href={`/dashboard/pm/tasks/${item.id}?from=board`}
        className="block text-sm font-medium text-gray-900 hover:text-primary-600 mt-1 line-clamp-2"
        onClick={(e) => e.stopPropagation()}
      >
        {item.title}
      </Link>

      {/* Row 4: Assignee | Labels */}
      <div className="flex items-center justify-between mt-2">
        <InlineAssigneePicker
          assigneeId={item.assignee_id}
          users={users}
          onUpdate={handleAssigneeUpdate}
          variant="avatar"
        />
        <InlineLabelPicker
          itemId={item.id}
          currentLabels={item.labels || []}
          allLabels={allLabels}
          onUpdate={handleLabelUpdate}
        />
      </div>
    </div>
  );
}
