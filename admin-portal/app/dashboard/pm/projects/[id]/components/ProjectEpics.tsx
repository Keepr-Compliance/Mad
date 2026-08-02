'use client';

/**
 * ProjectEpics -- "Epics" view for the project detail page (BACKLOG-2386).
 *
 * Sequel to the sprint drag-and-drop workspace (BACKLOG-1026). Groups the
 * right column by EPIC (parent -> child) instead of by sprint, letting the
 * user drag tasks between epics and in/out of the "no epic" backlog to re-file
 * them. Re-filing changes a task's parent_id via pm_reorder_item; sprint_id is
 * orthogonal and left untouched.
 *
 * Contains:
 * - ViewToggle: [ Sprints | Epics ] segmented control
 * - InlineEpicTaskCreate: "+ Add task" (creates with a parent_id)
 * - InlineEpicCreate: "+ Add epic" (creates a type='epic' item)
 * - EpicSection: droppable, collapsible epic with progress + child rows
 * - EpicBacklogPanel: droppable "no epic" backlog (mirrors BacklogPanel)
 * - EpicsWorkspace: composition root (own DndContext + DragOverlay)
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Plus,
  ChevronDown,
  ChevronRight,
  Loader2,
  Package,
} from 'lucide-react';
import { DndContext, DragOverlay, pointerWithin } from '@dnd-kit/core';
import { createItem } from '@/lib/pm-queries';
import type { PmBacklogItem, ItemStatus } from '@/lib/pm-types';
import { TYPE_COLORS, TYPE_LABELS } from '@/lib/pm-types';
import { DraggableItemRow } from './DraggableItemRow';
import { DroppableContainer } from './DroppableContainer';
import { ItemCardList } from './ProjectTasks';
import { groupItemsByEpic } from '../lib/groupItemsByEpic';
import { useEpicDragDrop, EPIC_BACKLOG_DROPPABLE_ID } from '../hooks/useEpicDragDrop';

// ---------------------------------------------------------------------------
// ViewToggle -- [ Sprints | Epics ] segmented control
// ---------------------------------------------------------------------------

export type ProjectView = 'sprints' | 'epics';

interface ViewToggleProps {
  view: ProjectView;
  onChange: (view: ProjectView) => void;
}

const VIEW_OPTIONS: { value: ProjectView; label: string }[] = [
  { value: 'sprints', label: 'Sprints' },
  { value: 'epics', label: 'Epics' },
];

export function ViewToggle({ view, onChange }: ViewToggleProps) {
  return (
    <div
      role="tablist"
      aria-label="Workspace view"
      className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-0.5"
    >
      {VIEW_OPTIONS.map((opt) => {
        const active = view === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
              active
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// InlineEpicTaskCreate -- "+ Add task" row (creates a child with a parent_id)
// ---------------------------------------------------------------------------

interface InlineEpicTaskCreateProps {
  projectId: string;
  /** Parent epic id, or null to create an un-filed (backlog) task. */
  parentId: string | null;
  onCreated: () => void;
}

export function InlineEpicTaskCreate({ projectId, parentId, onCreated }: InlineEpicTaskCreateProps) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (!adding) {
    return (
      <button
        onClick={() => setAdding(true)}
        className="flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700 py-2 px-1"
      >
        <Plus className="h-3 w-3" /> Add task
      </button>
    );
  }

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!title.trim()) return;
        setSubmitting(true);
        try {
          await createItem({
            title: title.trim(),
            parent_id: parentId || undefined,
            project_id: projectId,
          });
          setTitle('');
          setAdding(false);
          onCreated();
        } catch (err) {
          console.error('Failed to create task:', err);
        } finally {
          setSubmitting(false);
        }
      }}
      className="flex items-center gap-2 py-2 px-1"
    >
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Task title..."
        className="flex-1 text-sm border border-gray-300 rounded px-2 py-1 text-gray-900 bg-white focus:outline-none focus:ring-1 focus:ring-primary-500"
        autoFocus
      />
      <button
        type="submit"
        disabled={submitting || !title.trim()}
        className="text-xs bg-primary-600 text-white px-2 py-1 rounded hover:bg-primary-700 disabled:opacity-50"
      >
        {submitting ? 'Adding...' : 'Add'}
      </button>
      <button
        type="button"
        onClick={() => { setAdding(false); setTitle(''); }}
        className="text-xs text-gray-500 hover:text-gray-700"
      >
        Cancel
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// InlineEpicCreate -- "+ Add epic" row (creates a type='epic' item)
// ---------------------------------------------------------------------------

interface InlineEpicCreateProps {
  projectId: string;
  onCreated: () => void;
}

