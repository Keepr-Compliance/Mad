// @vitest-environment jsdom

/**
 * BACKLOG-4196 PR-A: Label swim lanes on the PM board.
 *
 * C4 an item with several labels is in every label's row; C5 an unlabelled
 * item is in "No label"; C7 labels are merged onto the board items; C8 a
 * labels response for a stale source is dropped; C9 a labels failure keeps
 * the columns, flags it, and label mode shows no grid; C10 an unknown
 * persisted mode falls back to Project; C11 Add in a label row labels the new
 * item (never for "No label", failure non-fatal); C12 a drop onto a lane copy
 * in another row resolves that copy's status; C13 a dragged lane copy
 * resolves to its item; C14 lane copies get distinct drag ids.
 *
 * Items come from makeItem(), whose shape is transcribed from a real
 * pm_get_board_tasks row. Label objects follow the live pm_labels embed
 * shape (id, name, color, project_id) with placeholder values.
 */

import { act, cleanup, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { DndContext, type DragEndEvent } from '@dnd-kit/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardColumns, PmBacklogItem, PmLabel } from '@/lib/pm-types';
import { makeItem, toColumns } from './board-fixtures';

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

// Record every drag id a card registers (C14).
const sortableIds = vi.hoisted(() => [] as string[]);
vi.mock('@dnd-kit/sortable', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/sortable')>();
  return {
    ...actual,
    useSortable: (args: Parameters<typeof actual.useSortable>[0]) => {
      sortableIds.push(String(args.id));
      return actual.useSortable(args);
    },
  };
});

import { groupItemsByDimension, SwimLaneGrid } from '../components/BoardColumn';
import {
  buildCardSortableId,
  buildSwimLaneCellId,
  NO_LABEL_KEY,
} from '../lib/swim-lane-ids';
import { useBoardDragDrop } from '../hooks/useBoardDragDrop';
import { LABELS_LOAD_ERROR, useBoardData } from '../hooks/useBoardData';
import BoardPage from '../page';

const ALPHA: PmLabel = { id: 'label-alpha', name: 'Alpha', color: '#111111', project_id: null };
const BETA: PmLabel = { id: 'label-beta', name: 'Beta', color: '#222222', project_id: 'project-p' };

// TWO has both labels, ONE only Alpha, NONE no label.
const TWO = makeItem({ id: 'two', item_number: 1, title: 'Two labels', status: 'pending', sprint_id: 'sprint-1' });
const ONE = makeItem({ id: 'one', item_number: 2, title: 'One label', status: 'testing', sprint_id: 'sprint-1' });
const NONE = makeItem({ id: 'none', item_number: 3, title: 'No labels', status: 'pending', sprint_id: 'sprint-1' });
const OTHER = makeItem({ id: 'other', item_number: 4, title: 'Other sprint', status: 'pending', sprint_id: 'sprint-2' });

function labelMap(): Map<string, PmLabel[]> {
  return new Map([
    ['two', [ALPHA, BETA]],
    ['one', [ALPHA]],
  ]);
}

/** Columns as the board holds them after labels were merged. */
function labelledColumns(): BoardColumns {
  const map = labelMap();
  return toColumns([TWO, ONE, NONE].map((i) => ({ ...i, labels: map.get(i.id) ?? [] })));
}

function ids(cols: BoardColumns | undefined): string[] {
  if (!cols) return [];
  return (Object.values(cols) as PmBacklogItem[][]).flat().map((i) => i.id).sort();
}

function persist(state: Record<string, unknown>) {
  localStorage.setItem(
    'pm-board-state',
    JSON.stringify({ selectedSprintId: 'sprint-1', collapsedLanes: [], ...state })
  );
}

