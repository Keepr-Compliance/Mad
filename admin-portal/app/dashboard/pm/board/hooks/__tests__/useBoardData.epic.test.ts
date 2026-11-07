// @vitest-environment jsdom

/**
 * useBoardData in Project mode (BACKLOG-4176): fetch by project, persisted
 * project, Add backlog / Add epic, epic moves. Other modes unchanged.
 */

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHILD_A1, PROJECT_ID, makeItem, projectColumns, toColumns } from '../../__tests__/board-fixtures';
import { NO_EPIC_KEY } from '../../lib/swim-lane-ids';

const q = vi.hoisted(() => ({
  listSprints: vi.fn(),
  listItems: vi.fn(),
  listProjects: vi.fn(),
  getBoardTasks: vi.fn(),
  updateItemStatus: vi.fn(),
  reorderItem: vi.fn(),
  createItem: vi.fn(),
  assignItem: vi.fn(),
  bulkUpdate: vi.fn(),
  bulkDelete: vi.fn(),
  assignToSprint: vi.fn(),
  listAssignableUsers: vi.fn(),
  listLabels: vi.fn(),
  updateItemField: vi.fn(),
}));
vi.mock('@/lib/pm-queries', () => q);

import { useBoardData } from '../useBoardData';

const KEY = 'pm-board-state';

function persist(state: Record<string, unknown>) {
  localStorage.setItem(KEY, JSON.stringify({ selectedSprintId: '', collapsedLanes: [], ...state }));
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const fn of Object.values(q)) fn.mockReset();
  q.listSprints.mockResolvedValue([]);
  q.listProjects.mockResolvedValue([]);
  q.listAssignableUsers.mockResolvedValue([]);
  q.listLabels.mockResolvedValue([]);
  q.listItems.mockResolvedValue({ items: [] });
  q.getBoardTasks.mockResolvedValue(projectColumns());
  q.createItem.mockResolvedValue({ id: 'new-id', item_number: 999, legacy_id: 'BACKLOG-999' });
  q.updateItemStatus.mockResolvedValue({ success: true });
  q.reorderItem.mockResolvedValue({ success: true });
  q.assignToSprint.mockResolvedValue(undefined);
});
afterEach(cleanup);

async function mountProjectMode() {
  persist({ swimLane: 'project', selectedProjectId: PROJECT_ID });
  const hook = renderHook(() => useBoardData());
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  await waitFor(() => expect(q.getBoardTasks).toHaveBeenCalled());
  return hook;
}

describe('Project mode loading', () => {
  it('fetches the whole project, with no sprint', async () => {
    const { result } = await mountProjectMode();
    expect(q.getBoardTasks).toHaveBeenCalledWith(null, PROJECT_ID);
    expect(result.current.columns.pending.length).toBeGreaterThan(0);
  });

  it('a sprint list arriving after mount does not refetch the project', async () => {
    q.listSprints.mockResolvedValue([{ id: 'sprint-1', status: 'active', name: 'S' }]);
    const { result } = await mountProjectMode();
    await waitFor(() => expect(result.current.selectedSprintId).toBe('sprint-1'));
    expect(q.getBoardTasks).toHaveBeenCalledTimes(1);
  });

  it('with no project picked, fetches nothing and stops loading', async () => {
    persist({ swimLane: 'project' });
    const { result } = renderHook(() => useBoardData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(q.getBoardTasks).not.toHaveBeenCalled();
  });

  it('restores and persists the picked project', async () => {
    const { result } = await mountProjectMode();
    expect(result.current.selectedProjectId).toBe(PROJECT_ID);
    act(() => result.current.setSelectedProjectId('project-q'));
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(KEY)!).selectedProjectId).toBe('project-q')
    );
    await waitFor(() => expect(q.getBoardTasks).toHaveBeenCalledWith(null, 'project-q'));
  });
});

describe('Add backlog (Project mode quick add)', () => {
  it('creates in the project under the row epic, no sprint, then sets the column status', async () => {
    const { result } = await mountProjectMode();
    await act(() => result.current.handleQuickAdd('New thing', 'testing', 'epic-a'));
    expect(q.createItem).toHaveBeenCalledWith({ title: 'New thing', project_id: PROJECT_ID, parent_id: 'epic-a' });
    expect(q.updateItemStatus).toHaveBeenCalledWith('new-id', 'testing');
  });

  it('in the No epic row creates with no parent; Pending column needs no status call', async () => {
    const { result } = await mountProjectMode();
    await act(() => result.current.handleQuickAdd('Loose', 'pending', NO_EPIC_KEY));
    expect(q.createItem).toHaveBeenCalledWith({ title: 'Loose', project_id: PROJECT_ID, parent_id: null });
    expect(q.updateItemStatus).not.toHaveBeenCalled();
  });
});

