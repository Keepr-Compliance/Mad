'use server';

/**
 * Change Member Role Server Action - Admin Portal (BACKLOG-3976)
 *
 * Support staff change a brokerage member's role from the organization page.
 * Auth: has_internal_role + has_permission(user_id, 'users.edit') — enforced in the
 * admin_update_org_member_role RPC, not here. The RPC also writes admin_audit_logs, and the
 * shared organization_members triggers apply the last-admin, identity-provider and it_admin rules.
 */

import { createClient } from '@/lib/supabase/server';
import { describeRoleChangeError, MEMBER_ROLE_OPTIONS, type MemberRole } from './changeMemberRole.helpers';

interface ChangeMemberRoleInput {
  organizationId: string;
  userId: string;
  role: MemberRole;
}

export interface ChangeMemberRoleResult {
  success: boolean;
  oldRole?: string;
  newRole?: string;
  error?: string;
}

export async function changeMemberRole(input: ChangeMemberRoleInput): Promise<ChangeMemberRoleResult> {
  if (!MEMBER_ROLE_OPTIONS.some((o) => o.value === input.role)) {
    return { success: false, error: describeRoleChangeError('invalid_role') };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('admin_update_org_member_role', {
    p_organization_id: input.organizationId,
    p_user_id: input.userId,
    p_role: input.role,
  });

  if (error) {
    return { success: false, error: describeRoleChangeError(null, error.message ?? 'error') };
  }

  const result = data as { success?: boolean; error?: string; old_role?: string; new_role?: string } | null;
  if (!result?.success) {
    return { success: false, error: describeRoleChangeError(result?.error) };
  }
  return { success: true, oldRole: result.old_role, newRole: result.new_role };
}
