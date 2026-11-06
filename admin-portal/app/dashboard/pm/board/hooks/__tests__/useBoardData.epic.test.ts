// @vitest-environment jsdom

/**
 * useBoardData in Project mode (BACKLOG-4176): fetch by project, persisted
 * project, Add backlog / Add epic, epic moves. Other modes unchanged.
 */

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHILD_A1, PROJECT_ID, projectColumns } from '../../__tests__/board-fixtures';
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
