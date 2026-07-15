/**
 * Shared payment fulfillment + quote helpers (BACKLOG-2005a).
 *
 * Used by both the Stripe webhook route and the reconciliation cron route so the
 * "paid -> unlocked" orchestration is defined in exactly one place.
 *
 * Fulfillment source of truth = the Stripe webhook (payment_intent.succeeded).
 * Deep-link returns / API responses are UX only and NEVER fulfill.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { UnlockQuote } from '../stripe';

/** Server-side quote for the user's next PAID unlock (2004 RPC). */
export async function getNextUnlockQuote(
  service: SupabaseClient,
  userId: string
): Promise<UnlockQuote | null> {
  const { data, error } = await service.rpc('get_next_unlock_quote', { p_user_id: userId });
  if (error) throw new Error(`get_next_unlock_quote failed: ${error.message}`);
  // The RPC RETURNS TABLE(...) -> supabase-js yields an array of rows.
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;
  return {
    nextUnitIndex: row.next_unit_index,
    unitPriceCents: row.unit_price_cents,
    currency: row.currency,
    pricingTierId: row.pricing_tier_id,
  };
}

export interface FulfillArgs {
  userId: string;
  localTransactionId: string;
  unitPriceCents: number;
  pricingTierId: string | null;
  stripePaymentIntentId: string;
  stripeCheckoutSessionId?: string | null;
  webhookEventId: string;
}

export interface FulfillResult {
  unlocked: boolean;
  alreadyFulfilled: boolean;
  ledgerEntryId: string | null;
  unlockId: string | null;
  purchaseLedgerId: string | null;
  balanceAfter: number | null;
}

/**
 * Idempotently record the purchase (+1) and the forced purchase-funded unlock via
 * finalize_paid_unlock (service_role). Safe to call more than once for the same
 * (user, tx) — the RPC short-circuits and the 2004 webhook_event_id unique index
 * de-dupes the purchase.
 */
export async function fulfillPaidUnlock(
  service: SupabaseClient,
  args: FulfillArgs
): Promise<FulfillResult> {
  const metadata: Record<string, string> = {
    webhook_event_id: args.webhookEventId,
    stripe_payment_intent_id: args.stripePaymentIntentId,
  };
  if (args.stripeCheckoutSessionId) {
    metadata.stripe_checkout_session_id = args.stripeCheckoutSessionId;
  }

  const { data, error } = await service.rpc('finalize_paid_unlock', {
    p_user_id: args.userId,
    p_local_transaction_id: args.localTransactionId,
    p_unit_price_cents: args.unitPriceCents,
    p_pricing_tier_id: args.pricingTierId,
    p_metadata: metadata,
  });
  if (error) throw new Error(`finalize_paid_unlock failed: ${error.message}`);

  const r = (data ?? {}) as Record<string, unknown>;
  return {
    unlocked: Boolean(r.unlocked),
    alreadyFulfilled: Boolean(r.already_fulfilled),
    ledgerEntryId: (r.ledger_entry_id as string) ?? null,
    unlockId: (r.unlock_id as string) ?? null,
    purchaseLedgerId: (r.purchase_ledger_id as string) ?? null,
    balanceAfter: (r.balance_after as number) ?? null,
  };
}

/** Compensating refund netting via record_refund (service_role). */
export async function recordRefund(
  service: SupabaseClient,
  userId: string,
  localTransactionId: string,
  metadata: Record<string, string>
): Promise<void> {
  const { error } = await service.rpc('record_refund', {
    p_user_id: userId,
    p_local_transaction_id: localTransactionId,
    p_metadata: metadata,
  });
  if (error) throw new Error(`record_refund failed: ${error.message}`);
}

/**
 * Emit the `payment-succeeded` funnel event server-side into the existing
 * analytics_events table (BACKLOG-2005a §9, option a — guaranteed, client-drop-proof).
 * Never throws: analytics must not break fulfillment.
 */
export async function emitPaymentSucceeded(
  service: SupabaseClient,
  userId: string,
  eventData: Record<string, unknown>
): Promise<void> {
  try {
    await service.from('analytics_events').insert({
      user_id: userId,
      event_name: 'payment-succeeded',
      event_data: eventData,
    });
  } catch {
    // swallow — analytics is best-effort (mirrors the desktop trackEvent contract)
  }
}
