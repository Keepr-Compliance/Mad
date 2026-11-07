// @vitest-environment jsdom

/**
 * BACKLOG-4192: items with status 'pending_uat' appear on the PM board.
 *
 * C1 header pill right after Testing, C2 card in no-grouping mode, C3 area / assignee cell,
 * C4 epic row cell + an epic whose own status is pending_uat keeps its row, C5 an unknown
 * status key from a newer RPC does not crash grouping, C6 drop into the column (off / area /
 * epic), C7 drag out, C8 status change + listItems fallback.
 *
 * Items come from makeItem(), whose shape is transcribed from a real pm_get_board_tasks row.
 */

import { act, cleanup, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { DndContext, type DragEndEvent } from '@dnd-kit/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALLOWED_TRANSITIONS, STATUS_COLORS, STATUS_LABELS, type BoardColumns, type PmBacklogItem } from '@/lib/pm-types';
import { EPIC_A, makeItem, toColumns } from './board-fixtures';

const q = vi.hoisted(() => ({
  listSprints: vi.fn(),
  listItems: vi.fn(),
  listProjects: vi.fn(),
  getBoardTasks: vi.fn(),
  updateItemStatus: vi.fn(),
  reorderItem: vi.fn(),
  createItem: vi.fn(),
  assignItem: vi.fn(),
  addItemLabel: vi.fn(),
  fetchItemLabels: vi.fn(),
  bulkUpdate: vi.fn(),
  bulkDelete: vi.fn(),
  assignToSprint: vi.fn(),
  listAssignableUsers: vi.fn(),
  listLabels: vi.fn(),
  updateItemField: vi.fn(),
}));
vi.mock('@/lib/pm-queries', () => q);

import { COLUMN_ORDER, KanbanBoard } from '../../components/KanbanBoard';
import { EpicLaneGrid, groupItemsByDimension, SwimLaneGrid } from '../components/BoardColumn';
import { groupColumnsByEpic } from '../lib/epic-lanes';
import { buildSwimLaneCellId, parseSwimLaneCellId } from '../lib/swim-lane-ids';
import { useBoardDragDrop } from '../hooks/useBoardDragDrop';
import { useBoardData } from '../hooks/useBoardData';
import type { SwimLaneMode } from '../../components/SwimLaneSelector';

const UAT = makeItem({ id: 'uat-1', item_number: 300, title: 'Awaiting founder UAT', status: 'pending_uat', area: 'Desktop', assignee_id: 'user-1', sort_order: 1 });
const UAT_CHILD = makeItem({ id: 'uat-child', item_number: 301, title: 'Child awaiting UAT', status: 'pending_uat', parent_id: 'epic-a', sort_order: 2 });
const UAT_EPIC = makeItem({ id: 'uat-epic', item_number: 302, title: 'Epic awaiting UAT', type: 'epic', status: 'pending_uat', sort_order: 3 });
const TESTING = makeItem({ id: 'testing-1', item_number: 303, title: 'In testing', status: 'testing', area: 'Desktop' });

function columns(): BoardColumns {
  return toColumns([EPIC_A, UAT, UAT_CHILD, UAT_EPIC, TESTING]);
}

function totalItems(cols: Record<string, PmBacklogItem[] | undefined>): number {
  return Object.values(cols).reduce((n, list) => n + (list?.length ?? 0), 0);
}

const gridProps = {
  collapsedLanes: new Set<string>(),
  onToggleLane: vi.fn(),
  selectedIds: new Set<string>(),
  onToggleSelect: vi.fn(),
  onItemUpdated: vi.fn(),
  onQuickAdd: vi.fn(),
  users: [],
  allLabels: [],
  compactCards: false,
};

function droppable(id: string): HTMLElement {
  const el = document.querySelector(`[data-droppable-id="${id}"]`);
  if (!el) throw new Error(`no droppable ${id}`);
  return el as HTMLElement;
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const fn of Object.values(q)) fn.mockReset();
  q.fetchItemLabels.mockResolvedValue(new Map());
  q.listSprints.mockResolvedValue([{ id: 'sprint-1', status: 'active', name: 'S' }]);
  q.listProjects.mockResolvedValue([]);
  q.listAssignableUsers.mockResolvedValue([]);
  q.listLabels.mockResolvedValue([]);
  q.listItems.mockResolvedValue({ items: [] });
  q.getBoardTasks.mockResolvedValue(columns());
  q.updateItemStatus.mockResolvedValue({ success: true });
});
afterEach(cleanup);

