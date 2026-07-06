'use client';

/**
 * BoardPage -- Kanban board view assembling KanbanBoard, SwimLaneSelector,
 * BacklogSidePanel, and BulkActionBar into a working drag-and-drop board.
 *
 * Layout:
 * +----------------------------------------------+------------------+
 * | Board: [Sprint v]  [SwimLane Toggle]         | Backlog panel    |
 * | Pending  In Progress  Testing  Completed     | (collapsible)    |
 * | [cards]  [cards]      [cards]  [cards]       |                  |
 * +----------------------------------------------+------------------+
 */

import { KanbanSquare } from 'lucide-react';
import { DndContext, DragOverlay } from '@dnd-kit/core';
import { Spinner } from '@keepr/design-system';
import { KanbanBoard, columnCollision } from '../components/KanbanBoard';
import { BacklogSidePanel } from '../components/BacklogSidePanel';
import { BulkActionBar } from '../components/BulkActionBar';
import { KanbanCard } from '../components/KanbanCard';
import { BoardFilters } from './components/BoardFilters';
import { SwimLaneGrid } from './components/BoardColumn';
import { useBoardDragDrop } from './hooks/useBoardDragDrop';
import { useBoardData } from './hooks/useBoardData';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function BoardPage() {
  const board = useBoardData();

  const {
    sensors,
    activeDragItem,
    activeDragIsBacklog,
    handleDragStart,
    handleDragEnd,
  } = useBoardDragDrop({
    columns: board.columns,
    selectedSprintId: board.selectedSprintId,
    swimLane: board.swimLane,
    loadBoardData: board.loadBoardData,
    loadBacklogItems: board.loadBacklogItems,
    handleStatusChange: board.handleStatusChange,
  });

  return (
    <div className="flex flex-col h-[calc(100vh)] -m-6">
      <BoardFilters
        sprints={board.sprints}
        selectedSprintId={board.selectedSprintId}
        onSprintChange={board.setSelectedSprintId}
        swimLane={board.swimLane}
        onSwimLaneChange={(mode) => { board.setSwimLane(mode); board.setCollapsedLanes(new Set()); }}
        compactCards={board.compactCards}
        onCompactToggle={() => board.setCompactCards(!board.compactCards)}
        refreshing={board.refreshing}
        onRefresh={board.handleRefresh}
        backlogOpen={board.backlogOpen}
        onBacklogToggle={() => board.setBacklogOpen(!board.backlogOpen)}
      />

      <DndContext
        sensors={sensors}
        collisionDetection={columnCollision}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="flex flex-1 overflow-hidden">
          <div className="flex-1 overflow-x-auto p-4">
            {board.loading ? (
              <div className="flex items-center justify-center h-64">
                <Spinner size="lg" />
              </div>
            ) : !board.selectedSprintId ? (
              <div className="flex flex-col items-center justify-center h-64 text-gray-400">
                <KanbanSquare className="h-12 w-12 mb-3 text-gray-300" />
                <p className="text-sm">Select a sprint to view the board</p>
              </div>
            ) : board.swimLane !== 'off' ? (
              <SwimLaneGrid
                columns={board.columns}
                swimLane={board.swimLane}
                nameMap={board.nameMap}
                collapsedLanes={board.collapsedLanes}
                onToggleLane={board.toggleLane}
                selectedIds={board.selectedIds}
                onToggleSelect={board.handleToggleSelect}
                onItemUpdated={board.handleItemUpdated}
                onQuickAdd={board.handleQuickAdd}
                users={board.boardUsers}
                allLabels={board.boardLabels}
                compactCards={board.compactCards}
              />
            ) : (
              <KanbanBoard
                columns={board.columns}
                onQuickAdd={board.handleQuickAdd}
                selectedIds={board.selectedIds}
                onToggleSelect={board.handleToggleSelect}
                onItemUpdated={board.handleItemUpdated}
                users={board.boardUsers}
                allLabels={board.boardLabels}
                compact={board.compactCards}
              />
            )}
          </div>

          <BacklogSidePanel
            isOpen={board.backlogOpen}
            onToggle={() => board.setBacklogOpen(!board.backlogOpen)}
            items={board.backlogItems}
            loading={board.backlogLoading}
            onSearch={board.handleBacklogSearch}
          />
        </div>

        <DragOverlay>
          {activeDragItem ? (
            activeDragIsBacklog ? (
              <div className="bg-white border border-primary-300 rounded p-2 shadow-lg rotate-2 max-w-[200px]">
                <span className="text-xs text-gray-400 font-mono">#{activeDragItem.item_number}</span>
                <p className="text-xs text-gray-900 font-medium line-clamp-2 mt-0.5">
                  {activeDragItem.title}
                </p>
              </div>
            ) : (
              <KanbanCard item={activeDragItem} isDragOverlay compact={board.compactCards} />
            )
          ) : null}
        </DragOverlay>
      </DndContext>

      <BulkActionBar
        selectedCount={board.selectedIds.size}
        onClearSelection={() => { board.setSelectedIds(new Set()); board.setBulkError(null); }}
        onChangeStatus={board.handleBulkStatusChange}
        onChangePriority={() => {}}
        onAssignToSprint={board.handleBulkAssignSprint}
        onAssignUser={board.handleBulkAssignUser}
        onDelete={board.handleBulkDeleteRequest}
        error={board.bulkError}
      />

      {board.deleteConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => board.setDeleteConfirmOpen(false)} />
          <div className="relative bg-white rounded-lg shadow-xl p-6 w-full max-w-sm mx-4">
            <h3 className="text-lg font-semibold text-gray-900">Confirm Delete</h3>
            <p className="mt-2 text-sm text-gray-600">
              Are you sure you want to delete{' '}
              <span className="font-medium">{board.selectedIds.size}</span>{' '}
              {board.selectedIds.size === 1 ? 'item' : 'items'}? This action cannot be undone.
            </p>
            {board.deleteError && <p className="mt-2 text-sm text-red-600">{board.deleteError}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => board.setDeleteConfirmOpen(false)}
                className="px-3 py-1.5 text-sm text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={board.handleBulkDeleteConfirm}
                className="px-3 py-1.5 text-sm text-white bg-red-600 rounded-md hover:bg-red-700 transition-colors"
              >
                Delete {board.selectedIds.size} {board.selectedIds.size === 1 ? 'item' : 'items'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
