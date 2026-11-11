// @vitest-environment jsdom

/**
 * useEpicDragDrop (BACKLOG-4193): moving an item between epics on the project
 * page keeps its sort_order. pm_reorder_item writes parent_id and sort_order
 * together, so a call without the item's own sort_order resets it.
 */

import { act, cleanup, renderHook } from '@testing-library/react';
import type { DragEndEvent } from '@dnd-kit/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeItem } from '../../../../board/__tests__/board-fixtures';

const q = vi.hoisted(() => ({ reorderItem: vi.fn() }));
vi.mock('@/lib/pm-queries', () => q);

import { EPIC_BACKLOG_DROPPABLE_ID, useEpicDragDrop } from '../useEpicDragDrop';

const ITEM = makeItem({ id: 'task-1', item_number: 101, parent_id: 'epic-a', sort_order: 7 });

function dragEnd(containerId: string, overId: string): DragEndEvent {
  return {
    active: { id: ITEM.id, data: { current: { item: ITEM, containerId } } },
    over: { id: overId },
  } as unknown as DragEndEvent;
}

beforeEach(() => {
  q.reorderItem.mockReset();
  q.reorderItem.mockResolvedValue({ success: true });
});
afterEach(cleanup);

function mount() {
  const moveItemParent = vi.fn();
  const onRefreshFallback = vi.fn();
  const hook = renderHook(() => useEpicDragDrop({ moveItemParent, onRefreshFallback }));
  return { ...hook, moveItemParent, onRefreshFallback };
}

describe('useEpicDragDrop keeps sort_order', () => {
  it('moving to another epic passes the item own sort_order', () => {
    const { result, moveItemParent } = mount();
    act(() => result.current.handleDragEnd(dragEnd('epic-a', 'epic-b')));
    expect(moveItemParent).toHaveBeenCalledWith('task-1', 'epic-b');
    expect(q.reorderItem).toHaveBeenCalledWith('task-1', 'epic-b', 7);
  });

  it('moving to the no-epic backlog passes a null parent and the item own sort_order', () => {
    const { result } = mount();
    act(() => result.current.handleDragEnd(dragEnd('epic-a', EPIC_BACKLOG_DROPPABLE_ID)));
    expect(q.reorderItem).toHaveBeenCalledWith('task-1', null, 7);
  });

  it('a drop on the same epic writes nothing', () => {
    const { result } = mount();
    act(() => result.current.handleDragEnd(dragEnd('epic-a', 'epic-a')));
    expect(q.reorderItem).not.toHaveBeenCalled();
  });
});
