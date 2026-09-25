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
import { getCurrentSplitsForOrg, canViewSplit, type SplitAgreementRow } from '@/lib/splitAgreements';
// PageHeader is Tier-2 (no @keepr/ui equivalent yet).
import { PageHeader } from '@keepr/design-system';
import { AlertBanner } from '@keepr/ui';

/** Map -> plain object: Next.js can only serialize plain data across the
 *  server/client boundary as props, not a Map. */
function splitsToPlainRecord(
  splits: Map<string, SplitAgreementRow>
): Record<string, { agent_pct: number; brokerage_pct: number }> {
  const record: Record<string, { agent_pct: number; brokerage_pct: number }> = {};
  for (const [agentUserId, row] of splits) {
    record[agentUserId] = { agent_pct: row.agent_pct, brokerage_pct: row.brokerage_pct };
  }
  return record;
}

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
    // NOT fetched during impersonation, full stop — `agent_split_agreements`
    // is not in lib/scoped-client.ts's ALLOWED_TABLES, and a table missing
    // from that allowlist does not read as empty: createBlockedQueryBuilder
    // throws on every method, which took down getAccountView() the same way
    // before this exact guard was added there (caught by
    // account-impersonation.test.tsx, not inferred — see that file's git
    // history and BACKLOG-3540). Same fix here: no query, no column, no
    // crash. Whether a support session should see the split at all is
    // BACKLOG-3540's open question, not answered by this omission.
    const splitsByAgent: Record<string, { agent_pct: number; brokerage_pct: number }> = {};

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
          // Hidden, not shown-with-a-false-"no agreement" — see the comment
          // on splitsByAgent above. A wrongly-blank column would read as "no
          // agent here has a split on file," which is not something we
          // checked.
          showSplitColumn={false}
          splitsByAgent={splitsByAgent}
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
  // Split column: admin/broker only, it_admin excluded — see splitAgreements.ts.
  // Only queried when the viewer can see it, not fetched-then-hidden.
  const showSplitColumn = canViewSplit(access.role);
  const splitsByAgent = showSplitColumn
    ? splitsToPlainRecord(
        await getCurrentSplitsForOrg(await createClient(), access.organizationId)
      )
    : {};

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
        showSplitColumn={showSplitColumn}
        splitsByAgent={splitsByAgent}
      />
    </div>
  );
}
