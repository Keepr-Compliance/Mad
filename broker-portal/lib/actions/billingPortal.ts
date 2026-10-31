'use server';

/**
 * "Manage billing" on the brokerage Billing page — BACKLOG-3854 (plan-3855 §3, founder 546c9af1).
 *
 * Opens Stripe's customer portal for the brokerage: invoice history (view, download, pay) and the
 * payment method, nothing else (lib/billing/portalConfig.ts). Takes NO arguments: the form's data
 * is ignored, the organization is the session's own, and the Stripe customer is that
 * organization's row in the current mode.
 *
 * Order: impersonation refused -> who is calling (orgActionContext, real set-up) ->
 * caps.canSeeInvoices (Broker, Admin, billing-only login; never IT admin) -> the customer row ->
 * only then any Stripe call. Any failure -> back to Billing with ?portal=unavailable.
 * redirect() is called OUTSIDE the try/catch: it works by throwing, so a catch around it would turn
 * every success into "unavailable".
 */

import { redirect } from 'next/navigation';
import { blockWriteDuringImpersonation } from '@/lib/impersonation-guards';
import { orgActionContext } from '@/lib/billing/orgActionContext';
import { readOrgCustomerId } from '@/lib/billing/orgBillingSetUp';
import { ensurePortalConfiguration } from '@/lib/billing/portalConfig';
import { returnBase, BILLING_PATH } from '@/lib/billing/personalActionContext';
import { getStripe } from '@/lib/stripe';

const PORTAL_UNAVAILABLE_PATH = `${BILLING_PATH}?portal=unavailable`;

export async function openBrokerageBillingPortal(): Promise<void> {
  let url: string | null = null;
  try {
    const blocked = await blockWriteDuringImpersonation();
    if (!blocked) {
      const ctx = await orgActionContext();
      if (!('error' in ctx) && ctx.caps.canSeeInvoices) {
        const customer = await readOrgCustomerId(ctx.service, ctx.organizationId, ctx.mode);
        if (customer) {
          const stripe = getStripe();
          const configuration = await ensurePortalConfiguration(stripe, ctx.mode);
          // The configured app URL, or the request host only when it is one of the configured
          // ones (the same allow-list the Agent plan checkout uses).
          const base = await returnBase();
          const session = await stripe.billingPortal.sessions.create({
            customer,
            configuration,
            return_url: `${base}${BILLING_PATH}`,
          });
          if (typeof session.url === 'string' && session.url.startsWith('https://')) url = session.url;
        }
      }
    }
  } catch (e) {
    console.error('[billing/portal] session unavailable:', (e as Error).message);
    url = null;
  }
  redirect(url ?? PORTAL_UNAVAILABLE_PATH);
}
