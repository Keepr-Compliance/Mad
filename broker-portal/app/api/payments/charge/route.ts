/**
 * Subsequent-unlock off-session charge (BACKLOG-2005a, Flow B).
 *
 * One-click: charge the saved card off-session at the fresh server quote. Handles
 * SCA/3DS (authentication_required -> hosted confirmation URL) and hard declines
 * as distinct outcomes. Fulfillment still happens on the webhook
 * (payment_intent.succeeded) — this route never writes the ledger directly.
 */

import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { getStripe, verifyBearerUser, CURRENCY, UNLOCK_PRODUCT_NAME } from '@/lib/stripe';
import { createServiceClient } from '@/lib/supabase/service';
import { getNextUnlockQuote } from '@/lib/payments/fulfillment';

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

  // Re-quote server-side (never trust a client price; handles the tier-crossed race).
  const quote = await getNextUnlockQuote(service, user.userId);
  if (!quote) {
    return NextResponse.json({ error: 'no active price' }, { status: 500 });
  }

  const { data: customer } = await service
    .from('stripe_customers')
    .select('stripe_customer_id, default_payment_method_id')
    .eq('user_id', user.userId)
    .maybeSingle();

  if (!customer?.stripe_customer_id || !customer.default_payment_method_id) {
    // No saved card -> the desktop must run the first-unlock Checkout flow.
    return NextResponse.json({ error: 'no_saved_payment_method' }, { status: 409 });
  }

  const unlockMetadata: Record<string, string> = {
    user_id: user.userId,
    local_transaction_id: localTransactionId,
    pricing_tier_id: quote.pricingTierId,
    quoted_unit_price_cents: String(quote.unitPriceCents),
  };

  let pi: Stripe.PaymentIntent;
  try {
    pi = await stripe.paymentIntents.create(
      {
        amount: quote.unitPriceCents,
        currency: CURRENCY,
        customer: customer.stripe_customer_id,
        payment_method: customer.default_payment_method_id,
        off_session: true,
        confirm: true,
        description: UNLOCK_PRODUCT_NAME,
        metadata: unlockMetadata,
      },
      {
        // Double-click guard keyed by (user, tx, quote).
        idempotencyKey: `pi:${user.userId}:${localTransactionId}:${quote.unitPriceCents}`,
      }
    );
  } catch (err) {
    return handleChargeError(err, service, user.userId, localTransactionId, quote.unitPriceCents, quote.pricingTierId);
  }

  await service.from('payment_intents').insert({
    user_id: user.userId,
    local_transaction_id: localTransactionId,
    stripe_payment_intent_id: pi.id,
    quoted_unit_price_cents: quote.unitPriceCents,
    pricing_tier_id: quote.pricingTierId,
    status: pi.status === 'requires_action' ? 'requires_action' : 'created',
  });

  if (pi.status === 'requires_action') {
    // SCA/3DS: hand the client a hosted confirmation URL.
    return NextResponse.json({
      requires_action: true,
      redirect_url: sca3dsUrl(pi),
      payment_intent_id: pi.id,
    });
  }

  // succeeded / processing -> the webhook fulfills. UX can show "processing".
  return NextResponse.json({ succeeded: true, payment_intent_id: pi.id });
}

/** Distinguish SCA (authentication_required) from a hard decline (R/§8). */
async function handleChargeError(
  err: unknown,
  service: ReturnType<typeof createServiceClient>,
  userId: string,
  localTransactionId: string,
  quotedCents: number,
  pricingTierId: string
): Promise<Response> {
  if (err instanceof Stripe.errors.StripeCardError) {
    const pi = err.payment_intent;
    if (err.code === 'authentication_required' && pi) {
      await service.from('payment_intents').insert({
        user_id: userId,
        local_transaction_id: localTransactionId,
        stripe_payment_intent_id: pi.id,
        quoted_unit_price_cents: quotedCents,
        pricing_tier_id: pricingTierId,
        status: 'requires_action',
      });
      return NextResponse.json({
        requires_action: true,
        redirect_url: sca3dsUrl(pi),
        payment_intent_id: pi.id,
      });
    }
    // Hard decline (card_declined, insufficient_funds, ...): distinct branch.
    return NextResponse.json(
      { declined: true, code: err.code ?? 'card_declined', message: err.message },
      { status: 402 }
    );
  }
  console.error('[payments/charge] unexpected error:', (err as Error).message);
  return NextResponse.json({ error: 'charge failed' }, { status: 500 });
}

/**
 * Hosted next-action URL for SCA. Stripe returns the redirect target inside
 * next_action; the desktop opens it externally and returns via keepr://payment-callback.
 */
function sca3dsUrl(pi: Stripe.PaymentIntent): string | null {
  const na = pi.next_action;
  if (na?.type === 'redirect_to_url' && na.redirect_to_url?.url) {
    return na.redirect_to_url.url;
  }
  return null;
}
