'use server';

/**
 * Deactivate User Server Action
 *
 * Handles suspending an organization member's access.
 * Sets license_status to 'suspended' (soft delete).
 *
 * TASK-1812: Deactivate/Remove user flow
 */

import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import type { Role } from '@/lib/types/users';
import { blockWriteDuringImpersonation } from '@/lib/impersonation-guards';
import { requireActiveOrgRole } from '@/lib/auth/memberAccess';
import { PORTAL_GRANTING_LICENSE_STATUSES } from '@/lib/auth/membership';

// ============================================================================
// Types
// ============================================================================

interface DeactivateInput {
  memberId: string;
}

interface DeactivateResult {
  success: boolean;
  error?: string;
}

/** Founder R9 (BACKLOG-4007): the exact sentence, the same as the Users-page removal. */
const BILLING_CONTACT_DEACTIVATE_REFUSED = 'Pick another billing contact first.';

/** BACKLOG-4027 (founder B): a brokerage always keeps one active admin. */
const LAST_ADMIN_DEACTIVATE_REFUSED = 'Cannot deactivate the last admin';

// ============================================================================
// Main Action
// ============================================================================

/**
 * Deactivate a member by setting their license_status to 'suspended'
 *
 * @param input - Member ID to deactivate
 * @returns Result with success or error
 */
export async function deactivateUser(input: DeactivateInput): Promise<DeactivateResult> {
  // Block during impersonation (read-only session)
  const blocked = await blockWriteDuringImpersonation();
  if (blocked) return { success: false, error: blocked.error };

  const supabase = await createClient();

  // Get current user
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return { success: false, error: 'Not authenticated' };
  }

  // Get target member details
  const { data: targetMember } = await supabase
    .from('organization_members')
    .select('id, user_id, role, organization_id, license_status')
    .eq('id', input.memberId)
    .single();

  if (!targetMember) {
    return { success: false, error: 'Member not found' };
  }

  // Cannot deactivate pending invites (use remove instead)
  if (!targetMember.user_id) {
    return { success: false, error: 'Cannot deactivate pending invitations. Use remove instead.' };
  }

  // BACKLOG-3917: the caller's own row in the TARGET organization, with an
  // access-granting status and a licence that is not suspended.
  const currentMembership = await requireActiveOrgRole(supabase, user.id, targetMember.organization_id, [
    'admin',
    'it_admin',
  ]);

  if (!currentMembership.ok) {
    return {
      success: false,
      error: currentMembership.reason === 'role' ? 'Not authorized to deactivate users' : 'Not authorized',
    };
  }

  // Permission checks
  const currentUserRole = currentMembership.role as Role;


  // Cannot deactivate yourself
  if (targetMember.user_id === user.id) {
    return { success: false, error: 'Cannot deactivate yourself' };
  }

  // Only it_admin can deactivate an it_admin
  if (targetMember.role === 'it_admin' && currentUserRole !== 'it_admin') {
    return { success: false, error: 'Only IT Admins can deactivate IT Admin users' };
  }

  // BACKLOG-4027 (founder B): "last admin" is the admin role only, the same rule as the
  // database guard (_guard_last_admin), which refuses this write anyway.
  if (targetMember.role === 'admin') {
    const { count } = await supabase
      .from('organization_members')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', targetMember.organization_id)
      .eq('role', 'admin')
      .in('license_status', [...PORTAL_GRANTING_LICENSE_STATUSES])
      .not('user_id', 'is', null)
      .neq('id', input.memberId);

    if (count === 0) {
      return { success: false, error: LAST_ADMIN_DEACTIVATE_REFUSED };
    }
  }

  // Update status to suspended. license_status is not writable from a user
  // session (BACKLOG-3843), so the write uses the service client after every
  // check above has passed on the user's own session. The service client
  // bypasses RLS, so the write is scoped explicitly to the member AND the
  // organization the caller was just verified to administer.
  const service = createServiceClient();
  const { error: updateError } = await service
    .from('organization_members')
    .update({
      license_status: 'suspended',
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.memberId)
    .eq('organization_id', targetMember.organization_id);

  if (updateError) {
    // BACKLOG-4007 People v2 (PM 6a68d0a2): the live billing contact's member row cannot be
    // deactivated from the Users page (the database refuses it: billing_contact_member).
    if (updateError.message?.includes('billing_contact_member')) {
      return { success: false, error: BILLING_CONTACT_DEACTIVATE_REFUSED };
    }
    if (updateError.message?.includes('last_admin')) {
      return { success: false, error: LAST_ADMIN_DEACTIVATE_REFUSED };
    }
    console.error('Error deactivating user:', updateError);
    return { success: false, error: 'Failed to deactivate user' };
  }

  return { success: true };
}
