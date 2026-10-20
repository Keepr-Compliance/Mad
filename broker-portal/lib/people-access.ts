/**
 * The /dashboard/people server gate — BACKLOG-4007 PR-4. Roles from lib/people-roles.ts; role
 * and organization from the same classifier middleware and the layout use.
 */

import { getPortalAccess } from '@/lib/auth/portalAccess';
import { mayUsePeople } from '@/lib/people-roles';

export type PeopleAccess = { allowed: true; organizationId: string; role: string } | { allowed: false };

/** May the signed-in caller open People? */
export async function checkPeopleAccess(): Promise<PeopleAccess> {
  const portal = await getPortalAccess();
  if (!portal) return { allowed: false };
  const { access } = portal;
  if (
    access.kind !== 'full' ||
    !mayUsePeople(access.role) ||
    // BACKLOG-3878 / 3853 PR-2B: a suspended account or brokerage keeps My Account and Support.
    portal.suspended === true ||
    portal.orgSuspended === true
  ) {
    return { allowed: false };
  }
  return { allowed: true, organizationId: access.organizationId, role: access.role };
}
