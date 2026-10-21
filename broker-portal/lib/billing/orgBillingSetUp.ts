/**
 * Whether a brokerage's billing is set up — BACKLOG-3854 (plan-3855 §2).
 *
 * Set up = an org_deals row whose status is not 'draft' AND an org_billing_stripe row with a
 * Stripe customer in the current Stripe mode. Read with the SERVICE client (both tables are
 * service_role only), after the page or action has admitted the person. Fails closed: any read
 * error -> false (no money block, no Stripe call).
 *
 * Not read: brokerage_billing_live. While that switch is off, _billing_save_deal refuses live
 * deals, so with the live key there is no non-draft live deal and this is false.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { StripeMode } from './mode';

export async function readOrgBillingSetUp(service: SupabaseClient, organizationId: string, mode: StripeMode): Promise<boolean> {
  try {
    const [deal, stripe] = await Promise.all([
      service.from('org_deals').select('status').eq('organization_id', organizationId).maybeSingle(),
      service
        .from('org_billing_stripe')
        .select('stripe_customer_id')
        .eq('organization_id', organizationId)
        .eq('stripe_mode', mode)
        .maybeSingle(),
    ]);
    if (deal.error || stripe.error) return false;
    const status = (deal.data as { status?: string | null } | null)?.status ?? null;
    const customer = (stripe.data as { stripe_customer_id?: string | null } | null)?.stripe_customer_id ?? null;
    return !!status && status !== 'draft' && !!customer;
  } catch {
    return false;
  }
}

/** The brokerage's Stripe customer in this mode, or null. Service client; the org id is the caller's own. */
export async function readOrgCustomerId(service: SupabaseClient, organizationId: string, mode: StripeMode): Promise<string | null> {
  const { data, error } = await service
    .from('org_billing_stripe')
    .select('stripe_customer_id')
    .eq('organization_id', organizationId)
    .eq('stripe_mode', mode)
    .maybeSingle();
  if (error) throw new Error(`org_billing_stripe read failed: ${error.code ?? 'unknown'}`);
  return (data as { stripe_customer_id?: string | null } | null)?.stripe_customer_id ?? null;
}
