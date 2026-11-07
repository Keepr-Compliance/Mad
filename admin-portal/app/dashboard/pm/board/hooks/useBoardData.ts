'use client';

/**
 * useBoardData -- Data fetching and mutation logic for the Kanban board.
 *
 * Encapsulates:
 * - Sprint, project, user, and label loading
 * - Board column data fetching with fallback
 * - Backlog item loading
 * - Status change (optimistic update)
 * - Quick add item
 * - Item selection toggle
 * - Bulk operations (status, sprint assign, user assign, delete)
 * - Board state persistence to localStorage
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { SwimLaneMode } from '../../components/SwimLaneSelector';
import {
  listSprints,
  listItems,
  listProjects,
  getBoardTasks,
  updateItemStatus,
  reorderItem,
  createItem,
  assignItem,
  addItemLabel,
  fetchItemLabels,
  bulkUpdate,
  bulkDelete,
  assignToSprint,
  listAssignableUsers,
  listLabels,
} from '@/lib/pm-queries';
import type {
  PmBacklogItem,
  PmProject,
  PmSprint,
  PmLabel,
  ItemStatus,
  BoardColumns,
  CreateItemParams,
} from '@/lib/pm-types';
import type { AssignableUser } from '../../components/KanbanCard';
import { isSwimLaneMode, NO_EPIC_KEY } from '../lib/swim-lane-ids';

// ---------------------------------------------------------------------------
// Board state persistence
// ---------------------------------------------------------------------------

const BOARD_STATE_KEY = 'pm-board-state';

/** Shown when the item labels could not be read (BACKLOG-4196). */
export const LABELS_LOAD_ERROR = 'Could not load labels. Try Refresh.';

function emptyBoardColumns(): BoardColumns {
  return {
    pending: [], in_progress: [], testing: [], pending_uat: [], completed: [],
    blocked: [], deferred: [], obsolete: [], reopened: [], waiting_for_user: [],
  };
}

interface BoardPersistedState {
  selectedSprintId: string;
  /** Project shown in Project mode (BACKLOG-4176). */
  selectedProjectId?: string;
  swimLane: SwimLaneMode;
  collapsedLanes: string[];
  compactCards?: boolean;
}

