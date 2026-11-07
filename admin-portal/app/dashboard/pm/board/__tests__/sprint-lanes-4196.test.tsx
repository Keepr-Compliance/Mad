// @vitest-environment jsdom

/**
 * BACKLOG-4196 PR-B: Sprint swim lanes on the PM board.
 *
 * Sprint mode shows one project (fetched like Project mode), one row per
 * sprint on the loaded items plus "No sprint". Dragging to another row moves
 * the item to that sprint; "No sprint" clears it; completed / cancelled
 * sprints refuse the drop. Status is written first, then the sprint.
 *
 * Items come from makeItem(), whose shape is transcribed from a real
 * pm_get_board_tasks row (to_jsonb(pm_backlog_items.*), sprint_id included).
 * Sprints follow the pm_list_sprints jsonb_build_object keys (id, legacy_id,
 * name, goal, status, start_date, end_date, project_id, created_at,
 * item_counts, total_items) with placeholder values.
 */

import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { DndContext, type DragEndEvent } from '@dnd-kit/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardColumns, ItemStatus, PmBacklogItem, PmProject, PmSprint } from '@/lib/pm-types';
import { makeItem, PROJECT_ID, toColumns } from './board-fixtures';

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

import { SprintLaneGrid } from '../components/BoardColumn';
import { BoardFilters } from '../components/BoardFilters';
import { buildSwimLaneCellId, NO_SPRINT_KEY, parseSwimLaneCellId } from '../lib/swim-lane-ids';
import {
  CLOSED_SPRINT_MESSAGE,
  groupColumnsBySprint,
  resolveSprintDrop,
  sprintLaneLabel,
  UNKNOWN_SPRINT_MESSAGE,
} from '../lib/sprint-lanes';
import { useBoardDragDrop } from '../hooks/useBoardDragDrop';
import { useBoardData } from '../hooks/useBoardData';
import BoardPage from '../page';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function sprint(o: Partial<PmSprint> & Pick<PmSprint, 'id' | 'status'>): PmSprint {
  return {
    legacy_id: null,
    name: o.id,
    goal: null,
    start_date: null,
    end_date: null,
    project_id: null,
    created_at: '2026-11-01T00:00:00+00:00',
    item_counts: {},
    total_items: 0,
    ...o,
  } as PmSprint;
}

const ACTIVE = sprint({ id: 'sp-active', status: 'active', legacy_id: 'SPRINT-10', name: 'Now', start_date: '2026-11-01' });
const PLANNED_LATE = sprint({ id: 'sp-planned-late', status: 'planned', legacy_id: 'SPRINT-12', name: 'Later', start_date: '2026-12-01' });
const PLANNED_EARLY = sprint({ id: 'sp-planned-early', status: 'planned', legacy_id: 'SPRINT-11', name: 'Next', start_date: '2026-11-15' });
const PLANNED_UNDATED = sprint({ id: 'sp-planned-undated', status: 'planned', name: 'Someday' });
const DONE = sprint({ id: 'sp-done', status: 'completed', legacy_id: 'SPRINT-9', name: 'Done', start_date: '2026-10-01' });
const CANCELLED = sprint({ id: 'sp-cancelled', status: 'cancelled', legacy_id: 'SPRINT-8', name: 'Dropped' });
// Sprints the board knows about but no loaded item uses: never a row.
const EMPTY_ACTIVE = sprint({ id: 'sp-empty', status: 'active', name: 'Empty' });

const SPRINTS = [DONE, CANCELLED, PLANNED_LATE, PLANNED_UNDATED, ACTIVE, PLANNED_EARLY, EMPTY_ACTIVE];

const IN_ACTIVE = makeItem({ id: 'in-active', item_number: 1, sprint_id: ACTIVE.id, status: 'pending' });
const IN_ACTIVE_2 = makeItem({ id: 'in-active-2', item_number: 2, sprint_id: ACTIVE.id, status: 'testing' });
const IN_LATE = makeItem({ id: 'in-late', item_number: 3, sprint_id: PLANNED_LATE.id, status: 'pending' });
const IN_EARLY = makeItem({ id: 'in-early', item_number: 4, sprint_id: PLANNED_EARLY.id, status: 'in_progress' });
const IN_UNDATED = makeItem({ id: 'in-undated', item_number: 5, sprint_id: PLANNED_UNDATED.id, status: 'pending' });
const IN_DONE = makeItem({ id: 'in-done', item_number: 6, sprint_id: DONE.id, status: 'completed' });
const IN_CANCELLED = makeItem({ id: 'in-cancelled', item_number: 7, sprint_id: CANCELLED.id, status: 'obsolete' });
const IN_GONE = makeItem({ id: 'in-gone', item_number: 8, sprint_id: 'sp-gone', status: 'pending' });
const NO_SPRINT = makeItem({ id: 'no-sprint', item_number: 9, sprint_id: null, status: 'pending' });

