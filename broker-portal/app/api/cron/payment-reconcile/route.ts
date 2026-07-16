/**
 * Reconciliation sweep (BACKLOG-2005a, R2 — net-new infra).
 *
 * The "paid -> eventually unlocked" guarantee. Vercel Cron hits this route on a
 * schedule (see broker-portal/vercel.json). It finds payment_intents that Stripe
 * captured (status 'succeeded') but that were never fulfilled (no unlock), re-checks
 * Stripe, and re-runs finalize_paid_unlock (idempotent) using the STORED
 * local_transaction_id (C-C — not re-parsed Stripe metadata).
 *
 * Auth: CRON_SECRET bearer (same pattern as admin-portal/app/api/cron/storage-check).
 */

import { NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { createServiceClient } from '@/lib/supabase/service';
import { fulfillPaidUnlock, emitPaymentSucceeded } from '@/lib/payments/fulfillment';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Only reconcile intents that have been 'succeeded' for at least this long, to give
// the normal webhook path time to fulfill first.
const GRACE_MINUTES = 5;
const BATCH_LIMIT = 50;

export async function GET(req: Request): Promise<Response> {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const service = createServiceClient();
  const stripe = getStripe();
  const cutoff = new Date(Date.now() - GRACE_MINUTES * 60_000).toISOString();

  const { data: stuck, error } = await service
    .from('payment_intents')
    .select('id, user_id, local_transaction_id, quoted_unit_price_cents, pricing_tier_id, stripe_payment_intent_id, stripe_checkout_session_id')
    .eq('status', 'succeeded')
    .lt('updated_at', cutoff)
    .limit(BATCH_LIMIT);

  if (error) {
    console.error('[cron/payment-reconcile] query failed:', error.message);
    return NextResponse.json({ error: 'query failed' }, { status: 500 });
  }

  let fulfilled = 0;
  let skipped = 0;
  for (const row of stuck ?? []) {
    try {
      const piId = await resolvePaymentIntentId(stripe, row);
      if (!piId) {
        skipped++;
        continue;
      }
      const pi = await stripe.paymentIntents.retrieve(piId);
      if (pi.status !== 'succeeded') {
        skipped++;
        continue;
      }

      const result = await fulfillPaidUnlock(service, {
        userId: row.user_id,
        localTransactionId: row.local_transaction_id, // C-C: stored identity
        unitPriceCents: row.quoted_unit_price_cents,
        pricingTierId: row.pricing_tier_id,
        stripePaymentIntentId: piId,
        stripeCheckoutSessionId: row.stripe_checkout_session_id,
        webhookEventId: `reconcile:${piId}`,
      });

      await service
        .from('payment_intents')
        .update({ status: 'fulfilled', updated_at: new Date().toISOString() })
        .eq('id', row.id);

      if (result.unlocked && !result.alreadyFulfilled) {
        await emitPaymentSucceeded(service, row.user_id, {
          local_transaction_id: row.local_transaction_id,
          unit_price_cents: row.quoted_unit_price_cents,
          pricing_tier_id: row.pricing_tier_id,
          stripe_payment_intent_id: piId,
        });
      }
      fulfilled++;
    } catch (err) {
      console.error(`[cron/payment-reconcile] row ${row.id} failed:`, (err as Error).message);
      skipped++;
    }
  }

  return NextResponse.json({ reconciled: fulfilled, skipped, scanned: stuck?.length ?? 0 });
}

async function resolvePaymentIntentId(
  stripe: ReturnType<typeof getStripe>,
  row: { stripe_payment_intent_id: string | null; stripe_checkout_session_id: string | null }
): Promise<string | null> {
  if (row.stripe_payment_intent_id) return row.stripe_payment_intent_id;
  if (row.stripe_checkout_session_id) {
    const session = await stripe.checkout.sessions.retrieve(row.stripe_checkout_session_id);
    return typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent?.id ?? null;
  }
  return null;
}
