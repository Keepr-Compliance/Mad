/**
 * Stripe webhook receiver (BACKLOG-2005a).
 *
 * Single authoritative fulfillment trigger = `payment_intent.succeeded`.
 * `checkout.session.completed` = payment-method save only (NO fulfillment) so a
 * first-unlock and a subsequent-unlock never double-count (R4).
 *
 * runtime=nodejs + req.text() for the RAW body BEFORE any parse: Stripe signature
 * verification needs the exact bytes.
 */

import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { getStripe } from '@/lib/stripe';
import { createServiceClient } from '@/lib/supabase/service';
import {
  fulfillPaidUnlock,
  recordRefund,
  emitPaymentSucceeded,
} from '@/lib/payments/fulfillment';
import { dispatchReceiptEmail } from '@/lib/payments/receipt';

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

  const service = createServiceClient();

  try {
    switch (event.type) {
      case 'payment_intent.succeeded':
        await handlePaymentIntentSucceeded(service, event);
        break;
      case 'checkout.session.completed':
        await handleCheckoutSessionCompleted(service, event);
        break;
      case 'payment_intent.payment_failed':
        await handlePaymentFailed(service, event);
        break;
      case 'charge.refunded':
      case 'refund.created':
        await handleRefund(service, event);
        break;
      case 'charge.dispute.created':
        await handleDispute(service, event);
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
async function handlePaymentIntentSucceeded(
  service: ReturnType<typeof createServiceClient>,
  event: Stripe.Event
): Promise<void> {
  const pi = event.data.object as Stripe.PaymentIntent;
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

  // Emit the funnel event + send a receipt only on a NEW fulfillment (not a
  // replay/short-circuit). Receipt dispatch is non-blocking (BACKLOG-2009).
  if (result.unlocked && !result.alreadyFulfilled) {
    await emitPaymentSucceeded(service, md.user_id, {
      local_transaction_id: md.local_transaction_id,
      unit_price_cents: unitPriceCents,
      pricing_tier_id: md.pricing_tier_id ?? null,
      stripe_payment_intent_id: pi.id,
    });
    await dispatchReceiptEmail(service, {
      userId: md.user_id,
      amountCents: unitPriceCents,
      stripePaymentIntentId: pi.id,
    });
  }
}

/** PM-save only. Does NOT fulfill (R4). */
async function handleCheckoutSessionCompleted(
  service: ReturnType<typeof createServiceClient>,
  event: Stripe.Event
): Promise<void> {
  const session = event.data.object as Stripe.Checkout.Session;
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
      const pi = await getStripe().paymentIntents.retrieve(piId);
      pmId = typeof pi.payment_method === 'string' ? pi.payment_method : pi.payment_method?.id ?? null;
    }
    await service
      .from('stripe_customers')
      .update({ default_payment_method_id: pmId, updated_at: new Date().toISOString() })
      .eq('user_id', md.user_id);
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

async function handleRefund(
  service: ReturnType<typeof createServiceClient>,
  event: Stripe.Event
): Promise<void> {
  // charge.refunded carries a Charge; refund.created carries a Refund. Resolve the PI.
  const obj = event.data.object as Stripe.Charge | Stripe.Refund;
  const piId =
    typeof (obj as Stripe.Charge).payment_intent === 'string'
      ? ((obj as Stripe.Charge).payment_intent as string)
      : typeof (obj as Stripe.Refund).payment_intent === 'string'
        ? ((obj as Stripe.Refund).payment_intent as string)
        : null;
  if (!piId) return;

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

async function handleDispute(
  service: ReturnType<typeof createServiceClient>,
  event: Stripe.Event
): Promise<void> {
  // v1 minimum (founder D5): Sentry-alertable log + mark the intent. Full dunning deferred.
  const dispute = event.data.object as Stripe.Dispute;
  const piId = typeof dispute.payment_intent === 'string' ? dispute.payment_intent : null;
  console.error(`[payments/webhook] chargeback opened for PI ${piId} (dispute ${dispute.id})`);
  if (piId) {
    await service
      .from('payment_intents')
      .update({ updated_at: new Date().toISOString() })
      .eq('stripe_payment_intent_id', piId);
  }
}