const ITEMS = [IN_ACTIVE, IN_ACTIVE_2, IN_LATE, IN_EARLY, IN_UNDATED, IN_DONE, IN_CANCELLED, IN_GONE, NO_SPRINT];

function sprintColumns(): BoardColumns {
  return toColumns(ITEMS);
}

const PROJECTS = [{ id: PROJECT_ID, name: 'Stable', status: 'active' }] as PmProject[];

function persist(state: Record<string, unknown>) {
  localStorage.setItem(
    'pm-board-state',
    JSON.stringify({ selectedSprintId: '', collapsedLanes: [], ...state })
  );
}

function allIds(cols: BoardColumns): string[] {
  return (Object.values(cols) as PmBacklogItem[][]).flat().map((i) => i.id).sort();
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const fn of Object.values(q)) fn.mockReset();
  q.listSprints.mockResolvedValue(SPRINTS);
  q.listProjects.mockResolvedValue(PROJECTS);
  q.listAssignableUsers.mockResolvedValue([]);
  q.listLabels.mockResolvedValue([]);
  q.listItems.mockResolvedValue({ items: [] });
  q.getBoardTasks.mockResolvedValue(sprintColumns());
  q.fetchItemLabels.mockResolvedValue(new Map());
  q.createItem.mockResolvedValue({ id: 'new-id', item_number: 999, legacy_id: 'BACKLOG-999' });
  q.updateItemStatus.mockResolvedValue({ success: true });
  q.updateItemField.mockResolvedValue({ success: true });
  q.assignToSprint.mockResolvedValue({ success: true, updated_count: 1 });
  q.bulkUpdate.mockResolvedValue(undefined);
});
afterEach(cleanup);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('sprint rows', () => {
  it('orders active, planned (by start_date, undated last), completed, cancelled, unknown, then No sprint', () => {
    const lanes = groupColumnsBySprint(sprintColumns(), SPRINTS);
    expect(lanes.map((l) => l.key)).toEqual([
      ACTIVE.id,
      PLANNED_EARLY.id,
      PLANNED_LATE.id,
      PLANNED_UNDATED.id,
      DONE.id,
      CANCELLED.id,
      'sp-gone',
      NO_SPRINT_KEY,
    ]);
  });

  it('puts each item in its sprint row; a sprint with no loaded item has no row', () => {
    const lanes = groupColumnsBySprint(sprintColumns(), SPRINTS);
    const byKey = new Map(lanes.map((l) => [l.key, allIds(l.columns)]));
    expect(byKey.get(ACTIVE.id)).toEqual(['in-active', 'in-active-2']);
    expect(byKey.get(NO_SPRINT_KEY)).toEqual(['no-sprint']);
    expect(byKey.has(EMPTY_ACTIVE.id)).toBe(false);
  });

  it('"No sprint" is present even when every item has a sprint', () => {
    const lanes = groupColumnsBySprint(toColumns([IN_ACTIVE]), SPRINTS);
    expect(lanes.map((l) => l.key)).toEqual([ACTIVE.id, NO_SPRINT_KEY]);
  });

  it('row label is "legacy_id — name", the name alone, the raw id when unknown', () => {
    expect(sprintLaneLabel(ACTIVE.id, ACTIVE)).toBe('SPRINT-10 — Now');
    expect(sprintLaneLabel(PLANNED_UNDATED.id, PLANNED_UNDATED)).toBe('Someday');
    expect(sprintLaneLabel('sp-gone', null)).toBe('sp-gone');
    expect(sprintLaneLabel(NO_SPRINT_KEY, null)).toBe('No sprint');
  });

  it('sprint cell ids round-trip, including "No sprint"', () => {
    expect(parseSwimLaneCellId(buildSwimLaneCellId('sprint', ACTIVE.id, 'testing'))).toEqual({
      dimension: 'sprint', groupKey: ACTIVE.id, status: 'testing',
    });
    expect(parseSwimLaneCellId(buildSwimLaneCellId('sprint', NO_SPRINT_KEY, 'pending'))?.groupKey).toBe(NO_SPRINT_KEY);
  });
});

