'use client';

/**
 * User Search Page - Admin Portal (Client Component)
 *
 * Provides a search interface for finding users across all organizations.
 * Uses debounced client-side search via the admin_search_users RPC.
 *
 * BACKLOG-1492: Added Invite User button gated on users.edit permission.
 */

import { useState, useCallback, useEffect } from 'react';
import { PageHeader, Button } from '@keepr/design-system';
import { UserSearchBar } from './UserSearchBar';
import { UserResultsTable } from './UserResultsTable';
import { InviteUserDialog } from './InviteUserDialog';
import { searchUsers, type AdminSearchUser } from '@/lib/admin-queries';
import { usePermissions } from '@/components/providers/PermissionsProvider';
import { PERMISSIONS } from '@/lib/permissions';

export function UsersPageClient() {
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState<AdminSearchUser[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showInviteDialog, setShowInviteDialog] = useState(false);
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
