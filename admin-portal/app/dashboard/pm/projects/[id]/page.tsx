'use client';

/**
 * Project Detail Page - /dashboard/pm/projects/[id]
 *
 * Composition root that assembles:
 * - ProjectHeader (name, description, delete)
 * - StatusSummary (progress bar, status badges)
 * - TokenMetricCards (est/actual/variance/days)
 * - BacklogPanel + SprintSections (responsive layout)
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { DndContext, DragOverlay, pointerWithin } from '@dnd-kit/core';
import {
  getProjectDetail,
  listItems,
  updateProjectField,
  deleteProject,
  bulkUpdate,
  bulkDelete,
} from '@/lib/pm-queries';
import type {
  PmProject,
  PmBacklogItem,
  PmSprint,
  SprintStatus,
  ProjectField,
  ItemStatus,
} from '@/lib/pm-types';
import { ProjectHeader, DeleteConfirmation, ProjectLoadingSkeleton, ProjectNotFound } from './components/ProjectHeader';
import { StatusSummary, TokenMetricCards, InlineSprintCreate } from './components/ProjectSprints';
import { BacklogPanel, SprintSection } from './components/ProjectTasks';
import { DraggableItemRow } from './components/DraggableItemRow';
import { useProjectDragDrop } from './hooks/useProjectDragDrop';
import { useResizableColumn } from './hooks/useResizableColumn';
import { AssignSprintControl } from './components/AssignSprintControl';
import { BulkActionBar } from '../../components/BulkActionBar';

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

export default function ProjectDetailPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  // Delete state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Project detail state
  const [project, setProject] = useState<PmProject | null>(null);
  const [sprints, setSprints] = useState<PmSprint[]>([]);
  const [itemsByStatus, setItemsByStatus] = useState<Record<string, number>>({});
  const [loadingDetail, setLoadingDetail] = useState(true);

  // All items for backlog + token sums
  const [allItems, setAllItems] = useState<PmBacklogItem[]>([]);
  const [loadingItems, setLoadingItems] = useState(true);

  // Status filter — clicking a segment/badge in StatusSummary narrows
  // the visible items in both the backlog panel and sprint sections.
  const [statusFilter, setStatusFilter] = useState<ItemStatus | null>(null);

  const handleStatusFilter = useCallback((status: ItemStatus | null) => {
    setStatusFilter(status);
  }, []);

  // BACKLOG-1664: multi-select state for bulk actions (assign to sprint,
  // bulk status change, bulk delete). Mirrors the board's selection pattern
  // in useBoardData.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [assignSprintOpen, setAssignSprintOpen] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkDeleteConfirmOpen, setBulkDeleteConfirmOpen] = useState(false);

  const handleToggleSelect = useCallback((itemId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  // Load project detail
  const loadDetail = useCallback(async () => {
    setLoadingDetail(true);
    try {
      const data = await getProjectDetail(projectId);
      setProject(data.project);
      setSprints(data.sprints);
      setItemsByStatus(data.items_by_status);
    } catch (err) {
      console.error('Failed to load project data:', err);
    } finally {
      setLoadingDetail(false);
    }
  }, [projectId]);

  useEffect(() => { loadDetail(); }, [loadDetail]);

  // Load ALL items for this project
  const loadItems = useCallback(async () => {
    setLoadingItems(true);
    try {
      const data = await listItems({ project_id: projectId, page_size: 500 });
      setAllItems(data.items);
    } catch (err) {
      console.error('Failed to load project data:', err);
    } finally {
      setLoadingItems(false);
    }
  }, [projectId]);

  useEffect(() => { loadItems(); }, [loadItems]);

  // Filter to unassigned items (no sprint_id); further narrow by statusFilter
  const backlogItems = useMemo(
    () =>
      allItems.filter(
        (item) =>
          !item.sprint_id && (!statusFilter || item.status === statusFilter)
      ),
    [allItems, statusFilter]
  );

  // Token sums
  const tokenSums = useMemo(() => {
    let estTotal = 0;
    let actualTotal = 0;
    for (const item of allItems) {
      estTotal += item.est_tokens ?? 0;
      actualTotal += item.actual_tokens ?? 0;
    }
    const variance = estTotal > 0 ? ((actualTotal - estTotal) / estTotal) * 100 : 0;
    return { estTotal, actualTotal, variance };
  }, [allItems]);

  // Sort sprints: active first, then planned, then completed, then cancelled
  const sortedSprints = useMemo(() => {
    const order: Record<SprintStatus, number> = {
      active: 0, planned: 1, completed: 2, cancelled: 3,
    };
    return [...sprints].sort(
      (a, b) => (order[a.status] ?? 99) - (order[b.status] ?? 99)
    );
  }, [sprints]);

  const refreshAll = useCallback(() => {
    loadDetail();
    loadItems();
  }, [loadDetail, loadItems]);

  // BACKLOG-1664: bulk action handlers for selected project tasks.
  const handleBulkStatusChange = useCallback(async (status: ItemStatus) => {
    if (selectedIds.size === 0) return;
    setBulkError(null);
    try {
      await bulkUpdate(Array.from(selectedIds), { status });
      clearSelection();
      refreshAll();
    } catch (err) {
      console.error('Failed to bulk update status:', err);
      setBulkError('Failed to update status. Please try again.');
    }
  }, [selectedIds, clearSelection, refreshAll]);

  const handleBulkAssignUser = useCallback(async (assigneeId: string | null) => {
    if (selectedIds.size === 0) return;
    setBulkError(null);
    try {
      await bulkUpdate(Array.from(selectedIds), { assignee_id: assigneeId });
      clearSelection();
      refreshAll();
    } catch (err) {
      console.error('Failed to bulk assign user:', err);
      setBulkError('Failed to assign user. Please try again.');
    }
  }, [selectedIds, clearSelection, refreshAll]);

  const handleBulkDeleteRequest = useCallback(() => {
    if (selectedIds.size === 0) return;
    setBulkError(null);
    setBulkDeleteConfirmOpen(true);
  }, [selectedIds]);

  const handleBulkDeleteConfirm = useCallback(async () => {
    if (selectedIds.size === 0) return;
    try {
      await bulkDelete(Array.from(selectedIds));
      clearSelection();
      setBulkDeleteConfirmOpen(false);
      refreshAll();
    } catch (err) {
      console.error('Failed to bulk delete:', err);
      setBulkError('Failed to delete items. Please try again.');
    }
  }, [selectedIds, clearSelection, refreshAll]);

  // Required by BulkActionBar but not a first-class action on the project
  // page. We leave this as a no-op with a dev warning — priority changes
  // still happen via item detail.
  const handleBulkPriorityChange = useCallback(() => {
    console.warn('Bulk priority change not supported on project page yet');
  }, []);

  // Optimistic move: update allItems locally by changing an item's sprint_id
  const moveItem = useCallback((itemId: string, targetSprintId: string | null) => {
    setAllItems((prev) =>
      prev.map((item) =>
        item.id === itemId ? { ...item, sprint_id: targetSprintId } : item
      )
    );
  }, []);

  // Drag-and-drop
  const { sensors, activeDragItem, handleDragStart, handleDragEnd } =
    useProjectDragDrop({ moveItem, onRefreshFallback: refreshAll });

  // Resizable Backlog | Sprints split (draggable divider, persisted width)
  const {
    containerRef: splitRef,
    width: backlogWidth,
    isLarge: splitIsLarge,
    dragging: splitDragging,
    startDrag: startSplitDrag,
    resetWidth: resetSplitWidth,
  } = useResizableColumn();

  // Update project field handler
  const handleUpdateField = useCallback(async (field: ProjectField, value: string | null) => {
    await updateProjectField(projectId, field, value);
    loadDetail();
  }, [projectId, loadDetail]);

  // Delete project handler
  async function handleDeleteProject() {
    setDeleting(true);
    try {
      await deleteProject(projectId);
      router.push('/dashboard/pm/projects');
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete project');
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  }

  // Loading / not found states
  if (loadingDetail) return <ProjectLoadingSkeleton />;
  if (!project) return <ProjectNotFound />;

  return (
    <div className="max-w-7xl mx-auto">
      <ProjectHeader
        project={project}
        projectId={projectId}
        onUpdateField={handleUpdateField}
        onDeleteRequest={() => setShowDeleteConfirm(true)}
      />

      {showDeleteConfirm && (
        <DeleteConfirmation
          projectName={project.name}
          deleting={deleting}
          deleteError={deleteError}
          onConfirm={handleDeleteProject}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}

      {!showDeleteConfirm && deleteError && (
        <div className="bg-red-50 border border-red-200 rounded-md p-4 mb-6">
          <p className="text-sm text-red-800">{deleteError}</p>
        </div>
      )}

      <StatusSummary
        itemsByStatus={itemsByStatus}
        tokenSums={tokenSums}
        activeFilter={statusFilter}
        onStatusFilter={handleStatusFilter}
      />

      <TokenMetricCards tokenSums={tokenSums} project={project} />

      {/* Responsive layout: Backlog panel + Sprint sections (drag-and-drop) */}
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div ref={splitRef} className="flex flex-col lg:flex-row gap-6">
          <div
            className="w-full lg:flex-none lg:max-h-[calc(100vh-200px)] lg:overflow-y-auto"
            style={splitIsLarge ? { width: `${backlogWidth}%` } : undefined}
          >
            <div className="flex items-center gap-2 mb-4">
              <h2 className="text-lg font-semibold text-gray-900">Backlog</h2>
              <span className="text-sm text-gray-500">({backlogItems.length})</span>
            </div>
            <BacklogPanel
              items={backlogItems}
              projectId={projectId}
              loading={loadingItems}
              onRefresh={refreshAll}
              selectedIds={selectedIds}
              onToggleSelect={handleToggleSelect}
            />
          </div>

          {/* Draggable divider: drag to resize, double-click to reset */}
          <div
            role="separator"
            aria-orientation="vertical"
            title="Drag to resize · double-click to reset"
            onPointerDown={startSplitDrag}
            onDoubleClick={resetSplitWidth}
            className="group hidden lg:flex lg:flex-none items-center justify-center w-2 -mx-2 cursor-col-resize touch-none"
          >
            <div
              className={`h-16 w-1 rounded-full transition-colors ${
                splitDragging ? 'bg-blue-500' : 'bg-gray-300 group-hover:bg-blue-400'
              }`}
            />
          </div>

          <div className="flex-1 space-y-4">
            <div className="flex items-center gap-2 mb-4">
              <h2 className="text-lg font-semibold text-gray-900">Sprints</h2>
              <span className="text-sm text-gray-500">({sortedSprints.length})</span>
            </div>

            {sortedSprints.length === 0 ? (
              <div className="border border-gray-200 rounded-lg p-8 text-center">
                <p className="text-sm text-gray-400">
                  No sprints yet. Create one below.
                </p>
              </div>
            ) : (
              sortedSprints.map((sprint) => (
                <SprintSection
                  key={sprint.id}
                  sprint={sprint}
                  projectId={projectId}
                  items={allItems.filter(
                    (i) =>
                      i.sprint_id === sprint.id &&
                      (!statusFilter || i.status === statusFilter)
                  )}
                  onRefresh={refreshAll}
                  selectedIds={selectedIds}
                  onToggleSelect={handleToggleSelect}
                />
              ))
            )}

            <InlineSprintCreate
              projectId={projectId}
              onCreated={refreshAll}
              selectedItemIds={Array.from(selectedIds)}
              onAutoAssigned={clearSelection}
            />
          </div>
        </div>

        {/* Drag overlay: floating preview card */}
        <DragOverlay>
          {activeDragItem ? (
            <DraggableItemRow
              item={activeDragItem}
              projectId={projectId}
              containerId=""
              isDragOverlay
            />
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* BACKLOG-1664: Bulk action bar for selected project tasks. */}
      <BulkActionBar
        selectedCount={selectedIds.size}
        onClearSelection={clearSelection}
        onChangeStatus={handleBulkStatusChange}
        onChangePriority={handleBulkPriorityChange}
        onAssignToSprint={() => setAssignSprintOpen(true)}
        onAssignUser={handleBulkAssignUser}
        onDelete={handleBulkDeleteRequest}
        error={bulkError}
      />

      {/* BACKLOG-1664: Sprint picker modal (opens from BulkActionBar). */}
      <AssignSprintControl
        open={assignSprintOpen}
        onClose={() => setAssignSprintOpen(false)}
        itemIds={Array.from(selectedIds)}
        onAssigned={() => {
          clearSelection();
          refreshAll();
        }}
      />

      {/* BACKLOG-1664: Bulk delete confirmation. Kept inline (not extracted)
          because it shares no state with the DeleteConfirmation above. */}
      {bulkDeleteConfirmOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center"
          onKeyDown={(e) => { if (e.key === 'Escape') setBulkDeleteConfirmOpen(false); }}
        >
          <div
            className="fixed inset-0 bg-black/50"
            onClick={() => setBulkDeleteConfirmOpen(false)}
          />
          <div className="relative bg-white rounded-lg shadow-xl w-full max-w-sm mx-4 p-5">
            <h3 className="text-base font-semibold text-gray-900 mb-2">
              Delete {selectedIds.size} {selectedIds.size === 1 ? 'task' : 'tasks'}?
            </h3>
            <p className="text-sm text-gray-600 mb-4">
              This action is a soft-delete and can be undone by an admin, but
              the items will disappear from all project and sprint views.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setBulkDeleteConfirmOpen(false)}
                className="px-3 py-1.5 text-sm text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleBulkDeleteConfirm}
                className="px-3 py-1.5 text-sm text-white bg-red-600 rounded hover:bg-red-700"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
