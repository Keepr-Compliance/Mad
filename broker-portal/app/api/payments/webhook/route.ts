/**
 * Stripe webhook receiver (BACKLOG-2005a).
 *
 * Single authoritative fulfillment trigger = `payment_intent.succeeded`.
 * `checkout.session.completed` = payment-method save only (NO fulfillment) so a
 * first-unlock and a subsequent-unlock never double-count (R4).
 *
 * runtime=nodejs + req.text() for the RAW body BEFORE any parse: Stripe signature
 * verification needs the exact bytes.
 *
 * BACKLOG-3846: every handler takes only ids from the payload (whose shape
 * follows the endpoint's API version) and re-fetches the object with the pinned
 * client (E0). Agent subscription events are handled in lib/billing/sync.ts.
 *
 * BACKLOG-3853: brokerage subscription events (a customer stored in org_billing_stripe) are
 * handled first, by lib/billing/brokerage.ts, and never reach the switch below. Only the
 * subscription / invoice / refund / dispute event types are checked there.
 */

import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import * as Sentry from '@sentry/nextjs';
import { getStripe } from '@/lib/stripe';
import { currentStripeMode, eventStripeMode } from '@/lib/billing/mode';
import { setDefaultPaymentMethod } from '@/lib/billing/customers';
import { createServiceClient } from '@/lib/supabase/service';
import {
  type BillingContext,
  handleInvoiceChargeRefunded,
  handleInvoiceDispute,
  handleInvoicePaid,
  handleInvoicePaymentFailed,
  handleSubscriptionCheckout,
  handleSubscriptionEvent,
  stripeId,
} from '@/lib/billing/sync';
import {
  fulfillPaidUnlock,
  recordRefund,
  emitPaymentSucceeded,
} from '@/lib/payments/fulfillment';
import { applyCardUpdate } from '@/lib/billing/cardUpdate';
import { dispatchBrokerageEvent } from '@/lib/billing/brokerage';

export const runtime = 'nodejs';
// Never cache; each webhook is a unique event.
export const dynamic = 'force-dynamic';

interface UnlockMetadata {
  user_id?: string;
  local_transaction_id?: string;
  pricing_tier_id?: string;
  quoted_unit_price_cents?: string;
}

export async function POST(req: Request): Promise<Response> {
  const signature = req.headers.get('stripe-signature');
  const webhookSecret = process.env.STRIPE_WEBHOOK_SIGNING_SECRET;

  if (!webhookSecret) {
    console.error('[payments/webhook] STRIPE_WEBHOOK_SIGNING_SECRET not configured');
    return NextResponse.json({ error: 'not configured' }, { status: 500 });
  }
  if (!signature) {
    return NextResponse.json({ error: 'missing signature' }, { status: 400 });
  }

  // RAW body first — do NOT req.json().
  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    // Signature verification failed -> tampered/invalid. No ledger write.
    console.error('[payments/webhook] signature verification failed:', (err as Error).message);
    return NextResponse.json({ error: 'invalid signature' }, { status: 400 });
  }

  // BACKLOG-3845 (plan v3.2 E0): an event from the other Stripe mode is not
  // processed. 200 so Stripe stops retrying; reported so a misrouted endpoint is seen.
  const keyMode = currentStripeMode();
  if (eventStripeMode(event) !== keyMode) {
    console.error(
      `[payments/webhook] ${event.type} ${event.id} livemode=${event.livemode} does not match key mode ${keyMode}; ignored`
    );
    Sentry.captureMessage('Stripe webhook event mode does not match key mode', {
      level: 'warning',
      tags: { billing_stage: 'webhook_mode', stripe_mode: keyMode },
      extra: { event_id: event.id, event_type: event.type, livemode: event.livemode },
    });
    return NextResponse.json({ received: true, ignored: 'mode_mismatch' }, { status: 200 });
  }

  const service = createServiceClient();
  const ctx: BillingContext = { service, stripe: getStripe(), mode: keyMode, event };
  // E0: the payload contributes only the object id.
  const objectId = (event.data.object as { id: string }).id;

  try {
    // BACKLOG-3853: a brokerage event is handled here and skips the Agent / per-export path.
    if (await dispatchBrokerageEvent(ctx, objectId)) {
      return NextResponse.json({ received: true }, { status: 200 });
    }
    switch (event.type) {
      case 'payment_intent.succeeded':
        await handlePaymentIntentSucceeded(ctx, objectId);
        break;
      case 'checkout.session.completed':
        await handleCheckoutSessionCompleted(ctx, objectId);
        break;
      case 'payment_intent.payment_failed':
        await handlePaymentFailed(service, event);
        break;
      case 'charge.refunded':
        await handleChargeRefunded(ctx, objectId);
        break;
      case 'refund.created':
        await handleRefundCreated(ctx, objectId);
        break;
      case 'charge.dispute.created':
        await handleDispute(ctx, objectId);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await handleSubscriptionEvent(ctx, objectId);
        break;
      case 'invoice.paid':
        await handleInvoicePaid(ctx, objectId);
        break;
      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(ctx, objectId);
        break;
      default:
        // Acknowledge unrelated events so Stripe stops retrying.
        break;
    }
  } catch (err) {
    // Return non-2xx so Stripe RETRIES (and the reconciliation sweep is a backstop).
    // Keep detail in server logs only (CodeQL: js/stack-trace-exposure).
    console.error(`[payments/webhook] handler error for ${event.type}:`, (err as Error).message);
    return NextResponse.json({ error: 'handler error' }, { status: 500 });
  }

  return NextResponse.json({ received: true }, { status: 200 });
}

