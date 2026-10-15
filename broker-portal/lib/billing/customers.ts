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
 * The user whose stored customer row in this mode is `customerId`, or null.
 * BACKLOG-3846: an Agent subscription is one whose Stripe customer has a
 * stripe_customers row; the user comes from that row, never from Stripe
 * metadata. Throws on a read error (the webhook retries).
 */
export async function getUserByStripeCustomer(
  service: ServiceClient,
  customerId: string,
  mode: StripeMode
): Promise<string | null> {
  const { data, error } = await service
    .from('stripe_customers')
    .select('user_id')
    .eq('stripe_customer_id', customerId)
    .eq('stripe_mode', mode)
    .maybeSingle();
  if (error) {
    throw new Error(`stripe_customers read by customer failed: ${error.message}`);
  }
  return (data as { user_id?: string } | null)?.user_id ?? null;
}

export interface PersonalOrganization {
  id: string;
  isTest: boolean;
}

/**
 * The user's personal organization, or null. Throws on a read error, so a
 * webhook retries instead of reading a transient failure as "not allowed".
 */
export async function getPersonalOrganization(
  service: ServiceClient,
  userId: string
): Promise<PersonalOrganization | null> {
  const { data, error } = await service
    .from('organizations')
    .select('id, is_test')
    .eq('personal_owner_user_id', userId)
    .maybeSingle();
  if (error) throw new Error(`personal organization read failed: ${error.message}`);
  const row = data as { id?: string; is_test?: boolean | null } | null;
  return row?.id ? { id: row.id, isTest: row.is_test === true } : null;
}

/** The mode-guard rule of isModeAllowedForUser, on an is_test flag already read (no personal org = false). */
export function modeAllowsTestFlag(mode: StripeMode, isTest: boolean): boolean {
  return mode === 'live' ? !isTest : isTest;
}

/**
 * Mode guard (plan 2.6). Live: refused when the user's personal organization is
 * is_test; no personal organization, or is_test false/null, stays allowed.
 * Test: allowed only when the personal organization is is_test; no personal
 * organization refuses. A read error refuses in both modes (fails closed).
 */
export async function isModeAllowedForUser(
  service: ServiceClient,
  userId: string,
  mode: StripeMode
): Promise<boolean> {
  const { data, error } = await service
    .from('organizations')
    .select('is_test')
    .eq('personal_owner_user_id', userId)
    .maybeSingle();
  if (error) {
    console.error('[billing/customers] is_test read failed:', error.message);
    return false;
  }
  const isTest = (data as { is_test?: boolean } | null)?.is_test === true;
  return modeAllowsTestFlag(mode, isTest);
}
