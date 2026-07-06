'use client';

/**
 * ProjectTasks -- Item display components for the project detail page.
 *
 * Contains:
 * - InlineItemCreate: "+ Add item" row for creating new items
 * - ItemCardList: Flex-based draggable card list (replaces MiniItemTable)
 * - BacklogPanel: Droppable backlog container (items not assigned to any sprint)
 * - SprintSection: Droppable collapsible sprint with parent-provided items
 */

import { useState } from 'react';
import Link from 'next/link';
import {
  Plus,
  ChevronDown,
  ChevronRight,
  Loader2,
  Package,
} from 'lucide-react';
import { createItem } from '@/lib/pm-queries';
import type { PmBacklogItem, PmSprint } from '@/lib/pm-types';
import {
  SPRINT_STATUS_LABELS,
  SPRINT_STATUS_COLORS,
} from '@/lib/pm-types';
import { DraggableItemRow } from './DraggableItemRow';
import { DroppableContainer } from './DroppableContainer';

// ---------------------------------------------------------------------------
// InlineItemCreate -- "+ Add item" row
// ---------------------------------------------------------------------------

interface InlineItemCreateProps {
  projectId: string;
  sprintId?: string | null;
  onCreated: () => void;
}

export function InlineItemCreate({ projectId, sprintId, onCreated }: InlineItemCreateProps) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (!adding) {
    return (
      <button
        onClick={() => setAdding(true)}
        className="flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700 py-2 px-1"
      >
        <Plus className="h-3 w-3" /> Add item
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
            sprint_id: sprintId || undefined,
            project_id: projectId,
          });
          setTitle('');
          setAdding(false);
          onCreated();
        } catch (err) {
          console.error('Failed to create:', err);
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
        placeholder="Item title..."
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
// ItemCardList -- Flex-based draggable card list (replaces MiniItemTable)
// ---------------------------------------------------------------------------

interface ItemCardListProps {
  items: PmBacklogItem[];
  projectId: string;
  /** Container id for drag source tracking (sprint id or 'backlog-panel') */
  containerId: string;
  /** BACKLOG-1664: selected item ids for bulk operations */
  selectedIds?: Set<string>;
  /** BACKLOG-1664: toggle an item's selection */
  onToggleSelect?: (itemId: string) => void;
}

export function ItemCardList({
  items,
  projectId,
  containerId,
  selectedIds,
  onToggleSelect,
}: ItemCardListProps) {
  if (items.length === 0) {
    return (
      <p className="text-xs text-gray-400 py-2">No items in this section.</p>
    );
  }

  return (
    <div className="space-y-1.5">
      {items.map((item) => (
        <DraggableItemRow
          key={item.id}
          item={item}
          projectId={projectId}
          containerId={containerId}
          selected={selectedIds?.has(item.id)}
          onToggleSelect={onToggleSelect}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SprintSection -- Collapsible sprint with parent-provided items
// ---------------------------------------------------------------------------

interface SprintSectionProps {
  sprint: PmSprint;
  projectId: string;
  /** Items for this sprint, filtered by the parent from the allItems array */
  items: PmBacklogItem[];
  onRefresh: () => void;
  /** BACKLOG-1664: selected item ids for bulk operations */
  selectedIds?: Set<string>;
  /** BACKLOG-1664: toggle an item's selection */
  onToggleSelect?: (itemId: string) => void;
}

export function SprintSection({
  sprint,
  projectId,
  items,
  onRefresh,
  selectedIds,
  onToggleSelect,
}: SprintSectionProps) {
  const defaultExpanded =
    sprint.status === 'active' || sprint.status === 'planned';
  const [expanded, setExpanded] = useState(defaultExpanded);

  // Sprint-wide counts (legacy — shown as secondary label for context on
  // cross-project sprints).
  const sprintCompleted = sprint.item_counts?.completed ?? 0;
  const sprintTotal = sprint.total_items ?? 0;

  // BACKLOG-1664: project-scoped counts. Populated by pm_get_project_detail.
  // Fallback to sprint-wide when absent so this component still works when
  // fed by sprint-centric RPCs that don't provide the per-project fields.
  const projectTotal = sprint.project_total ?? sprintTotal;
  const projectCompleted = sprint.project_completed ?? sprintCompleted;
  const projectPct =
    projectTotal > 0 ? Math.round((projectCompleted / projectTotal) * 100) : 0;

  // Show the sprint-wide count as secondary context only when the sprint
  // contains items from other projects too (i.e. sprintTotal > projectTotal).
  const hasCrossProjectItems = sprintTotal > projectTotal;

  return (
    <DroppableContainer droppableId={sprint.id}>
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
          <Link
            href={`/dashboard/pm/sprints/${sprint.id}`}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
            className="font-medium text-gray-900 hover:text-primary-600 hover:underline truncate"
          >
            {sprint.name}
          </Link>
          {sprint.legacy_id && (
            <span className="text-xs text-gray-400 font-mono shrink-0">
              {sprint.legacy_id}
            </span>
          )}
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium shrink-0 ${SPRINT_STATUS_COLORS[sprint.status]}`}
          >
            {SPRINT_STATUS_LABELS[sprint.status]}
          </span>
          <div className="flex-1" />
          <div className="flex items-center gap-2 shrink-0">
            <div
              className="w-20 h-1.5 bg-gray-200 rounded-full overflow-hidden hidden sm:block"
              title={`${projectCompleted} of ${projectTotal} in this project done`}
            >
              <div
                className="h-full bg-green-500 rounded-full transition-all"
                style={{ width: `${projectPct}%` }}
              />
            </div>
            <span className="text-xs text-gray-700 whitespace-nowrap font-medium">
              {projectCompleted}/{projectTotal}
            </span>
            {hasCrossProjectItems && (
              <span
                className="text-xs text-gray-400 whitespace-nowrap"
                title={`Sprint has ${sprintTotal} items across all projects (${sprintCompleted} completed)`}
              >
                ({sprintTotal} all)
              </span>
            )}
          </div>
        </button>

        {expanded && (
          <div className="px-4 py-2 border-t border-gray-100">
            <ItemCardList
              items={items}
              projectId={projectId}
              containerId={sprint.id}
              selectedIds={selectedIds}
              onToggleSelect={onToggleSelect}
            />
            <InlineItemCreate
              projectId={projectId}
              sprintId={sprint.id}
              onCreated={onRefresh}
            />
          </div>
        )}
      </div>
    </DroppableContainer>
  );
}

// ---------------------------------------------------------------------------
// BacklogPanel -- Items not assigned to any sprint
// ---------------------------------------------------------------------------

interface BacklogPanelProps {
  items: PmBacklogItem[];
  projectId: string;
  loading: boolean;
  onRefresh: () => void;
  /** BACKLOG-1664: selected item ids for bulk operations */
  selectedIds?: Set<string>;
  /** BACKLOG-1664: toggle an item's selection */
  onToggleSelect?: (itemId: string) => void;
}

export function BacklogPanel({
  items,
  projectId,
  loading,
  onRefresh,
  selectedIds,
  onToggleSelect,
}: BacklogPanelProps) {
  return (
    <DroppableContainer droppableId="backlog-panel">
      <div className="border border-gray-200 rounded-lg overflow-hidden">
        <div className="bg-gray-50 px-4 py-3 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <Package className="h-4 w-4 text-gray-500" />
            <h3 className="font-medium text-gray-900 text-sm">
              Backlog (unassigned)
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
              containerId="backlog-panel"
              selectedIds={selectedIds}
              onToggleSelect={onToggleSelect}
            />
          )}
          <InlineItemCreate
            projectId={projectId}
            sprintId={null}
            onCreated={onRefresh}
          />
        </div>
      </div>
    </DroppableContainer>
  );
}