describe('Add epic', () => {
  it('creates an epic in the picked project', async () => {
    const { result } = await mountProjectMode();
    await act(() => result.current.handleAddEpic('Fresh epic'));
    expect(q.createItem).toHaveBeenCalledWith({ title: 'Fresh epic', type: 'epic', project_id: PROJECT_ID });
  });
});

describe('handleEpicMove', () => {
  it('writes status first, then the parent with the item sort_order', async () => {
    const { result } = await mountProjectMode();
    await act(() =>
      result.current.handleEpicMove(CHILD_A1, { status: 'testing', parent: { parentId: 'epic-b', sortOrder: CHILD_A1.sort_order } })
    );
    expect(q.updateItemStatus).toHaveBeenCalledWith('child-a1', 'testing');
    expect(q.reorderItem).toHaveBeenCalledWith('child-a1', 'epic-b', 7);
    expect(q.updateItemStatus.mock.invocationCallOrder[0]).toBeLessThan(q.reorderItem.mock.invocationCallOrder[0]);
  });

  it('on failure shows an inline error and reloads', async () => {
    const { result } = await mountProjectMode();
    const loadsBefore = q.getBoardTasks.mock.calls.length;
    q.reorderItem.mockRejectedValueOnce(new Error('cycle'));
    await act(() =>
      result.current.handleEpicMove(CHILD_A1, { status: null, parent: { parentId: 'epic-b', sortOrder: 7 } })
    );
    expect(result.current.boardError).toMatch(/Could not move #200/);
    expect(q.getBoardTasks.mock.calls.length).toBeGreaterThan(loadsBefore);
  });
});

describe('Partial failure message', () => {
  it('says the status was saved but the epic move failed when only the parent write fails', async () => {
    const { result } = await mountProjectMode();
    q.reorderItem.mockRejectedValueOnce(new Error('cycle'));
    await act(() =>
      result.current.handleEpicMove(CHILD_A1, { status: 'testing', parent: { parentId: 'epic-b', sortOrder: 7 } })
    );
    expect(q.updateItemStatus).toHaveBeenCalledWith('child-a1', 'testing');
    expect(result.current.boardError).toMatch(/status was saved but the epic move failed/);
  });
});

describe('Stale project response', () => {
  it('ignores a slow response for a previous project and refuses Add backlog under its epic', async () => {
    let resolveA: (v: unknown) => void = () => {};
    const slowA = new Promise((r) => { resolveA = r; });
    const colsB = projectColumns();
    colsB.pending = colsB.pending.filter((i) => i.id !== 'epic-a');
    q.getBoardTasks.mockImplementation((_s: unknown, pid: string) =>
      pid === PROJECT_ID ? slowA : Promise.resolve(colsB)
    );
    persist({ swimLane: 'project', selectedProjectId: PROJECT_ID });
    const { result } = renderHook(() => useBoardData());
    await waitFor(() => expect(q.getBoardTasks).toHaveBeenCalledWith(null, PROJECT_ID));
    act(() => result.current.setSelectedProjectId('project-q'));
    await waitFor(() => expect(q.getBoardTasks).toHaveBeenCalledWith(null, 'project-q'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { resolveA(projectColumns()); await slowA; });
    const allIds = (Object.values(result.current.columns) as { id: string }[][]).flat().map((i) => i.id);
    expect(allIds).not.toContain('epic-a');
    await act(() => result.current.handleQuickAdd('Wrong parent', 'pending', 'epic-a'));
    expect(q.createItem).not.toHaveBeenCalled();
  });
});

describe('Add backlog refuses an epic from another project (BACKLOG-4195 N5)', () => {
  it('an epic that IS on the loaded board but belongs to another project is refused', async () => {
    const cols = projectColumns();
    cols.pending = cols.pending.map((i) => (i.id === 'epic-a' ? { ...i, project_id: 'project-other' } : i));
    q.getBoardTasks.mockResolvedValue(cols);
    const { result } = await mountProjectMode();
    const onBoard = (Object.values(result.current.columns) as { id: string }[][]).flat().map((i) => i.id);
    expect(onBoard).toContain('epic-a');
    await act(() => result.current.handleQuickAdd('Wrong project', 'pending', 'epic-a'));
    expect(q.createItem).not.toHaveBeenCalled();
    expect(result.current.boardError).toMatch(/Could not add the item/);
  });
});

describe('Stale response after a mode or sprint switch (BACKLOG-4195 N6)', () => {
  it('drops a project response that arrives after switching Project -> Area', async () => {
    let resolveP: (v: unknown) => void = () => {};
    const slowP = new Promise((r) => { resolveP = r; });
    const sprintCols = toColumns([makeItem({ id: 'sprint-item', item_number: 501, project_id: null })]);
    q.getBoardTasks.mockImplementation((sprintId: string | null) =>
      sprintId === null ? slowP : Promise.resolve(sprintCols)
    );
    persist({ swimLane: 'project', selectedProjectId: PROJECT_ID, selectedSprintId: 'sprint-1' });
    const { result } = renderHook(() => useBoardData());
    await waitFor(() => expect(q.getBoardTasks).toHaveBeenCalledWith(null, PROJECT_ID));
    act(() => result.current.setSwimLane('area'));
    await waitFor(() => expect(q.getBoardTasks).toHaveBeenCalledWith('sprint-1'));
    await waitFor(() => expect(result.current.columns.pending.map((i) => i.id)).toEqual(['sprint-item']));
    await act(async () => { resolveP(projectColumns()); await slowP; });
    const allIds = (Object.values(result.current.columns) as { id: string }[][]).flat().map((i) => i.id);
    expect(allIds).toEqual(['sprint-item']);
  });

  it('drops a sprint response that arrives after picking another sprint', async () => {
    let resolveS1: (v: unknown) => void = () => {};
    const slowS1 = new Promise((r) => { resolveS1 = r; });
    const s1Cols = toColumns([makeItem({ id: 's1-item', item_number: 601 })]);
    const s2Cols = toColumns([makeItem({ id: 's2-item', item_number: 602 })]);
    q.getBoardTasks.mockImplementation((sprintId: string | null) =>
      sprintId === 'sprint-1' ? slowS1 : Promise.resolve(s2Cols)
    );
    persist({ swimLane: 'area', selectedSprintId: 'sprint-1' });
    const { result } = renderHook(() => useBoardData());
    await waitFor(() => expect(q.getBoardTasks).toHaveBeenCalledWith('sprint-1'));
    act(() => result.current.setSelectedSprintId('sprint-2'));
    await waitFor(() => expect(result.current.columns.pending.map((i) => i.id)).toEqual(['s2-item']));
    await act(async () => { resolveS1(s1Cols); await slowS1; });
    const allIds = (Object.values(result.current.columns) as { id: string }[][]).flat().map((i) => i.id);
    expect(allIds).toEqual(['s2-item']);
  });
});

describe('Project mode never assigns to a hidden sprint', () => {
  it('bulk assign-to-sprint is a no-op', async () => {
    persist({ swimLane: 'project', selectedProjectId: PROJECT_ID, selectedSprintId: 'sprint-old' });
    const { result } = renderHook(() => useBoardData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.setSelectedIds(new Set(['child-a1'])));
    await act(() => result.current.handleBulkAssignSprint());
    expect(q.assignToSprint).not.toHaveBeenCalled();
  });
});

describe('Other modes unchanged', () => {
  it('quick add without a sprint does nothing', async () => {
    persist({ swimLane: 'area' });
    const { result } = renderHook(() => useBoardData());
    await waitFor(() => expect(q.listSprints).toHaveBeenCalled());
    expect(result.current.selectedSprintId).toBe('');
    await act(() => result.current.handleQuickAdd('X', 'pending', 'Frontend'));
    expect(q.createItem).not.toHaveBeenCalled();
  });

  it('quick add with a sprint creates in the sprint, tagged with the area', async () => {
    persist({ swimLane: 'area', selectedSprintId: 'sprint-1' });
    const { result } = renderHook(() => useBoardData());
    await waitFor(() => expect(q.getBoardTasks).toHaveBeenCalledWith('sprint-1'));
    await act(() => result.current.handleQuickAdd('X', 'pending', 'Frontend'));
    expect(q.createItem).toHaveBeenCalledWith({ title: 'X', sprint_id: 'sprint-1', area: 'Frontend' });
  });
});
