/**
 * Who may open the Users list and a member's detail page — BACKLOG-3541.
 *
 * The two pages carried near-identical inline access checks before this file
 * existed. Consolidated so the allowed-role list has exactly one place to
 * widen, and one place a mutation test can catch it widening too far.
 *
 * Management actions (Change Role / Deactivate / Remove, and the invite
 * flow) stay gated separately by `canManage` (`['admin', 'it_admin']`),
 * unchanged by this file — this only controls who can VIEW the list and a
 * member's detail page.
 *
 * `USERS_PAGE_ROLES` itself lives in the import-free `./users-access-roles`
 * and is re-exported here so existing call sites (`import { USERS_PAGE_ROLES }
 * from '@/lib/users-access'`) are unchanged. This file imports
 * `@/lib/supabase/server` (`next/headers`), so a `'use client'` component
 * cannot import anything from here — see `users-access-roles.ts`'s header.
 */

import { createClient } from '@/lib/supabase/server';
import type { Role } from '@/lib/types/users';
import { USERS_PAGE_ROLES } from './users-access-roles';

export { USERS_PAGE_ROLES } from './users-access-roles';

export interface UsersPageAccessGranted {
  allowed: true;
  organizationId: string;
  role: Role;
  userId: string;
}

export interface UsersPageAccessDenied {
  allowed: false;
  reason: 'unauthenticated' | 'unauthorized';
}

export type UsersPageAccess = UsersPageAccessGranted | UsersPageAccessDenied;

/**
 * May the signed-in caller view the Users list / a member's detail page?
 *
 * Returns rather than throws — both pages turn the answer into a redirect.
 * Does not consider impersonation; each page handles that branch separately
 * with its own scoped, read-only client.
 */
export async function checkUsersPageAccess(): Promise<UsersPageAccess> {
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

  if (
    !membership ||
    !(USERS_PAGE_ROLES as readonly string[]).includes(membership.role)
  ) {
    return { allowed: false, reason: 'unauthorized' };
  }

  return {
    allowed: true,
    organizationId: membership.organization_id,
    role: membership.role as Role,
    userId: user.id,
  };
}