describe('C1 header pill', () => {
  it('Pending UAT column sits right after Testing, teal, labelled "Pending UAT"', () => {
    expect(COLUMN_ORDER.indexOf('pending_uat')).toBe(COLUMN_ORDER.indexOf('testing') + 1);
    expect(STATUS_LABELS.pending_uat).toBe('Pending UAT');
    expect(STATUS_COLORS.pending_uat).toBe('bg-teal-100 text-teal-800');
    render(<DndContext><SwimLaneGrid columns={columns()} swimLane="area" nameMap={new Map()} {...gridProps} /></DndContext>);
    const pills = screen.getAllByTestId(/^board-header-pill-/).map((p) => p.getAttribute('data-testid'));
    expect(pills.indexOf('board-header-pill-pending_uat')).toBe(pills.indexOf('board-header-pill-testing') + 1);
    const pill = screen.getByTestId('board-header-pill-pending_uat');
    expect(pill.textContent).toBe('Pending UAT');
    expect(pill.className).toContain('bg-teal-100 text-teal-800');
  });
});

describe('C2 no-grouping mode', () => {
  it('a pending_uat item renders as a card in the Pending UAT column', () => {
    render(<DndContext><KanbanBoard columns={columns()} /></DndContext>);
    const labels = screen.getAllByText(/^(Testing|Pending UAT|Waiting for User)$/).map((n) => n.textContent);
    expect(labels).toEqual(['Testing', 'Pending UAT', 'Waiting for User']);
    expect(screen.getByText('Awaiting founder UAT')).toBeTruthy();
  });
});

describe('C3 area / assignee cells', () => {
  it.each([
    ['area', 'Desktop'],
    ['assignee', 'user-1'],
  ] as const)('%s mode: the item is in its row\'s pending_uat cell', (mode, key) => {
    render(<DndContext><SwimLaneGrid columns={columns()} swimLane={mode} nameMap={new Map()} {...gridProps} /></DndContext>);
    const cell = droppable(buildSwimLaneCellId(mode, key, 'pending_uat'));
    expect(within(cell).getByText('Awaiting founder UAT')).toBeTruthy();
  });
});

describe('C4 epic rows', () => {
  it('a pending_uat child sits in its epic row; a pending_uat epic keeps its own row', () => {
    const lanes = groupColumnsByEpic(columns());
    expect(lanes.map((l) => l.key)).toContain('uat-epic');
    expect(lanes.find((l) => l.key === 'epic-a')!.columns.pending_uat.map((i) => i.id)).toEqual(['uat-child']);
    render(<DndContext><EpicLaneGrid columns={columns()} {...gridProps} onAddEpic={vi.fn()} /></DndContext>);
    expect(screen.getByTestId('epic-lane-uat-epic')).toBeTruthy();
    const cell = droppable(buildSwimLaneCellId('epic', 'epic-a', 'pending_uat'));
    expect(within(cell).getByText('Child awaiting UAT')).toBeTruthy();
  });
});

describe('C5 unknown status key from a newer RPC', () => {
  it('grouping does not throw and keeps every item', () => {
    const cols = { ...columns(), some_future_status: [makeItem({ id: 'future', item_number: 400, status: 'pending' })] } as BoardColumns;
    const before = totalItems(cols as unknown as Record<string, PmBacklogItem[]>);
    for (const dim of ['area', 'assignee', 'project'] as const) {
      const groups = groupItemsByDimension(cols, dim);
      const after = Array.from(groups.values()).reduce(
        (n, g) => n + totalItems(g as unknown as Record<string, PmBacklogItem[]>), 0);
      expect(after).toBe(before);
    }
    const lanes = groupColumnsByEpic(cols);
    const epicCount = 2; // EPIC_A and UAT_EPIC are rows, not cards
    expect(lanes.reduce((n, l) => n + totalItems(l.columns as unknown as Record<string, PmBacklogItem[]>), 0)).toBe(before - epicCount);
  });
});

function drop(activeId: string, overId: string): DragEndEvent {
  return { active: { id: activeId, data: { current: undefined } }, over: { id: overId } } as unknown as DragEndEvent;
}

