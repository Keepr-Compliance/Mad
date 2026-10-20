/**
 * The "Pay overdue invoice" link for a suspended brokerage — BACKLOG-3853.
 *
 * Same picker as the suspension email (./overdue.ts: overdueOf, oldest due date first, then
 * created; "now" is the test clock's time when the customer has one). Unlike the email, there is
 * no fallback to a non-overdue invoice: no overdue invoice means no button. Any failure also
 * means no button; the page never waits on or breaks for this.
 */

import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { listOpenInvoices, overdueOf, stripeNow } from './overdue';
import type { StripeMode } from './mode';

export async function oldestOverdueInvoiceUrl(deps: {
  service: SupabaseClient;
  stripe: Stripe;
  mode: StripeMode;
  organizationId: string;
}): Promise<string | null> {
  try {
    const { data, error } = await deps.service
      .from('org_billing_stripe')
      .select('stripe_customer_id')
      .eq('organization_id', deps.organizationId)
      .eq('stripe_mode', deps.mode)
      .maybeSingle();
    const customerId = error ? null : (data as { stripe_customer_id?: string | null } | null)?.stripe_customer_id;
    if (!customerId) return null;
    const now = await stripeNow({ stripe: deps.stripe }, customerId);
    const first = overdueOf(await listOpenInvoices({ stripe: deps.stripe }, customerId), now)[0];
    const url = first?.hosted_invoice_url ?? null;
    return url && url.startsWith('https://') ? url : null;
  } catch (e) {
    console.error('[billing/page] overdue invoice link unavailable:', (e as Error).message);
    return null;
  }
}
