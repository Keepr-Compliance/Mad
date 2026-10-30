/**
 * The Stripe customer portal configuration brokerages use — BACKLOG-3854 (plan-3855 §3, founder
 * 546c9af1, SR 6bada226 change 9).
 *
 * Keepr owns it (metadata.keepr = 'brokerage-portal-v1'); the account default is never used, since
 * anyone with dashboard access can edit that. It allows the invoice history (view, download, pay)
 * and saving a payment method, and nothing else: no plan or quantity change, no cancel, no pause,
 * no customer details edit (the billing contact stays Keepr's, 4007), and no Stripe-hosted login
 * page (a link that lets anyone with the customer's email in, past Keepr's own gate).
 *
 * Every use asserts all of that, plus active and the mode; any mismatch throws and no session is
 * made. Creation passes an idempotency key per mode, so two first clicks at once make one
 * configuration; if two exist anyway, the oldest is used and the duplicate is logged.
 */

import type Stripe from 'stripe';
import type { StripeMode } from './mode';

export const PORTAL_CONFIG_TAG = 'brokerage-portal-v1';

export function portalConfigCreateParams(): Stripe.BillingPortal.ConfigurationCreateParams {
  return {
    business_profile: { headline: 'Your Keepr invoices and payment method' },
    features: {
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_update: { enabled: false },
      subscription_cancel: { enabled: false },
      customer_update: { enabled: false },
    },
    login_page: { enabled: false },
    metadata: { keepr: PORTAL_CONFIG_TAG },
  };
}

/** Throws unless the configuration allows exactly invoice history + payment method update. */
export function assertPortalConfiguration(c: Stripe.BillingPortal.Configuration, mode: StripeMode): void {
  const f = c.features as unknown as Record<string, { enabled?: boolean } | undefined>;
  const problems: string[] = [];
  if (c.active !== true) problems.push('active');
  if (c.livemode !== (mode === 'live')) problems.push('livemode');
  if (f.invoice_history?.enabled !== true) problems.push('invoice_history');
  if (f.payment_method_update?.enabled !== true) problems.push('payment_method_update');
  if (f.subscription_update?.enabled !== false) problems.push('subscription_update');
  if (f.subscription_cancel?.enabled !== false) problems.push('subscription_cancel');
  // Present at API 2025-02-24.acacia (TEST spike 2026-10-21); absent counts as off.
  if (f.subscription_pause !== undefined && f.subscription_pause?.enabled !== false) problems.push('subscription_pause');
  if (f.customer_update?.enabled !== false) problems.push('customer_update');
  if (c.login_page?.enabled !== false) problems.push('login_page');
  if (problems.length > 0) throw new Error(`portal configuration not allowed: ${problems.join(', ')}`);
}

/** The id of the asserted Keepr configuration for this mode, created on first use. */
export async function ensurePortalConfiguration(stripe: Stripe, mode: StripeMode): Promise<string> {
  const ours: Stripe.BillingPortal.Configuration[] = [];
  let startingAfter: string | undefined;
  for (;;) {
    const page = await stripe.billingPortal.configurations.list({ active: true, limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) });
    for (const c of page.data) if (c.metadata?.keepr === PORTAL_CONFIG_TAG) ours.push(c);
    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1].id;
  }
  let config: Stripe.BillingPortal.Configuration;
  if (ours.length === 0) {
    config = await stripe.billingPortal.configurations.create(portalConfigCreateParams(), {
      idempotencyKey: `brokerage:portal-config:${mode}:v1`,
    });
  } else {
    if (ours.length > 1) console.error(`[billing/portal] ${ours.length} Keepr portal configurations; using the oldest`);
    config = [...ours].sort((a, b) => a.created - b.created)[0];
  }
  assertPortalConfiguration(config, mode);
  return config.id;
}
