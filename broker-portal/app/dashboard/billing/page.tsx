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
 *   5. BACKLOG-3878: a suspended brokerage member (organization page)
 *      -> /dashboard/account. The brokerage's bill is not theirs. A suspended
 *      personal owner IS shown the page: it is where they land.
 *   BACKLOG-3853 PR-2B: a suspended BROKERAGE (org_deals, not the licence) is
 *   NOT refused: Billing is where its broker, admin and IT admin land. The page
 *   shows the suspended banner and offers nothing to buy or manage.
 *
 * Each step runs before any billing data is read. BACKLOG-3847 reads the
 * personal owner's Agent plan (mirror row, support grant) and the Agent prices
 * AFTER step 4; account suspension stays with 3878, the organization's deal
 * with 3853/3855. BACKLOG-3848 reads blocks 4–6 (credits, card, contact,
 * receipts/invoices) for the personal owner only, also after step 4: an
 * organization page (broker, admin, it_admin) returns before any of it.
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
import { getPersonalBillingView } from '@/lib/billing/personalBilling';
import { createClient } from '@/lib/supabase/server';
import { suspendedForDispute } from '@/lib/billing/suspensionCause';
import type { OrgSuspensionReason } from '@/components/billing/OrgSuspendedBanner';

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

function stripeOrNull() {
  try {
    return getStripe();
  } catch (e) {
    console.error('[billing/page] Stripe unavailable:', (e as Error).message);
    return null;
  }
}

/** BACKLOG-3853 PR-2B: why the deal is suspended, or null when the read fails (the banner then says "contact Keepr"). */
async function orgSuspensionReason(organizationId: string): Promise<OrgSuspensionReason> {
  try {
    const { data, error } = await createServiceClient()
      .from('org_deals')
      .select('suspended_reason')
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (error) return null;
    const reason = (data as { suspended_reason?: string | null } | null)?.suspended_reason;
    return reason === 'non_payment' || reason === 'other' ? reason : null;
  } catch {
    return null;
  }
}

/** BACKLOG-3853: the brokerage's name for the prefilled support request; null when the read fails. */
async function orgName(organizationId: string): Promise<string | null> {
  try {
    const { data } = await createServiceClient().from('organizations').select('name').eq('id', organizationId).maybeSingle();
    return (data as { name?: string | null } | null)?.name ?? null;
  } catch {
    return null;
  }
}

export default async function BillingRoute({ searchParams }: { searchParams?: Promise<SearchParams> }) {
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
  if (caps.kind !== 'personal' && portal.suspended === true) redirect('/dashboard/account');
  if (caps.kind !== 'personal') {
    if (portal.orgSuspended === true && portal.access.kind === 'full') {
      // BACKLOG-3853 PR-2B: read after admission. The reason is service-side only.
      const orgCaps = billingCapabilities({
        access: portal.access,
        isImpersonating: false,
        enabled: true,
        ...SITUATION_3844,
        orgSuspended: true,
      });
      if (!orgCaps) notFound();
      const reason = await orgSuspensionReason(portal.access.organizationId);
      const organizationName = await orgName(portal.access.organizationId);
      return (
        <BillingPage
          caps={orgCaps}
          orgBillingSetUp={SITUATION_3844.orgBillingSetUp}
          orgSuspension={{ reason, role: portal.access.role, organizationName }}
        />
      );
    }
    return <BillingPage caps={caps} orgBillingSetUp={SITUATION_3844.orgBillingSetUp} />;
  }

  // BACKLOG-3847: the personal owner's Agent plan, read only now that the page is admitted.
  const service = createServiceClient();
  const mode = currentStripeMode();
  const view = await getAgentPlanView(service, portal.user.id, mode);
  const personalCaps = billingCapabilities({
    access: portal.access,
    isImpersonating: false,
    enabled: true,
    ...SITUATION_3844,
    agentPlan: view.state,
    renewalUnpaid: view.row?.status === 'unpaid',
    // BACKLOG-3878: the licence, as every personal action reads it.
    accountSuspended: view.suspended,
  });
  if (!personalCaps) notFound();
  const sp = (await searchParams) ?? {};
  const checkout = one(sp.checkout);
  // BACKLOG-3848 blocks 4–6: read only, never creates a Stripe customer; each source fails soft.
  const [prices, billing, disputeSuspension] = await Promise.all([
    agentPrices(),
    getPersonalBillingView({
      session: await createClient(),
      service,
      stripe: stripeOrNull(),
      userId: portal.user.id,
      signInEmail: portal.user.email ?? null,
      mode,
      view,
    }),
    view.suspended ? suspendedForDispute(service, portal.user.id) : Promise.resolve(false),
  ]);
  const personal: PersonalPlanData = {
    state: view.state,
    interval: view.row?.interval ?? null,
    currentPeriodEnd: view.row?.current_period_end ?? null,
    supportGrantEffective: view.supportGrantEffective,
    prices,
    checkout: checkout === 'success' || checkout === 'cancelled' ? checkout : null,
    sessionId: one(sp.session_id),
    paymentIncomplete: view.paymentIncomplete,
    billing,
    suspended: view.suspended,
    suspendedForDispute: disputeSuspension,
    card: one(sp.card) === 'updated' || one(sp.card) === 'cancelled' ? (one(sp.card) as 'updated' | 'cancelled') : null,
    canEndPlanNow: personalCaps.canEndPlanNow,
    renewalUnpaid: view.row?.status === 'unpaid',
    canUpdateCard: personalCaps.canUpdateCard,
  };
  return <BillingPage caps={personalCaps} orgBillingSetUp={SITUATION_3844.orgBillingSetUp} personal={personal} />;
}
