'use client';

/**
 * Sprint List Page - /dashboard/pm/sprints
 *
 * Displays all sprints with toggle between list and card views.
 * Includes search and status filter tabs.
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { ArrowLeft, List, LayoutGrid, Plus, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { SearchInput } from '@keepr/design-system';
import { listSprints } from '@/lib/pm-queries';
import type { PmSprint } from '@/lib/pm-types';
import { usePermissions } from '@/components/providers/PermissionsProvider';
import { PERMISSIONS } from '@/lib/permissions';
import { SprintList } from '../components/SprintList';
import { SprintCard } from '../components/SprintCard';
import { CreateSprintDialog } from '../components/CreateSprintDialog';

type ViewMode = 'list' | 'card';
type StatusFilter = 'all' | 'active' | 'planned' | 'completed';

export default function SprintsPage() {
  const [sprints, setSprints] = useState<PmSprint[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const router = useRouter();
  const { hasPermission } = usePermissions();

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listSprints();
      setSprints(data);
    } catch (err) {
      console.error('Failed to load sprint data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Filter sprints by status and search query
  const filteredSprints = sprints.filter((s) => {
    if (statusFilter !== 'all' && s.status !== statusFilter) return false;
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      s.name.toLowerCase().includes(q) ||
      (s.goal && s.goal.toLowerCase().includes(q)) ||
      (s.legacy_id && s.legacy_id.toLowerCase().includes(q))
    );
  });

  const filterTabs: { key: StatusFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'active', label: 'Active' },
    { key: 'planned', label: 'Planned' },
    { key: 'completed', label: 'Completed' },
  ];

  return (
    <div className="max-w-7xl mx-auto">
      {/* Navigation */}
      <div className="mb-6">
        <button
          onClick={() => router.back()}
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Sprints</h1>
            <p className="text-sm text-gray-500 mt-1">
              {loading ? '...' : `${filteredSprints.length} sprints`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setViewMode('list')}
              className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md border ${
                viewMode === 'list'
                  ? 'bg-primary-50 border-primary-300 text-primary-700'
                  : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
              }`}
            >
              <List className="h-4 w-4" />
              List
            </button>
            <button
              onClick={() => setViewMode('card')}
              className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md border ${
                viewMode === 'card'
                  ? 'bg-primary-50 border-primary-300 text-primary-700'
                  : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
              }`}
            >
              <LayoutGrid className="h-4 w-4" />
              Cards
            </button>
            {hasPermission(PERMISSIONS.PM_MANAGE) && (
              <button
                onClick={() => setShowCreateDialog(true)}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-primary-600 border border-transparent rounded-md hover:bg-primary-700"
              >
                <Plus className="h-4 w-4" />
                New Sprint
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center gap-1 mb-4 border-b border-gray-200">
        {filterTabs.map((tab) => {
          const count = tab.key === 'all'
            ? sprints.length
            : sprints.filter((s) => s.status === tab.key).length;
          return (
            <button
              key={tab.key}
              onClick={() => setStatusFilter(tab.key)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                statusFilter === tab.key
                  ? 'border-primary-500 text-primary-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {tab.label}
              <span className="ml-1.5 text-xs text-gray-400">({count})</span>
            </button>
          );
        })}
      </div>

      {/* Search Bar */}
      <SearchInput
        placeholder="Search sprints by name, goal, or ID..."
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        containerClassName="mb-4"
        trailing={
          searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="text-gray-400 hover:text-gray-600"
            >
              <X className="h-4 w-4" />
            </button>
          )
        }
      />

      {/* Sprint List or Cards */}
      {viewMode === 'list' ? (
        <SprintList sprints={filteredSprints} loading={loading} />
      ) : loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="bg-white border border-gray-200 rounded-lg p-6 animate-pulse"
            >
              <div className="h-5 bg-gray-200 rounded w-3/4 mb-3" />
              <div className="h-4 bg-gray-200 rounded w-1/2 mb-4" />
              <div className="h-2.5 bg-gray-100 rounded-full mb-4" />
              <div className="h-4 bg-gray-200 rounded w-1/3" />
            </div>
          ))}
        </div>
      ) : filteredSprints.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
          <p className="text-gray-500 text-sm">No sprints found.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredSprints.map((sprint) => (
            <Link key={sprint.id} href={`/dashboard/pm/sprints/${sprint.id}`}>
              <SprintCard sprint={sprint} />
            </Link>
          ))}
        </div>
      )}

      {/* Create Sprint Dialog */}
      <CreateSprintDialog
        open={showCreateDialog}
        onClose={() => setShowCreateDialog(false)}
        onCreated={(newSprintId) => {
          setShowCreateDialog(false);
          router.push(`/dashboard/pm/sprints/${newSprintId}`);
        }}
      />
    </div>
  );
}
