'use client';

/**
 * Task Detail Page - PM Module
 *
 * Two-column layout: main content (left) + sidebar (right).
 * Shows item detail, description, comments, activity timeline,
 * sidebar metadata, labels, linked items, and dependencies.
 *
 * Pattern: Adapted from support/[id]/page.tsx
 */

import { Suspense, useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Trash2 } from 'lucide-react';
import { usePermissions } from '@/components/providers/PermissionsProvider';
import { PERMISSIONS } from '@/lib/permissions';
import { getItemDetail, deleteItem, listItemDependencies, updateItemField } from '@/lib/pm-queries';
import type { ItemDetailResponse, PmDependency } from '@/lib/pm-types';
import { TaskStatusBadge } from '../../components/TaskStatusBadge';
import { TaskPriorityBadge } from '../../components/TaskPriorityBadge';
import { TaskTypeBadge } from '../../components/TaskTypeBadge';
import { TaskDescription } from '../../components/TaskDescription';
import { TaskActivityTimeline } from '../../components/TaskActivityTimeline';
import { TaskCommentComposer } from '../../components/TaskCommentComposer';
import { TaskSidebar } from '../../components/TaskSidebar';
import { DependencyPanel } from '../../components/DependencyPanel';
import { LinkedItemsPanel } from '../../components/LinkedItemsPanel';
import { LabelPicker } from '../../components/LabelPicker';
import { SupportTicketLinksPanel } from '../../components/SupportTicketLinksPanel';
import { InlineEditText } from '../../components/InlineEditText';

// -- Loading Skeleton --------------------------------------------------------

function LoadingSkeleton() {
  return (
    <div className="max-w-7xl mx-auto animate-pulse">
      <div className="h-8 bg-gray-200 rounded w-64 mb-6" />
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <div className="lg:col-span-3 space-y-4">
          <div className="h-32 bg-gray-200 rounded" />
          <div className="h-24 bg-gray-200 rounded" />
          <div className="h-48 bg-gray-200 rounded" />
        </div>
        <div className="lg:col-span-2 space-y-4">
          <div className="h-64 bg-gray-200 rounded" />
          <div className="h-32 bg-gray-200 rounded" />
          <div className="h-32 bg-gray-200 rounded" />
        </div>
      </div>
    </div>
  );
}

// -- Main Page ---------------------------------------------------------------

export default function TaskDetailPage() {
  return (
    <Suspense fallback={<LoadingSkeleton />}>
      <TaskDetailContent />
    </Suspense>
  );
}

