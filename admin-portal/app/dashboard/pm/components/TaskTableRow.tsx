'use client';

/**
 * TaskTableRow -- Individual table row rendering for TaskTable.
 *
 * Contains:
 * - InlineTypeDropdown: Inline type editor
 * - InlineAreaEditor: Inline area text editor
 * - TaskTableRow: The row component with all inline editors
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check, GripVertical } from 'lucide-react';
import { useDraggable } from '@dnd-kit/core';
import { Checkbox } from '@keepr/design-system';
import type { PmBacklogItem, ItemType } from '@/lib/pm-types';
import { TYPE_LABELS, TYPE_COLORS } from '@/lib/pm-types';
import { updateItemField } from '@/lib/pm-queries';
import { formatTokens } from '@/lib/pm-utils';
import { useClickOutside } from '@/hooks/useClickOutside';
import { InlineStatusPicker } from './InlineStatusPicker';
import { InlinePriorityPicker } from './InlinePriorityPicker';
import { InlineAssigneePicker } from './InlineAssigneePicker';
import type { AssignableUser } from './InlineAssigneePicker';
import { StatusBadge, PriorityBadge, TypeBadge, formatDate } from './TaskTableHeader';

// ---------------------------------------------------------------------------
// Inline Dropdown: Type
// ---------------------------------------------------------------------------

function InlineTypeDropdown({
  itemId,
  type,
  onUpdated,
}: {
  itemId: string;
  type: ItemType;
  onUpdated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useClickOutside(ref, close, open);

  async function handleSelect(newType: ItemType) {
    setOpen(false);
    if (newType === type) return;
    try {
      await updateItemField(itemId, 'type', newType);
      onUpdated();
    } catch (err) {
      console.error('Failed to update type:', err);
    }
  }

  return (
    <div ref={ref} className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={(e) => {
          e.preventDefault();
          setOpen(!open);
        }}
        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium cursor-pointer hover:ring-2 hover:ring-offset-1 hover:ring-gray-300 ${TYPE_COLORS[type]}`}
      >
        {TYPE_LABELS[type]}
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 bg-white border rounded-md shadow-lg z-20 py-1 w-28">
          {(['feature', 'bug', 'chore', 'spike', 'epic'] as ItemType[]).map((t) => (
            <button
              key={t}
              onClick={() => handleSelect(t)}
              className={`w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 flex items-center justify-between ${
                t === type ? 'bg-primary-50' : ''
              }`}
            >
              <span
                className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium ${TYPE_COLORS[t]}`}
              >
                {TYPE_LABELS[t]}
              </span>
              {t === type && <Check className="h-3 w-3 text-primary-600" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline Text Input: Area
// ---------------------------------------------------------------------------

function InlineAreaEditor({
  itemId,
  area,
  onUpdated,
}: {
  itemId: string;
  area: string | null;
  onUpdated: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(area || '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  async function handleSave() {
    setEditing(false);
    const newValue = value.trim();
    if (newValue === (area || '')) return;
    try {
      await updateItemField(itemId, 'area', newValue || null);
      onUpdated();
    } catch (err) {
      console.error('Failed to update area:', err);
      setValue(area || '');
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      handleSave();
    } else if (e.key === 'Escape') {
      setValue(area || '');
      setEditing(false);
    }
  }

  if (editing) {
    return (
      <div onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={handleSave}
          onKeyDown={handleKeyDown}
          className="w-full px-2 py-0.5 text-sm text-gray-900 bg-white border border-primary-400 rounded focus:outline-none focus:ring-1 focus:ring-primary-500"
        />
      </div>
    );
  }

  return (
    <div onClick={(e) => e.stopPropagation()}>
      <button
        onClick={(e) => {
          e.preventDefault();
          setValue(area || '');
          setEditing(true);
        }}
        className="text-sm text-left cursor-pointer hover:text-primary-600 transition-colors"
      >
        {area ? (
          <span className="text-gray-500">{area}</span>
        ) : (
          <span className="text-gray-300">-</span>
        )}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TaskTableRow
// ---------------------------------------------------------------------------

interface TaskTableRowProps {
  item: PmBacklogItem;
  itemUrl: string;
  editable: boolean;
  treeMode?: boolean;
  selectedIds?: Set<string>;
  onSelectionChange?: (ids: Set<string>) => void;
  onItemUpdated?: () => void;
  users?: AssignableUser[];
  userMap?: Map<string, { display_name: string | null; email: string }>;
  /** When true, row exposes a drag handle that emits {type:'sprint-item',item}. */
  draggable?: boolean;
}

