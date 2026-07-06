'use client';

/**
 * BulkActionBar - Floating bulk action bar for the support ticket tables.
 *
 * Appears fixed at the bottom center when tickets are selected.
 * Provides bulk actions: Change Status, Assign, and Delete (soft-delete).
 *
 * Pattern: Follows BacklogBulkBar from the PM module.
 * Task: TASK-2292
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { X, ChevronUp, Loader2, Trash2 } from 'lucide-react';
import { Button } from '@keepr/design-system';
import type { TicketStatus, TicketPriority, SupportCategory } from '@/lib/support-types';
import { STATUS_LABELS, STATUS_COLORS, PRIORITY_LABELS, PRIORITY_COLORS } from '@/lib/support-types';
import { getAssignableAgents, bulkUpdateTickets, getCategories } from '@/lib/support-queries';
import type { AssignableAgent } from '@/lib/support-queries';
import { useClickOutside } from '@/hooks/useClickOutside';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Statuses available for bulk change (excludes 'deleted' -- use the delete button for that) */
const BULK_STATUS_OPTIONS: TicketStatus[] = [
  'new',
  'assigned',
  'in_progress',
  'pending',
  'resolved',
  'closed',
];

const BULK_PRIORITY_OPTIONS: TicketPriority[] = ['low', 'normal', 'high', 'urgent'];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DropdownType = 'status' | 'assign' | 'priority' | 'category' | null;