function TaskDetailContent() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const itemId = params.id as string;
  const { hasPermission } = usePermissions();

  const [detail, setDetail] = useState<ItemDetailResponse | null>(null);
  const [dependencies, setDependencies] = useState<PmDependency[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Compute context-aware back link from searchParams
  const backLink = useMemo(() => {
    const from = searchParams.get('from');
    if (from === 'project') {
      const projectId = searchParams.get('projectId');
      if (projectId) {
        return { label: 'Back to Project', href: `/dashboard/pm/projects/${projectId}` };
      }
    }
    if (from === 'sprint') {
      const sprintId = searchParams.get('sprintId');
      if (sprintId) {
        return { label: 'Back to Sprint', href: `/dashboard/pm/sprints/${sprintId}` };
      }
    }
    if (from === 'board') {
      return { label: 'Back to Board', href: '/dashboard/pm/board' };
    }
    if (from === 'my-tasks') {
      return { label: 'Back to My Tasks', href: '/dashboard/pm/my-tasks' };
    }
    return { label: 'Back to Backlog', href: '/dashboard/pm/backlog' };
  }, [searchParams]);

  const loadDependencies = useCallback(async () => {
    try {
      const deps = await listItemDependencies(itemId);
      setDependencies(deps);
    } catch (err) {
      console.error('Failed to load dependencies:', err);
      setDependencies([]);
    }
  }, [itemId]);

  const loadDetail = useCallback(async () => {
    try {
      const data = await getItemDetail(itemId);
      setDetail(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load item');
    } finally {
      setLoading(false);
    }
  }, [itemId]);

  useEffect(() => {
    loadDetail();
    loadDependencies();
  }, [loadDetail, loadDependencies]);

  async function handleDelete() {
    setDeleting(true);
    try {
      await deleteItem(itemId);
      router.push(backLink.href);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete item');
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  }

  // -- Loading state ----------------------------------------------------------

  if (loading) {
    return <LoadingSkeleton />;
  }

  // -- Error state ------------------------------------------------------------

  if (error || !detail) {
    return (
      <div className="max-w-7xl mx-auto">
        <Link
          href={backLink.href}
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 mb-6"
        >
          <ArrowLeft className="h-4 w-4" />
          {backLink.label}
        </Link>
        <div className="bg-white rounded-lg border border-red-200 p-8 text-center">
          <p className="text-red-600 text-sm">{error || 'Item not found'}</p>
        </div>
      </div>
    );
  }

  const { item, comments, events, links, labels, children, parent } = detail;

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <Link
          href={backLink.href}
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 mb-3"
        >
          <ArrowLeft className="h-4 w-4" />
          {backLink.label}
        </Link>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-500 font-mono">
                  #{item.item_number}
                </span>
                {parent && (
                  <span className="text-xs text-gray-400">
                    child of{' '}
                    <Link
                      href={`/dashboard/pm/tasks/${parent.id}`}
                      className="text-primary-600 hover:text-primary-700 font-medium"
                    >
                      #{parent.item_number} {parent.title}
                    </Link>
                  </span>
                )}
              </div>
              <h1 className="text-xl font-bold text-gray-900">
                <InlineEditText
                  value={item.title}
                  placeholder="Task title..."
                  onSave={async (newValue) => {
                    if (!newValue) return;
                    await updateItemField(item.id, 'title', newValue);
                    loadDetail();
                  }}
                  displayClassName="text-xl font-bold text-gray-900"
                />
              </h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <TaskTypeBadge type={item.type} />
            <TaskStatusBadge status={item.status} />
            <TaskPriorityBadge priority={item.priority} />
            {hasPermission(PERMISSIONS.PM_ADMIN) && (
              <button
                onClick={() => setShowDeleteConfirm(true)}
                className="inline-flex items-center gap-1.5 text-xs text-red-500 hover:text-red-700 transition-colors"
                title="Delete item"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Delete Confirmation */}
      {showDeleteConfirm && (
        <div className="bg-red-50 border border-red-200 rounded-md p-4 mb-6">
          <p className="text-sm text-red-800">
            Are you sure you want to delete item #{item.item_number}? This will soft-delete the item.
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
              className="px-3 py-1 text-sm bg-white border rounded hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Two-column layout: 3:2 ratio */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Left: Description, Comment Composer, Activity Timeline */}
        <div className="lg:col-span-3 space-y-6">
          <TaskDescription
            itemId={item.id}
            description={item.description}
            body={item.body}
            onUpdate={loadDetail}
          />

          <TaskCommentComposer
            itemId={item.id}
            onCommentAdded={loadDetail}
          />

          <TaskActivityTimeline
            comments={comments}
            events={events}
          />
        </div>

        {/* Right: Sidebar, Labels, Dependencies, Linked Items */}
        <div className="lg:col-span-2 space-y-6">
          <TaskSidebar item={item} onUpdate={loadDetail} />

          <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-200">
            <LabelPicker
              itemId={item.id}
              currentLabels={labels}
              onUpdate={loadDetail}
            />

            <DependencyPanel
              itemId={item.id}
              dependencies={dependencies}
              onUpdate={() => { loadDetail(); loadDependencies(); }}
            />

            <LinkedItemsPanel
              itemId={item.id}
              links={links}
              onUpdate={loadDetail}
            />

            <SupportTicketLinksPanel
              itemId={item.id}
              onUpdate={loadDetail}
            />
          </div>
        </div>
      </div>

      {/* Children (sub-items) */}
      {children && children.length > 0 && (
        <div className="mt-8">
          <h2 className="text-sm font-medium text-gray-700 mb-3">
            Sub-Items ({children.length})
          </h2>
          <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100">
            {children.map((child) => (
              <button
                key={child.id}
                onClick={() => router.push(`/dashboard/pm/tasks/${child.id}`)}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors text-left"
              >
                <span className="text-sm text-gray-700 truncate flex-1">
                  {child.title}
                </span>
                <span className="text-xs text-gray-400 capitalize">
                  {child.status.replace('_', ' ')}
                </span>
                <span className="text-xs text-gray-400 capitalize">
                  {child.priority}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
