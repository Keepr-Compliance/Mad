'use client';

/**
 * User List Client Component
 *
 * Main client component for displaying and filtering organization members.
 * Provides search, role filter, status filter, card/list view toggle,
 * and bulk actions.
 *
 * TASK-1809: User list component implementation
 * TASK-1810: Added invite user modal integration
 * TASK-1812: Added deactivate/remove user modals
 */

import { useState, useMemo, useCallback } from 'react';
import { LayoutGrid, List, Plus, Users } from 'lucide-react';
import { Button, Checkbox } from '@keepr/design-system';
import UserCard from './UserCard';
import UserTableRow from './UserTableRow';
import UserSearchFilter from './UserSearchFilter';
import InviteUserModal from './InviteUserModal';
import EditRoleModal from './EditRoleModal';
import BulkEditRoleModal from './BulkEditRoleModal';
import DeactivateUserModal from './DeactivateUserModal';
import RemoveUserModal from './RemoveUserModal';
import { EmptyState, SearchIcon } from '@/components/ui/EmptyState';
import { formatUserDisplayName } from '@/lib/utils/userDisplay';
import { resendInvite } from '@/lib/actions/resendInvite';
import type { OrganizationMember, Role } from '@/lib/types/users';

type ViewMode = 'cards' | 'list';

interface UserListClientProps {
  initialMembers: OrganizationMember[];
  currentUserId: string;
  currentUserRole: Role;
  organizationId: string;
  readOnly?: boolean;
}