function readPersistedBoardState(): BoardPersistedState | null {
  if (typeof window === 'undefined') return null;
  try {
    const saved = localStorage.getItem(BOARD_STATE_KEY);
    if (saved) return JSON.parse(saved) as BoardPersistedState;
  } catch (err) {
    console.error('Failed to read board state from localStorage:', err);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useBoardData() {
  // -- State ---------------------------------------------------------------
  // NOTE: state initializers must NOT read localStorage — that causes a
  // server/client mismatch and triggers React hydration error #418. The
  // persisted values are loaded in a mount-only useEffect below. The
  // `hydrated` flag gates the write-effect so we don't clobber persisted
  // state with defaults before it has a chance to be restored.
  const [hydrated, setHydrated] = useState(false);
  const [sprints, setSprints] = useState<PmSprint[]>([]);
  const [selectedSprintId, setSelectedSprintId] = useState<string>('');
  const [swimLane, setSwimLane] = useState<SwimLaneMode>('project');
  const [backlogOpen, setBacklogOpen] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [projects, setProjects] = useState<PmProject[]>([]);
  const [boardError, setBoardError] = useState<string | null>(null);
  // The last board load could not read item labels. Label mode then shows
  // no grid rather than every item under "No label".
  const [labelsFailed, setLabelsFailed] = useState(false);
  const [columns, setColumns] = useState<BoardColumns>(emptyBoardColumns);
  const [backlogItems, setBacklogItems] = useState<PmBacklogItem[]>([]);
  const [backlogLoading, setBacklogLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [collapsedLanes, setCollapsedLanes] = useState<Set<string>>(() => new Set());
  const [compactCards, setCompactCards] = useState<boolean>(false);
  const [nameMap, setNameMap] = useState<Map<string, string>>(new Map());
  const [boardUsers, setBoardUsers] = useState<AssignableUser[]>([]);
  const [boardLabels, setBoardLabels] = useState<PmLabel[]>([]);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);

  const toggleLane = useCallback((laneKey: string) => {
    setCollapsedLanes((prev) => {
      const next = new Set(prev);
      if (next.has(laneKey)) next.delete(laneKey);
      else next.add(laneKey);
      return next;
    });
  }, []);

  // -- Restore persisted UI state (mount-only, client-only) ----------------
  // Reading localStorage must happen after hydration to avoid React error
  // #418. The `hydrated` flag below prevents the write-effect from clobbering
  // the persisted state with defaults before this effect can run.
  useEffect(() => {
    const persisted = readPersistedBoardState();
    if (persisted) {
      if (persisted.selectedSprintId) setSelectedSprintId(persisted.selectedSprintId);
      if (persisted.selectedProjectId) setSelectedProjectId(persisted.selectedProjectId);
      // An unknown persisted mode (older or newer build) falls back to the default.
      if (isSwimLaneMode(persisted.swimLane)) setSwimLane(persisted.swimLane);
      if (persisted.collapsedLanes) setCollapsedLanes(new Set(persisted.collapsedLanes));
      if (typeof persisted.compactCards === 'boolean') setCompactCards(persisted.compactCards);
    }
    setHydrated(true);
  }, []);

  // -- Persist board UI state to localStorage ------------------------------
  useEffect(() => {
    if (!hydrated) return; // Wait for restore before writing to avoid clobbering.
    try {
      const state: BoardPersistedState = {
        selectedSprintId, selectedProjectId, swimLane,
        collapsedLanes: Array.from(collapsedLanes), compactCards,
      };
      localStorage.setItem(BOARD_STATE_KEY, JSON.stringify(state));
    } catch (err) {
      console.error('Failed to persist board state to localStorage:', err);
    }
  }, [hydrated, selectedSprintId, selectedProjectId, swimLane, collapsedLanes, compactCards]);

  // -- Data fetching -------------------------------------------------------

  useEffect(() => {
    async function loadSprints() {
      try {
        const data = await listSprints();
        const sprintList = Array.isArray(data) ? data : [];
        setSprints(sprintList);
        if (!selectedSprintId) {
          const active = sprintList.find((s) => s.status === 'active');
          const initial = active || sprintList[0];
          if (initial) setSelectedSprintId(initial.id);
        }
      } catch (err) {
        console.error('Failed to load sprints:', err);
      }
    }
    loadSprints();
  }, []);

  useEffect(() => {
    async function loadProjects() {
      try {
        const data = await listProjects();
        const list = Array.isArray(data) ? data : [];
        const map = new Map<string, string>();
        for (const p of list) map.set(p.id, p.name);
        setNameMap(map);
        setProjects(list);
      } catch (err) {
        console.error('Failed to load projects:', err);
      }
    }
    loadProjects();
  }, []);

  const refreshLabels = useCallback(() => {
    listLabels().then(setBoardLabels).catch((err) => console.error('Failed to load labels:', err));
  }, []);

  useEffect(() => {
    listAssignableUsers().then(setBoardUsers).catch((err) => console.error('Failed to load users:', err));
    refreshLabels();
  }, [refreshLabels]);

  const projectMode = swimLane === 'project';
  // The board's source: a project in Project mode, the sprint otherwise.
  const boardSourceKey = projectMode ? `project:${selectedProjectId}` : `sprint:${selectedSprintId}`;
  // Latest board source (mode + project/sprint), read after awaits to drop
  // stale responses: a newer project or sprint, or a mode switch such as
  // Project -> Area, while the fetch was in flight.
  const boardSourceRef = useRef(boardSourceKey);
  boardSourceRef.current = boardSourceKey;
  // The sprint only matters outside Project mode; keeping it out of Project
  // mode's deps stops a late sprint-list load from refetching the project.
  const sprintForLoad = projectMode ? '' : selectedSprintId;

  /**
   * Read the labels of every item in `data`, merge them onto the items and
   * show the result -- unless the board source changed while either fetch
   * was in flight (BACKLOG-4196). pm_get_board_tasks returns no labels.
   */
  const showColumnsWithLabels = useCallback(async (data: BoardColumns, requestedSource: string) => {
    const ids = (Object.values(data) as (PmBacklogItem[] | undefined)[]).flatMap((items) =>
      (items ?? []).map((i) => i.id)
    );
    let labelMap: Map<string, PmLabel[]> | null = null;
    try {
      labelMap = await fetchItemLabels(ids);
    } catch (err) {
      console.error('Failed to load item labels:', err);
    }
    // The source or the mode changed while the labels were in flight: drop it.
    if (boardSourceRef.current !== requestedSource) return;
    if (!labelMap) {
      setLabelsFailed(true);
      setBoardError(LABELS_LOAD_ERROR);
      setColumns(data);
      return;
    }
    const found = labelMap;
    setLabelsFailed(false);
    setBoardError((prev) => (prev === LABELS_LOAD_ERROR ? null : prev));
    const merged = {} as Record<string, PmBacklogItem[]>;
    for (const [status, items] of Object.entries(data) as [string, PmBacklogItem[] | undefined][]) {
      merged[status] = (items ?? []).map((item) => ({ ...item, labels: found.get(item.id) ?? [] }));
    }
    setColumns(merged as unknown as BoardColumns);
  }, []);

  const loadBoardData = useCallback(async () => {
    // Project mode (BACKLOG-4176): every item of one project, no sprint.
    if (projectMode) {
      if (!selectedProjectId) {
        setColumns(emptyBoardColumns());
        setLoading(false);
        setRefreshing(false);
        return;
      }
      try {
        const requestedSource = `project:${selectedProjectId}`;
        const data = await getBoardTasks(null, selectedProjectId);
        // The project or the mode changed while this was in flight: drop it.
        if (boardSourceRef.current !== requestedSource) return;
        await showColumnsWithLabels(data, requestedSource);
      } catch (err) {
        // No listItems fallback here: it is page-capped and would show a
        // silently truncated project.
        console.error('Failed to load project board:', err);
        setBoardError('Could not load this project. Try Refresh.');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
      return;
    }
    if (!sprintForLoad) { setLoading(false); return; }
    const requestedSource = `sprint:${sprintForLoad}`;
    try {
      const data = await getBoardTasks(sprintForLoad);
      // The sprint or the mode changed while this was in flight: drop it.
      if (boardSourceRef.current !== requestedSource) return;
      await showColumnsWithLabels(data, requestedSource);
    } catch (err) {
      console.error('Failed to load board tasks:', err);
      try {
        const result = await listItems({ sprint_id: sprintForLoad, page_size: 200 });
        if (boardSourceRef.current !== requestedSource) return;
        const items = result.items || [];
        await showColumnsWithLabels({
          pending: items.filter((i) => i.status === 'pending'),
          in_progress: items.filter((i) => i.status === 'in_progress'),
          testing: items.filter((i) => i.status === 'testing'),
          pending_uat: items.filter((i) => i.status === 'pending_uat'),
          completed: items.filter((i) => i.status === 'completed'),
          blocked: items.filter((i) => i.status === 'blocked'),
          deferred: items.filter((i) => i.status === 'deferred'),
          obsolete: items.filter((i) => i.status === 'obsolete'),
          reopened: items.filter((i) => i.status === 'reopened'),
          waiting_for_user: items.filter((i) => i.status === 'waiting_for_user'),
        }, requestedSource);
      } catch (fallbackErr) {
        console.error('Fallback listItems also failed:', fallbackErr);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [projectMode, selectedProjectId, sprintForLoad, showColumnsWithLabels]);

  const handleItemUpdated = useCallback(() => {
    loadBoardData();
    refreshLabels();
  }, [loadBoardData, refreshLabels]);

  // Switching source must not show the previous source's items under the
  // new grouping while the fetch is in flight.
  useEffect(() => {
    setColumns(emptyBoardColumns());
    setBoardError(null);
    setLabelsFailed(false);
  }, [boardSourceKey]);

  useEffect(() => {
    if (!hydrated) return;
    if (projectMode) { setLoading(true); loadBoardData(); return; }
    if (sprintForLoad) { setLoading(true); loadBoardData(); }
  }, [hydrated, projectMode, sprintForLoad, loadBoardData]);

  const loadBacklogItems = useCallback(async (search?: string) => {
    setBacklogLoading(true);
    try {
      const result = await listItems({ unassigned_only: true, search: search || undefined, page_size: 100 });
      setBacklogItems(result.items || []);
    } catch (err) {
      console.error('Failed to load backlog items:', err);
    } finally {
      setBacklogLoading(false);
    }
  }, []);

  useEffect(() => {
    if (backlogOpen) loadBacklogItems();
  }, [backlogOpen, loadBacklogItems]);

  // -- Mutations -----------------------------------------------------------

  const handleStatusChange = useCallback(
    async (itemId: string, newStatus: ItemStatus) => {
      setColumns((prev) => {
        const updated = { ...prev };
        let movedItem: PmBacklogItem | null = null;
        for (const status of Object.keys(updated) as ItemStatus[]) {
          const items = updated[status] as PmBacklogItem[];
          const idx = items.findIndex((i) => i.id === itemId);
          if (idx !== -1) {
            movedItem = { ...items[idx], status: newStatus };
            updated[status] = [...items.slice(0, idx), ...items.slice(idx + 1)] as typeof items;
            break;
          }
        }
        if (movedItem) {
          const target = (updated[newStatus] || []) as PmBacklogItem[];
          (updated as Record<string, PmBacklogItem[]>)[newStatus] = [...target, movedItem];
        }
        return updated;
      });
      try {
        await updateItemStatus(itemId, newStatus);
      } catch (err) {
        console.error('Failed to update status:', err);
        await loadBoardData();
      }
    },
    [loadBoardData]
  );

  const handleQuickAdd = useCallback(
    async (title: string, status: ItemStatus, groupKey?: string) => {
      // Project mode "Add backlog": item in the picked project, under the
      // row's epic, no sprint.
      if (projectMode) {
        if (!selectedProjectId) return;
        // Refuse a lane whose epic is not on the loaded board or does not
        // belong to the picked project (stale board).
        if (groupKey && groupKey !== NO_EPIC_KEY) {
          const loadedEpic = (Object.values(columns) as PmBacklogItem[][]).some((items) =>
            items.some(
              (i) => i.type === 'epic' && i.id === groupKey && i.project_id === selectedProjectId
            )
          );
          if (!loadedEpic) {
            setBoardError('Could not add the item. The board is still loading. Try again.');
            return;
          }
        }
        try {
          const params: CreateItemParams = {
            title,
            project_id: selectedProjectId,
            parent_id: groupKey && groupKey !== NO_EPIC_KEY ? groupKey : null,
          };
          const created = await createItem(params);
          if (status !== 'pending' && created.id) await updateItemStatus(created.id, status);
        } catch (err) {
          console.error('Failed to add backlog item:', err);
          setBoardError('Could not add the item. Try again.');
        }
        await loadBoardData();
        return;
      }
      if (!selectedSprintId) return;
      try {
        const params: CreateItemParams = { title, sprint_id: selectedSprintId };
        const isRealGroup = groupKey && !groupKey.startsWith('No ') && groupKey !== 'Unassigned';
        if (isRealGroup && swimLane === 'area') params.area = groupKey;
        const created = await createItem(params);
        if (status !== 'pending' && created.id) await updateItemStatus(created.id, status);
        if (isRealGroup && swimLane === 'assignee' && created.id) {
          try { await assignItem(created.id, groupKey); } catch { /* non-fatal */ }
        }
        // Label mode: the row's key is the label id; "No label" adds none.
        if (isRealGroup && swimLane === 'label' && created.id) {
          try {
            await addItemLabel(created.id, groupKey);
          } catch (labelErr) {
            // Non-fatal: the item exists; it shows under "No label".
            console.error('Failed to label the new item:', labelErr);
            setBoardError(`#${created.item_number} was added, but its label could not be set.`);
          }
        }
        await loadBoardData();
      } catch (err) {
        console.error('Failed to quick-add item:', err);
      }
    },
    [projectMode, selectedProjectId, selectedSprintId, swimLane, columns, loadBoardData]
  );

  /** Project mode: create a new epic in the picked project (a new row). */
  const handleAddEpic = useCallback(
    async (title: string) => {
      if (!projectMode || !selectedProjectId) return;
      try {
        await createItem({ title, type: 'epic', project_id: selectedProjectId });
      } catch (err) {
        console.error('Failed to add epic:', err);
        setBoardError('Could not add the epic. Try again.');
      }
      await loadBoardData();
    },
    [projectMode, selectedProjectId, loadBoardData]
  );

  /**
   * Project mode: move an item to another epic row. Status is written first,
   * then the parent. reorderItem is always given the item's own sort_order,
   * because it defaults a missing one to 0.
   */
  const handleEpicMove = useCallback(
    async (
      item: PmBacklogItem,
      plan: { status: ItemStatus | null; parent: { parentId: string | null; sortOrder: number } | null }
    ) => {
      setBoardError(null);
      let statusSaved = false;
      try {
        if (plan.status) {
          await updateItemStatus(item.id, plan.status);
          statusSaved = true;
        }
        if (plan.parent) await reorderItem(item.id, plan.parent.parentId, plan.parent.sortOrder);
      } catch (err) {
        console.error('Failed to move item between epics:', err);
        setBoardError(
          statusSaved
            ? `#${item.item_number}: the status was saved but the epic move failed. The board was reloaded.`
            : `Could not move #${item.item_number}. The board was reloaded.`
        );
      }
      await loadBoardData();
    },
    [loadBoardData]
  );

  const handleToggleSelect = useCallback((itemId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId); else next.add(itemId);
      return next;
    });
  }, []);

  const handleBulkStatusChange = useCallback(async (status: ItemStatus) => {
    if (selectedIds.size === 0) return;
    setBulkError(null);
    try {
      await bulkUpdate(Array.from(selectedIds), { status });
      setSelectedIds(new Set());
      await loadBoardData();
    } catch (err) {
      console.error('Failed to bulk update status:', err);
      setBulkError('Failed to update status. Please try again.');
    }
  }, [selectedIds, loadBoardData]);

  const handleBulkAssignSprint = useCallback(async () => {
    // Project mode has no sprint on screen; never assign to a hidden one.
    if (projectMode) return;
    if (selectedIds.size === 0 || !selectedSprintId) return;
    try {
      await assignToSprint(Array.from(selectedIds), selectedSprintId);
      setSelectedIds(new Set());
      await loadBoardData();
    } catch (err) {
      console.error('Failed to bulk assign to sprint:', err);
      setBulkError('Failed to assign to sprint. Please try again.');
    }
  }, [projectMode, selectedIds, selectedSprintId, loadBoardData]);

  const handleBulkAssignUser = useCallback(async (assigneeId: string | null) => {
    if (selectedIds.size === 0) return;
    try {
      await bulkUpdate(Array.from(selectedIds), { assignee_id: assigneeId });
      setSelectedIds(new Set());
      await loadBoardData();
    } catch (err) {
      console.error('Failed to bulk assign user:', err);
      setBulkError('Failed to assign user. Please try again.');
    }
  }, [selectedIds, loadBoardData]);

  const handleBulkDeleteRequest = useCallback(() => {
    if (selectedIds.size === 0) return;
    setDeleteError(null);
    setDeleteConfirmOpen(true);
  }, [selectedIds]);

  const handleBulkDeleteConfirm = useCallback(async () => {
    if (selectedIds.size === 0) return;
    try {
      await bulkDelete(Array.from(selectedIds));
      setSelectedIds(new Set());
      setDeleteConfirmOpen(false);
      await loadBoardData();
    } catch (err) {
      console.error('Failed to bulk delete:', err);
      setDeleteError('Failed to delete items. Please try again.');
    }
  }, [selectedIds, loadBoardData]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadBoardData();
  }, [loadBoardData]);

  const handleBacklogSearch = useCallback((query: string) => {
    loadBacklogItems(query);
  }, [loadBacklogItems]);

  return {
    // State
    sprints,
    selectedSprintId,
    setSelectedSprintId,
    selectedProjectId,
    setSelectedProjectId,
    projects,
    projectMode,
    boardError,
    setBoardError,
    labelsFailed,
    swimLane,
    setSwimLane,
    backlogOpen,
    setBacklogOpen,
    columns,
    backlogItems,
    backlogLoading,
    loading,
    refreshing,
    selectedIds,
    setSelectedIds,
    collapsedLanes,
    setCollapsedLanes,
    compactCards,
    setCompactCards,
    nameMap,
    boardUsers,
    boardLabels,
    deleteConfirmOpen,
    setDeleteConfirmOpen,
    deleteError,
    bulkError,
    setBulkError,
    // Actions
    toggleLane,
    loadBoardData,
    loadBacklogItems,
    handleItemUpdated,
    handleStatusChange,
    handleQuickAdd,
    handleAddEpic,
    handleEpicMove,
    handleToggleSelect,
    handleBulkStatusChange,
    handleBulkAssignSprint,
    handleBulkAssignUser,
    handleBulkDeleteRequest,
    handleBulkDeleteConfirm,
    handleRefresh,
    handleBacklogSearch,
  };
}