beforeEach(() => {
  localStorage.clear();
  sortableIds.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const fn of Object.values(q)) fn.mockReset();
  q.listSprints.mockResolvedValue([
    { id: 'sprint-1', status: 'active', name: 'S1' },
    { id: 'sprint-2', status: 'planned', name: 'S2' },
  ]);
  q.listProjects.mockResolvedValue([]);
  q.listAssignableUsers.mockResolvedValue([]);
  q.listLabels.mockResolvedValue([]);
  q.listItems.mockResolvedValue({ items: [] });
  q.getBoardTasks.mockImplementation(async (sprintId: string | null) =>
    sprintId === 'sprint-2' ? toColumns([OTHER]) : toColumns([TWO, ONE, NONE])
  );
  q.fetchItemLabels.mockResolvedValue(labelMap());
  q.createItem.mockResolvedValue({ id: 'new-id', item_number: 999, legacy_id: 'BACKLOG-999' });
  q.updateItemStatus.mockResolvedValue({ success: true });
  q.addItemLabel.mockResolvedValue({ success: true });
});
afterEach(cleanup);

// ---------------------------------------------------------------------------
// Grouping and rendering
// ---------------------------------------------------------------------------

describe('label grouping', () => {
  it('C4: an item with two labels is in both label groups', () => {
    const groups = groupItemsByDimension(labelledColumns(), 'label');
    expect(ids(groups.get(ALPHA.id))).toEqual(['one', 'two']);
    expect(ids(groups.get(BETA.id))).toEqual(['two']);
  });

  it('C5: an item with no labels is in "No label", and only there', () => {
    const groups = groupItemsByDimension(labelledColumns(), 'label');
    expect(ids(groups.get(NO_LABEL_KEY))).toEqual(['none']);
    expect(Array.from(groups.keys()).sort()).toEqual([ALPHA.id, BETA.id, NO_LABEL_KEY].sort());
  });
});

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

function renderLabelGrid() {
  return render(
    <DndContext>
      <SwimLaneGrid columns={labelledColumns()} swimLane="label" nameMap={new Map()} {...gridProps} />
    </DndContext>
  );
}

