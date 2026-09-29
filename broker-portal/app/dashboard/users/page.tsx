/**
 * Users Management Page
 *
 * Main page for viewing and managing organization members.
 * Viewable by the roles in USERS_PAGE_ROLES (lib/users-access.ts); member
 * management actions stay gated separately by canManage (admin/it_admin).
 * During impersonation, renders in read-only mode (TASK-2138).
 *
 * TASK-1808: Initial route structure
 * TASK-1809: Integrated UserListClient
 * TASK-1810: Added organizationId prop for invite modal
 * TASK-2138: Read-only mode during impersonation
 * BACKLOG-3541: narrowed the SELECT to rendered fields; opened the page to
 * USERS_PAGE_ROLES
 */

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import UserListClient from '@/components/users/UserListClient';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getImpersonationSession } from '@/lib/impersonation';
import { getDataClient } from '@/lib/impersonation-guards';
import { checkUsersPageAccess } from '@/lib/users-access';
import {
  USER_LIST_SELECT,
  projectListMember,
  type ListMember,
  type RawListMemberRow,
} from '@/lib/queries/userQueries';
// PageHeader is Tier-2 (no @keepr/ui equivalent yet).
import { PageHeader } from '@keepr/design-system';
import { AlertBanner } from '@keepr/ui';

async function getOrganizationMembers(
  organizationId: string
): Promise<ListMember[]> {
  const supabase = await createClient();

  const { data: members, error } = await supabase
    .from('organization_members')
    .select(USER_LIST_SELECT)
    .eq('organization_id', organizationId)
    .order('joined_at', { ascending: false, nullsFirst: true });

  if (error) {
    console.error('Error fetching organization members:', error);
    return [];
  }

  return ((members || []) as unknown as RawListMemberRow[]).map(projectListMember);
}

/**
 * Fetch members during impersonation using the scoped data client.
 * The scoped client restricts queries to the target user's organization.
 */
async function getImpersonationMembers(
  organizationId: string,
  client: SupabaseClient
): Promise<ListMember[]> {
  const { data: members, error } = await client
    .from('organization_members')
    .select(USER_LIST_SELECT)
    .eq('organization_id', organizationId)
    .order('joined_at', { ascending: false, nullsFirst: true });

  if (error) {
    console.error('Error fetching organization members during impersonation:', error);
    return [];
  }

  return ((members || []) as unknown as RawListMemberRow[]).map(projectListMember);
}

export default async function UsersPage() {
  const impersonation = await getImpersonationSession();

  // During impersonation: render read-only view using scoped client
  if (impersonation) {
    const { client, organizationId, targetUserId } = await getDataClient();

    if (!organizationId || !targetUserId) {
      redirect('/dashboard');
    }

    const members = await getImpersonationMembers(organizationId, client);

    return (
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Read-only banner */}
        <AlertBanner variant="warning">Read-only during support session</AlertBanner>

        {/* Header */}
        <PageHeader
          title="Users Management"
          subtitle="Manage your organization's team members"
        />

        {/* User List (read-only) */}
        <UserListClient
          initialMembers={members}
          currentUserId={targetUserId}
          currentUserRole="admin"
          organizationId={organizationId}
          readOnly
        />
      </div>
    );
  }

  // Normal access: require authentication and a role in USERS_PAGE_ROLES
  const access = await checkUsersPageAccess();

  if (!access.allowed) {
    redirect('/dashboard');
  }

  const members = await getOrganizationMembers(access.organizationId);

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <PageHeader
        title="Users Management"
        subtitle="Manage your organization's team members"
      />

      {/* User List */}
      <UserListClient
        initialMembers={members}
        currentUserId={access.userId}
        currentUserRole={access.role}
        organizationId={access.organizationId}
      />
    </div>
  );
}