describe('resolveSprintDrop', () => {
  const base = { sprints: SPRINTS };
  it('same row, other column: status only', () => {
    expect(resolveSprintDrop({ ...base, item: IN_ACTIVE, currentStatus: 'pending', targetLaneKey: ACTIVE.id, targetStatus: 'testing' }))
      .toEqual({ status: 'testing', sprint: null });
  });
  it('same row, same column: nothing', () => {
    expect(resolveSprintDrop({ ...base, item: IN_ACTIVE, currentStatus: 'pending', targetLaneKey: ACTIVE.id, targetStatus: 'pending' })).toBeNull();
  });
  it('other row: sprint, and status when the column changed', () => {
    expect(resolveSprintDrop({ ...base, item: IN_ACTIVE, currentStatus: 'pending', targetLaneKey: PLANNED_EARLY.id, targetStatus: 'pending' }))
      .toEqual({ status: null, sprint: { sprintId: PLANNED_EARLY.id } });
    expect(resolveSprintDrop({ ...base, item: IN_ACTIVE, currentStatus: 'pending', targetLaneKey: PLANNED_EARLY.id, targetStatus: 'blocked' }))
      .toEqual({ status: 'blocked', sprint: { sprintId: PLANNED_EARLY.id } });
  });
  it('"No sprint" clears the sprint', () => {
    expect(resolveSprintDrop({ ...base, item: IN_ACTIVE, currentStatus: 'pending', targetLaneKey: NO_SPRINT_KEY, targetStatus: 'pending' }))
      .toEqual({ status: null, sprint: { sprintId: null } });
  });
  it.each([
    ['completed', DONE],
    ['cancelled', CANCELLED],
  ])('a %s target sprint is refused', (_s, target) => {
    expect(resolveSprintDrop({ ...base, item: IN_ACTIVE, currentStatus: 'pending', targetLaneKey: target.id, targetStatus: 'pending' }))
      .toEqual({ refused: CLOSED_SPRINT_MESSAGE(sprintLaneLabel(target.id, target)) });
  });
  it('a target sprint missing from the sprint list is refused with its own message', () => {
    expect(resolveSprintDrop({ ...base, item: IN_ACTIVE, currentStatus: 'pending', targetLaneKey: 'sp-gone', targetStatus: 'pending' }))
      .toEqual({ refused: UNKNOWN_SPRINT_MESSAGE });
  });
  it('moving OUT of a completed sprint is allowed', () => {
    expect(resolveSprintDrop({ ...base, item: IN_DONE, currentStatus: 'completed', targetLaneKey: ACTIVE.id, targetStatus: 'completed' }))
      .toEqual({ status: null, sprint: { sprintId: ACTIVE.id } });
  });
  it('a status change inside a completed row is allowed (no sprint write)', () => {
    expect(resolveSprintDrop({ ...base, item: IN_DONE, currentStatus: 'completed', targetLaneKey: DONE.id, targetStatus: 'reopened' }))
      .toEqual({ status: 'reopened', sprint: null });
  });
});

// ---------------------------------------------------------------------------
// useBoardData in Sprint mode
// ---------------------------------------------------------------------------

async function mountSprintMode(extra: Record<string, unknown> = {}) {
  persist({ swimLane: 'sprint', selectedProjectId: PROJECT_ID, ...extra });
  const hook = renderHook(() => useBoardData());
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  await waitFor(() => expect(q.getBoardTasks).toHaveBeenCalled());
  await waitFor(() => expect(hook.result.current.sprints).toHaveLength(SPRINTS.length));
  return hook;
}