/** AUTHORITATIVE fulfillment. */
async function handlePaymentIntentSucceeded(ctx: BillingContext, piId: string): Promise<void> {
  const { service, event } = ctx;
  const pi = await ctx.stripe.paymentIntents.retrieve(piId);
  // W-2: a subscription invoice's PaymentIntent never unlocks a transaction and
  // never touches payment_intents; invoice.paid owns it.
  if (stripeId(pi.invoice)) {
    console.info(`[payments/webhook] payment_intent.succeeded ${pi.id} belongs to an invoice; ignored`);
    return;
  }
  const md = (pi.metadata ?? {}) as UnlockMetadata;

  if (!md.user_id || !md.local_transaction_id) {
    // C-A: metadata MUST ride the PI (payment_intent_data.metadata for Checkout).
    // If it is absent we cannot know which tx to unlock — log and 200 (retrying
    // will not help); the reconciliation sweep uses the stored payment_intents row.
    console.error(
      `[payments/webhook] payment_intent.succeeded ${pi.id} missing unlock metadata; ` +
        `reconciliation sweep will resolve via stored payment_intents row`
    );
    // Still advance the intent to 'succeeded' so the sweep can pick it up.
    await service
      .from('payment_intents')
      .update({ status: 'succeeded', webhook_event_id: event.id, updated_at: new Date().toISOString() })
      .eq('stripe_payment_intent_id', pi.id)
      .in('status', ['created', 'requires_action']);
    return;
  }

  const unitPriceCents = md.quoted_unit_price_cents
    ? parseInt(md.quoted_unit_price_cents, 10)
    : pi.amount;

  const result = await fulfillPaidUnlock(service, {
    userId: md.user_id,
    localTransactionId: md.local_transaction_id,
    unitPriceCents,
    pricingTierId: md.pricing_tier_id ?? null,
    stripePaymentIntentId: pi.id,
    stripeCheckoutSessionId: null,
    webhookEventId: event.id,
  });

  await service
    .from('payment_intents')
    .update({ status: 'fulfilled', webhook_event_id: event.id, updated_at: new Date().toISOString() })
    .eq('stripe_payment_intent_id', pi.id);

  // Emit the funnel event only on a NEW fulfillment (not a replay/short-circuit).
  // No Keepr receipt: Stripe emails the receipt for the solo launch (founder
  // 2026-10-13, BACKLOG-3648/3848), so Keepr's own one is switched off.
  if (result.unlocked && !result.alreadyFulfilled) {
    await emitPaymentSucceeded(service, md.user_id, {
      local_transaction_id: md.local_transaction_id,
      unit_price_cents: unitPriceCents,
      pricing_tier_id: md.pricing_tier_id ?? null,
      stripe_payment_intent_id: pi.id,
    });
  }
}