export default function UserListClient({
  initialMembers,
  currentUserId,
  currentUserRole,
  organizationId,
  readOnly = false,
}: UserListClientProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);
  const [editRoleMember, setEditRoleMember] = useState<OrganizationMember | null>(null);
  const [isBulkEditOpen, setIsBulkEditOpen] = useState(false);
  const [deactivateMember, setDeactivateMember] = useState<OrganizationMember | null>(null);
  const [removeMember, setRemoveMember] = useState<OrganizationMember | null>(null);
  const [, setResendingId] = useState<string | null>(null);
  const [resendResult, setResendResult] = useState<{ memberId: string; success: boolean; error?: string } | null>(null);

  const handleResendInvite = useCallback(async (member: OrganizationMember) => {
    setResendingId(member.id);
    setResendResult(null);
    try {
      const result = await resendInvite({ memberId: member.id, organizationId });
      setResendResult({ memberId: member.id, success: result.success, error: result.error });
      setTimeout(() => setResendResult(null), 3000);
    } finally {
      setResendingId(null);
    }
  }, [organizationId]);

  const filteredMembers = useMemo(() => {
    return initialMembers.filter((member) => {
      const searchLower = searchQuery.toLowerCase();
      const displayName =
        member.user?.display_name ||
        `${member.user?.first_name || ''} ${member.user?.last_name || ''}`.trim() ||
        '';
      const email = member.user?.email || member.invited_email || '';
      const invitedEmail = member.invited_email || '';

      const matchesSearch =
        !searchQuery ||
        displayName.toLowerCase().includes(searchLower) ||
        email.toLowerCase().includes(searchLower) ||
        invitedEmail.toLowerCase().includes(searchLower);

      const matchesRole = roleFilter === 'all' || member.role === roleFilter;
      const matchesStatus =
        statusFilter === 'all' || member.license_status === statusFilter;

      return matchesSearch && matchesRole && matchesStatus;
    });
  }, [initialMembers, searchQuery, roleFilter, statusFilter]);

  const hasFilters =
    searchQuery !== '' || roleFilter !== 'all' || statusFilter !== 'all';
  const canManage =
    !readOnly && (currentUserRole === 'admin' || currentUserRole === 'it_admin');

  // Bulk selection helpers
  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredMembers.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredMembers.map((m) => m.id)));
    }
  };

  const allSelected =
    filteredMembers.length > 0 && selectedIds.size === filteredMembers.length;

  // Only count non-self selected members for bulk actions
  const selectedNonSelf = filteredMembers.filter(
    (m) => selectedIds.has(m.id) && m.user_id !== currentUserId
  );

  return (
    <div className="space-y-4">
      {/* Action bar */}
      <div className="flex items-center justify-between">
        {/* View toggle */}
        <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1">
          <button
            onClick={() => setViewMode('list')}
            className={`p-2 rounded-md transition-colors ${viewMode === 'list' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}
            aria-label="List view"
            title="List view"
          >
            <List className="h-4 w-4" />
          </button>
          <button
            onClick={() => { setViewMode('cards'); setSelectedIds(new Set()); }}
            className={`p-2 rounded-md transition-colors ${viewMode === 'cards' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}
            aria-label="Card view"
            title="Card view"
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center gap-3">
          {/* Bulk actions */}
          {canManage && selectedNonSelf.length > 0 && (
            <div className="flex items-center rounded-lg bg-primary-50 border border-primary-200 px-4 py-2.5">
              <button
                onClick={() => setIsBulkEditOpen(true)}
                className="text-sm font-medium text-primary-800 hover:text-primary-900 focus:outline-none focus:underline transition-colors"
              >
                Change Role ({selectedNonSelf.length})
              </button>
            </div>
          )}

          {/* Invite button */}
          {canManage && (
            <Button onClick={() => setIsInviteModalOpen(true)}>
              <Plus className="h-4 w-4" />
              Invite User
            </Button>
          )}
        </div>
      </div>

      {/* Resend invite notification */}
      {resendResult && (
        <div className={`rounded-md px-4 py-3 text-sm border ${resendResult.success ? 'bg-success-50 text-success-800 border-success-200' : 'bg-danger-50 text-danger-800 border-danger-200'}`}>
          {resendResult.success ? 'Invitation resent successfully.' : `Failed to resend: ${resendResult.error}`}
        </div>
      )}

      <UserSearchFilter
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        roleFilter={roleFilter}
        onRoleChange={setRoleFilter}
        statusFilter={statusFilter}
        onStatusChange={setStatusFilter}
      />

      {filteredMembers.length === 0 ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200">
          <EmptyState
            icon={hasFilters ? <SearchIcon /> : <Users className="h-12 w-12" />}
            title={hasFilters ? 'No users found' : 'No users yet'}
            description={
              hasFilters
                ? 'Try adjusting your search or filters'
                : 'No users in this organization yet. Invite team members to get started.'
            }
          />
        </div>
      ) : (
        <>
          {/* Results count */}
          <div className="text-sm text-gray-500">
            Showing {filteredMembers.length} of {initialMembers.length} user
            {initialMembers.length !== 1 ? 's' : ''}
          </div>

          {viewMode === 'cards' ? (
            /* Card grid view */
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filteredMembers.map((member) => (
                <UserCard
                  key={member.id}
                  member={member}
                  isCurrentUser={member.user_id === currentUserId}
                  canManage={canManage}
                  onEditRole={setEditRoleMember}
                  onResendInvite={handleResendInvite}
                  onDeactivate={setDeactivateMember}
                  onRemove={setRemoveMember}
                />
              ))}
            </div>
          ) : (
            /* Table/list view */
            <div className="bg-white rounded-lg shadow-sm border border-gray-200">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    {canManage && (
                      <th className="w-12 px-4 py-3">
                        <Checkbox checked={allSelected} onChange={toggleSelectAll} />
                      </th>
                    )}
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">User</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Role</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Joined</th>
                    {canManage && <th className="w-12 px-4 py-3" />}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {filteredMembers.map((member) => (
                    <UserTableRow
                      key={member.id}
                      member={member}
                      isSelected={selectedIds.has(member.id)}
                      isCurrentUser={member.user_id === currentUserId}
                      canManage={canManage}
                      onToggleSelect={() => toggleSelect(member.id)}
                      onEditRole={() => setEditRoleMember(member)}
                      onResendInvite={() => handleResendInvite(member)}
                      onDeactivate={() => setDeactivateMember(member)}
                      onRemove={() => setRemoveMember(member)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Invite User Modal */}
      <InviteUserModal
        isOpen={isInviteModalOpen}
        onClose={() => setIsInviteModalOpen(false)}
        organizationId={organizationId}
      />

      {/* Edit Role Modal (single user) */}
      {editRoleMember && (
        <EditRoleModal
          isOpen={!!editRoleMember}
          onClose={() => setEditRoleMember(null)}
          memberId={editRoleMember.id}
          memberName={formatUserDisplayName(editRoleMember.user ?? null, editRoleMember.invited_email)}
          currentRole={editRoleMember.role}
          currentUserRole={currentUserRole}
        />
      )}

      {/* Bulk Edit Role Modal */}
      <BulkEditRoleModal
        isOpen={isBulkEditOpen}
        onClose={() => { setIsBulkEditOpen(false); setSelectedIds(new Set()); }}
        memberIds={selectedNonSelf.map((m) => m.id)}
        memberCount={selectedNonSelf.length}
        currentUserRole={currentUserRole}
      />

      {/* Deactivate User Modal */}
      {deactivateMember && (
        <DeactivateUserModal
          isOpen={!!deactivateMember}
          onClose={() => setDeactivateMember(null)}
          memberId={deactivateMember.id}
          memberName={formatUserDisplayName(deactivateMember.user ?? null, deactivateMember.invited_email)}
        />
      )}

      {/* Remove User Modal */}
      {removeMember && (
        <RemoveUserModal
          isOpen={!!removeMember}
          onClose={() => setRemoveMember(null)}
          memberId={removeMember.id}
          memberName={formatUserDisplayName(removeMember.user ?? null, removeMember.invited_email)}
          isPending={!removeMember.user_id}
        />
      )}
    </div>
  );
}