describe('Sprint mode loading', () => {
  it('fetches the whole project, never a sprint, even with a persisted sprint', async () => {
    const { result } = await mountSprintMode({ selectedSprintId: 'stale-sprint' });
    expect(q.getBoardTasks).toHaveBeenCalledWith(null, PROJECT_ID);
    for (const call of q.getBoardTasks.mock.calls) expect(call[0]).toBeNull();
    expect(result.current.projectScoped).toBe(true);
    expect(result.current.projectMode).toBe(false);
    expect(allIds(result.current.columns)).toEqual(ITEMS.map((i) => i.id).sort());
  });

  it('a sprint list arriving after mount does not refetch the project', async () => {
    const { result } = await mountSprintMode();
    await waitFor(() => expect(result.current.selectedSprintId).toBe(ACTIVE.id));
    expect(q.getBoardTasks).toHaveBeenCalledTimes(1);
  });

  it('merges labels onto items in Sprint mode', async () => {
    const label = { id: 'label-x', name: 'X', color: '#000000', project_id: null };
    q.fetchItemLabels.mockResolvedValue(new Map([['in-active', [label]]]));
    const { result } = await mountSprintMode();
    await waitFor(() =>
      expect(result.current.columns.pending.find((i) => i.id === 'in-active')?.labels).toEqual([label])
    );
  });

  it('drops a slow response for the previous project', async () => {
    let resolveP: (v: unknown) => void = () => {};
    const slowP = new Promise((r) => { resolveP = r; });
    const colsQ = toColumns([makeItem({ id: 'q-item', item_number: 50, project_id: 'project-q', sprint_id: ACTIVE.id })]);
    q.getBoardTasks.mockImplementation((_s: unknown, pid: string) =>
      pid === PROJECT_ID ? slowP : Promise.resolve(colsQ)
    );
    persist({ swimLane: 'sprint', selectedProjectId: PROJECT_ID, selectedSprintId: 'stale-sprint' });
    const { result } = renderHook(() => useBoardData());
    await waitFor(() => expect(q.getBoardTasks).toHaveBeenCalledWith(null, PROJECT_ID));
    act(() => result.current.setSelectedProjectId('project-q'));
    await waitFor(() => expect(q.getBoardTasks).toHaveBeenCalledWith(null, 'project-q'));
    await waitFor(() => expect(allIds(result.current.columns)).toEqual(['q-item']));
    await act(async () => { resolveP(sprintColumns()); await slowP; });
    expect(allIds(result.current.columns)).toEqual(['q-item']);
  });
});

describe('handleSprintMove', () => {
  it('writes status first, then assignToSprint(target), then reloads', async () => {
    const { result } = await mountSprintMode();
    const order: string[] = [];
    q.updateItemStatus.mockImplementation(async () => { order.push('status'); return { success: true }; });
    q.assignToSprint.mockImplementation(async () => { order.push('sprint'); return { success: true }; });
    const loadsBefore = q.getBoardTasks.mock.calls.length;
    await act(() => result.current.handleSprintMove(IN_ACTIVE, { status: 'testing', sprint: { sprintId: PLANNED_EARLY.id } }));
    expect(order).toEqual(['status', 'sprint']);
    expect(q.updateItemStatus).toHaveBeenCalledWith('in-active', 'testing');
    expect(q.assignToSprint).toHaveBeenCalledWith(['in-active'], PLANNED_EARLY.id);
    expect(q.updateItemField).not.toHaveBeenCalled();
    expect(q.getBoardTasks.mock.calls.length).toBeGreaterThan(loadsBefore);
    expect(result.current.boardError).toBeNull();
  });

  it('"No sprint" clears sprint_id with updateItemField', async () => {
    const { result } = await mountSprintMode();
    await act(() => result.current.handleSprintMove(IN_ACTIVE, { status: null, sprint: { sprintId: null } }));
    expect(q.updateItemField).toHaveBeenCalledWith('in-active', 'sprint_id', null);
    expect(q.assignToSprint).not.toHaveBeenCalled();
    expect(q.updateItemStatus).not.toHaveBeenCalled();
  });

  it('a status failure writes no sprint and says the move failed', async () => {
    const { result } = await mountSprintMode();
    q.updateItemStatus.mockRejectedValue(new Error('denied'));
    await act(() => result.current.handleSprintMove(IN_ACTIVE, { status: 'testing', sprint: { sprintId: PLANNED_EARLY.id } }));
    expect(q.assignToSprint).not.toHaveBeenCalled();
    expect(result.current.boardError).toBe('Could not move #1. The board was reloaded.');
  });

  it('a sprint failure after the status saved says so', async () => {
    const { result } = await mountSprintMode();
    q.assignToSprint.mockRejectedValue(new Error('Sprint not found'));
    const loadsBefore = q.getBoardTasks.mock.calls.length;
    await act(() => result.current.handleSprintMove(IN_ACTIVE, { status: 'testing', sprint: { sprintId: PLANNED_EARLY.id } }));
    expect(result.current.boardError).toBe(
      '#1: the status was saved but the sprint move failed. The board was reloaded.'
    );
    expect(q.getBoardTasks.mock.calls.length).toBeGreaterThan(loadsBefore);
  });
});

