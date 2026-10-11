/**
 * stripe_customers access (BACKLOG-3845, RC9). The only module that reads or
 * writes stripe_customers: every query is keyed by (user_id, stripe_mode), the
 * table's primary key, so a user's test customer is never used in live mode and
 * a card-clear in one mode never touches the other.
 *
 * Also the mode guard (SR ruling req. 10): a test-mode deployment may create or
 * change Stripe objects only for users whose personal organization is is_test.
 * Callers run it before their first Stripe call.
 */

import * as Sentry from '@sentry/nextjs';
import type Stripe from 'stripe';
import type { createServiceClient } from '@/lib/supabase/service';
import type { StripeMode } from './mode';

type ServiceClient = ReturnType<typeof createServiceClient>;

export interface StripeCustomerRow {
  stripe_customer_id: string;
  default_payment_method_id: string | null;
}

/** The user's customer in this mode, or null. Throws on a read error. */
export async function getStripeCustomer(
  service: ServiceClient,
  userId: string,
  mode: StripeMode
): Promise<StripeCustomerRow | null> {
  const { data, error } = await service
    .from('stripe_customers')
    .select('stripe_customer_id, default_payment_method_id')
    .eq('user_id', userId)
    .eq('stripe_mode', mode)
    .maybeSingle();
  if (error) {
    throw new Error(`stripe_customers read failed: ${error.message}`);
  }
  return (data as StripeCustomerRow | null) ?? null;
}

/**
 * The user's Stripe customer id in this mode, creating the Stripe customer and
 * its stripe_customers row when there is none. A failed row insert is logged
 * and reported; on a concurrent insert (23505) the stored id wins.
 */
export async function ensureStripeCustomer(
  service: ServiceClient,
  stripe: Stripe,
  userId: string,
  email: string | null,
  mode: StripeMode
): Promise<string> {
  const existing = await getStripeCustomer(service, userId, mode);
  if (existing?.stripe_customer_id) return existing.stripe_customer_id;

  const customer = await stripe.customers.create({
    email: email ?? undefined,
    metadata: { user_id: userId },
  });
  const { error } = await service.from('stripe_customers').insert({
    user_id: userId,
    stripe_customer_id: customer.id,
    stripe_mode: mode,
  });
  if (error) {
    console.error('[billing/customers] stripe_customers insert failed:', error.code, error.message);
    Sentry.captureMessage('stripe_customers insert failed', {
      level: 'error',
      tags: { billing_stage: 'customer_insert', stripe_mode: mode },
      extra: { user_id: userId, stripe_customer_id: customer.id, code: error.code },
    });
    if (error.code === '23505') {
      const stored = await getStripeCustomer(service, userId, mode);
      if (stored?.stripe_customer_id) return stored.stripe_customer_id;
    }
  }
  return customer.id;
}

/** Forget the saved card of the user's customer in this mode only. */
export async function clearDefaultPaymentMethod(
  service: ServiceClient,
  userId: string,
  mode: StripeMode
): Promise<void> {
  const { error } = await service
    .from('stripe_customers')
    .update({ default_payment_method_id: null })
    .eq('user_id', userId)
    .eq('stripe_mode', mode);
  if (error) throw new Error(`stripe_customers card clear failed: ${error.message}`);
}

/** Store the saved card of the user's customer in this mode only. */
export async function setDefaultPaymentMethod(
  service: ServiceClient,
  userId: string,
  mode: StripeMode,
  paymentMethodId: string | null
): Promise<void> {
  const { error } = await service
    .from('stripe_customers')
    .update({ default_payment_method_id: paymentMethodId, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('stripe_mode', mode);
  if (error) throw new Error(`stripe_customers card update failed: ${error.message}`);
}

/**
 * Mode guard. Live: always allowed here (the grant RPC refuses live for is_test
 * users). Test: allowed only when the user's personal organization is is_test;
 * no personal organization, or a read error, refuses (fails closed).
 */
export async function isModeAllowedForUser(
  service: ServiceClient,
  userId: string,
  mode: StripeMode
): Promise<boolean> {
  if (mode === 'live') return true;
  const { data, error } = await service
    .from('organizations')
    .select('is_test')
    .eq('personal_owner_user_id', userId)
    .maybeSingle();
  if (error) {
    console.error('[billing/customers] is_test read failed:', error.message);
    return false;
  }
  return (data as { is_test?: boolean } | null)?.is_test === true;
}
