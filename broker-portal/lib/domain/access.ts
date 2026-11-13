/**
 * Who may manage this brokerage's domain claims — BACKLOG-3962.
 *
 * The organization is the session's own (getPortalAccess, the classifier middleware uses),
 * never a value posted by the browser (R2). Admitted only when ALL of:
 *   - a full portal session whose role is admin or it_admin (ORG_SETTINGS_ROLES);
 *   - the account and the brokerage are not suspended;
 *   - requireActiveOrgRole re-reads the caller's row in THAT organization and admits it.
 *
 * Every domain claim action calls this; hiding the settings link is not a gate.
 */

import { getPortalAccess } from '@/lib/auth/portalAccess';
import { requireActiveOrgRole } from '@/lib/auth/memberAccess';
import { ORG_SETTINGS_ROLES, seesOrgPolicy } from '@/lib/org-settings-access';

type PortalAccessResult = NonNullable<Awaited<ReturnType<typeof getPortalAccess>>>;

export type DomainClaimAccess =
  | { ok: true; supabase: PortalAccessResult['supabase']; userId: string; organizationId: string }
  | { ok: false };

export async function requireDomainClaimAccess(): Promise<DomainClaimAccess> {
  const portal = await getPortalAccess();
  if (!portal) return { ok: false };
  const { access, user, supabase } = portal;
  if (access.kind !== 'full' || !seesOrgPolicy(access.role)) return { ok: false };
  if (portal.suspended === true || portal.orgSuspended === true) return { ok: false };

  const organizationId = access.organizationId;
  const membership = await requireActiveOrgRole(supabase, user.id, organizationId, ORG_SETTINGS_ROLES);
  if (!membership.ok) return { ok: false };

  return { ok: true, supabase, userId: user.id, organizationId };
}
