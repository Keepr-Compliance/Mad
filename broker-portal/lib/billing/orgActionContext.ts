/**
 * Who is calling an organization Billing action — BACKLOG-3854.
 *
 * Recomputed on the server for every action, the same way the Billing page admits the person
 * (app/dashboard/billing/page.tsx): the flag, the signed-in session, billingCapabilities with the
 * REAL orgBillingSetUp and the brokerage's suspension. The organization id is the session's own
 * (portal.access.organizationId); no action takes one from the client.
 */

import { getPortalAccess, type PortalAccessResult } from '@/lib/auth/portalAccess';
import { billingEnabled } from './flag';
import { billingCapabilities, type BillingCapabilities } from './capabilities';
import { createServiceClient } from '@/lib/supabase/service';
import { currentStripeMode, type StripeMode } from './mode';
import { readOrgBillingSetUp } from './orgBillingSetUp';
import { readOrgBillingSuspendedFor } from '@/lib/auth/orgSuspension';
import { BILLING_CONTACT_ROLE } from '@/lib/auth/billingContact';

export interface OrgActionContext {
  portal: PortalAccessResult;
  organizationId: string;
  /** broker | admin | it_admin, or the billing-only login's role. */
  role: string;
  caps: BillingCapabilities;
  service: ReturnType<typeof createServiceClient>;
  mode: StripeMode;
}

export async function orgActionContext(): Promise<OrgActionContext | { error: 'not_authorized' }> {
  if (!billingEnabled()) return { error: 'not_authorized' };
  const portal = await getPortalAccess();
  if (!portal || portal.suspended === true) return { error: 'not_authorized' };
  const access = portal.access;
  if (access.kind === 'none' || access.kind === 'unknown') return { error: 'not_authorized' };
  const billingContact = portal.billingContact === true;
  if (!(access.kind === 'full' || billingContact)) return { error: 'not_authorized' };
  const organizationId = access.organizationId;
  const service = createServiceClient();
  const mode = currentStripeMode();
  const orgSuspended = billingContact ? await readOrgBillingSuspendedFor(portal.supabase, organizationId) : portal.orgSuspended;
  const caps = billingCapabilities({
    access,
    isImpersonating: false,
    enabled: true,
    agentPlan: 'none',
    accountSuspended: false,
    orgBillingSetUp: await readOrgBillingSetUp(service, organizationId, mode),
    orgSuspended: orgSuspended === true,
    billingContact,
  });
  if (!caps || caps.kind !== 'organization') return { error: 'not_authorized' };
  return {
    portal,
    organizationId,
    role: billingContact ? BILLING_CONTACT_ROLE : access.kind === 'full' ? access.role : '',
    caps,
    service,
    mode,
  };
}
