/**
 * Update card — BACKLOG-3848.
 *
 * The person enters a card on a Stripe-hosted Checkout page in `setup` mode
 * (SR Q1: chosen over the Billing Portal, whose writes are untraced). When
 * that session completes, applyCardUpdate() runs from two places: the webhook
 * (checkout.session.completed) and the page the person comes back to
 * (confirm-on-return). Either may run first; both are safe to run twice.
 *
 * SR R2 (ownership and E0):
 *   - the session is re-fetched; it must be `setup`, `complete` and of kind
 *     agent_card_update;
 *   - the user is the stored stripe_customers row of the session's customer in
 *     this mode (getUserByStripeCustomer), never metadata; on the return page
 *     that user must also be the caller;
 *   - the SetupIntent is re-fetched: `succeeded` and the SAME customer; the
 *     card is read from the SetupIntent only.
 * Writes, in order, each skipped when it already holds the card: the customer's
 * default (invoice_settings), the caller's Agent subscription in this mode
 * (not canceled), the stored per-export card (stripe_customers). One card per
 * customer per mode: this also replaces the card used for per-export purchases.
 *
 * SR R3 (paying the failed renewal):
 *   (a) decided on a FRESH subscriptions.retrieve, never the mirror: `past_due`,
 *       not paused, and the account not suspended (licences);
 *   (b) only the subscription's latest invoice, when it is `open`, belongs to
 *       this subscription and customer, and its subscription line pays the
 *       current period (the BACKLOG-3846 grant rule — a payment that would not
 *       turn Unlimited back on is never taken);
 *   (c) the card is passed explicitly, idempotency key
 *       `card-update-pay:<invoice>:<card>`;
 *   (d) any pay error re-fetches the invoice first: `paid` is success (covers
 *       "Invoice is already paid" and a concurrent caller);
 *   (e) a card error (declined, or the bank wants confirmation) is an outcome,
 *       never a throw: the webhook answers 200, or Stripe would redeliver for
 *       three days and try the card each time;
 *   (f) `unpaid` is not paid (untraced in TEST). After a payment, a
 *       subscription that is not active raises an alert.
 * Not enforced here (SR R7): Stripe's own retry schedule can still charge the
 * open invoice against the new default card while an account is suspended;
 * BACKLOG-3878's pause_collection is what stops that.
 */

import type Stripe from 'stripe';
import type { createServiceClient } from '@/lib/supabase/service';
import type { StripeMode } from './mode';
import { billingAlert } from './alert';
import { getAgentPlanView } from './agentPlan';
import { getPersonalOrganization, getStripeCustomer, getUserByStripeCustomer, modeAllowsTestFlag, setDefaultPaymentMethod } from './customers';
import { stripeId, subscriptionLine } from './sync';

type ServiceClient = ReturnType<typeof createServiceClient>;

export const CARD_UPDATE_KIND = 'agent_card_update';

export type PayOutcome =
  | { kind: 'none' }
  | { kind: 'paid' }
  | { kind: 'declined' }
  | { kind: 'action_required'; invoiceUrl: string | null }
  | { kind: 'not_paid'; reason: 'unpaid' | 'suspended' | 'paused' | 'pending' };

export type CardUpdateOutcome =
  | { kind: 'refused'; reason: string }
  | { kind: 'updated'; paymentMethodId: string; pay: PayOutcome };

export interface CardUpdateContext {
  service: ServiceClient;
  stripe: Stripe;
  mode: StripeMode;
}

function isPaused(sub: Stripe.Subscription): boolean {
  return sub.pause_collection !== null && sub.pause_collection !== undefined;
}

function refused(reason: string): CardUpdateOutcome {
  console.warn(`[billing/card-update] refused: ${reason}`);
  return { kind: 'refused', reason };
}

/**
 * Pay the failed renewal with the new card, when SR R3's rules allow it.
 * `onError: 'throw'` (webhook): a non-card error is rethrown so Stripe retries.
 * `onError: 'report'` (return page): it reads as "pending".
 */
