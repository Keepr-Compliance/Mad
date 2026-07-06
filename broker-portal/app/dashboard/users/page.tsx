/**
 * Users Management Page
 *
 * Main page for viewing and managing organization members.
 * Only accessible to admin and it_admin roles.
 * During impersonation, renders in read-only mode (TASK-2138).
 *
 * TASK-1808: Initial route structure
 * TASK-1809: Integrated UserListClient
 * TASK-1810: Added organizationId prop for invite modal
 * TASK-2138: Read-only mode during impersonation
 */

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import UserListClient from '@/components/users/UserListClient';
import type { OrganizationMember, Role } from '@/lib/types/users';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getImpersonationSession } from '@/lib/impersonation';
import { getDataClient } from '@/lib/impersonation-guards';
// PageHeader is Tier-2 (no @keepr/ui equivalent yet).
import { PageHeader } from '@keepr/design-system';
import { AlertBanner } from '@keepr/ui';

interface AccessCheckResult {
  allowed: true;
  organizationId: string;
  role: Role;
  userId: string;
}

interface AccessDeniedResult {
  allowed: false;
  reason: 'unauthenticated' | 'unauthorized';
}

type AccessCheck = AccessCheckResult | AccessDeniedResult;

async function checkUserAccess(): Promise<AccessCheck> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { allowed: false, reason: 'unauthenticated' };

  const { data: membership } = await supabase
    .from('organization_members')
    .select('role, organization_id')
    .eq('user_id', user.id)
    .maybeSingle();

  // Only admin and it_admin can access users management
  const allowedRoles: Role[] = ['admin', 'it_admin'];
  if (!membership || !allowedRoles.includes(membership.role as Role)) {
    return { allowed: false, reason: 'unauthorized' };
  }

  return {
    allowed: true,
    organizationId: membership.organization_id,
    role: membership.role as Role,
    userId: user.id,
  };
}

async function getOrganizationMembers(
  organizationId: string
): Promise<OrganizationMember[]> {
  const supabase = await createClient();

  const { data: members, error } = await supabase
    .from('organization_members')
    .select(
      `
      id,
      organization_id,
      user_id,
      role,
      license_status,
      invited_email,
      invitation_token,
      invitation_expires_at,
      invited_by,
      invited_at,
      joined_at,
      last_invited_at,
      created_at,
      updated_at,
      provisioned_by,
      provisioned_at,
      scim_synced_at,
      provisioning_metadata,
      idp_groups,
      group_sync_enabled,
      user:users!organization_members_user_id_public_users_fkey (
        id,
        email,
        first_name,
        last_name,
        display_name,
        avatar_url,
        oauth_provider,
        oauth_id,
        last_login_at,
        created_at,
        updated_at,
        last_sso_login_at,
        last_sso_provider,
        is_managed,
        scim_external_id,
        sso_only,
        jit_provisioned,
        jit_provisioned_at,
        provisioning_source,
        suspended_at,
        suspension_reason,
        idp_claims
      )
    `
    )
    .eq('organization_id', organizationId)
    .order('joined_at', { ascending: false, nullsFirst: true });

  if (error) {
    console.error('Error fetching organization members:', error);
    return [];
  }

  // Transform to match OrganizationMember type
  // The join returns user as an array in some cases, normalize to single object
  return (members || []).map((member) => ({
    ...member,
    user: Array.isArray(member.user) ? member.user[0] : member.user,
  })) as OrganizationMember[];
}

/**
 * Fetch members during impersonation using the scoped data client.
 * The scoped client restricts queries to the target user's organization.
 */
async function getImpersonationMembers(
  organizationId: string,
  client: SupabaseClient
): Promise<OrganizationMember[]> {
  const { data: members, error } = await client
    .from('organization_members')
    .select(
      `
      id,
      organization_id,
      user_id,
      role,
      license_status,
      invited_email,
      invitation_token,
      invitation_expires_at,
      invited_by,
      invited_at,
      joined_at,
      last_invited_at,
      created_at,
      updated_at,
      provisioned_by,
      provisioned_at,
      scim_synced_at,
      provisioning_metadata,
      idp_groups,
      group_sync_enabled,
      user:users!organization_members_user_id_public_users_fkey (
        id,
        email,
        first_name,
        last_name,
        display_name,
        avatar_url,
        oauth_provider,
        oauth_id,
        last_login_at,
        created_at,
        updated_at,
        last_sso_login_at,
        last_sso_provider,
        is_managed,
        scim_external_id,
        sso_only,
        jit_provisioned,
        jit_provisioned_at,
        provisioning_source,
        suspended_at,
        suspension_reason,
        idp_claims
      )
    `
    )
    .eq('organization_id', organizationId)
    .order('joined_at', { ascending: false, nullsFirst: true });

  if (error) {
    console.error('Error fetching organization members during impersonation:', error);
    return [];
  }

  return (members || []).map((member) => ({
    ...member,
    user: Array.isArray(member.user) ? member.user[0] : member.user,
  })) as OrganizationMember[];
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

  // Normal access: require authentication and admin/it_admin role
  const access = await checkUserAccess();

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