/** PM-save only. Does NOT fulfill (R4). */
async function handleCheckoutSessionCompleted(ctx: BillingContext, sessionId: string): Promise<void> {
  const { service, event } = ctx;
  const session = await ctx.stripe.checkout.sessions.retrieve(sessionId);
  // W-1: a subscription Checkout has no PaymentIntent. It must not touch the
  // saved per-export card or payment_intents; it only mirrors the subscription.
  if (session.mode === 'subscription') {
    await handleSubscriptionCheckout(ctx, session);
    return;
  }
  // BACKLOG-3848 (SR R1): EVERY setup-mode session ends here, whatever its
  // metadata. A setup session has no PaymentIntent, so the per-export card save
  // below would store null. applyCardUpdate() acts only on an Update-card
  // session and refuses (logs, no write) anything else. A card decline while
  // paying the failed renewal is an outcome, not a throw: this answers 200.
  if (session.mode === 'setup') {
    const out = await applyCardUpdate(ctx, session.id, { onPayError: 'throw' });
    console.info(`[payments/webhook] setup session ${session.id}: ${out.kind === 'updated' ? `card updated, payment ${out.pay.kind}` : `ignored (${out.reason})`}`);
    return;
  }
  const md = (session.metadata ?? {}) as UnlockMetadata;
  const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
  const piId =
    typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent?.id;

  // Save the default payment method for future off-session charges (Flow B).
  if (customerId && md.user_id) {
    let pmId: string | null = null;
    if (piId) {
      const pi = await ctx.stripe.paymentIntents.retrieve(piId);
      pmId = typeof pi.payment_method === 'string' ? pi.payment_method : pi.payment_method?.id ?? null;
    }
    // The event's mode row only (RC9); the mode check in POST guarantees it is the key's mode.
    await setDefaultPaymentMethod(service, md.user_id, eventStripeMode(event), pmId);
  }

  // Advance the intent (fulfillment still happens on payment_intent.succeeded).
  if (session.id) {
    await service
      .from('payment_intents')
      .update({ status: 'succeeded', updated_at: new Date().toISOString() })
      .eq('stripe_checkout_session_id', session.id)
      .in('status', ['created', 'requires_action']);
  }
}

async function handlePaymentFailed(
  service: ReturnType<typeof createServiceClient>,
  event: Stripe.Event
): Promise<void> {
  const pi = event.data.object as Stripe.PaymentIntent;
  await service
    .from('payment_intents')
    .update({ status: 'failed', webhook_event_id: event.id, updated_at: new Date().toISOString() })
    .eq('stripe_payment_intent_id', pi.id)
    .not('status', 'eq', 'fulfilled');
}

/**
 * charge.refunded. An invoice charge is an Agent subscription payment
 * (lib/billing/sync.ts); any other charge keeps the per-export path.
 */
async function handleChargeRefunded(ctx: BillingContext, chargeId: string): Promise<void> {
  const charge = await ctx.stripe.charges.retrieve(chargeId, { expand: ['invoice'] });
  if (charge.invoice) {
    await handleInvoiceChargeRefunded(ctx, charge, charge.invoice);
    return;
  }
  await recordPerExportRefund(ctx, stripeId(charge.payment_intent));
}

/**
 * refund.created. A Refund carries no invoice, so it only feeds the per-export
 * path, which acts only when the PaymentIntent has a payment_intents row.
 */
async function handleRefundCreated(ctx: BillingContext, refundId: string): Promise<void> {
  const refund = await ctx.stripe.refunds.retrieve(refundId);
  await recordPerExportRefund(ctx, stripeId(refund.payment_intent));
}