describe('sprint-only actions are no-ops in Sprint mode (persisted sprint on file)', () => {
  it('bulk assign-sprint writes nothing', async () => {
    const { result } = await mountSprintMode({ selectedSprintId: 'stale-sprint' });
    // A sprint id is on file (persisted or auto-picked), so only the mode guard stops the write.
    expect(result.current.selectedSprintId).toBeTruthy();
    act(() => result.current.handleToggleSelect('in-active'));
    await act(() => result.current.handleBulkAssignSprint());
    expect(q.assignToSprint).not.toHaveBeenCalled();
  });

  it('other modes unchanged: Area mode bulk assign-sprint still writes to the selected sprint', async () => {
    persist({ swimLane: 'area', selectedSprintId: ACTIVE.id });
    const { result } = renderHook(() => useBoardData());
    await waitFor(() => expect(q.getBoardTasks).toHaveBeenCalledWith(ACTIVE.id));
    act(() => result.current.handleToggleSelect('in-active'));
    await act(() => result.current.handleBulkAssignSprint());
    expect(q.assignToSprint).toHaveBeenCalledWith(['in-active'], ACTIVE.id);
  });
});

describe('Add in a sprint row', () => {
  it('creates the item in the picked project and the row sprint (no sprint selected)', async () => {
    const { result } = await mountSprintMode();
    expect(result.current.selectedSprintId).not.toBe(PLANNED_EARLY.id);
    await act(() => result.current.handleQuickAdd('New one', 'pending', PLANNED_EARLY.id));
    expect(q.createItem).toHaveBeenCalledWith({ title: 'New one', project_id: PROJECT_ID, sprint_id: PLANNED_EARLY.id });
  });

  it('in "No sprint" creates with sprint_id null, and sets a non-pending status', async () => {
    const { result } = await mountSprintMode();
    await act(() => result.current.handleQuickAdd('Loose', 'testing', NO_SPRINT_KEY));
    expect(q.createItem).toHaveBeenCalledWith({ title: 'Loose', project_id: PROJECT_ID, sprint_id: null });
    expect(q.updateItemStatus).toHaveBeenCalledWith('new-id', 'testing');
  });

  it('refuses a row whose sprint has no loaded item of the picked project', async () => {
    const { result } = await mountSprintMode();
    await act(() => result.current.handleQuickAdd('Stale', 'pending', EMPTY_ACTIVE.id));
    expect(q.createItem).not.toHaveBeenCalled();
    expect(result.current.boardError).toMatch(/Could not add the item/);
  });

  it('refuses a completed sprint row', async () => {
    const { result } = await mountSprintMode();
    await act(() => result.current.handleQuickAdd('Late', 'pending', DONE.id));
    expect(q.createItem).not.toHaveBeenCalled();
    expect(result.current.boardError).toMatch(/the sprint is closed/);
  });
});

// ---------------------------------------------------------------------------
// Drops
// ---------------------------------------------------------------------------

const handleStatusChange = vi.fn();
const handleEpicMove = vi.fn();
const handleSprintMove = vi.fn();
const onDropRefused = vi.fn();
const loadBoardData = vi.fn();
const loadBacklogItems = vi.fn();

function mountDrag(swimLane: 'sprint' | 'area' = 'sprint', selectedSprintId = 'stale-sprint') {
  for (const fn of [handleStatusChange, handleEpicMove, handleSprintMove, onDropRefused, loadBoardData, loadBacklogItems]) {
    fn.mockReset();
    fn.mockResolvedValue(undefined);
  }
  return renderHook(() =>
    useBoardDragDrop({
      columns: sprintColumns(),
      selectedSprintId,
      swimLane,
      loadBoardData,
      loadBacklogItems,
      handleStatusChange,
      handleEpicMove,
      sprints: SPRINTS,
      handleSprintMove,
      onDropRefused,
    })
  ).result.current;
}

