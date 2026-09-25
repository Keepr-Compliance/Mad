'use server';

/**
 * Get Invitation Link Server Action — BACKLOG-3541
 *
 * Returns the invite-acceptance link for one pending member, fetched on
 * demand. The token itself is no longer part of the Users list payload (see
 * lib/queries/userQueries.ts) — this is the call "Copy Invite Link" makes
 * instead, authorized the same way `resendInvite` is.
 */

import { createClient } from '@/lib/supabase/server';

interface GetInvitationLinkInput {
  memberId: string;
  organizationId: string;
}

interface GetInvitationLinkResult {
  success: boolean;
  error?: string;
  inviteLink?: string;
}

export async function getInvitationLink(
  input: GetInvitationLinkInput
): Promise<GetInvitationLinkResult> {
  const supabase = await createClient();

  // Verify current user is admin/it_admin in the target organization
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { success: false, error: 'Not authenticated' };
  }

  const { data: membership } = await supabase
    .from('organization_members')
    .select('role, organization_id')
    .eq('user_id', user.id)
    .eq('organization_id', input.organizationId)
    .maybeSingle();

  if (!membership || !['admin', 'it_admin'].includes(membership.role)) {
    return { success: false, error: 'Not authorized' };
  }

  // Get the pending invite
  const { data: pendingMember } = await supabase
    .from('organization_members')
    .select('id, invitation_token, user_id')
    .eq('id', input.memberId)
    .eq('organization_id', input.organizationId)
    .maybeSingle();

  if (!pendingMember) {
    return { success: false, error: 'Invitation not found' };
  }

  if (pendingMember.user_id) {
    return { success: false, error: 'This user has already accepted the invitation' };
  }

  if (!pendingMember.invitation_token) {
    return { success: false, error: 'No invitation link available' };
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.keeprcompliance.com';
  return {
    success: true,
    inviteLink: `${baseUrl}/invite/${pendingMember.invitation_token}`,
  };
}
