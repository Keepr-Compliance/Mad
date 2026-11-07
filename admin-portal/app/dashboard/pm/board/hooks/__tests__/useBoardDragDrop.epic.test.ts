// @vitest-environment jsdom

/**
 * useBoardDragDrop in Project mode (BACKLOG-4176): drops between epic rows.
 */

import { cleanup, renderHook } from '@testing-library/react';
import type { DragEndEvent } from '@dnd-kit/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectColumns } from '../../__tests__/board-fixtures';
import { buildSwimLaneCellId, NO_EPIC_KEY } from '../../lib/swim-lane-ids';
import type { ItemStatus } from '@/lib/pm-types';
import type { SwimLaneMode } from '../../../components/SwimLaneSelector';

const q = vi.hoisted(() => ({
  updateItemStatus: vi.fn(),
  updateItemField: vi.fn(),
  assignToSprint: vi.fn(),
  reorderItem: vi.fn(),
}));
vi.mock('@/lib/pm-queries', () => q);

import { useBoardDragDrop } from '../useBoardDragDrop';

const handleStatusChange = vi.fn();
const handleEpicMove = vi.fn();
const loadBoardData = vi.fn();
const loadBacklogItems = vi.fn();

beforeEach(() => {
  for (const fn of [...Object.values(q), handleStatusChange, handleEpicMove, loadBoardData, loadBacklogItems]) {
    fn.mockReset();
    fn.mockResolvedValue(undefined);
  }
});
afterEach(cleanup);

function mount(swimLane: SwimLaneMode = 'project') {
  return renderHook(() =>
    useBoardDragDrop({
      columns: projectColumns(),
      selectedSprintId: '',
      swimLane,
      loadBoardData,
      loadBacklogItems,
      handleStatusChange,
      handleEpicMove,
    })
  ).result.current;
}

function drop(activeId: string, overId: string): DragEndEvent {
  return { active: { id: activeId, data: { current: undefined } }, over: { id: overId } } as unknown as DragEndEvent;
}

const cell = (key: string, status: ItemStatus) => buildSwimLaneCellId('epic', key, status);

function noFieldWrites() {
  expect(q.updateItemField).not.toHaveBeenCalled();
  expect(q.assignToSprint).not.toHaveBeenCalled();
}

describe('Project mode drops', () => {
  it('into another epic row: re-parents with sort_order and sets status', async () => {
    await mount().handleDragEnd(drop('child-a1', cell('epic-b', 'testing')));
    expect(handleEpicMove).toHaveBeenCalledTimes(1);
    const [item, plan] = handleEpicMove.mock.calls[0];
    expect(item.id).toBe('child-a1');
    expect(plan).toEqual({ status: 'testing', parent: { parentId: 'epic-b', sortOrder: 7 } });
    expect(handleStatusChange).not.toHaveBeenCalled();
    noFieldWrites();
  });

  it('into No epic: clears the parent', async () => {
    await mount().handleDragEnd(drop('child-c1', cell(NO_EPIC_KEY, 'obsolete')));
    expect(handleEpicMove.mock.calls[0][1]).toEqual({ status: null, parent: { parentId: null, sortOrder: 4 } });
    noFieldWrites();
  });

  it('onto a card in another epic row uses that card\'s row', async () => {
    await mount().handleDragEnd(drop('orphan', 'child-a1'));
    expect(handleEpicMove.mock.calls[0][1]).toEqual({ status: null, parent: { parentId: 'epic-a', sortOrder: 11 } });
  });

  it('same row, other column: status only, through the optimistic path', async () => {
    await mount().handleDragEnd(drop('child-a1', cell('epic-a', 'in_progress')));
    expect(handleStatusChange).toHaveBeenCalledWith('child-a1', 'in_progress');
    expect(handleEpicMove).not.toHaveBeenCalled();
    noFieldWrites();
  });

  it('item under a non-epic parent dropped in No epic, same column: nothing written', async () => {
    await mount().handleDragEnd(drop('under-plain', cell(NO_EPIC_KEY, 'testing')));
    expect(handleEpicMove).not.toHaveBeenCalled();
    expect(handleStatusChange).not.toHaveBeenCalled();
    noFieldWrites();
  });

  it('dragging an epic does nothing', async () => {
    await mount().handleDragEnd(drop('epic-a', cell('epic-b', 'in_progress')));
    expect(handleEpicMove).not.toHaveBeenCalled();
    expect(handleStatusChange).not.toHaveBeenCalled();
    noFieldWrites();
  });
});

describe('Other modes', () => {
  it('area mode: a column drop still changes status only', async () => {
    await mount('area').handleDragEnd(drop('child-a1', buildSwimLaneCellId('area', 'No Area', 'testing')));
    expect(handleStatusChange).toHaveBeenCalledWith('child-a1', 'testing');
    expect(handleEpicMove).not.toHaveBeenCalled();
    noFieldWrites();
  });

  it('no-grouping mode: a plain column drop changes status', async () => {
    await mount('off').handleDragEnd(drop('child-a1', 'completed'));
    expect(handleStatusChange).toHaveBeenCalledWith('child-a1', 'completed');
  });
});