function drop(activeId: string, overId: string, data?: unknown): DragEndEvent {
  return { active: { id: activeId, data: { current: data } }, over: { id: overId } } as unknown as DragEndEvent;
}

const cell = (key: string, status: ItemStatus) => buildSwimLaneCellId('sprint', key, status);

function noWrites() {
  expect(q.assignToSprint).not.toHaveBeenCalled();
  expect(q.updateItemField).not.toHaveBeenCalled();
  expect(q.updateItemStatus).not.toHaveBeenCalled();
  expect(handleSprintMove).not.toHaveBeenCalled();
}

describe('Sprint mode drops', () => {
  it('same row, other column: optimistic status only, no sprint write', async () => {
    await mountDrag().handleDragEnd(drop('in-active', cell(ACTIVE.id, 'testing')));
    expect(handleStatusChange).toHaveBeenCalledWith('in-active', 'testing');
    expect(handleSprintMove).not.toHaveBeenCalled();
    expect(q.assignToSprint).not.toHaveBeenCalled();
  });

  it('other row: handleSprintMove with status and target sprint', async () => {
    await mountDrag().handleDragEnd(drop('in-active', cell(PLANNED_EARLY.id, 'blocked')));
    expect(handleSprintMove).toHaveBeenCalledTimes(1);
    const [item, plan] = handleSprintMove.mock.calls[0];
    expect(item.id).toBe('in-active');
    expect(plan).toEqual({ status: 'blocked', sprint: { sprintId: PLANNED_EARLY.id } });
    expect(handleStatusChange).not.toHaveBeenCalled();
  });

  it('onto a card in another row uses that card\'s sprint', async () => {
    await mountDrag().handleDragEnd(drop('in-active', 'in-early'));
    expect(handleSprintMove.mock.calls[0][1]).toEqual({ status: 'in_progress', sprint: { sprintId: PLANNED_EARLY.id } });
  });

  it('into "No sprint" clears the sprint', async () => {
    await mountDrag().handleDragEnd(drop('in-active', cell(NO_SPRINT_KEY, 'pending')));
    expect(handleSprintMove.mock.calls[0][1]).toEqual({ status: null, sprint: { sprintId: null } });
  });

  it.each([
    ['completed', DONE],
    ['cancelled', CANCELLED],
  ])('into a %s sprint is refused with a message, nothing written', async (_s, target) => {
    await mountDrag().handleDragEnd(drop('in-active', cell(target.id, 'pending')));
    expect(onDropRefused).toHaveBeenCalledWith(CLOSED_SPRINT_MESSAGE(sprintLaneLabel(target.id, target)));
    noWrites();
    expect(handleStatusChange).not.toHaveBeenCalled();
  });

  it('out of a completed sprint into an active one is allowed', async () => {
    await mountDrag().handleDragEnd(drop('in-done', cell(ACTIVE.id, 'completed')));
    expect(handleSprintMove.mock.calls[0][1]).toEqual({ status: null, sprint: { sprintId: ACTIVE.id } });
    expect(onDropRefused).not.toHaveBeenCalled();
  });

  it('a non-sprint cell id is ignored', async () => {
    await mountDrag().handleDragEnd(drop('in-active', buildSwimLaneCellId('epic', PLANNED_EARLY.id, 'testing')));
    noWrites();
    expect(handleStatusChange).not.toHaveBeenCalled();
  });

  it('a card dropped on the backlog panel is NOT unassigned', async () => {
    await mountDrag().handleDragEnd(drop('in-active', 'backlog-panel'));
    noWrites();
  });

  it('a backlog-panel item dropped on the board is NOT assigned to the persisted sprint', async () => {
    await mountDrag().handleDragEnd(drop('in-late', cell(ACTIVE.id, 'pending'), { type: 'backlog-item', item: IN_LATE }));
    noWrites();
  });

  it('other modes unchanged: Area mode backlog-panel drop still unassigns', async () => {
    await mountDrag('area', ACTIVE.id).handleDragEnd(drop('in-active', 'backlog-panel'));
    expect(q.updateItemField).toHaveBeenCalledWith('in-active', 'sprint_id', null);
  });
});

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

