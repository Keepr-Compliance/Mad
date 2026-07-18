/**
 * Payment status / claim endpoint (BACKLOG-2005a).
 *
 * The desktop polls this after the keepr://payment-callback deep-link return to learn
 * whether the unlock has been fulfilled yet (the webhook is authoritative and may lag).
 * If Stripe says the PI is paid but the ledger has no unlock, this self-heals by
 * calling finalize_paid_unlock (idempotent) so the user is never stuck paid-but-locked.
 *
 * Auth: user JWT (own rows only via the verified user id).
 */

import { NextResponse } from 'next/server';
import { getStripe, verifyBearerUser } from '@/lib/stripe';
import { createServiceClient } from '@/lib/supabase/service';
import { fulfillPaidUnlock, emitPaymentSucceeded } from '@/lib/payments/fulfillment';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const user = await verifyBearerUser(req);
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const sessionId = new URL(req.url).searchParams.get('session');
  if (!sessionId) {
    return NextResponse.json({ error: 'session required' }, { status: 400 });
  }

  const service = createServiceClient();

  const { data: intent } = await service
    .from('payment_intents')
    .select('user_id, local_transaction_id, status, quoted_unit_price_cents, pricing_tier_id, stripe_payment_intent_id')
    .eq('stripe_checkout_session_id', sessionId)
    .maybeSingle();

  if (!intent || intent.user_id !== user.userId) {
    // Do not leak other users' intents.
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const unlocked = await isUnlocked(service, user.userId, intent.local_transaction_id);
  if (unlocked) {
    return NextResponse.json({ status: 'fulfilled', unlocked: true });
  }

  // Self-heal: if Stripe already captured the payment but fulfillment lagged/was lost,
  // finalize now (idempotent). Resolve the PI from the Checkout Session.
  if (intent.status === 'succeeded' || intent.status === 'created') {
    try {
      const stripe = getStripe();
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      const piId =
        typeof session.payment_intent === 'string'
          ? session.payment_intent
          : session.payment_intent?.id;
      if (session.payment_status === 'paid' && piId) {
        const result = await fulfillPaidUnlock(service, {
          userId: intent.user_id,
          localTransactionId: intent.local_transaction_id,
          unitPriceCents: intent.quoted_unit_price_cents,
          pricingTierId: intent.pricing_tier_id,
          stripePaymentIntentId: piId,
          stripeCheckoutSessionId: sessionId,
          webhookEventId: `selfheal:${sessionId}`,
        });
        await service
          .from('payment_intents')
          .update({ status: 'fulfilled', updated_at: new Date().toISOString() })
          .eq('stripe_checkout_session_id', sessionId);
        if (result.unlocked && !result.alreadyFulfilled) {
          await emitPaymentSucceeded(service, intent.user_id, {
            local_transaction_id: intent.local_transaction_id,
            unit_price_cents: intent.quoted_unit_price_cents,
            pricing_tier_id: intent.pricing_tier_id,
            stripe_payment_intent_id: piId,
          });
        }
        return NextResponse.json({ status: 'fulfilled', unlocked: true });
      }
    } catch (err) {
      console.error('[payments/status] self-heal failed:', (err as Error).message);
      // Fall through to report the stored status.
    }
  }

  return NextResponse.json({ status: intent.status, unlocked: false });
}

async function isUnlocked(
  service: ReturnType<typeof createServiceClient>,
  userId: string,
  localTransactionId: string
): Promise<boolean> {
  const { data } = await service
    .from('transaction_unlocks')
    .select('id')
    .eq('user_id', userId)
    .eq('local_transaction_id', localTransactionId)
    .maybeSingle();
  return Boolean(data);
}
