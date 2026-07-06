'use client';

/**
 * Sprint Detail Page - /dashboard/pm/sprints/[id]
 *
 * Shows full sprint information: header with status badge, goal, date range,
 * item progress breakdown, token metric cards with tooltips,
 * and a paginated task table of sprint items.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  Calendar,
  Target,
  CheckCircle2,
  Clock,
  AlertCircle,
  Loader2,
  Trash2,
  Coins,
  TrendingUp,
  TrendingDown,
  Info,
} from 'lucide-react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  getSprintDetail,
  listItems,
  deleteSprint,
  updateSprintField,
  assignToSprint,
  updateItemField,
} from '@/lib/pm-queries';
import TokenMetricsBreakdown from '../../components/TokenMetricsBreakdown';
import { usePermissions } from '@/components/providers/PermissionsProvider';
import { PERMISSIONS } from '@/lib/permissions';
import type {
  PmBacklogItem,
  SprintDetailResponse,
  ItemStatus,
  SortableColumn,
  SortDirection,
} from '@/lib/pm-types';
import { STATUS_LABELS } from '@/lib/pm-types';
import { TaskTable } from '../../components/TaskTable';
import { InlineSprintStatusPicker } from '../../components/InlineSprintStatusPicker';
import { DualProgressBar } from '../../components/DualProgressBar';
import { InlineEditText } from '../../components/InlineEditText';
import { BacklogSidePanel } from '../../components/BacklogSidePanel';
import { formatTokens } from '@/lib/pm-utils';

// ---------------------------------------------------------------------------
// localStorage key for backlog panel visibility
// ---------------------------------------------------------------------------

const BACKLOG_OPEN_STORAGE_KEY = 'pm-sprint-detail-backlog-open';

function readPersistedBacklogOpen(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const saved = localStorage.getItem(BACKLOG_OPEN_STORAGE_KEY);
    if (saved !== null) return saved === 'true';
  } catch (err) {
    console.error('Failed to read backlog panel state:', err);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Client-side sorting (same as backlog page)
// ---------------------------------------------------------------------------

const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const STATUS_ORDER: Record<string, number> = { pending: 0, in_progress: 1, testing: 2, waiting_for_user: 3, reopened: 4, blocked: 5, completed: 6, deferred: 7, obsolete: 8 };
const TYPE_ORDER: Record<string, number> = { epic: 0, feature: 1, bug: 2, spike: 3, chore: 4 };

function sortItems(items: PmBacklogItem[], col: SortableColumn | null, dir: SortDirection): PmBacklogItem[] {
  if (!col) return items;
  const d = dir === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    let cmp = 0;
    switch (col) {
      case 'item_number': cmp = a.item_number - b.item_number; break;
      case 'title': cmp = a.title.localeCompare(b.title); break;
      case 'type': cmp = (TYPE_ORDER[a.type] ?? 99) - (TYPE_ORDER[b.type] ?? 99); break;
      case 'status': cmp = (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99); break;
      case 'priority': cmp = (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99); break;
      case 'area': cmp = (a.area || '').localeCompare(b.area || ''); break;
      case 'est_tokens': cmp = (a.est_tokens ?? 0) - (b.est_tokens ?? 0); break;
      case 'created_at': cmp = new Date(a.created_at).getTime() - new Date(b.created_at).getTime(); break;
    }
    return cmp * d;
  });
}

export default function SprintDetailPage() {
  const params = useParams();
  const router = useRouter();
  const sprintId = params.id as string;
  const { hasPermission } = usePermissions();

  const [detail, setDetail] = useState<SprintDetailResponse | null>(null);
  const [items, setItems] = useState<PmBacklogItem[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [sortBy, setSortBy] = useState<SortableColumn | null>(null);
  const [sortDir, setSortDir] = useState<SortDirection>('asc');
  const [statusFilter, setStatusFilter] = useState<ItemStatus | null>(null);

  // Backlog side panel state (drag-drop to add items to this sprint).
  // State init must NOT read localStorage — causes React hydration error
  // #418. We restore from localStorage in a mount-only useEffect below.
  // The `hydrated` flag gates the write-effect so the default `false`
  // doesn't clobber the persisted value before it's restored.
  const [hydrated, setHydrated] = useState(false);
  const [backlogOpen, setBacklogOpen] = useState<boolean>(false);
  const [backlogItems, setBacklogItems] = useState<PmBacklogItem[]>([]);
  const [backlogLoading, setBacklogLoading] = useState(false);
  // Drag state: item being dragged + whether it came from the backlog panel
  // (backlog-item) or an existing sprint row (sprint-item). Drives DragOverlay.
  const [activeDragItem, setActiveDragItem] = useState<PmBacklogItem | null>(null);
  const [activeDragType, setActiveDragType] = useState<'backlog-item' | 'sprint-item' | null>(null);

  const pageSize = 50;

  // Load sprint detail (showSpinner=true for initial load, false for inline refreshes)
  const loadDetail = useCallback(async (showSpinner = true) => {
    if (!sprintId) return;
    if (showSpinner) setLoading(true);
    setError(null);
    try {
      const data = await getSprintDetail(sprintId);
      setDetail(data);
    } catch (err) {
      console.error('Failed to load sprint detail:', err);
      setError('Failed to load sprint detail.');
    } finally {
      if (showSpinner) setLoading(false);
    }
  }, [sprintId]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  // Load paginated items (server-side status filter when statusFilter is set)
  const loadItems = useCallback(async () => {
    if (!sprintId) return;

    setItemsLoading(true);
    try {
      const data = await listItems({
        sprint_id: sprintId,
        status: statusFilter,
        page,
        page_size: pageSize,
      });
      setItems(data.items);
      setTotalCount(data.total_count);
      setTotalPages(Math.ceil(data.total_count / pageSize));
    } catch (err) {
      console.error('Failed to load sprint items:', err);
    } finally {
      setItemsLoading(false);
    }
  }, [sprintId, page, statusFilter]);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  // Restore backlog panel state from localStorage on mount. Must be in an
  // effect (not state init) to avoid React hydration error #418.
  useEffect(() => {
    const saved = readPersistedBacklogOpen();
    if (saved) setBacklogOpen(true);
    setHydrated(true);
  }, []);

  // Persist backlog panel open/closed state to localStorage so it survives
  // page reloads (matches the board's pm-board-state pattern). Gated on
  // `hydrated` so the default `false` doesn't clobber the persisted value.
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(BACKLOG_OPEN_STORAGE_KEY, String(backlogOpen));
    } catch (err) {
      console.error('Failed to persist backlog panel state:', err);
    }
  }, [hydrated, backlogOpen]);

  // Load unassigned backlog items (sprint_id IS NULL). Mirrors the board's
  // loadBacklogItems in useBoardData.ts so the panel feels identical.
  const loadBacklogItems = useCallback(async (search?: string) => {
    setBacklogLoading(true);
    try {
      const result = await listItems({
        unassigned_only: true,
        search: search || undefined,
        page_size: 100,
      });
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

  const handleBacklogSearch = useCallback(
    (query: string) => {
      loadBacklogItems(query);
    },
    [loadBacklogItems]
  );

  // --- Drag and drop --------------------------------------------------------
  // Two flows are supported here:
  //   1) backlog-item  -> drop on `sprint-items`   => assign to this sprint
  //   2) sprint-item   -> drop on `backlog-panel`  => unassign from sprint
  // Other combinations are no-ops (e.g. sprint-item dropped back on
  // `sprint-items` -- it's already in this sprint).
  // Mirrors the Kanban board's `useBoardDragDrop` pattern.
  const sensors = useSensors(
    useSensor(PointerSensor, {
      // 8px activation threshold keeps accidental clicks from starting a drag,
      // so clicking a row still navigates to the task detail.
      activationConstraint: { distance: 8 },
    }),
    useSensor(KeyboardSensor)
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const data = event.active.data.current;
    if (data?.type === 'backlog-item') {
      setActiveDragItem(data.item as PmBacklogItem);
      setActiveDragType('backlog-item');
    } else if (data?.type === 'sprint-item') {
      setActiveDragItem(data.item as PmBacklogItem);
      setActiveDragType('sprint-item');
    }
  }, []);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      setActiveDragItem(null);
      setActiveDragType(null);

      if (!over) return;

      const data = active.data.current;
      const overId = over.id as string;

      // Flow 2: sprint row dragged back onto the backlog panel -> unassign.
      if (overId === 'backlog-panel' && data?.type === 'sprint-item') {
        const item = data.item as PmBacklogItem;
        try {
          await updateItemField(item.id, 'sprint_id', null);
          await Promise.all([
            loadDetail(false),
            loadItems(),
            loadBacklogItems(),
          ]);
        } catch (err) {
          console.error('Failed to unassign item from sprint:', err);
          // Refresh to revert any optimistic UI state.
          await Promise.all([loadDetail(false), loadItems()]);
        }
        return;
      }

      // Flow 1: backlog item dragged onto the sprint items table -> assign.
      if (overId === 'sprint-items' && data?.type === 'backlog-item') {
        const item = data.item as PmBacklogItem;
        try {
          await assignToSprint([item.id], sprintId);
          await Promise.all([
            loadDetail(false),
            loadItems(),
            loadBacklogItems(),
          ]);
        } catch (err) {
          console.error('Failed to assign backlog item to sprint:', err);
        }
        return;
      }

      // Any other combination (e.g. sprint-item dropped back on sprint-items)
      // is a no-op -- nothing to update.
    },
    [sprintId, loadDetail, loadItems, loadBacklogItems]
  );

  // Reset page to 1 alongside the filter change (done synchronously in
  // handleStatusFilter below) so we only trigger one loadItems fetch per
  // filter change instead of two.
  const handleStatusFilter = useCallback((status: ItemStatus | null) => {
    setPage(1);
    setStatusFilter(status);
  }, []);

  // Sort handler
  function handleSort(column: SortableColumn) {
    if (sortBy === column) {
      setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(column);
      setSortDir('asc');
    }
  }

  const sortedItems = useMemo(() => sortItems(items, sortBy, sortDir), [items, sortBy, sortDir]);

  // Build task URL with sprint context (must be before early returns for hook rules)
  const buildItemUrl = useMemo(
    () => (itemId: string) => `/dashboard/pm/tasks/${itemId}?from=sprint&sprintId=${sprintId}`,
    [sprintId]
  );

  async function handleDelete() {
    setDeleting(true);
    try {
      await deleteSprint(sprintId);
      router.push('/dashboard/pm/sprints');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete sprint');
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  }

  // Loading state
  if (loading) {
    return (
      <div className="max-w-7xl mx-auto">
        <div className="mb-6">
          <Link
            href="/dashboard/pm/sprints"
            className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Sprints
          </Link>
        </div>
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 text-gray-400 animate-spin" />
        </div>
      </div>
    );
  }

  // Error state
  if (error || !detail) {
    return (
      <div className="max-w-7xl mx-auto">
        <div className="mb-6">
          <Link
            href="/dashboard/pm/sprints"
            className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Sprints
          </Link>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
          <p className="text-gray-500 text-sm">
            {error || 'Sprint not found.'}
          </p>
        </div>
      </div>
    );
  }

  const { sprint, metrics } = detail;

  // Build byStatus counts from the full (unpaginated) sprint items returned
  // by pm_get_sprint_detail. We can't rely on sprint.item_counts because the
  // detail RPC doesn't populate it (only pm_list_sprints does).
  const byStatus: Record<string, number> = {};
  for (const it of detail.items) {
    byStatus[it.status] = (byStatus[it.status] ?? 0) + 1;
  }

  // Status breakdown for the progress section
  const statusBreakdown: {
    label: string;
    count: number;
    icon: typeof CheckCircle2;
    color: string;
  }[] = [
    {
      label: 'Completed',
      count: metrics.completed_items,
      icon: CheckCircle2,
      color: 'text-green-500',
    },
    {
      label: 'In Progress',
      count: metrics.in_progress_items,
      icon: Clock,
      color: 'text-blue-500',
    },
    {
      label: 'Remaining',
      count: Math.max(
        0,
        metrics.total_items -
          metrics.completed_items -
          metrics.in_progress_items
      ),
      icon: AlertCircle,
      color: 'text-gray-400',
    },
  ];

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="flex gap-0 -mr-6">
        {/* Main content column */}
        <div className="flex-1 min-w-0 max-w-7xl mx-auto pr-6">
      {/* Navigation */}
      <div className="mb-6">
        <Link
          href="/dashboard/pm/sprints"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Sprints
        </Link>

        {/* Sprint Header */}
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-gray-900">
                <InlineEditText
                  value={sprint.name}
                  placeholder="Sprint name..."
                  onSave={async (newValue) => {
                    if (!newValue) return;
                    await updateSprintField(sprintId, 'name', newValue);
                    loadDetail(false);
                  }}
                  displayClassName="text-2xl font-bold text-gray-900"
                />
              </h1>
              {sprint.legacy_id && (
                <span className="text-xs text-gray-400 font-mono">
                  {sprint.legacy_id}
                </span>
              )}
              <InlineSprintStatusPicker
                sprintId={sprintId}
                status={sprint.status}
                canEdit={hasPermission(PERMISSIONS.PM_MANAGE)}
                onUpdated={() => loadDetail(false)}
              />
            </div>
            <div className="mt-2 flex items-start gap-1">
              <Target className="h-4 w-4 flex-shrink-0 text-gray-500 mt-0.5" />
              <InlineEditText
                value={sprint.goal}
                placeholder="Add a sprint goal..."
                multiline
                onSave={async (newValue) => {
                  await updateSprintField(sprintId, 'goal', newValue);
                  loadDetail(false);
                }}
                displayClassName="text-sm text-gray-500"
                rows={2}
              />
            </div>
            <div className="mt-1 flex items-center gap-2 text-sm text-gray-500">
              <Calendar className="h-4 w-4 flex-shrink-0" />
              <input
                type="date"
                value={sprint.start_date ? sprint.start_date.slice(0, 10) : ''}
                onChange={async (e) => {
                  const val = e.target.value;
                  await updateSprintField(sprintId, 'start_date', val || null);
                  loadDetail(false);
                }}
                className="border border-gray-200 rounded px-2 py-0.5 text-sm text-gray-700 bg-white focus:outline-none focus:ring-1 focus:ring-primary-500"
                title="Start date"
              />
              <span className="text-gray-400">-</span>
              <input
                type="date"
                value={sprint.end_date ? sprint.end_date.slice(0, 10) : ''}
                onChange={async (e) => {
                  const val = e.target.value;
                  await updateSprintField(sprintId, 'end_date', val || null);
                  loadDetail(false);
                }}
                className="border border-gray-200 rounded px-2 py-0.5 text-sm text-gray-700 bg-white focus:outline-none focus:ring-1 focus:ring-primary-500"
                title="End date"
              />
            </div>
          </div>
          {hasPermission(PERMISSIONS.PM_ADMIN) && (
            <button
              onClick={() => setShowDeleteConfirm(true)}
              className="inline-flex items-center gap-1.5 text-xs text-red-500 hover:text-red-700 transition-colors"
              title="Delete sprint"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </button>
          )}
        </div>
      </div>

      {/* Delete Confirmation */}
      {showDeleteConfirm && (
        <div className="bg-red-50 border border-red-200 rounded-md p-4 mb-6">
          <p className="text-sm text-red-800">
            Are you sure you want to delete sprint &quot;{sprint.name}&quot;? This will soft-delete the sprint.
          </p>
          <div className="flex gap-2 mt-3">
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="px-3 py-1 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
            >
              {deleting ? 'Deleting...' : 'Delete'}
            </button>
            <button
              onClick={() => setShowDeleteConfirm(false)}
              className="px-3 py-1 text-sm text-gray-700 bg-white border rounded hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Progress Section */}
      <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
        <DualProgressBar
          completed={metrics.completed_items}
          total={metrics.total_items}
          byStatus={byStatus}
          estTokens={metrics.total_est_tokens}
          actualTokens={metrics.total_actual_tokens}
          onStatusFilter={handleStatusFilter}
          activeFilter={statusFilter}
        />
        <div className="grid grid-cols-3 gap-4 mt-4 pt-4 border-t border-gray-100">
          {statusBreakdown.map((item) => {
            const Icon = item.icon;
            return (
              <div key={item.label} className="flex items-center gap-2">
                <Icon className={`h-5 w-5 ${item.color}`} />
                <div>
                  <div className="text-lg font-semibold text-gray-900">
                    {item.count}
                  </div>
                  <div className="text-xs text-gray-500">{item.label}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Token Metric Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-50">
              <Coins className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Estimated Tokens</p>
              <p className="text-2xl font-bold text-gray-900">
                {formatTokens(metrics.total_est_tokens)}
              </p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-purple-50">
              <Coins className="h-5 w-5 text-purple-600" />
            </div>
            <div>
              <p className="text-sm text-gray-500">Actual Tokens</p>
              <p className="text-2xl font-bold text-gray-900">
                {formatTokens(metrics.total_actual_tokens)}
              </p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <div className="flex items-center gap-3">
            {(() => {
              const variance =
                metrics.total_est_tokens > 0
                  ? ((metrics.total_actual_tokens - metrics.total_est_tokens) /
                      metrics.total_est_tokens) *
                    100
                  : 0;
              const isOver = variance > 0;
              const Icon = isOver ? TrendingUp : TrendingDown;
              return (
                <>
                  <div
                    className={`p-2 rounded-lg ${isOver ? 'bg-red-50' : 'bg-green-50'}`}
                  >
                    <Icon
                      className={`h-5 w-5 ${isOver ? 'text-red-600' : 'text-green-600'}`}
                    />
                  </div>
                  <div>
                    <div className="flex items-center gap-1">
                      <p className="text-sm text-gray-500">Variance</p>
                      <span className="group relative">
                        <Info className="h-3.5 w-3.5 text-gray-400 cursor-help" />
                        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 text-xs text-white bg-gray-800 rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                          (Actual − Estimated) / Estimated × 100
                        </span>
                      </span>
                    </div>
                    <p
                      className={`text-2xl font-bold ${isOver ? 'text-red-600' : 'text-green-600'}`}
                    >
                      {isOver ? '+' : ''}
                      {variance.toFixed(0)}%
                    </p>
                  </div>
                </>
              );
            })()}
          </div>
        </div>

        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <div className="flex items-center gap-3">
            {(() => {
              const SCOPE_CREEP_RED_THRESHOLD = 4;
              const original = sprint.original_item_count ?? metrics.total_items;
              const added = metrics.total_items - original;
              const pct = original > 0 ? Math.round((added / original) * 100) : 0;
              const hasCreep = added > 0;
              const isSevere = added >= SCOPE_CREEP_RED_THRESHOLD;
              return (
                <>
                  <div className={`p-2 rounded-lg ${hasCreep ? (isSevere ? 'bg-red-50' : 'bg-yellow-50') : 'bg-green-50'}`}>
                    <TrendingUp className={`h-5 w-5 ${hasCreep ? (isSevere ? 'text-red-600' : 'text-yellow-600') : 'text-green-600'}`} />
                  </div>
                  <div>
                    <div className="flex items-center gap-1">
                      <p className="text-sm text-gray-500">Scope Change</p>
                      <span className="group relative">
                        <Info className="h-3.5 w-3.5 text-gray-400 cursor-help" />
                        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 text-xs text-white bg-gray-800 rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                          Items added after sprint started vs original count
                        </span>
                      </span>
                    </div>
                    <p className={`text-2xl font-bold ${hasCreep ? (isSevere ? 'text-red-600' : 'text-yellow-600') : 'text-green-600'}`}>
                      {added > 0 ? '+' : ''}{added} ({pct}%)
                    </p>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      </div>

      {/* Token Metrics Breakdown by Agent Type — wrapper card only renders
          when there is data to show (component owns the wrapper). */}
      <TokenMetricsBreakdown
        sprintId={sprint.id}
        defaultExpanded
        wrapperClassName="bg-white rounded-lg border border-gray-200 p-6 mb-6"
      />

      {/* Sprint Items Table (droppable target for backlog items) */}
      <SprintItemsDropZone
        totalCount={totalCount}
        statusFilter={statusFilter}
        onClearStatusFilter={() => handleStatusFilter(null)}
      >
        <TaskTable
          items={sortedItems}
          totalCount={totalCount}
          page={page}
          pageSize={pageSize}
          totalPages={totalPages}
          onPageChange={setPage}
          loading={itemsLoading}
          buildItemUrl={buildItemUrl}
          sortBy={sortBy}
          sortDir={sortDir}
          onSort={handleSort}
          enableDrag
        />
      </SprintItemsDropZone>
        </div>

        {/* Backlog side panel (collapsible, drag-to-assign source) */}
        <BacklogSidePanel
          isOpen={backlogOpen}
          onToggle={() => setBacklogOpen((prev) => !prev)}
          items={backlogItems}
          loading={backlogLoading}
          onSearch={handleBacklogSearch}
        />
      </div>

      {/* Floating preview card while dragging.
          - backlog-item (from side panel): compact card, matches BacklogPanelItem.
          - sprint-item (from the items table): same compact ghost so the user
            sees what they're dragging without the table row lifting out. */}
      <DragOverlay>
        {activeDragItem && activeDragType ? (
          <div className="bg-white border border-primary-300 rounded p-2 shadow-lg rotate-2 max-w-[240px]">
            <span className="text-xs text-gray-400 font-mono">
              #{activeDragItem.item_number}
            </span>
            <p className="text-xs text-gray-900 font-medium line-clamp-2 mt-0.5">
              {activeDragItem.title}
            </p>
            {activeDragType === 'sprint-item' && (
              <p className="text-[10px] text-gray-400 mt-1">Drop on backlog to unassign</p>
            )}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

// ---------------------------------------------------------------------------
// SprintItemsDropZone -- droppable wrapper around the sprint items table.
// Extracted so useDroppable can be called from a child (keeping SprintDetailPage
// free of the extra hook). Renders the section header + filter chip and a
// drop-highlight ring when a backlog item is hovered over it.
// ---------------------------------------------------------------------------

interface SprintItemsDropZoneProps {
  totalCount: number;
  statusFilter: ItemStatus | null;
  onClearStatusFilter: () => void;
  children: React.ReactNode;
}

function SprintItemsDropZone({
  totalCount,
  statusFilter,
  onClearStatusFilter,
  children,
}: SprintItemsDropZoneProps) {
  const { setNodeRef, isOver } = useDroppable({ id: 'sprint-items' });

  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-sm font-semibold text-gray-900">
          Sprint Items ({totalCount})
        </h2>
        {statusFilter && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-gray-100 text-gray-700">
            Filtered: {STATUS_LABELS[statusFilter]}
            <button
              type="button"
              onClick={onClearStatusFilter}
              className="ml-0.5 text-gray-400 hover:text-gray-700"
            >
              &times;
            </button>
          </span>
        )}
      </div>
      <div
        ref={setNodeRef}
        className={`transition-all rounded-lg ${
          isOver
            ? 'ring-2 ring-primary-400 ring-offset-2 ring-offset-white bg-primary-50/30'
            : ''
        }`}
      >
        {children}
      </div>
    </div>
  );
}