describe('SprintLaneGrid', () => {
  it('renders one row per sprint with its label and status pill, "No sprint" last', () => {
    render(
      <DndContext>
        <SprintLaneGrid
          columns={sprintColumns()}
          sprints={SPRINTS}
          collapsedLanes={new Set()}
          onToggleLane={vi.fn()}
          selectedIds={new Set()}
          onToggleSelect={vi.fn()}
          onItemUpdated={vi.fn()}
          onQuickAdd={vi.fn()}
          users={[]}
          allLabels={[]}
          compactCards={false}
        />
      </DndContext>
    );
    const rows = screen.getAllByTestId(/^sprint-lane-(?!status)/);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      `sprint-lane-${ACTIVE.id}`,
      `sprint-lane-${PLANNED_EARLY.id}`,
      `sprint-lane-${PLANNED_LATE.id}`,
      `sprint-lane-${PLANNED_UNDATED.id}`,
      `sprint-lane-${DONE.id}`,
      `sprint-lane-${CANCELLED.id}`,
      'sprint-lane-sp-gone',
      'sprint-lane-none',
    ]);
    const active = screen.getByTestId(`sprint-lane-${ACTIVE.id}`);
    expect(within(active).getByText('SPRINT-10 — Now')).toBeTruthy();
    expect(within(active).getByTestId(`sprint-lane-status-${ACTIVE.id}`).textContent).toBe('Active');
    expect(within(screen.getByTestId('sprint-lane-sp-gone')).getByText('sp-gone')).toBeTruthy();
    expect(active.querySelector(`[data-droppable-id="${cell(ACTIVE.id, 'pending')}"]`)).not.toBeNull();
  });
});

describe('BoardFilters in Sprint mode', () => {
  it('shows the project picker and hides the sprint selector and Backlog button', () => {
    render(
      <BoardFilters
        sprints={SPRINTS}
        selectedSprintId={ACTIVE.id}
        onSprintChange={vi.fn()}
        projects={PROJECTS}
        selectedProjectId={PROJECT_ID}
        onProjectChange={vi.fn()}
        swimLane="sprint"
        onSwimLaneChange={vi.fn()}
        compactCards={false}
        onCompactToggle={vi.fn()}
        refreshing={false}
        onRefresh={vi.fn()}
        backlogOpen={false}
        onBacklogToggle={vi.fn()}
      />
    );
    expect(screen.getByTestId('project-picker').textContent).toBe('Stable');
    expect(screen.queryByText(/SPRINT-10/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Backlog' })).toBeNull();
  });

  it('the swim-lane selector offers Sprint', () => {
    const onSwimLaneChange = vi.fn();
    render(
      <BoardFilters
        sprints={[]} selectedSprintId="" onSprintChange={vi.fn()} projects={PROJECTS}
        selectedProjectId="" onProjectChange={vi.fn()} swimLane="off" onSwimLaneChange={onSwimLaneChange}
        compactCards={false} onCompactToggle={vi.fn()} refreshing={false} onRefresh={vi.fn()}
        backlogOpen={false} onBacklogToggle={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sprint' }));
    expect(onSwimLaneChange).toHaveBeenCalledWith('sprint');
  });
});

describe('BoardPage in Sprint mode', () => {
  it('shows sprint rows with no sprint selected, and no backlog panel', async () => {
    persist({ swimLane: 'sprint', selectedProjectId: PROJECT_ID, selectedSprintId: '' });
    q.listSprints.mockResolvedValue([]); // no auto-picked sprint either
    render(<BoardPage />);
    await screen.findByTestId('sprint-lane-none');
    expect(screen.queryByText('Select a sprint to view the board')).toBeNull();
    expect(screen.queryByTitle('Open backlog panel')).toBeNull();
  });

  it('with no project picked, asks for one', async () => {
    persist({ swimLane: 'sprint' });
    render(<BoardPage />);
    await screen.findByText('Select a project to view the board');
    expect(q.getBoardTasks).not.toHaveBeenCalled();
  });

  it('other modes unchanged: Area mode still shows the backlog panel toggle', async () => {
    persist({ swimLane: 'area', selectedSprintId: ACTIVE.id });
    render(<BoardPage />);
    await screen.findByTitle('Open backlog panel');
  });
});
