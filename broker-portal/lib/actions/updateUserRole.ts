'use server';

/**
 * Update User Role Server Action
 *
 * Handles changing an organization member's role.
 * Validates permissions and prevents last admin removal.
 *
 * TASK-1811: Edit user role modal
 */

import { createClient } from '@/lib/supabase/server';
import type { Role } from '@/lib/types/users';
import { blockWriteDuringImpersonation } from '@/lib/impersonation-guards';
import { requireActiveOrgRole } from '@/lib/auth/memberAccess';

// ============================================================================
// Types
// ============================================================================

interface UpdateRoleInput {
  memberId: string;
  newRole: Role;
}

interface UpdateRoleResult {
  success: boolean;
  error?: string;
}

// ============================================================================
// Main Action
// ============================================================================

/**
 * Update a member's role within the organization
 *
 * @param input - Member ID and new role
 * @returns Result with success or error
 */
export async function updateUserRole(input: UpdateRoleInput): Promise<UpdateRoleResult> {
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
    .select('id, user_id, role, organization_id')
    .eq('id', input.memberId)
    .single();

  if (!targetMember) {
    return { success: false, error: 'Member not found' };
  }

  // Cannot change role for pending invites (no user_id)
  if (!targetMember.user_id) {
    return { success: false, error: 'Cannot change role for pending invitations' };
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
      error: currentMembership.reason === 'role' ? 'Not authorized to change roles' : 'Not authorized',
    };
  }

  // Permission checks
  const currentUserRole = currentMembership.role as Role;


  // Cannot change own role
  if (targetMember.user_id === user.id) {
    return { success: false, error: 'Cannot change your own role' };
  }

  // Only it_admin can assign it_admin role
  if (input.newRole === 'it_admin' && currentUserRole !== 'it_admin') {
    return { success: false, error: 'Only IT Admins can assign IT Admin role' };
  }

  // Only it_admin can demote an it_admin
  if (targetMember.role === 'it_admin' && currentUserRole !== 'it_admin') {
    return { success: false, error: 'Only IT Admins can change IT Admin roles' };
  }

  // Check if this would remove the last admin/it_admin
  if (
    ['admin', 'it_admin'].includes(targetMember.role) &&
    !['admin', 'it_admin'].includes(input.newRole)
  ) {
    const { count } = await supabase
      .from('organization_members')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', targetMember.organization_id)
      .in('role', ['admin', 'it_admin'])
      .neq('id', input.memberId);

    if (count === 0) {
      return { success: false, error: 'Cannot demote the last admin. Assign another admin first.' };
    }
  }

  // Update the role
  const { error: updateError } = await supabase
    .from('organization_members')
    .update({
      role: input.newRole,
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.memberId);

  if (updateError) {
    console.error('Error updating role:', updateError);
    return { success: false, error: 'Failed to update role' };
  }

  return { success: true };
}