export function InlineEpicCreate({ projectId, onCreated }: InlineEpicCreateProps) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (!adding) {
    return (
      <button
        onClick={() => setAdding(true)}
        className="flex items-center gap-1 text-sm text-primary-600 hover:text-primary-700 py-3 px-4"
      >
        <Plus className="h-4 w-4" /> Add epic
      </button>
    );
  }

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!title.trim()) return;
        setSubmitting(true);
        try {
          await createItem({
            title: title.trim(),
            type: 'epic',
            project_id: projectId,
          });
          setTitle('');
          setAdding(false);
          onCreated();
        } catch (err) {
          console.error('Failed to create epic:', err);
        } finally {
          setSubmitting(false);
        }
      }}
      className="flex items-center gap-2 py-3 px-4"
    >
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Epic title..."
        className="flex-1 text-sm border border-gray-300 rounded px-2 py-1 text-gray-900 bg-white focus:outline-none focus:ring-1 focus:ring-primary-500"
        autoFocus
      />
      <button
        type="submit"
        disabled={submitting || !title.trim()}
        className="text-xs bg-primary-600 text-white px-2 py-1 rounded hover:bg-primary-700 disabled:opacity-50"
      >
        {submitting ? 'Adding...' : 'Add'}
      </button>
      <button
        type="button"
        onClick={() => { setAdding(false); setTitle(''); }}
        className="text-xs text-gray-500 hover:text-gray-700"
      >
        Cancel
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// EpicSection -- Collapsible, droppable epic with progress + child rows
// ---------------------------------------------------------------------------

interface EpicSectionProps {
  epic: PmBacklogItem;
  projectId: string;
  /** ALL child tasks of this epic (unfiltered) — used for the progress count. */
  items: PmBacklogItem[];
  /** Active status filter (null = show all). Applied to displayed rows only. */
  statusFilter?: ItemStatus | null;
  onRefresh: () => void;
  selectedIds?: Set<string>;
  onToggleSelect?: (itemId: string) => void;
}

