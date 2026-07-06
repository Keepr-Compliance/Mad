'use client';

/**
 * Floating action bar that appears when multiple items are selected on the board.
 * Shows selected count + bulk actions: Change Status (dropdown), Assign User,
 * Assign Sprint, Delete. Fixed at the bottom of the viewport with dark styling.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { X, ChevronUp, Calendar, Trash2, UserX } from 'lucide-react';
import type { ItemStatus, AssignableUser } from '@/lib/pm-types';
import { STATUS_LABELS, STATUS_COLORS } from '@/lib/pm-types';
import { listAssignableUsers } from '@/lib/pm-queries';
import { useClickOutside } from '@/hooks/useClickOutside';

const STATUS_OPTIONS: ItemStatus[] = [
  'pending',
  'in_progress',
  'testing',
  'completed',
  'blocked',
  'deferred',
];

interface BulkActionBarProps {
  selectedCount: number;
  onClearSelection: () => void;
  onChangeStatus: (status: ItemStatus) => void;
  onChangePriority: (priority: string) => void;
  onAssignToSprint: () => void;
  onAssignUser: (assigneeId: string | null) => void;
  onDelete: () => void;
  error?: string | null;
}

export function BulkActionBar({
  selectedCount,
  onClearSelection,
  onChangeStatus,
  onAssignToSprint,
  onAssignUser,
  onDelete,
  error,
}: BulkActionBarProps) {
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const [assignMenuOpen, setAssignMenuOpen] = useState(false);
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [userSearch, setUserSearch] = useState('');
  const barRef = useRef<HTMLDivElement>(null);

  // Fetch users when assign dropdown opens
  useEffect(() => {
    if (assignMenuOpen && users.length === 0) {
      listAssignableUsers()
        .then(setUsers)
        .catch((err) => console.error('Failed to load users:', err));
    }
    if (!assignMenuOpen) {
      setUserSearch('');
    }
  }, [assignMenuOpen, users.length]);

  // Close menus on outside click
  const closeMenus = useCallback(() => {
    setStatusMenuOpen(false);
    setAssignMenuOpen(false);
  }, []);
  useClickOutside(barRef, closeMenus, statusMenuOpen || assignMenuOpen);

  if (selectedCount === 0) return null;

  const filteredUsers = users.filter((u) => {
    if (!userSearch.trim()) return true;
    const q = userSearch.toLowerCase();
    return (
      (u.display_name?.toLowerCase().includes(q) ?? false) ||
      u.email.toLowerCase().includes(q)
    );
  });

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50" ref={barRef}>
      <div className="flex items-center gap-3 bg-gray-900 text-white rounded-lg shadow-lg px-4 py-2.5">
        {/* Selected count */}
        <span className="text-sm font-medium">
          {selectedCount} selected
        </span>

        <div className="w-px h-5 bg-gray-700" />

        {/* Status dropdown */}
        <div className="relative">
          <button
            onClick={() => {
              setStatusMenuOpen(!statusMenuOpen);
              setAssignMenuOpen(false);
            }}
            className="flex items-center gap-1 text-sm text-gray-300 hover:text-white transition-colors"
          >
            <ChevronUp className="h-4 w-4" />
            Move to...
          </button>
          {statusMenuOpen && (
            <div className="absolute bottom-full left-0 mb-2 w-48 bg-white border border-gray-200 rounded-lg shadow-lg z-20 overflow-hidden">
              {STATUS_OPTIONS.map((status) => (
                <button
                  key={status}
                  onClick={() => {
                    onChangeStatus(status);
                    setStatusMenuOpen(false);
                  }}
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

        {/* Assign user dropdown */}
        <div className="relative">
          <button
            onClick={() => {
              setAssignMenuOpen(!assignMenuOpen);
              setStatusMenuOpen(false);
            }}
            className="flex items-center gap-1 text-sm text-gray-300 hover:text-white transition-colors"
          >
            <ChevronUp className="h-4 w-4" />
            Assign
          </button>
          {assignMenuOpen && (
            <div className="absolute bottom-full left-0 mb-2 w-64 bg-white border border-gray-200 rounded-lg shadow-lg z-20 overflow-hidden">
              {/* Search input */}
              <div className="px-3 py-2 border-b border-gray-100">
                <input
                  type="text"
                  value={userSearch}
                  onChange={(e) => setUserSearch(e.target.value)}
                  placeholder="Search by name or email..."
                  className="w-full px-2 py-1 text-sm text-gray-900 bg-white border border-gray-300 rounded focus:ring-primary-500 focus:border-primary-500"
                  autoFocus
                />
              </div>
              {/* Unassign option */}
              <button
                onClick={() => {
                  onAssignUser(null);
                  setAssignMenuOpen(false);
                }}
                className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors flex items-center gap-2 border-b border-gray-100"
              >
                <UserX className="h-4 w-4 text-gray-400" />
                <span>Unassign</span>
              </button>
              {/* User list */}
              <div className="max-h-48 overflow-y-auto">
                {users.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-gray-400">Loading...</div>
                ) : (
                  filteredUsers.map((user) => (
                    <button
                      key={user.id}
                      onClick={() => {
                        onAssignUser(user.id);
                        setAssignMenuOpen(false);
                      }}
                      className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                    >
                      <div className="truncate font-medium">
                        {user.display_name || user.email}
                      </div>
                      {user.display_name && (
                        <div className="truncate text-xs text-gray-400">
                          {user.email}
                        </div>
                      )}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        {/* Sprint assignment */}
        <button
          onClick={onAssignToSprint}
          className="flex items-center gap-1 text-sm text-gray-300 hover:text-white transition-colors"
        >
          <Calendar className="h-4 w-4" />
          Assign Sprint
        </button>

        {/* Delete */}
        <button
          onClick={onDelete}
          className="flex items-center gap-1 text-sm text-red-400 hover:text-red-300 transition-colors"
        >
          <Trash2 className="h-4 w-4" />
          Delete
        </button>

        <div className="w-px h-5 bg-gray-700" />

        {/* Close / clear selection */}
        <button
          onClick={onClearSelection}
          className="p-1 text-gray-400 hover:text-white transition-colors"
        >
          <X className="h-4 w-4" />
        </button>

        {/* Error feedback */}
        {error && (
          <span className="text-xs text-red-400 ml-1">{error}</span>
        )}
      </div>
    </div>
  );
}
