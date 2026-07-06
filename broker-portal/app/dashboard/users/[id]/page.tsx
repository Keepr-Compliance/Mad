/**
 * User Details Page
 *
 * Shows detailed information about a specific organization member.
 * Only accessible to admin and it_admin roles.
 *
 * TASK-1813: Full user details view implementation
 */

import { createClient } from '@/lib/supabase/server';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import UserDetailsCard, { type MemberDetailsData } from '@/components/users/UserDetailsCard';
import type { Role } from '@/lib/types/users';
import { getImpersonationSession } from '@/lib/impersonation';

// ============================================================================
// Types
// ============================================================================

interface PageProps {
  params: Promise<{ id: string }>;
}

interface UserDetailsResult {
  member: MemberDetailsData;
  currentUserId: string;
  currentUserRole: Role;
  organizationId: string;
}

interface NotFoundResult {
  notFound: true;
}

// ============================================================================
// Data Fetching
// ============================================================================

/**
 * Fetch user details with access control checks
 */
async function getUserDetails(memberId: string): Promise<UserDetailsResult | NotFoundResult | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  // Not authenticated
  if (!user) return null;

  // Get current user's membership
  const { data: currentMembership } = await supabase
    .from('organization_members')
    .select('role, organization_id')
    .eq('user_id', user.id)
    .maybeSingle();

  // No membership or unauthorized role
  if (!currentMembership || !['admin', 'it_admin'].includes(currentMembership.role)) {
    return null;
  }

  // Get target member with full details
  // Note: We fetch all fields including SSO/SCIM columns from SPRINT-070
  const { data: member, error } = await supabase
    .from('organization_members')
    .select(`
      id,
      user_id,
      role,
      license_status,
      invited_email,
      invited_at,
      joined_at,
      provisioned_by,
      provisioned_at,
      scim_synced_at,
      provisioning_metadata,
      idp_groups,
      invited_by,
      last_invited_at,
      created_at,
      updated_at,
      user:users!organization_members_user_id_public_users_fkey (
        id,
        email,
        first_name,
        last_name,
        display_name,
        avatar_url,
        last_login_at,
        created_at,
        last_sso_login_at,
        last_sso_provider,
        is_managed
      )
    `)
    .eq('id', memberId)
    .eq('organization_id', currentMembership.organization_id)
    .single();

  if (error || !member) {
    return { notFound: true };
  }

  // Try to get inviter information if invited_by is set
  let inviterData: { user?: { email: string; display_name: string | null } } | undefined;

  if (member.invited_by) {
    const { data: inviterMember } = await supabase
      .from('organization_members')
      .select(`
        user:users!organization_members_user_id_public_users_fkey (
          email,
          display_name
        )
      `)
      .eq('id', member.invited_by)
      .single();

    if (inviterMember?.user) {
      // Supabase returns joined relations as arrays, get first element
      const userRecord = Array.isArray(inviterMember.user)
        ? inviterMember.user[0]
        : inviterMember.user;
      if (userRecord) {
        inviterData = { user: userRecord as { email: string; display_name: string | null } };
      }
    }
  }

  // Supabase returns joined relations as arrays, extract first element
  const userData = Array.isArray(member.user) ? member.user[0] : member.user;

  return {
    member: {
      ...member,
      user: userData,
      inviter: inviterData,
    } as MemberDetailsData,
    currentUserId: user.id,
    currentUserRole: currentMembership.role as Role,
    organizationId: currentMembership.organization_id,
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Get the display name for breadcrumb
 */
function getBreadcrumbName(member: MemberDetailsData): string {
  if (member.user?.display_name) {
    return member.user.display_name;
  }

  const fullName = [member.user?.first_name, member.user?.last_name]
    .filter(Boolean)
    .join(' ')
    .trim();

  if (fullName) {
    return fullName;
  }

  return member.invited_email || 'User Details';
}

// ============================================================================
// Page Component
// ============================================================================

export default async function UserDetailsPage({ params }: PageProps) {
  // Block user details during impersonation (read-only session)
  const impersonationSession = await getImpersonationSession();
  if (impersonationSession) {
    redirect('/dashboard');
  }

  const { id } = await params;

  // Validate UUID format early
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(id)) {
    notFound();
  }

  const data = await getUserDetails(id);

  // Not authenticated or unauthorized
  if (!data) {
    redirect('/dashboard');
  }

  // Member not found
  if ('notFound' in data) {
    notFound();
  }

  const breadcrumbName = getBreadcrumbName(data.member);

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Breadcrumb Navigation */}
      <nav aria-label="Breadcrumb">
        <ol className="flex items-center space-x-2 text-sm text-gray-500">
          <li>
            <Link href="/dashboard" className="hover:text-gray-700 transition-colors">
              Dashboard
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li>
            <Link href="/dashboard/users" className="hover:text-gray-700 transition-colors">
              Users
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li className="text-gray-900 font-medium truncate max-w-[200px]">
            {breadcrumbName}
          </li>
        </ol>
      </nav>

      {/* Back Link */}
      <Link
        href="/dashboard/users"
        className="inline-flex items-center text-sm text-gray-500 hover:text-gray-700 transition-colors"
      >
        <ArrowLeft className="h-4 w-4 mr-1" aria-hidden="true" />
        Back to Users
      </Link>

      {/* User Details Card */}
      <UserDetailsCard
        member={data.member}
        currentUserId={data.currentUserId}
        currentUserRole={data.currentUserRole}
      />
    </div>
  );
}