describe('label rows', () => {
  it('rows are named by label, in name order, "No label" last; the card is in each of its rows', () => {
    renderLabelGrid();
    const rows = screen.getAllByTestId(/^swim-lane-/).map((r) => r.getAttribute('data-testid'));
    expect(rows).toEqual([`swim-lane-${ALPHA.id}`, `swim-lane-${BETA.id}`, `swim-lane-${NO_LABEL_KEY}`]);
    const alphaRow = screen.getByTestId(`swim-lane-${ALPHA.id}`);
    expect(within(alphaRow).getAllByText('Alpha').length).toBeGreaterThan(0);
    const cellA = document.querySelector(`[data-droppable-id="${buildSwimLaneCellId('label', ALPHA.id, 'pending')}"]`)!;
    const cellB = document.querySelector(`[data-droppable-id="${buildSwimLaneCellId('label', BETA.id, 'pending')}"]`)!;
    expect(within(cellA as HTMLElement).getByText('Two labels')).toBeTruthy();
    expect(within(cellB as HTMLElement).getByText('Two labels')).toBeTruthy();
  });

  it('C14: each copy of a card registers its own drag id', () => {
    renderLabelGrid();
    expect(sortableIds).toContain(buildCardSortableId('two', ALPHA.id));
    expect(sortableIds).toContain(buildCardSortableId('two', BETA.id));
    expect(sortableIds).toContain(buildCardSortableId('none', NO_LABEL_KEY));
    expect(sortableIds).not.toContain('two');
  });

  it('area mode still uses plain item ids', () => {
    render(
      <DndContext>
        <SwimLaneGrid columns={labelledColumns()} swimLane="area" nameMap={new Map()} {...gridProps} />
      </DndContext>
    );
    expect(sortableIds).toContain('two');
    expect(sortableIds.some((id) => id.startsWith('card:'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// useBoardData
// ---------------------------------------------------------------------------

async function mountLabelMode() {
  persist({ swimLane: 'label' });
  const hook = renderHook(() => useBoardData());
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  await waitFor(() => expect(q.fetchItemLabels).toHaveBeenCalled());
  return hook;
}

describe('labels on the board', () => {
  it('C7: labels are read for the loaded items and merged onto them', async () => {
    const { result } = await mountLabelMode();
    expect(q.fetchItemLabels.mock.calls[0][0].slice().sort()).toEqual(['none', 'one', 'two']);
    await waitFor(() => {
      const two = result.current.columns.pending.find((i) => i.id === 'two');
      expect(two?.labels).toEqual([ALPHA, BETA]);
    });
    expect(result.current.columns.pending.find((i) => i.id === 'none')?.labels).toEqual([]);
    expect(result.current.labelsFailed).toBe(false);
  });

  it('C7: labels are merged in project mode too', async () => {
    q.getBoardTasks.mockResolvedValue(toColumns([TWO]));
    persist({ swimLane: 'project', selectedProjectId: 'project-p' });
    const { result } = renderHook(() => useBoardData());
    await waitFor(() => expect(result.current.columns.pending[0]?.labels).toEqual([ALPHA, BETA]));
  });

  it('C8: a labels response for a sprint no longer selected is dropped', async () => {
    let releaseFirst: (m: Map<string, PmLabel[]>) => void = () => {};
    q.fetchItemLabels.mockImplementationOnce(
      () => new Promise<Map<string, PmLabel[]>>((resolve) => { releaseFirst = resolve; })
    );
    persist({ swimLane: 'label' });
    const { result } = renderHook(() => useBoardData());
    await waitFor(() => expect(q.fetchItemLabels).toHaveBeenCalledTimes(1));
    act(() => result.current.setSelectedSprintId('sprint-2'));
    await waitFor(() => expect(ids(result.current.columns)).toEqual(['other']));
    await act(async () => { releaseFirst(labelMap()); });
    expect(ids(result.current.columns)).toEqual(['other']);
  });

  it('C9: a labels failure keeps the columns, flags it and shows the message', async () => {
    q.fetchItemLabels.mockRejectedValue(new Error('denied'));
    const { result } = await mountLabelMode();
    await waitFor(() => expect(result.current.labelsFailed).toBe(true));
    expect(ids(result.current.columns)).toEqual(['none', 'one', 'two']);
    expect(result.current.boardError).toBe(LABELS_LOAD_ERROR);
  });

  it('C9: after a failure, a successful reload clears the flag and the message', async () => {
    q.fetchItemLabels.mockRejectedValueOnce(new Error('denied'));
    const { result } = await mountLabelMode();
    await waitFor(() => expect(result.current.labelsFailed).toBe(true));
    await act(() => result.current.handleRefresh());
    expect(result.current.labelsFailed).toBe(false);
    expect(result.current.boardError).toBeNull();
  });

  it('C10: an unknown persisted mode falls back to Project', async () => {
    persist({ swimLane: 'sprint' });
    const { result } = renderHook(() => useBoardData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.swimLane).toBe('project');
  });

  it('C10: a persisted Label mode is restored', async () => {
    const { result } = await mountLabelMode();
    expect(result.current.swimLane).toBe('label');
  });
});

describe('Add in a label row', () => {
  it('C11: creates the item in the sprint, then attaches the row label', async () => {
    const { result } = await mountLabelMode();
    await act(() => result.current.handleQuickAdd('New thing', 'pending', ALPHA.id));
    expect(q.createItem).toHaveBeenCalledWith({ title: 'New thing', sprint_id: 'sprint-1' });
    expect(q.addItemLabel).toHaveBeenCalledWith('new-id', ALPHA.id);
  });

  it('C11: in "No label" no label is attached', async () => {
    const { result } = await mountLabelMode();
    await act(() => result.current.handleQuickAdd('New thing', 'pending', NO_LABEL_KEY));
    expect(q.createItem).toHaveBeenCalledTimes(1);
    expect(q.addItemLabel).not.toHaveBeenCalled();
  });

  it('C11: a label failure is not fatal: the board reloads and says so', async () => {
    q.addItemLabel.mockRejectedValue(new Error('denied'));
    const { result } = await mountLabelMode();
    const loadsBefore = q.getBoardTasks.mock.calls.length;
    await act(() => result.current.handleQuickAdd('New thing', 'pending', ALPHA.id));
    expect(q.getBoardTasks.mock.calls.length).toBe(loadsBefore + 1);
    expect(result.current.boardError).toContain('#999 was added');
  });

  it('area mode never attaches a label', async () => {
    persist({ swimLane: 'area' });
    const { result } = renderHook(() => useBoardData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(() => result.current.handleQuickAdd('New thing', 'pending', 'Desktop'));
    expect(q.addItemLabel).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Drag and drop in Label mode
// ---------------------------------------------------------------------------

describe('Label mode drops', () => {
  const handleStatusChange = vi.fn();
  const handleEpicMove = vi.fn();
  const loadBoardData = vi.fn();
  const loadBacklogItems = vi.fn();

  beforeEach(() => {
    for (const fn of [handleStatusChange, handleEpicMove, loadBoardData, loadBacklogItems]) {
      fn.mockReset();
      fn.mockResolvedValue(undefined);
    }
  });

  function mount() {
    return renderHook(() =>
      useBoardDragDrop({
        columns: labelledColumns(),
        selectedSprintId: 'sprint-1',
        swimLane: 'label',
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

  function noLabelOrFieldWrites() {
    expect(q.addItemLabel).not.toHaveBeenCalled();
    expect(q.updateItemField).not.toHaveBeenCalled();
    expect(q.assignToSprint).not.toHaveBeenCalled();
    expect(handleEpicMove).not.toHaveBeenCalled();
  }

  it('C12: a card dropped onto a lane copy of a card in another row takes that card\'s status', async () => {
    // "none" (pending, No label) dropped onto ONE's copy in the Alpha row (testing).
    await mount().handleDragEnd(
      drop(buildCardSortableId('none', NO_LABEL_KEY), buildCardSortableId('one', ALPHA.id))
    );
    expect(handleStatusChange).toHaveBeenCalledWith('none', 'testing');
    noLabelOrFieldWrites();
  });

  it('C13: a lane copy dropped on another row\'s cell changes status only', async () => {
    await mount().handleDragEnd(
      drop(buildCardSortableId('two', BETA.id), buildSwimLaneCellId('label', ALPHA.id, 'in_progress'))
    );
    expect(handleStatusChange).toHaveBeenCalledWith('two', 'in_progress');
    noLabelOrFieldWrites();
  });

  it('C13: dragging a lane copy starts a drag of its item', () => {
    const { result } = renderHook(() =>
      useBoardDragDrop({
        columns: labelledColumns(),
        selectedSprintId: 'sprint-1',
        swimLane: 'label',
        loadBoardData,
        loadBacklogItems,
        handleStatusChange,
        handleEpicMove,
      })
    );
    act(() =>
      result.current.handleDragStart({
        active: { id: buildCardSortableId('two', BETA.id), data: { current: undefined } },
      } as never)
    );
    expect(result.current.activeDragItem?.id).toBe('two');
  });

  it('a lane copy dropped in its own status in another row does nothing', async () => {
    await mount().handleDragEnd(
      drop(buildCardSortableId('two', ALPHA.id), buildSwimLaneCellId('label', NO_LABEL_KEY, 'pending'))
    );
    expect(handleStatusChange).not.toHaveBeenCalled();
    noLabelOrFieldWrites();
  });

  it('a lane copy dropped on the backlog panel unassigns its item from the sprint', async () => {
    q.updateItemField.mockResolvedValue(undefined);
    await mount().handleDragEnd(drop(buildCardSortableId('two', ALPHA.id), 'backlog-panel'));
    expect(q.updateItemField).toHaveBeenCalledWith('two', 'sprint_id', null);
  });
});

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

describe('BoardPage in Label mode', () => {
  it('C9: when labels fail, no lanes are shown (nothing lands in "No label")', async () => {
    q.fetchItemLabels.mockRejectedValue(new Error('denied'));
    persist({ swimLane: 'label' });
    render(<BoardPage />);
    await screen.findByTestId('label-lanes-unavailable');
    expect(screen.queryAllByTestId(/^swim-lane-/)).toHaveLength(0);
  });

  it('with labels loaded, the label rows render', async () => {
    persist({ swimLane: 'label' });
    render(<BoardPage />);
    await screen.findByTestId(`swim-lane-${ALPHA.id}`);
    expect(screen.queryByTestId('label-lanes-unavailable')).toBeNull();
  });
});
