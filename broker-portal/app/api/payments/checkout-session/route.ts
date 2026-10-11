/**
 * First-unlock Stripe Checkout Session (BACKLOG-2005a, Flow A).
 *
 * Charges the server-quoted price AND saves the card off-session for future
 * one-click unlocks. Desktop-originated: user JWT verified server-side (R5); the
 * price ALWAYS comes from get_next_unlock_quote — never the request body.
 *
 * C-A (critical): fulfillment metadata is set via `payment_intent_data.metadata`
 * (which propagates onto the PaymentIntent) so `payment_intent.succeeded` — the
 * single fulfillment trigger — carries the tx identity. Session-level metadata is
 * also set for dashboard readability but is NOT the load-bearing carrier.
 */

import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { getStripe, verifyBearerUser, CURRENCY, UNLOCK_PRODUCT_NAME, paymentCallbackUrl } from '@/lib/stripe';
import { createServiceClient } from '@/lib/supabase/service';
import { getNextUnlockQuote } from '@/lib/payments/fulfillment';
import { currentStripeMode } from '@/lib/billing/mode';
import { ensureStripeCustomer, isModeAllowedForUser } from '@/lib/billing/customers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  local_transaction_id?: string;
}

export async function POST(req: Request): Promise<Response> {
  const user = await verifyBearerUser(req);
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  const localTransactionId = body.local_transaction_id;
  if (!localTransactionId) {
    return NextResponse.json({ error: 'local_transaction_id required' }, { status: 400 });
  }

  const service = createServiceClient();
  const stripe = getStripe();
  const mode = currentStripeMode();

  // BACKLOG-3845: a test-mode deployment serves only is_test users. Before any
  // Stripe call, so a refused user leaves no customer or session behind.
  if (!(await isModeAllowedForUser(service, user.userId, mode))) {
    return NextResponse.json({ error: 'payments unavailable for this account' }, { status: 403 });
  }

  // Server-side quote (never client-supplied).
  const quote = await getNextUnlockQuote(service, user.userId);
  if (!quote) {
    return NextResponse.json({ error: 'no active price' }, { status: 500 });
  }

  // Ensure a Stripe Customer + stripe_customers row for this mode.
  const customerId = await ensureStripeCustomer(service, stripe, user.userId, user.email, mode);

  const portalBase = process.env.NEXT_PUBLIC_APP_URL || 'https://app.keeprcompliance.com';
  const unlockMetadata: Record<string, string> = {
    user_id: user.userId,
    local_transaction_id: localTransactionId,
    pricing_tier_id: quote.pricingTierId,
    quoted_unit_price_cents: String(quote.unitPriceCents),
  };

  const session = await stripe.checkout.sessions.create(
    {
      mode: 'payment',
      customer: customerId,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: CURRENCY,
            unit_amount: quote.unitPriceCents,
            product_data: { name: UNLOCK_PRODUCT_NAME },
          },
        },
      ],
      // Save the card for future off-session charges (Flow B).
      payment_intent_data: {
        setup_future_usage: 'off_session',
        // C-A: metadata MUST ride the PaymentIntent (Stripe does NOT copy session
        // metadata onto the PI). This is what payment_intent.succeeded reads.
        metadata: unlockMetadata,
      },
      // Also set session-level metadata (dashboard readability; not load-bearing).
      metadata: unlockMetadata,
      // Stripe emails automatic receipts (founder D6). Stripe Tax OFF at launch.
      success_url: `${portalBase}/payments/complete?session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${portalBase}/payments/cancelled`,
    },
    {
      // Double-click guard: same (user, tx, quote) returns the same session.
      idempotencyKey: `co:${user.userId}:${localTransactionId}:${quote.unitPriceCents}`,
    }
  );

  const { error: insertError } = await service.from('payment_intents').insert({
    user_id: user.userId,
    local_transaction_id: localTransactionId,
    stripe_checkout_session_id: session.id,
    stripe_payment_intent_id:
      typeof session.payment_intent === 'string' ? session.payment_intent : null,
    quoted_unit_price_cents: quote.unitPriceCents,
    pricing_tier_id: quote.pricingTierId,
    status: 'created',
    stripe_mode: mode,
  });
  if (insertError) {
    // No money has moved yet. Without this row the payment could not be
    // reconciled, so the session is expired and its URL never returned.
    console.error('[payments/checkout-session] payment_intents insert failed:', insertError.code, insertError.message);
    Sentry.captureMessage('payment_intents insert failed at checkout', {
      level: 'error',
      tags: { billing_stage: 'checkout_insert', stripe_mode: mode },
      extra: { user_id: user.userId, checkout_session_id: session.id, code: insertError.code },
    });
    try {
      await stripe.checkout.sessions.expire(session.id);
    } catch (expireErr) {
      console.error('[payments/checkout-session] session expire failed:', (expireErr as Error).message);
    }
    return NextResponse.json({ error: 'checkout could not be recorded' }, { status: 500 });
  }

  // The desktop opens session.url externally; the success page deep-links back via
  // paymentCallbackUrl(session.id). Return the URL (and the callback for clarity).
  return NextResponse.json({
    checkout_url: session.url,
    deep_link: paymentCallbackUrl(session.id),
  });
}