export function EpicSection({
  epic,
  projectId,
  items,
  statusFilter,
  onRefresh,
  selectedIds,
  onToggleSelect,
}: EpicSectionProps) {
  const [expanded, setExpanded] = useState(true);

  // Progress is computed from the FULL child set so it reflects true epic
  // progress regardless of any active status filter.
  const total = items.length;
  const completed = items.filter((i) => i.status === 'completed').length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  // Displayed rows respect the active status filter.
  const displayItems = statusFilter
    ? items.filter((i) => i.status === statusFilter)
    : items;

  return (
    <DroppableContainer droppableId={epic.id}>
      <div className="border border-gray-200 rounded-lg overflow-hidden">
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center gap-3 px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors text-left"
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-gray-500 shrink-0" />
          ) : (
            <ChevronRight className="h-4 w-4 text-gray-500 shrink-0" />
          )}
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium shrink-0 ${TYPE_COLORS.epic}`}
          >
            {TYPE_LABELS.epic}
          </span>
          <span className="text-xs text-gray-400 font-mono shrink-0">
            #{epic.item_number}
          </span>
          <Link
            href={`/dashboard/pm/tasks/${epic.id}?from=project&projectId=${projectId}`}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
            className="font-medium text-gray-900 hover:text-primary-600 hover:underline truncate"
          >
            {epic.title}
          </Link>
          <div className="flex-1" />
          <div className="flex items-center gap-2 shrink-0">
            <div
              className="w-20 h-1.5 bg-gray-200 rounded-full overflow-hidden hidden sm:block"
              title={`${completed} of ${total} tasks done`}
            >
              <div
                className="h-full bg-green-500 rounded-full transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-xs text-gray-700 whitespace-nowrap font-medium">
              {completed}/{total}
            </span>
          </div>
        </button>

        {expanded && (
          <div className="px-4 py-2 border-t border-gray-100">
            <ItemCardList
              items={displayItems}
              projectId={projectId}
              containerId={epic.id}
              selectedIds={selectedIds}
              onToggleSelect={onToggleSelect}
            />
            <InlineEpicTaskCreate
              projectId={projectId}
              parentId={epic.id}
              onCreated={onRefresh}
            />
          </div>
        )}
      </div>
    </DroppableContainer>
  );
}

// ---------------------------------------------------------------------------
// EpicBacklogPanel -- "No epic" backlog (mirrors BacklogPanel)
// ---------------------------------------------------------------------------

interface EpicBacklogPanelProps {
  /** The "no epic" items to display (already status-filtered by the parent). */
  items: PmBacklogItem[];
  projectId: string;
  loading: boolean;
  onRefresh: () => void;
  selectedIds?: Set<string>;
  onToggleSelect?: (itemId: string) => void;
}

export function EpicBacklogPanel({
  items,
  projectId,
  loading,
  onRefresh,
  selectedIds,
  onToggleSelect,
}: EpicBacklogPanelProps) {
  return (
    <DroppableContainer droppableId={EPIC_BACKLOG_DROPPABLE_ID}>
      <div className="border border-gray-200 rounded-lg overflow-hidden">
        <div className="bg-gray-50 px-4 py-3 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <Package className="h-4 w-4 text-gray-500" />
            <h3 className="font-medium text-gray-900 text-sm">
              Backlog (no epic)
            </h3>
            <span className="text-xs text-gray-500">({items.length})</span>
          </div>
        </div>

        <div className="px-4 py-2">
          {loading ? (
            <div className="flex items-center gap-2 py-4 justify-center text-gray-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-xs">Loading...</span>
            </div>
          ) : (
            <ItemCardList
              items={items}
              projectId={projectId}
              containerId={EPIC_BACKLOG_DROPPABLE_ID}
              selectedIds={selectedIds}
              onToggleSelect={onToggleSelect}
            />
          )}
          <InlineEpicTaskCreate
            projectId={projectId}
            parentId={null}
            onCreated={onRefresh}
          />
        </div>
      </div>
    </DroppableContainer>
  );
}

// ---------------------------------------------------------------------------
// EpicsWorkspace -- Composition root for the Epics view (own DndContext)
// ---------------------------------------------------------------------------

interface EpicsWorkspaceProps {
  /** All non-deleted items for this project (epics + tasks). */
  allItems: PmBacklogItem[];
  projectId: string;
  loading: boolean;
  /** Active status filter (null = all). */
  statusFilter?: ItemStatus | null;
  selectedIds?: Set<string>;
  onToggleSelect?: (itemId: string) => void;
  /** Full refresh (used as the optimistic-update revert fallback). */
  onRefresh: () => void;
  /** Optimistic local updater: set an item's parent_id (null = backlog). */
  moveItemParent: (itemId: string, parentId: string | null) => void;
}

export function EpicsWorkspace({
  allItems,
  projectId,
  loading,
  statusFilter,
  selectedIds,
  onToggleSelect,
  onRefresh,
  moveItemParent,
}: EpicsWorkspaceProps) {
  const grouped = useMemo(() => groupItemsByEpic(allItems), [allItems]);

  const { sensors, activeDragItem, handleDragStart, handleDragEnd } =
    useEpicDragDrop({ moveItemParent, onRefreshFallback: onRefresh });

  // Backlog display respects the active status filter (mirrors the sprint
  // view's pre-filtered backlogItems contract).
  const backlogDisplay = statusFilter
    ? grouped.backlog.filter((i) => i.status === statusFilter)
    : grouped.backlog;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="flex flex-col min-[1200px]:flex-row gap-6">
        {/* Left: "no epic" backlog */}
        <div className="w-full min-[1200px]:flex-none min-[1200px]:w-[380px] min-[1200px]:max-h-[calc(100vh-200px)] min-[1200px]:overflow-y-auto">
          <div className="flex items-center gap-2 mb-4">
            <h2 className="text-lg font-semibold text-gray-900">Backlog</h2>
            <span className="text-sm text-gray-500">({backlogDisplay.length})</span>
          </div>
          <EpicBacklogPanel
            items={backlogDisplay}
            projectId={projectId}
            loading={loading}
            onRefresh={onRefresh}
            selectedIds={selectedIds}
            onToggleSelect={onToggleSelect}
          />
        </div>

        {/* Right: epic sections */}
        <div className="flex-1 min-w-0 space-y-4">
          <div className="flex items-center gap-2 mb-4">
            <h2 className="text-lg font-semibold text-gray-900">Epics</h2>
            <span className="text-sm text-gray-500">({grouped.epics.length})</span>
          </div>

          {grouped.epics.length === 0 ? (
            <div className="border border-gray-200 rounded-lg p-8 text-center">
              <p className="text-sm text-gray-400">
                No epics yet. Create one below.
              </p>
            </div>
          ) : (
            grouped.epics.map((epic) => (
              <EpicSection
                key={epic.id}
                epic={epic}
                projectId={projectId}
                items={grouped.childrenByEpicId[epic.id] ?? []}
                statusFilter={statusFilter}
                onRefresh={onRefresh}
                selectedIds={selectedIds}
                onToggleSelect={onToggleSelect}
              />
            ))
          )}

          <InlineEpicCreate projectId={projectId} onCreated={onRefresh} />
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
  );
}