export async function payAfterCardUpdate(
  ctx: CardUpdateContext,
  args: { subscriptionId: string; customerId: string; paymentMethodId: string; suspended: boolean; onError: 'throw' | 'report' }
): Promise<PayOutcome> {
  const { stripe } = ctx;
  const sub = await stripe.subscriptions.retrieve(args.subscriptionId);
  if (sub.status === 'unpaid') return { kind: 'not_paid', reason: 'unpaid' };
  if (sub.status !== 'past_due') return { kind: 'none' };
  if (isPaused(sub)) return { kind: 'not_paid', reason: 'paused' };
  if (args.suspended) return { kind: 'not_paid', reason: 'suspended' };

  const invoiceId = stripeId(sub.latest_invoice);
  if (!invoiceId) return { kind: 'none' };
  const inv = await stripe.invoices.retrieve(invoiceId);
  const line = subscriptionLine(inv);
  if (
    inv.status !== 'open' ||
    stripeId(inv.subscription) !== sub.id ||
    stripeId(inv.customer) !== args.customerId ||
    !line ||
    line.period.end < sub.current_period_end
  ) {
    console.info(`[billing/card-update] latest invoice ${inv.id} of ${sub.id} is not payable here; no payment`);
    return { kind: 'none' };
  }

  try {
    await stripe.invoices.pay(
      inv.id,
      { payment_method: args.paymentMethodId },
      { idempotencyKey: `card-update-pay:${inv.id}:${args.paymentMethodId}` }
    );
  } catch (err) {
    const now = await stripe.invoices.retrieve(inv.id);
    if (now.status !== 'paid') {
      const e = err as { type?: string; code?: string };
      if (e.type === 'StripeCardError') {
        if (e.code === 'invoice_payment_intent_requires_action' || e.code === 'authentication_required') {
          return { kind: 'action_required', invoiceUrl: now.hosted_invoice_url ?? null };
        }
        return { kind: 'declined' };
      }
      if (args.onError === 'throw') throw err;
      console.error(`[billing/card-update] pay of ${inv.id} failed: ${e.type ?? 'error'}`);
      return { kind: 'not_paid', reason: 'pending' };
    }
  }

  const after = await stripe.subscriptions.retrieve(sub.id);
  if (after.status !== 'active' && after.status !== 'trialing') {
    billingAlert('card_update_pay_not_active', ctx.mode, { subscription_id: sub.id, invoice_id: inv.id, status: after.status });
  }
  return { kind: 'paid' };
}

/**
 * Apply a completed setup-mode Checkout session. `callerUserId` is set on the
 * return page (the session must belong to the caller) and absent in the webhook.
 */
export async function applyCardUpdate(
  ctx: CardUpdateContext,
  sessionId: string,
  opts: { callerUserId?: string; onPayError: 'throw' | 'report' }
): Promise<CardUpdateOutcome> {
  const { stripe, service, mode } = ctx;
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.mode !== 'setup') return refused('not_setup_mode');
  if (session.metadata?.kind !== CARD_UPDATE_KIND) return refused('not_card_update');
  if (session.status !== 'complete') return refused('not_complete');

  const customerId = stripeId(session.customer);
  if (!customerId) return refused('no_customer');
  const userId = await getUserByStripeCustomer(service, customerId, mode);
  if (!userId) return refused('unknown_customer');
  if (opts.callerUserId !== undefined && opts.callerUserId !== userId) return refused('not_caller');
  const org = await getPersonalOrganization(service, userId);
  if (!modeAllowsTestFlag(mode, org?.isTest === true)) return refused('mode_not_allowed');

  const siId = stripeId(session.setup_intent);
  if (!siId) return refused('no_setup_intent');
  const si = await stripe.setupIntents.retrieve(siId);
  if (si.status !== 'succeeded') return refused('setup_not_succeeded');
  if (stripeId(si.customer) !== customerId) return refused('setup_other_customer');
  const pm = stripeId(si.payment_method);
  if (!pm) return refused('no_payment_method');

  // 1. The customer's default (renewals and future invoices).
  const customer = await stripe.customers.retrieve(customerId);
  const current =
    customer && !('deleted' in customer && customer.deleted)
      ? stripeId((customer as Stripe.Customer).invoice_settings?.default_payment_method as string | Stripe.PaymentMethod | null)
      : null;
  if (current !== pm) {
    await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: pm } });
  }

  // 2. The user's own Agent subscription in this mode (the mirror's row; never canceled).
  const view = await getAgentPlanView(service, userId, mode);
  const subId = view.row?.stripe_subscription_id ?? null;
  if (subId) {
    const sub = await stripe.subscriptions.retrieve(subId);
    if (stripeId(sub.customer) === customerId && sub.status !== 'canceled' && stripeId(sub.default_payment_method) !== pm) {
      await stripe.subscriptions.update(subId, { default_payment_method: pm });
    }
  }

  // 3. The stored card (per-export purchases).
  const row = await getStripeCustomer(service, userId, mode);
  if (row && row.default_payment_method_id !== pm) {
    await setDefaultPaymentMethod(service, userId, mode, pm);
  }

  const pay: PayOutcome = subId
    ? await payAfterCardUpdate(ctx, {
        subscriptionId: subId,
        customerId,
        paymentMethodId: pm,
        suspended: view.suspended,
        onError: opts.onPayError,
      })
    : { kind: 'none' };
  console.info(`[billing/card-update] card updated for customer ${customerId}; payment: ${pay.kind}`);
  return { kind: 'updated', paymentMethodId: pm, pay };
}