async function recordPerExportRefund(ctx: BillingContext, piId: string | null): Promise<void> {
  if (!piId) return;
  const { service, event } = ctx;

  // Resolve tx identity from the STORED payment_intents row (C-C), not Stripe metadata.
  const { data: row } = await service
    .from('payment_intents')
    .select('user_id, local_transaction_id')
    .eq('stripe_payment_intent_id', piId)
    .maybeSingle();
  if (!row) return;

  await recordRefund(service, row.user_id, row.local_transaction_id, {
    webhook_event_id: event.id,
    stripe_payment_intent_id: piId,
  });
}

async function handleDispute(ctx: BillingContext, disputeId: string): Promise<void> {
  const { service } = ctx;
  // BACKLOG-2077 (founder 2026-07-16): a chargeback suspends the WHOLE account,
  // not just the disputed deal. Resolve the user from the STORED payment_intents
  // row (like handleRefund, C-C) -- never trust dispute metadata -- then flip
  // licenses.status -> 'suspended' via the service-role RPC, which records the
  // reason (tx, amount, dispute id, date) and audits the action. The desktop app
  // enforces the block off licenses.status (blockReason='suspended').
  //
  // Dispute WON/LOST auto-lift is OUT for v1: support reinstates manually.
  const dispute = await ctx.stripe.disputes.retrieve(disputeId);
  const piId = stripeId(dispute.payment_intent);
  console.error(`[payments/webhook] chargeback opened for PI ${piId} (dispute ${dispute.id})`);

  if (!piId) {
    // No PI on the dispute -> we cannot attribute it to a user. Log + 200.
    console.error(`[payments/webhook] dispute ${dispute.id} has no payment_intent; cannot suspend`);
    return;
  }

  // Resolve tx identity from the stored payment_intents row (not Stripe metadata).
  const { data: row, error: lookupError } = await service
    .from('payment_intents')
    .select('user_id, local_transaction_id')
    .eq('stripe_payment_intent_id', piId)
    .maybeSingle();

  // A transient DB/PostgREST failure is NOT "no row". If we swallowed it we would
  // log a misleading "no payment_intents row", return 200, Stripe would stop
  // retrying, and the suspension would be permanently and silently dropped (there
  // is no reconciliation-sweep backstop for suspensions). THROW so the outer catch
  // returns non-2xx and Stripe RETRIES (the suspend RPC is idempotent per dispute
  // id, so retries are safe). Mirrors the RPC leg's throw-for-retry invariant.
  if (lookupError) {
    throw new Error(
      `dispute ${dispute.id}: payment_intents lookup failed for PI ${piId}: ${lookupError.message}`
    );
  }

  if (!row) {
    // BACKLOG-3846 (plan v3 R4): no per-export row. An Agent subscription
    // invoice's PaymentIntent carries the invoice; that path suspends the
    // stored Agent user and revokes.
    const pi = await ctx.stripe.paymentIntents.retrieve(piId, { expand: ['invoice'] });
    const invoice = pi.invoice && typeof pi.invoice !== 'string' ? pi.invoice : null;
    if (invoice) {
      await handleInvoiceDispute(ctx, dispute, piId, invoice);
      return;
    }
    // Genuinely no matching row and no invoice. Retrying will not help, so take
    // the benign log-and-200 path.
    console.error(
      `[payments/webhook] dispute ${dispute.id}: no payment_intents row and no invoice for PI ${piId}; nothing to suspend`
    );
    return;
  }

  const { error } = await service.rpc('suspend_account_for_dispute', {
    p_user_id: row.user_id,
    p_stripe_dispute_id: dispute.id,
    p_payment_intent_id: piId,
    p_local_transaction_id: row.local_transaction_id,
    p_amount_cents: dispute.amount ?? null,
    p_dispute_created_at: dispute.created
      ? new Date(dispute.created * 1000).toISOString()
      : null,
  });
  // Throw so the outer catch returns non-2xx and Stripe RETRIES (a suspension we
  // failed to write must not be silently dropped on a money/access path).
  if (error) {
    throw new Error(`suspend_account_for_dispute failed: ${error.message}`);
  }
}
