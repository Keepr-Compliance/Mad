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

  // Get current user's membership
  const { data: currentMembership } = await supabase
    .from('organization_members')
    .select('role')
    .eq('user_id', user.id)
    .eq('organization_id', targetMember.organization_id)
    .single();

  if (!currentMembership) {
    return { success: false, error: 'Not authorized' };
  }

  // Permission checks
  const currentUserRole = currentMembership.role as Role;

  // Only admin/it_admin can deactivate users
  if (!['admin', 'it_admin'].includes(currentUserRole)) {
    return { success: false, error: 'Not authorized to deactivate users' };
  }

  // Cannot deactivate yourself
  if (targetMember.user_id === user.id) {
    return { success: false, error: 'Cannot deactivate yourself' };
  }

  // Only it_admin can deactivate an it_admin
  if (targetMember.role === 'it_admin' && currentUserRole !== 'it_admin') {
    return { success: false, error: 'Only IT Admins can deactivate IT Admin users' };
  }

  // Check if this would remove the last active admin/it_admin
  if (['admin', 'it_admin'].includes(targetMember.role)) {
    const { count } = await supabase
      .from('organization_members')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', targetMember.organization_id)
      .in('role', ['admin', 'it_admin'])
      .eq('license_status', 'active')
      .neq('id', input.memberId);

    if (count === 0) {
      return { success: false, error: 'Cannot deactivate the last admin' };
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
    console.error('Error deactivating user:', updateError);
    return { success: false, error: 'Failed to deactivate user' };
  }

  return { success: true };
}
