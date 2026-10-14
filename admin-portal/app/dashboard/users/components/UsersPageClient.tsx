'use client';

/**
 * User Search Page - Admin Portal (Client Component)
 *
 * Provides a search interface for finding users across all organizations.
 * Uses debounced client-side search via the admin_search_users RPC.
 *
 * BACKLOG-1492: Added Invite User button gated on users.edit permission.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { PageHeader, Button } from '@keepr/design-system';
import { UserSearchBar } from './UserSearchBar';
import { UserResultsTable } from './UserResultsTable';
import { InviteUserDialog } from './InviteUserDialog';
import { searchUsers, type AdminSearchUser } from '@/lib/admin-queries';
import { usePermissions } from '@/components/providers/PermissionsProvider';
import { PERMISSIONS } from '@/lib/permissions';
import { getPlanLines } from '@/lib/actions/planLines';
import type { PlanCellState } from './UserResultsTable';

export function UsersPageClient() {
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState<AdminSearchUser[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showInviteDialog, setShowInviteDialog] = useState(false);
  const [planLines, setPlanLines] = useState<PlanCellState>({ status: 'idle' });
  // Only the latest search may write the Plan column (a slow earlier answer must not).
  const planRequest = useRef(0);
  const { hasPermission } = usePermissions();

  const canInvite = hasPermission(PERMISSIONS.USERS_EDIT);

  // Load all users on mount
  const loadUsers = useCallback(async (searchQuery = '') => {
    setError(null);
    setIsLoading(true);
    const { data, error: searchError } = await searchUsers(searchQuery);
    if (searchError) {
      setError(searchError.message);
      setUsers(null);
    } else {
      setUsers(data);
    }
    setIsLoading(false);

    // BACKLOG-3859: one batched server action per result page (never per row).
    const ids = (searchError ? [] : data ?? []).map((u) => u.id);
    const req = ++planRequest.current;
    if (ids.length === 0) {
      setPlanLines({ status: 'idle' });
      return;
    }
    setPlanLines({ status: 'loading' });
    try {
      const res = await getPlanLines(ids);
      if (req !== planRequest.current) return;
      setPlanLines(res.ok ? { status: 'ready', lines: res.lines } : { status: 'error' });
    } catch {
      if (req !== planRequest.current) return;
      setPlanLines({ status: 'error' });
    }
  }, []);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const handleSearch = useCallback(async (searchQuery: string) => {
    setQuery(searchQuery);
    await loadUsers(searchQuery);
  }, [loadUsers]);

  const handleInvited = useCallback(() => {
    // Refresh the user list after a successful invite
    loadUsers(query);
  }, [loadUsers, query]);

  return (
    <div className="max-w-7xl mx-auto">
      <PageHeader
        title="Users"
        subtitle="Search and view users across all organizations."
        actions={
          canInvite && (
            <Button type="button" onClick={() => setShowInviteDialog(true)}>
              Invite User
            </Button>
          )
        }
      />

      <div className="space-y-6">
        <UserSearchBar onSearch={handleSearch} isLoading={isLoading} />
        <UserResultsTable
          users={users}
          query={query}
          isLoading={isLoading}
          error={error}
          planLines={planLines}
        />
      </div>

      {showInviteDialog && (
        <InviteUserDialog
          onClose={() => setShowInviteDialog(false)}
          onInvited={handleInvited}
        />
      )}
    </div>
  );
}
