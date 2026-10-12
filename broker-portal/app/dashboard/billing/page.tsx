/**
 * Billing route — BACKLOG-3844.
 *
 * THIS PAGE IS THE GATE. It decides on its own who may see billing; the
 * sidebar entry is presentation only, so each refusal below is load-bearing:
 *
 *   1. Flag off (lib/billing/flag.ts)            -> 404, for everyone.
 *   2. A support / impersonation session         -> 404. Billing is never shown
 *      to support, and the staffer's own portal session must not be shown in
 *      its place.
 *   3. Not signed in                             -> /login.
 *   4. billingCapabilities(...) is null          -> 404: a brokerage agent, a
 *      failed membership read, no membership.
 *
 * Each step runs before any billing data is read. The situation is fixed in
 * 3844 (no billing data is read yet): the Agent plan reader lands with 3847,
 * account suspension with 3878, the organization's deal with 3853/3855.
 */

import { notFound, redirect } from 'next/navigation';
import { getImpersonationSession } from '@/lib/impersonation';
import { getPortalAccess } from '@/lib/auth/portalAccess';
import { billingEnabled } from '@/lib/billing/flag';
import { billingCapabilities } from '@/lib/billing/capabilities';
import { BillingPage } from '@/components/billing/BillingPage';

const SITUATION_3844 = {
  agentPlan: 'none',
  accountSuspended: false,
  orgBillingSetUp: false,
} as const;

export default async function BillingRoute() {
  if (!billingEnabled()) notFound();
  if (await getImpersonationSession()) notFound();

  const portal = await getPortalAccess();
  if (!portal) redirect('/login');

  const caps = billingCapabilities({
    access: portal.access,
    isImpersonating: false,
    enabled: true,
    ...SITUATION_3844,
  });
  if (!caps) notFound();

  return <BillingPage caps={caps} orgBillingSetUp={SITUATION_3844.orgBillingSetUp} />;
}
