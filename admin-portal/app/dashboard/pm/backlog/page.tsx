'use client';

/**
 * Backlog Management Page - /dashboard/pm/backlog
 *
 * Main list view for all PM backlog items. Provides:
 * - Stats cards (total open, pending, in progress, blocked, active sprints)
 * - Full-text search (debounced) + client-side ID/legacy_id/description matching
 * - Multi-select filter bar (status, priority, type, area, sprint, project)
 * - Sortable table columns (click to toggle asc/desc)
 * - Saved view configurations
 * - Paginated table (flat) or hierarchy tree view (toggled)
 * - Create item dialog
 *
 * Pattern: Follows admin-portal/app/dashboard/support/page.tsx
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, List, GitBranch } from 'lucide-react';
import { PageHeader, Button } from '@keepr/design-system';
import { listItems, listAssignableUsers } from '@/lib/pm-queries';
import type { PmBacklogItem, PmSavedView, SortableColumn, SortDirection, ItemStatus, ItemPriority, ItemType } from '@/lib/pm-types';
import { TaskStatsCards } from '../components/TaskStatsCards';
import type { CustomGauge } from '../components/TaskStatsCards';
import { TaskFilters } from '../components/TaskFilters';
import { TaskTable } from '../components/TaskTable';
import { TaskSearchBar } from '../components/TaskSearchBar';
import { SavedViewSelector } from '../components/SavedViewSelector';
import { HierarchyTree } from '../components/HierarchyTree';
import { CreateTaskDialog } from '../components/CreateTaskDialog';
import { BacklogBulkBar } from '../components/BacklogBulkBar';

// ---------------------------------------------------------------------------
// Priority order maps for sorting enum-valued columns
// ---------------------------------------------------------------------------

const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const STATUS_ORDER: Record<string, number> = {
  pending: 0,
  in_progress: 1,
  testing: 2,
  waiting_for_user: 3,
  reopened: 4,
  blocked: 5,
  completed: 6,
  deferred: 7,
  obsolete: 8,
};

const TYPE_ORDER: Record<string, number> = {
  epic: 0,
  feature: 1,
  bug: 2,
  spike: 3,
  chore: 4,
};

// ---------------------------------------------------------------------------
// Client-side sorting helper
// ---------------------------------------------------------------------------

function sortItems(
  items: PmBacklogItem[],
  sortBy: SortableColumn | null,
  sortDir: SortDirection
): PmBacklogItem[] {
  if (!sortBy) return items;

  const sorted = [...items];
  const dir = sortDir === 'asc' ? 1 : -1;

  sorted.sort((a, b) => {
    let cmp = 0;
    switch (sortBy) {
      case 'item_number':
        cmp = a.item_number - b.item_number;
        break;
      case 'title':
        cmp = a.title.localeCompare(b.title);
        break;
      case 'type':
        cmp = (TYPE_ORDER[a.type] ?? 99) - (TYPE_ORDER[b.type] ?? 99);
        break;
      case 'status':
        cmp = (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99);
        break;
      case 'priority':
        cmp = (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99);
        break;
      case 'area':
        cmp = (a.area || '').localeCompare(b.area || '');
        break;
      case 'est_tokens':
        cmp = (a.est_tokens ?? 0) - (b.est_tokens ?? 0);
        break;
      case 'created_at':
        cmp = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        break;
    }
    return cmp * dir;
  });

  return sorted;
}

// ---------------------------------------------------------------------------
// Client-side multi-value filtering
// ---------------------------------------------------------------------------

function matchesMultiFilters(
  item: PmBacklogItem,
  statuses: string[],
  priorities: string[],
  types: string[],
  areas: string[],
  sprintIds: string[],
  projectIds: string[]
): boolean {
  if (statuses.length > 0 && !statuses.includes(item.status)) return false;
  if (priorities.length > 0 && !priorities.includes(item.priority)) return false;
  if (types.length > 0 && !types.includes(item.type)) return false;
  if (areas.length > 0 && !(item.area && areas.includes(item.area))) return false;
  if (sprintIds.length > 0 && !(item.sprint_id && sprintIds.includes(item.sprint_id))) return false;
  if (projectIds.length > 0 && !(item.project_id && projectIds.includes(item.project_id))) return false;
  return true;
}

export default function BacklogPage() {
  const router = useRouter();

  // Items state
  const [items, setItems] = useState<PmBacklogItem[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  // Multi-select filter state (arrays instead of single values)
  const [statusFilters, setStatusFilters] = useState<string[]>([]);
  const [priorityFilters, setPriorityFilters] = useState<string[]>([]);
  const [typeFilters, setTypeFilters] = useState<string[]>([]);
  const [areaFilters, setAreaFilters] = useState<string[]>([]);
  const [sprintFilters, setSprintFilters] = useState<string[]>([]);
  const [projectFilters, setProjectFilters] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');

  // Sort state
  const [sortBy, setSortBy] = useState<SortableColumn | null>(null);
  const [sortDir, setSortDir] = useState<SortDirection>('asc');

  // Selection state for bulk actions
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // View mode
  const [treeMode, setTreeMode] = useState(false);
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  // Active stats card (selected via TaskStatsCards click)
  const [activeStatsCard, setActiveStatsCard] = useState<string | undefined>(undefined);

  // Custom gauge state (pinned saved views)
  const [customGauges, setCustomGauges] = useState<CustomGauge[]>([]);
  const [gaugeViews, setGaugeViews] = useState<PmSavedView[]>([]);
  const gaugeViewsRef = useRef<PmSavedView[]>([]);

  // User map for assignee name resolution
  const [userMap, setUserMap] = useState<Map<string, { display_name: string | null; email: string }>>(new Map());
  // Raw users list for assignee dropdown in inline editing
  const [users, setUsers] = useState<{ id: string; display_name: string | null; email: string }[]>([]);

  const pageSize = 50;

  // ---------------------------------------------------------------------------
  // Data loading: fetch large page from RPC, apply client-side filtering/sorting
  // ---------------------------------------------------------------------------
  // Strategy: When multi-select filters are active, we pass single-value filters
  // to the RPC when only 1 value is selected (optimization), otherwise fetch all
  // and filter client-side. For search, we pass to RPC for full-text, then
  // supplement with client-side matching.

  const loadItems = useCallback(async () => {
    setLoading(true);
    try {
      // Determine what to pass to RPC vs. filter client-side
      const rpcStatus = statusFilters.length === 1 ? (statusFilters[0] as ItemStatus) : null;
      const rpcPriority = priorityFilters.length === 1 ? (priorityFilters[0] as ItemPriority) : null;
      const rpcType = typeFilters.length === 1 ? (typeFilters[0] as ItemType) : null;
      const rpcArea = areaFilters.length === 1 ? areaFilters[0] : null;
      const rpcSprint = sprintFilters.length === 1 ? sprintFilters[0] : null;
      const rpcProject = projectFilters.length === 1 ? projectFilters[0] : null;

      // For enhanced search we still pass to RPC for full-text matching,
      // but also supplement with client-side matching on ID/legacy_id/description.
      // When multi-filters are active, we need to fetch a larger page to account
      // for client-side filtering reducing the result set.
      const needsClientFilter =
        statusFilters.length > 1 ||
        priorityFilters.length > 1 ||
        typeFilters.length > 1 ||
        areaFilters.length > 1 ||
        sprintFilters.length > 1 ||
        projectFilters.length > 1;

      // Fetch a large batch when client-side filtering will reduce results
      const fetchSize = needsClientFilter ? 500 : pageSize;

      const data = await listItems({
        status: rpcStatus,
        priority: rpcPriority,
        type: rpcType,
        area: rpcArea,
        sprint_id: rpcSprint,
        project_id: rpcProject,
        search: searchQuery || undefined,
        root_only: treeMode ? true : undefined,
        page: needsClientFilter ? 1 : page,
        page_size: fetchSize,
      });

      let filteredItems = data.items;

      // Apply client-side multi-value filtering when more than 1 value selected
      if (needsClientFilter) {
        filteredItems = filteredItems.filter((item) =>
          matchesMultiFilters(item, statusFilters, priorityFilters, typeFilters, areaFilters, sprintFilters, projectFilters)
        );
      }

      const clientTotal = needsClientFilter ? filteredItems.length : data.total_count;

      // Client-side pagination when client-side filtering is active
      if (needsClientFilter) {
        const start = (page - 1) * pageSize;
        filteredItems = filteredItems.slice(start, start + pageSize);
      }

      setItems(filteredItems);
      setTotalCount(clientTotal);
    } catch (err) {
      console.error('Failed to load backlog items:', err);
    } finally {
      setLoading(false);
    }
  }, [statusFilters, priorityFilters, typeFilters, areaFilters, sprintFilters, projectFilters, searchQuery, page, treeMode]);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  // Load assignable users once for assignee name resolution + inline editing
  useEffect(() => {
    listAssignableUsers()
      .then((loadedUsers) => {
        const map = new Map<string, { display_name: string | null; email: string }>();
        for (const user of loadedUsers) {
          map.set(user.id, { display_name: user.display_name, email: user.email });
        }
        setUserMap(map);
        setUsers(loadedUsers);
      })
      .catch(() => {});
  }, []);

  // ---------------------------------------------------------------------------
  // Custom gauge: load counts for pinned saved views
  // ---------------------------------------------------------------------------

  const handleViewsChanged = useCallback((views: PmSavedView[]) => {
    const pinned = views.filter((v) => !!v.filters.displayAsGauge);
    setGaugeViews(pinned);
    gaugeViewsRef.current = pinned;
  }, []);

  // Load gauge counts whenever gaugeViews changes
  useEffect(() => {
    if (gaugeViews.length === 0) {
      setCustomGauges([]);
      return;
    }

    let cancelled = false;

    async function loadGaugeCounts() {
      const results: CustomGauge[] = [];

      // Helper: convert saved filter value to array
      const toArray = (val: unknown): string[] => {
        if (Array.isArray(val)) return val as string[];
        if (typeof val === 'string' && val) return [val];
        return [];
      };

      // Helper: single value for RPC (only when exactly 1 value)
      const toSingle = (val: unknown): string | null => {
        const arr = toArray(val);
        return arr.length === 1 ? arr[0] : null;
      };

      for (const view of gaugeViews) {
        // Extract filter params from the saved view, stripping the displayAsGauge flag
        const { displayAsGauge: _, ...filters } = view.filters;

        const statuses = toArray(filters.status ?? filters.statuses);
        const priorities = toArray(filters.priority ?? filters.priorities);
        const types = toArray(filters.type ?? filters.types);
        const areas = toArray(filters.area ?? filters.areas);
        const sprintIds = toArray(filters.sprint_id ?? filters.sprintIds);
        const projectIds = toArray(filters.project_id ?? filters.projectIds);

        // Check if any filter has multiple values (needs client-side filtering)
        const needsClientFilter =
          statuses.length > 1 ||
          priorities.length > 1 ||
          types.length > 1 ||
          areas.length > 1 ||
          sprintIds.length > 1 ||
          projectIds.length > 1;

        try {
          const data = await listItems({
            status: toSingle(filters.status ?? filters.statuses) as ItemStatus | null,
            priority: toSingle(filters.priority ?? filters.priorities) as ItemPriority | null,
            type: toSingle(filters.type ?? filters.types) as ItemType | null,
            area: toSingle(filters.area ?? filters.areas),
            sprint_id: toSingle(filters.sprint_id ?? filters.sprintIds),
            project_id: toSingle(filters.project_id ?? filters.projectIds),
            page: 1,
            page_size: needsClientFilter ? 500 : 1, // Need full set for client-side filtering
          });

          if (cancelled) return;

          let count = data.total_count;

          // Apply client-side filtering for multi-value filters
          if (needsClientFilter) {
            count = data.items.filter((item) =>
              matchesMultiFilters(item, statuses, priorities, types, areas, sprintIds, projectIds)
            ).length;
          }

          results.push({
            id: view.id,
            name: view.name,
            count,
            filterKey: `gauge_${view.id}`,
          });
        } catch (err) {
          console.error(`Failed to load gauge count for "${view.name}":`, err);
          if (cancelled) return;
          results.push({
            id: view.id,
            name: view.name,
            count: 0,
            filterKey: `gauge_${view.id}`,
          });
        }
      }

      if (!cancelled) {
        setCustomGauges(results);
      }
    }

    loadGaugeCounts();
    return () => {
      cancelled = true;
    };
  }, [gaugeViews]);

  // ---------------------------------------------------------------------------
  // Derived: sort the current page of items client-side
  // ---------------------------------------------------------------------------

  const sortedItems = useMemo(
    () => sortItems(items, sortBy, sortDir),
    [items, sortBy, sortDir]
  );

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  // ---------------------------------------------------------------------------
  // Filter change handlers -- reset page to 1
  // ---------------------------------------------------------------------------

  function handleStatusesChange(statuses: string[]) {
    setStatusFilters(statuses);
    setActiveStatsCard(undefined);
    setPage(1);
    setSelectedIds(new Set());
  }

  function handlePrioritiesChange(priorities: string[]) {
    setPriorityFilters(priorities);
    setPage(1);
    setSelectedIds(new Set());
  }

  function handleTypesChange(types: string[]) {
    setTypeFilters(types);
    setPage(1);
    setSelectedIds(new Set());
  }

  function handleAreasChange(areas: string[]) {
    setAreaFilters(areas);
    setPage(1);
    setSelectedIds(new Set());
  }

  function handleSprintIdsChange(sprintIds: string[]) {
    setSprintFilters(sprintIds);
    setPage(1);
    setSelectedIds(new Set());
  }

  function handleProjectIdsChange(projectIds: string[]) {
    setProjectFilters(projectIds);
    setPage(1);
    setSelectedIds(new Set());
  }

  const handleSearch = useCallback((query: string) => {
    setSearchQuery(query);
    setPage(1);
    setSelectedIds(new Set());
  }, []);

  // ---------------------------------------------------------------------------
  // Stats card click handler -- map card keys to filter state
  // ---------------------------------------------------------------------------

  function handleStatsCardClick(cardKey: string) {
    switch (cardKey) {
      case 'total_open':
        // Clear status filters to show all open items
        setStatusFilters([]);
        setActiveStatsCard('total_open');
        setPage(1);
        setSelectedIds(new Set());
        break;
      case 'pending':
        setStatusFilters(['pending']);
        setActiveStatsCard('pending');
        setPage(1);
        setSelectedIds(new Set());
        break;
      case 'in_progress':
        setStatusFilters(['in_progress']);
        setActiveStatsCard('in_progress');
        setPage(1);
        setSelectedIds(new Set());
        break;
      case 'blocked':
        setStatusFilters(['blocked']);
        setActiveStatsCard('blocked');
        setPage(1);
        setSelectedIds(new Set());
        break;
      case 'active_sprints':
        router.push('/dashboard/pm/sprints');
        return; // Don't update activeCard for navigation
    }
  }

  // ---------------------------------------------------------------------------
  // Custom gauge click handler -- apply the saved view's filter config
  // ---------------------------------------------------------------------------

  function handleGaugeClick(gauge: CustomGauge) {
    // Find the saved view that corresponds to this gauge
    const view = gaugeViewsRef.current.find((v) => v.id === gauge.id);
    if (!view) return;

    // Strip displayAsGauge and apply the rest as filters
    const { displayAsGauge: _, ...filters } = view.filters;
    handleLoadView(filters);
    setActiveStatsCard(`gauge_${gauge.id}`);
  }

  // ---------------------------------------------------------------------------
  // Sort handler: toggle direction, or set new column
  // ---------------------------------------------------------------------------

  function handleSort(column: SortableColumn) {
    if (sortBy === column) {
      // Toggle direction, or clear if already desc
      if (sortDir === 'asc') {
        setSortDir('desc');
      } else {
        // Clear sort
        setSortBy(null);
        setSortDir('asc');
      }
    } else {
      setSortBy(column);
      setSortDir('asc');
    }
  }

  // ---------------------------------------------------------------------------
  // Saved view load handler
  // ---------------------------------------------------------------------------

  function handleLoadView(filters: Record<string, unknown>) {
    // Support both old single-value and new array formats
    const toArray = (val: unknown): string[] => {
      if (Array.isArray(val)) return val as string[];
      if (typeof val === 'string' && val) return [val];
      return [];
    };

    setStatusFilters(toArray(filters.status ?? filters.statuses));
    setPriorityFilters(toArray(filters.priority ?? filters.priorities));
    setTypeFilters(toArray(filters.type ?? filters.types));
    setAreaFilters(toArray(filters.area ?? filters.areas));
    setSprintFilters(toArray(filters.sprint_id ?? filters.sprintIds));
    setProjectFilters(toArray(filters.project_id ?? filters.projectIds));
    setPage(1);
  }

  // ---------------------------------------------------------------------------
  // Bulk action complete handler -- reload data and clear selection
  // ---------------------------------------------------------------------------

  const handleBulkComplete = useCallback(() => {
    setSelectedIds(new Set());
    loadItems();
  }, [loadItems]);

  function handleItemClick(itemId: string) {
    router.push(`/dashboard/pm/tasks/${itemId}`);
  }

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <PageHeader
        title="Backlog"
        subtitle={`${totalCount} items`}
        actions={
          <>
            {/* Tree toggle */}
            <button
              onClick={() => setTreeMode(!treeMode)}
              className={`inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-md border ${
                treeMode
                  ? 'bg-primary-50 border-primary-300 text-primary-700'
                  : 'bg-white border-gray-300 text-gray-700'
              }`}
            >
              {treeMode ? <GitBranch className="h-4 w-4" /> : <List className="h-4 w-4" />}
              {treeMode ? 'Tree View' : 'Flat View'}
            </button>
            {/* Create button */}
            <Button variant="primary" onClick={() => setShowCreateDialog(true)}>
              <Plus className="h-4 w-4" />
              Create Item
            </Button>
          </>
        }
      />

      {/* Stats Cards */}
      <TaskStatsCards
        onCardClick={handleStatsCardClick}
        activeCard={activeStatsCard}
        customGauges={customGauges}
        onGaugeClick={handleGaugeClick}
      />

      {/* Search Bar + Saved View Selector */}
      <div className="flex items-center gap-4 mb-4">
        <div className="flex-1">
          <TaskSearchBar onSearch={handleSearch} />
        </div>
        <SavedViewSelector
          currentFilters={{
            statuses: statusFilters,
            priorities: priorityFilters,
            types: typeFilters,
            areas: areaFilters,
            sprintIds: sprintFilters,
            projectIds: projectFilters,
          }}
          onLoadView={handleLoadView}
          onViewsChanged={handleViewsChanged}
        />
      </div>

      {/* Filters */}
      <div className="mb-4">
        <TaskFilters
          statuses={statusFilters}
          priorities={priorityFilters}
          types={typeFilters}
          areas={areaFilters}
          sprintIds={sprintFilters}
          projectIds={projectFilters}
          onStatusesChange={handleStatusesChange}
          onPrioritiesChange={handlePrioritiesChange}
          onTypesChange={handleTypesChange}
          onAreasChange={handleAreasChange}
          onSprintIdsChange={handleSprintIdsChange}
          onProjectIdsChange={handleProjectIdsChange}
        />
      </div>

      {/* Main content: Table or Tree */}
      {treeMode ? (
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          {loading ? (
            <div className="animate-pulse space-y-3">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="h-6 bg-gray-200 rounded w-3/4" />
              ))}
            </div>
          ) : (
            <HierarchyTree items={sortedItems} onItemClick={handleItemClick} />
          )}
        </div>
      ) : (
        <TaskTable
          items={sortedItems}
          totalCount={totalCount}
          page={page}
          pageSize={pageSize}
          totalPages={totalPages}
          onPageChange={setPage}
          loading={loading}
          searchActive={!!searchQuery}
          sortBy={sortBy}
          sortDir={sortDir}
          onSort={handleSort}
          selectedIds={selectedIds}
          onSelectionChange={setSelectedIds}
          userMap={userMap}
          onItemUpdated={loadItems}
          users={users}
        />
      )}

      {/* Create Item Dialog */}
      <CreateTaskDialog
        open={showCreateDialog}
        onClose={() => setShowCreateDialog(false)}
        onCreated={loadItems}
      />

      {/* Bulk Action Bar */}
      <BacklogBulkBar
        selectedIds={selectedIds}
        onClearSelection={() => setSelectedIds(new Set())}
        onComplete={handleBulkComplete}
      />
    </div>
  );
}