interface BulkActionBarProps {
  selectedIds: Set<string>;
  onClearSelection: () => void;
  /** Called after a bulk action completes so the parent can reload data */
  onComplete: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BulkActionBar({
  selectedIds,
  onClearSelection,
  onComplete,
}: BulkActionBarProps) {
  const [openDropdown, setOpenDropdown] = useState<DropdownType>(null);
  const [loading, setLoading] = useState(false);
  const [agents, setAgents] = useState<AssignableAgent[]>([]);
  const [agentSearch, setAgentSearch] = useState('');
  const [categories, setCategories] = useState<SupportCategory[]>([]);
  const [categorySearch, setCategorySearch] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

  // -------------------------------------------------------------------------
  // Fetch agents when assign dropdown opens
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (openDropdown === 'assign' && agents.length === 0) {
      getAssignableAgents()
        .then(setAgents)
        .catch((err) => console.error('Failed to load agents:', err));
    }
    if (openDropdown !== 'assign') {
      setAgentSearch('');
    }
  }, [openDropdown, agents.length]);

  // -------------------------------------------------------------------------
  // Fetch categories when category dropdown opens
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (openDropdown === 'category' && categories.length === 0) {
      getCategories()
        .then(setCategories)
        .catch((err) => console.error('Failed to load categories:', err));
    }
    if (openDropdown !== 'category') {
      setCategorySearch('');
    }
  }, [openDropdown, categories.length]);

  // -------------------------------------------------------------------------
  // Close dropdown on outside click
  // -------------------------------------------------------------------------

  const closeDropdown = useCallback(() => {
    setOpenDropdown(null);
    setShowDeleteConfirm(false);
  }, []);
  useClickOutside(barRef, closeDropdown, openDropdown !== null || showDeleteConfirm);

  // -------------------------------------------------------------------------
  // Action handlers
  // -------------------------------------------------------------------------

  const ids = Array.from(selectedIds);

  const handleAction = useCallback(
    async (action: () => Promise<unknown>) => {
      setLoading(true);
      try {
        await action();
        setOpenDropdown(null);
        setShowDeleteConfirm(false);
        onComplete();
      } catch (err) {
        console.error('Bulk action failed:', err);
      } finally {
        setLoading(false);
      }
    },
    [onComplete]
  );

  const handleStatusChange = useCallback(
    (status: TicketStatus) =>
      handleAction(() => bulkUpdateTickets(ids, { status })),
    [ids, handleAction]
  );

  const handleAssign = useCallback(
    (agentId: string) =>
      handleAction(() => bulkUpdateTickets(ids, { assignee_id: agentId })),
    [ids, handleAction]
  );

  const handleUnassign = useCallback(
    () => handleAction(() => bulkUpdateTickets(ids, { unassign: true })),
    [ids, handleAction]
  );

  const handlePriorityChange = useCallback(
    (priority: TicketPriority) =>
      handleAction(() => bulkUpdateTickets(ids, { priority })),
    [ids, handleAction]
  );

  const handleCategoryChange = useCallback(
    (categoryId: string) =>
      handleAction(() => bulkUpdateTickets(ids, { category_id: categoryId })),
    [ids, handleAction]
  );

  const handleDelete = useCallback(
    () => handleAction(() => bulkUpdateTickets(ids, { status: 'deleted' })),
    [ids, handleAction]
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (selectedIds.size === 0) return null;

  function toggleDropdown(type: DropdownType) {
    setShowDeleteConfirm(false);
    setOpenDropdown((prev) => (prev === type ? null : type));
  }

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50" ref={barRef}>
      {/* Delete confirmation popover */}
      {showDeleteConfirm && (
        <div className="absolute bottom-full right-0 mb-2 w-72 bg-white border border-gray-200 rounded-lg shadow-lg p-4">
          <p className="text-sm text-gray-700 font-medium mb-1">
            Delete {selectedIds.size} ticket{selectedIds.size > 1 ? 's' : ''}?
          </p>
          <p className="text-xs text-gray-500 mb-3">
            Tickets will be soft-deleted and hidden from the default view. They can be recovered by filtering for &quot;Deleted&quot; status.
          </p>
          <div className="flex items-center gap-2 justify-end">
            <button
              onClick={() => setShowDeleteConfirm(false)}
              className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800 transition-colors"
            >
              Cancel
            </button>
            <Button variant="danger" size="sm" onClick={handleDelete} disabled={loading}>
              {loading ? 'Deleting...' : 'Delete'}
            </Button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3 bg-gray-900 text-white rounded-lg shadow-lg px-4 py-2.5">
        {/* Loading overlay */}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900/80 rounded-lg">
            <Loader2 className="h-5 w-5 animate-spin text-white" />
          </div>
        )}

        {/* Selected count */}
        <span className="text-sm font-medium whitespace-nowrap">
          {selectedIds.size} selected
        </span>

        <div className="w-px h-5 bg-gray-700" />

        {/* Status dropdown */}
        <div className="relative">
          <button
            onClick={() => toggleDropdown('status')}
            className="flex items-center gap-1 text-sm text-gray-300 hover:text-white transition-colors whitespace-nowrap"
          >
            <ChevronUp className="h-4 w-4" />
            Status
          </button>
          {openDropdown === 'status' && (
            <div className="absolute bottom-full left-0 mb-2 w-48 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden">
              {BULK_STATUS_OPTIONS.map((status) => (
                <button
                  key={status}
                  onClick={() => handleStatusChange(status)}
                  className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors flex items-center gap-2"
                >
                  <span
                    className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[status]}`}
                  >
                    {STATUS_LABELS[status]}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Priority dropdown */}
        <div className="relative">
          <button
            onClick={() => toggleDropdown('priority')}
            className="flex items-center gap-1 text-sm text-gray-300 hover:text-white transition-colors whitespace-nowrap"
          >
            <ChevronUp className="h-4 w-4" />
            Priority
          </button>
          {openDropdown === 'priority' && (
            <div className="absolute bottom-full left-0 mb-2 w-48 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden">
              {BULK_PRIORITY_OPTIONS.map((priority) => (
                <button
                  key={priority}
                  onClick={() => handlePriorityChange(priority)}
                  className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors flex items-center gap-2"
                >
                  <span
                    className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${PRIORITY_COLORS[priority]}`}
                  >
                    {PRIORITY_LABELS[priority]}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Assign dropdown */}
        <div className="relative">
          <button
            onClick={() => toggleDropdown('assign')}
            className="flex items-center gap-1 text-sm text-gray-300 hover:text-white transition-colors whitespace-nowrap"
          >
            <ChevronUp className="h-4 w-4" />
            Assign
          </button>
          {openDropdown === 'assign' && (
            <div className="absolute bottom-full left-0 mb-2 w-64 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden">
              {/* Search input */}
              <div className="px-3 py-2 border-b border-gray-100">
                <input
                  type="text"
                  value={agentSearch}
                  onChange={(e) => setAgentSearch(e.target.value)}
                  placeholder="Search by name or email..."
                  className="w-full px-2 py-1 text-sm text-gray-900 bg-white border border-gray-300 rounded focus:ring-primary-500 focus:border-primary-500"
                  autoFocus
                />
              </div>
              {/* Agent list */}
              <div className="max-h-48 overflow-y-auto">
                {/* Unassign option */}
                <button
                  onClick={() => handleUnassign()}
                  className="w-full text-left px-3 py-2 text-sm text-gray-500 hover:bg-gray-50 transition-colors border-b border-gray-100 italic"
                >
                  Unassign
                </button>
                {agents.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-gray-400">Loading...</div>
                ) : (
                  agents
                    .filter((a) => {
                      if (!agentSearch.trim()) return true;
                      const q = agentSearch.toLowerCase();
                      return (
                        a.display_name.toLowerCase().includes(q) ||
                        a.email.toLowerCase().includes(q)
                      );
                    })
                    .map((agent) => (
                      <button
                        key={agent.user_id}
                        onClick={() => handleAssign(agent.user_id)}
                        className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                      >
                        <div className="truncate font-medium">
                          {agent.display_name || agent.email}
                        </div>
                        {agent.display_name && (
                          <div className="truncate text-xs text-gray-400">
                            {agent.email}
                          </div>
                        )}
                      </button>
                    ))
                )}
              </div>
            </div>
          )}
        </div>

        {/* Category dropdown */}
        <div className="relative">
          <button
            onClick={() => toggleDropdown('category')}
            className="flex items-center gap-1 text-sm text-gray-300 hover:text-white transition-colors whitespace-nowrap"
          >
            <ChevronUp className="h-4 w-4" />
            Category
          </button>
          {openDropdown === 'category' && (
            <div className="absolute bottom-full right-0 mb-2 w-64 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden">
              {/* Search input */}
              <div className="px-3 py-2 border-b border-gray-100">
                <input
                  type="text"
                  value={categorySearch}
                  onChange={(e) => setCategorySearch(e.target.value)}
                  placeholder="Search categories..."
                  className="w-full px-2 py-1 text-sm text-gray-900 bg-white border border-gray-300 rounded focus:ring-primary-500 focus:border-primary-500"
                  autoFocus
                />
              </div>
              <div className="max-h-48 overflow-y-auto">
                {categories.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-gray-400">Loading...</div>
                ) : (
                  categories
                    .filter((c) => {
                      if (!categorySearch.trim()) return true;
                      return c.name.toLowerCase().includes(categorySearch.toLowerCase());
                    })
                    .map((cat) => (
                      <button
                        key={cat.id}
                        onClick={() => handleCategoryChange(cat.id)}
                        className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors truncate"
                      >
                        {cat.name}
                      </button>
                    ))
                )}
              </div>
            </div>
          )}
        </div>

        <div className="w-px h-5 bg-gray-700" />

        {/* Delete button */}
        <button
          onClick={() => {
            setOpenDropdown(null);
            setShowDeleteConfirm(true);
          }}
          className="flex items-center gap-1 text-sm text-red-400 hover:text-red-300 transition-colors whitespace-nowrap"
          title="Soft-delete selected tickets"
        >
          <Trash2 className="h-4 w-4" />
          Delete
        </button>

        <div className="w-px h-5 bg-gray-700" />

        {/* Clear selection */}
        <button
          onClick={onClearSelection}
          className="p-1 text-gray-400 hover:text-white transition-colors"
          title="Clear selection"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