function dragHook(swimLane: SwimLaneMode) {
  const handleStatusChange = vi.fn().mockResolvedValue(undefined);
  const handleEpicMove = vi.fn().mockResolvedValue(undefined);
  const hook = renderHook(() =>
    useBoardDragDrop({
      columns: columns(),
      selectedSprintId: 'sprint-1',
      swimLane,
      loadBoardData: vi.fn(),
      loadBacklogItems: vi.fn(),
      handleStatusChange,
      handleEpicMove,
      sprints: [],
      handleSprintMove: vi.fn(),
      onDropRefused: vi.fn(),
    })
  ).result.current;
  return { hook, handleStatusChange, handleEpicMove };
}

describe('C6 drop into Pending UAT', () => {
  it('no-grouping mode: dropping on the column sets pending_uat', async () => {
    const { hook, handleStatusChange } = dragHook('off');
    await hook.handleDragEnd(drop('testing-1', 'pending_uat'));
    expect(handleStatusChange).toHaveBeenCalledWith('testing-1', 'pending_uat');
  });

  it('area mode: dropping on a pending_uat cell sets pending_uat', async () => {
    expect(parseSwimLaneCellId(buildSwimLaneCellId('area', 'Desktop', 'pending_uat'))).toEqual({
      dimension: 'area', groupKey: 'Desktop', status: 'pending_uat',
    });
    const { hook, handleStatusChange } = dragHook('area');
    await hook.handleDragEnd(drop('testing-1', buildSwimLaneCellId('area', 'Desktop', 'pending_uat')));
    expect(handleStatusChange).toHaveBeenCalledWith('testing-1', 'pending_uat');
  });

  it('project mode: dropping on an epic row pending_uat cell moves it there', async () => {
    const { hook, handleEpicMove } = dragHook('project');
    await hook.handleDragEnd(drop('testing-1', buildSwimLaneCellId('epic', 'epic-a', 'pending_uat')));
    expect(handleEpicMove).toHaveBeenCalledTimes(1);
    expect(handleEpicMove.mock.calls[0][1]).toMatchObject({ status: 'pending_uat', parent: { parentId: 'epic-a' } });
  });
});

describe('C7 drag out of Pending UAT', () => {
  it('no-grouping mode: a pending_uat card dropped on Completed becomes completed', async () => {
    const { hook, handleStatusChange } = dragHook('off');
    await hook.handleDragEnd(drop('uat-1', 'completed'));
    expect(handleStatusChange).toHaveBeenCalledWith('uat-1', 'completed');
  });

  it('status picker: Testing offers Pending UAT; Pending UAT offers Completed, Reopened, Testing', () => {
    expect(ALLOWED_TRANSITIONS.testing).toContain('pending_uat');
    expect(ALLOWED_TRANSITIONS.pending_uat).toEqual(['completed', 'reopened', 'testing']);
  });
});

describe('C8 status change and fallback', () => {
  async function mount() {
    localStorage.setItem('pm-board-state', JSON.stringify({ selectedSprintId: 'sprint-1', collapsedLanes: [], swimLane: 'off' }));
    const hook = renderHook(() => useBoardData());
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    await waitFor(() => expect(q.getBoardTasks).toHaveBeenCalled());
    return hook;
  }

  it('handleStatusChange(id, pending_uat) moves the card and calls updateItemStatus', async () => {
    const { result } = await mount();
    await waitFor(() => expect(result.current.columns.testing.map((i) => i.id)).toEqual(['testing-1']));
    await act(() => result.current.handleStatusChange('testing-1', 'pending_uat'));
    expect(q.updateItemStatus).toHaveBeenCalledWith('testing-1', 'pending_uat');
    expect(result.current.columns.pending_uat.map((i) => i.id)).toContain('testing-1');
    expect(result.current.columns.testing).toHaveLength(0);
  });

  it('when the board RPC fails, the listItems fallback still fills Pending UAT', async () => {
    q.getBoardTasks.mockRejectedValue(new Error('rpc down'));
    q.listItems.mockResolvedValue({ items: [UAT, TESTING] });
    const { result } = await mount();
    await waitFor(() => expect(result.current.columns.pending_uat.map((i) => i.id)).toEqual(['uat-1']));
  });
});
