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
 * Each step runs before any billing data is read. BACKLOG-3847 reads the
 * personal owner's Agent plan (mirror row, support grant) and the Agent prices
 * AFTER step 4; account suspension stays with 3878, the organization's deal
 * with 3853/3855.
 */

import { notFound, redirect } from 'next/navigation';
import { getImpersonationSession } from '@/lib/impersonation';
import { getPortalAccess } from '@/lib/auth/portalAccess';
import { billingEnabled } from '@/lib/billing/flag';
import { billingCapabilities } from '@/lib/billing/capabilities';
import { BillingPage, type PersonalPlanData } from '@/components/billing/BillingPage';
import { createServiceClient } from '@/lib/supabase/service';
import { getStripe } from '@/lib/stripe';
import { currentStripeMode } from '@/lib/billing/mode';
import { formatPrice, getAgentPlanView, getAgentPrices, type AgentPrice } from '@/lib/billing/agentPlan';

const SITUATION_3844 = {
  agentPlan: 'none',
  accountSuspended: false,
  orgBillingSetUp: false,
} as const;

type SearchParams = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string | null {
  return typeof v === 'string' ? v : null;
}

async function agentPrices(): Promise<PersonalPlanData['prices']> {
  try {
    const p = await getAgentPrices(getStripe());
    const show = (x?: AgentPrice) => (x ? { id: x.id, display: formatPrice(x) } : undefined);
    return { month: show(p.month), year: show(p.year) };
  } catch (e) {
    // Prices unavailable: the page renders, nothing can be bought.
    console.error('[billing/page] Agent prices read failed:', (e as Error).message);
    return {};
  }
}

export default async function BillingRoute({ searchParams }: { searchParams?: Promise<SearchParams> } = {}) {
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
  if (caps.kind !== 'personal') {
    return <BillingPage caps={caps} orgBillingSetUp={SITUATION_3844.orgBillingSetUp} />;
  }

  // BACKLOG-3847: the personal owner's Agent plan, read only now that the page is admitted.
  const view = await getAgentPlanView(createServiceClient(), portal.user.id, currentStripeMode());
  const personalCaps = billingCapabilities({
    access: portal.access,
    isImpersonating: false,
    enabled: true,
    ...SITUATION_3844,
    agentPlan: view.state,
  });
  if (!personalCaps) notFound();
  const sp = (await searchParams) ?? {};
  const checkout = one(sp.checkout);
  const personal: PersonalPlanData = {
    state: view.state,
    interval: view.row?.interval ?? null,
    currentPeriodEnd: view.row?.current_period_end ?? null,
    supportGrantEffective: view.supportGrantEffective,
    prices: await agentPrices(),
    checkout: checkout === 'success' || checkout === 'cancelled' ? checkout : null,
    sessionId: one(sp.session_id),
  };
  return <BillingPage caps={personalCaps} orgBillingSetUp={SITUATION_3844.orgBillingSetUp} personal={personal} />;
}
