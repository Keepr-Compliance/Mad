'use server';

/**
 * Bulk Update Role Server Action
 *
 * Updates the role for multiple organization members at once.
 */

import { createClient } from '@/lib/supabase/server';
import type { Role } from '@/lib/types/users';
import { blockWriteDuringImpersonation } from '@/lib/impersonation-guards';
import { requireActiveOrgRole } from '@/lib/auth/memberAccess';
import { LAST_ADMIN_DEMOTE_REFUSED, ROLE_MANAGED_BY_IDP } from '@/lib/users/roleRefusals';

interface BulkUpdateRoleInput {
  /** BACKLOG-3917: the organization the caller acts in; the caller's row there decides. */
  organizationId: string;
  memberIds: string[];
  newRole: Role;
}

interface BulkUpdateRoleResult {
  success: boolean;
  updatedCount?: number;
  error?: string;
}

export async function bulkUpdateRole(
  input: BulkUpdateRoleInput
): Promise<BulkUpdateRoleResult> {
  // Block during impersonation (read-only session)
  const blocked = await blockWriteDuringImpersonation();
  if (blocked) return { success: false, error: blocked.error };

  const supabase = await createClient();

  // Verify current user is admin/it_admin
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { success: false, error: 'Not authenticated' };
  }

  // BACKLOG-3917: the caller's row in the TARGET organization (was: any one row
  // of theirs), with an access-granting status and a licence not suspended.
  const membership = await requireActiveOrgRole(supabase, user.id, input.organizationId, ['admin', 'it_admin']);

  if (!membership.ok) {
    return { success: false, error: 'Not authorized to update roles' };
  }

  // Validate role assignment permissions
  const allowedRoles: Role[] =
    membership.role === 'it_admin'
      ? ['agent', 'broker', 'admin', 'it_admin']
      : ['agent', 'broker', 'admin'];

  if (!allowedRoles.includes(input.newRole)) {
    return { success: false, error: 'Cannot assign this role' };
  }

  // Note: Current user exclusion is handled by .neq('user_id', user.id) in the
  // Supabase query below, so no client-side filtering is needed here.
  const memberIdsToUpdate = input.memberIds;

  if (memberIdsToUpdate.length === 0) {
    return { success: false, error: 'No users to update' };
  }

  // Update all members in the same organization
  const { data, error } = await supabase
    .from('organization_members')
    .update({ role: input.newRole, updated_at: new Date().toISOString() })
    .eq('organization_id', input.organizationId)
    .in('id', memberIdsToUpdate)
    .neq('user_id', user.id) // Don't update own role
    .select('id');

  if (error) {
    // BACKLOG-4027: the database refusals (one statement, so nothing was changed).
    if (error.message?.includes('last_admin')) {
      return { success: false, error: LAST_ADMIN_DEMOTE_REFUSED };
    }
    if (error.message?.includes('managed_by_idp')) {
      return { success: false, error: ROLE_MANAGED_BY_IDP };
    }
    console.error('Error bulk updating roles:', error);
    return { success: false, error: 'Failed to update roles' };
  }

  return {
    success: true,
    updatedCount: data?.length || 0,
  };
}
