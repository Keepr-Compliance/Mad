'use client';

/**
 * My Tasks Page - /dashboard/pm/my-tasks
 *
 * Filtered view showing backlog items assigned to the current user.
 * Fetches via listItems RPC and filters client-side by assignee_id.
 * Reuses Sprint B components: TaskTable, TaskSearchBar.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { ArrowLeft, UserCheck } from 'lucide-react';
import Link from 'next/link';
import type { PmBacklogItem, ItemStatus } from '@/lib/pm-types';
import { listItems } from '@/lib/pm-queries';
import { createClient } from '@/lib/supabase/client';
import { TaskTable } from '../components/TaskTable';
import { TaskSearchBar } from '../components/TaskSearchBar';

// ---------------------------------------------------------------------------
// Filter tabs
// ---------------------------------------------------------------------------

type FilterTab = 'all' | ItemStatus;

const TABS: { value: FilterTab; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'pending', label: 'Pending' },
  { value: 'testing', label: 'Testing' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'completed', label: 'Completed' },
];

const PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function MyTasksPage() {
  const [allMyItems, setAllMyItems] = useState<PmBacklogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterTab>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [userId, setUserId] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  // -------------------------------------------------------------------------
  // Get current user ID
  // -------------------------------------------------------------------------

  useEffect(() => {
    async function getUser() {
      const supabase = createClient();
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) setUserId(user.id);
      } catch (err) {
        console.error('Failed to get current user:', err);
      }
    }
    getUser();
  }, []);

  // -------------------------------------------------------------------------
  // Load all items assigned to the current user
  // -------------------------------------------------------------------------

  const loadItems = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const result = await listItems({
        assignee_id: userId,
        search: searchQuery || undefined,
        page_size: 200,
      });
      setAllMyItems(result.items);
    } catch {
      // Failed to load -- items remain empty
    } finally {
      setLoading(false);
    }
  }, [userId, searchQuery]);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  // -------------------------------------------------------------------------
  // Tab counts (computed from all items, ignoring current filter)
  // -------------------------------------------------------------------------

  const tabCounts = useMemo(() => {
    const counts: Record<string, number> = { all: allMyItems.length };
    for (const tab of TABS) {
      if (tab.value !== 'all') {
        counts[tab.value] = allMyItems.filter(
          (i) => i.status === tab.value
        ).length;
      }
    }
    return counts;
  }, [allMyItems]);

  // -------------------------------------------------------------------------
  // Filtered items for the current tab
  // -------------------------------------------------------------------------

  const filteredItems = useMemo(() => {
    if (filter === 'all') return allMyItems;
    return allMyItems.filter((i) => i.status === filter);
  }, [allMyItems, filter]);

  const totalCount = filteredItems.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  // Paginated slice for the table
  const pagedItems = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filteredItems.slice(start, start + PAGE_SIZE);
  }, [filteredItems, page]);

  // Reset page when filter changes
  useEffect(() => {
    setPage(1);
  }, [filter]);

  // -------------------------------------------------------------------------
  // Search handler (from TaskSearchBar)
  // -------------------------------------------------------------------------

  const handleSearch = useCallback((query: string) => {
    setSearchQuery(query);
    setPage(1);
  }, []);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <Link
          href="/dashboard/pm"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Dashboard
        </Link>
        <div className="flex items-center gap-2">
          <UserCheck className="h-6 w-6 text-gray-400" />
          <h1 className="text-2xl font-bold text-gray-900">My Tasks</h1>
        </div>
        <p className="text-sm text-gray-500 mt-1">Items assigned to you</p>
      </div>

      {/* Search */}
      <div className="mb-4">
        <TaskSearchBar
          onSearch={handleSearch}
          placeholder="Search your tasks..."
        />
      </div>

      {/* Filter tabs */}
      <div className="flex items-center gap-1 mb-4 border-b border-gray-200">
        {TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setFilter(tab.value)}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              filter === tab.value
                ? 'border-primary-500 text-primary-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.label}
            {(tabCounts[tab.value] ?? 0) > 0 && (
              <span className="ml-1.5 text-xs bg-gray-100 text-gray-600 rounded-full px-1.5 py-0.5">
                {tabCounts[tab.value]}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Items table or empty state */}
      {!loading && totalCount === 0 ? (
        <div className="text-center py-12">
          <UserCheck className="h-8 w-8 text-gray-300 mx-auto mb-2" />
          <p className="text-gray-500 text-sm">No items assigned to you</p>
          <p className="text-gray-400 text-xs mt-1">
            {filter !== 'all'
              ? `No items with status "${filter.replace(/_/g, ' ')}"`
              : 'Items assigned to you will appear here'}
          </p>
        </div>
      ) : (
        <TaskTable
          items={pagedItems}
          totalCount={totalCount}
          page={page}
          pageSize={PAGE_SIZE}
          totalPages={totalPages}
          onPageChange={setPage}
          loading={loading}
          searchActive={!!searchQuery}
          buildItemUrl={(itemId) => `/dashboard/pm/tasks/${itemId}?from=my-tasks`}
        />
      )}
    </div>
  );
}