export function TaskTableRow({
  item,
  itemUrl,
  editable,
  treeMode,
  selectedIds,
  onSelectionChange,
  onItemUpdated,
  users,
  userMap,
  draggable = false,
}: TaskTableRowProps) {
  const router = useRouter();

  // useDraggable is always called to satisfy Rules of Hooks. When `draggable`
  // is false, we simply don't render the grip handle or attach the node ref,
  // so the draggable instance is inert (no UI, no listeners wired).
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: item.id,
    data: { type: 'sprint-item', item },
    disabled: !draggable,
  });

  function toggleItem(id: string) {
    if (!onSelectionChange || !selectedIds) return;
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    onSelectionChange(next);
  }

  return (
    <tr
      ref={draggable ? setNodeRef : undefined}
      onClick={(e: React.MouseEvent<HTMLTableRowElement>) => {
        const target = e.target as HTMLElement;
        if (target.closest('a') || target.closest('input') || target.closest('button') || target.closest('[data-inline-edit]') || target.closest('[data-drag-handle]')) return;
        router.push(itemUrl);
      }}
      className={`hover:bg-gray-50 cursor-pointer transition-colors ${isDragging ? 'opacity-50' : ''}`}
    >
      {draggable && (
        <td
          className="pl-2 pr-1 py-3 w-8"
          onClick={(e) => e.stopPropagation()}
          data-drag-handle
        >
          <button
            type="button"
            {...attributes}
            {...listeners}
            className="cursor-grab active:cursor-grabbing text-gray-300 hover:text-gray-600 focus:outline-none focus:ring-1 focus:ring-primary-400 rounded"
            aria-label={`Drag ${item.title}`}
          >
            <GripVertical className="h-4 w-4" />
          </button>
        </td>
      )}
      {onSelectionChange && (
        <td className="px-4 py-3 w-10" onClick={(e) => e.stopPropagation()}>
          <Checkbox
            checked={selectedIds?.has(item.id) ?? false}
            onChange={() => toggleItem(item.id)}
          />
        </td>
      )}
      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
        #{item.item_number}
      </td>
      <td
        className="px-4 py-3 text-sm text-gray-900 max-w-sm truncate font-medium"
        style={treeMode && item.parent_id ? { paddingLeft: '2.5rem' } : undefined}
      >
        <Link
          href={itemUrl}
          className="hover:text-primary-600 hover:underline"
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
        >
          {item.title}
        </Link>
        {item.child_count && item.child_count > 0 ? (
          <span className="ml-2 text-xs text-gray-400">
            ({item.child_count} children)
          </span>
        ) : null}
      </td>
      <td className="px-4 py-3 whitespace-nowrap" data-inline-edit>
        {editable ? (
          <InlineTypeDropdown itemId={item.id} type={item.type} onUpdated={onItemUpdated!} />
        ) : (
          <TypeBadge type={item.type} />
        )}
      </td>
      <td className="px-4 py-3 whitespace-nowrap" data-inline-edit>
        {editable ? (
          <InlineStatusPicker itemId={item.id} status={item.status} onUpdated={onItemUpdated!} />
        ) : (
          <StatusBadge status={item.status} />
        )}
      </td>
      <td className="px-4 py-3 whitespace-nowrap" data-inline-edit>
        {editable ? (
          <InlinePriorityPicker itemId={item.id} priority={item.priority} onUpdated={onItemUpdated!} />
        ) : (
          <PriorityBadge priority={item.priority} />
        )}
      </td>
      <td className="px-4 py-3 whitespace-nowrap" data-inline-edit>
        {editable && users ? (
          <InlineAssigneePicker
            itemId={item.id}
            assigneeId={item.assignee_id}
            users={users}
            userMap={userMap}
            variant="text"
            onUpdated={onItemUpdated!}
          />
        ) : (
          <span className="text-sm text-gray-500">
            {item.assignee_id && userMap?.has(item.assignee_id)
              ? (userMap.get(item.assignee_id)!.display_name || userMap.get(item.assignee_id)!.email)
              : <span className="text-gray-300">Unassigned</span>
            }
          </span>
        )}
      </td>
      <td className="px-4 py-3 whitespace-nowrap" data-inline-edit>
        {editable ? (
          <InlineAreaEditor itemId={item.id} area={item.area} onUpdated={onItemUpdated!} />
        ) : (
          <span className="text-sm text-gray-500">{item.area || '-'}</span>
        )}
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
        {formatTokens(item.est_tokens)}
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
        {formatDate(item.created_at)}
      </td>
    </tr>
  );
}
