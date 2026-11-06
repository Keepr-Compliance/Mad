// @vitest-environment jsdom

/**
 * Board UI in Project mode (BACKLOG-4176): project picker, epic rows,
 * "Add backlog" / "Add epic", Pending header pill.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { DndContext } from '@dnd-kit/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STATUS_COLORS, type PmProject } from '@/lib/pm-types';
import { projectColumns } from '../../__tests__/board-fixtures';

vi.mock('@/lib/pm-queries', () => ({ updateItemField: vi.fn() }));

import { BoardFilters } from '../BoardFilters';
import { EpicLaneGrid, PENDING_HEADER_PILL, SwimLaneGrid } from '../BoardColumn';
import { KanbanQuickAdd } from '../../../components/KanbanQuickAdd';
import type { SwimLaneMode } from '../../../components/SwimLaneSelector';

afterEach(cleanup);

const PROJECTS = [
  { id: 'project-p', name: 'Stable' },
  { id: 'project-q', name: 'Alpha' },
] as PmProject[];

function renderFilters(swimLane: SwimLaneMode, onProjectChange = vi.fn()) {
  render(
    <BoardFilters
      sprints={[]}
      selectedSprintId=""
      onSprintChange={vi.fn()}
      projects={PROJECTS}
      selectedProjectId=""
      onProjectChange={onProjectChange}
      swimLane={swimLane}
      onSwimLaneChange={vi.fn()}
      compactCards={false}
      onCompactToggle={vi.fn()}
      refreshing={false}
      onRefresh={vi.fn()}
      backlogOpen={false}
      onBacklogToggle={vi.fn()}
    />
  );
  return onProjectChange;
}

describe('BoardFilters', () => {
  it('Project mode shows the project picker, prompts "Select a project", hides sprint + Backlog', () => {
    const onProjectChange = renderFilters('project');
    const picker = screen.getByLabelText('Project') as HTMLSelectElement;
    expect(picker.value).toBe('');
    expect(within(picker).getAllByRole('option').map((o) => o.textContent)).toEqual(['Select a project', 'Alpha', 'Stable']);
    expect(screen.queryByText('Select Sprint')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Backlog' })).toBeNull();
    fireEvent.change(picker, { target: { value: 'project-p' } });
    expect(onProjectChange).toHaveBeenCalledWith('project-p');
  });

  it.each(['off', 'area', 'assignee'] as SwimLaneMode[])('%s mode keeps the sprint selector, no picker', (mode) => {
    renderFilters(mode);
    expect(screen.queryByLabelText('Project')).toBeNull();
    expect(screen.getByText('Select Sprint')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Backlog' })).toBeTruthy();
  });
});

function renderEpicGrid(onQuickAdd = vi.fn(), onAddEpic = vi.fn()) {
  render(
    <DndContext>
      <EpicLaneGrid
        columns={projectColumns()}
        collapsedLanes={new Set()}
        onToggleLane={vi.fn()}
        selectedIds={new Set()}
        onToggleSelect={vi.fn()}
        onItemUpdated={vi.fn()}
        onQuickAdd={onQuickAdd}
        onAddEpic={onAddEpic}
        users={[]}
        allLabels={[]}
        compactCards={false}
      />
    </DndContext>
  );
  return { onQuickAdd, onAddEpic };
}

describe('EpicLaneGrid', () => {
  it('one row per epic (empty included, sub-epic after its parent), No epic last', () => {
    renderEpicGrid();
    const rows = screen.getAllByTestId(/^epic-lane-/).map((r) => r.getAttribute('data-testid'));
    expect(rows).toEqual(['epic-lane-epic-a', 'epic-lane-epic-c', 'epic-lane-epic-b', 'epic-lane-none']);
  });

  it('epic row header shows title, #number, status badge; sub-epic shows its parent', () => {
    renderEpicGrid();
    const b = screen.getByTestId('epic-lane-epic-b');
    expect(within(b).getByText('Epic B')).toBeTruthy();
    expect(within(b).getByText('#101')).toBeTruthy();
    expect(within(b).getByText('In Progress').className).toContain(STATUS_COLORS.in_progress);
    expect(within(screen.getByTestId('epic-lane-epic-c')).getByText('↳ Epic A')).toBeTruthy();
  });

  it('epics never render as cards', () => {
    renderEpicGrid();
    // Cards render their title, so a card for an epic would add a second match.
    expect(screen.getAllByText('Item 200')).toHaveLength(1);
    expect(screen.getAllByText('Epic A')).toHaveLength(1);
    expect(screen.getAllByText('Epic B')).toHaveLength(1);
    expect(screen.getAllByText('Epic C')).toHaveLength(1);
  });

  it('cells say "Add backlog" and pass the row key; one "Add epic" row', async () => {
    const { onQuickAdd, onAddEpic } = renderEpicGrid();
    const row = screen.getByTestId('epic-lane-epic-b');
    const adds = within(row).getAllByRole('button', { name: 'Add backlog' });
    expect(adds).toHaveLength(9);
    expect(screen.queryByRole('button', { name: 'Add item' })).toBeNull();
    fireEvent.click(adds[2]); // testing column
    fireEvent.change(within(row).getByPlaceholderText('Enter title...'), { target: { value: 'Card' } });
    fireEvent.click(within(row).getByRole('button', { name: 'Add' }));
    await vi.waitFor(() => expect(onQuickAdd).toHaveBeenCalledWith('Card', 'testing', 'epic-b'));

    const addEpic = screen.getAllByRole('button', { name: 'Add epic' });
    expect(addEpic).toHaveLength(1);
    fireEvent.click(addEpic[0]);
    fireEvent.change(screen.getByPlaceholderText('Enter title...'), { target: { value: 'New epic' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await vi.waitFor(() => expect(onAddEpic).toHaveBeenCalledWith('New epic'));
  });
});

describe('Pending header pill', () => {
  it('Project mode: Pending pill is white with a gray ring; others keep STATUS_COLORS', () => {
    renderEpicGrid();
    expect(screen.getByTestId('board-header-pill-pending').className).toContain(PENDING_HEADER_PILL);
    expect(PENDING_HEADER_PILL).toBe('bg-white text-gray-700 ring-1 ring-inset ring-gray-300');
    for (const s of ['in_progress', 'testing', 'completed', 'obsolete'] as const) {
      const cls = screen.getByTestId(`board-header-pill-${s}`).className;
      expect(cls).toContain(STATUS_COLORS[s]);
      expect(cls).not.toContain('ring-gray-300');
    }
  });

  it('STATUS_COLORS.pending itself is unchanged', () => {
    expect(STATUS_COLORS.pending).toBe('bg-gray-100 text-gray-800');
  });

  it('area mode keeps "Add item" and also gets the Pending header pill', () => {
    render(
      <DndContext>
        <SwimLaneGrid
          columns={projectColumns()}
          swimLane="area"
          nameMap={new Map()}
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
    expect(screen.getAllByRole('button', { name: 'Add item' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Add backlog' })).toBeNull();
    expect(screen.getByTestId('board-header-pill-pending').className).toContain(PENDING_HEADER_PILL);
  });
});

describe('KanbanQuickAdd', () => {
  it('defaults to "Add item"', () => {
    render(<KanbanQuickAdd onAdd={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Add item' })).toBeTruthy();
  });
});
