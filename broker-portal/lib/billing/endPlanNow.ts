/**
 * End an Agent plan whose renewal payment failed, now — BACKLOG-3848.
 *
 * Founder decision (Q1 = A, 2026-10-13): a card-failed (past_due) plan ends
 * immediately, the unpaid renewal is voided (forgiven), nothing more is
 * charged, credits are kept. Order (SR R4, measured in Stripe TEST):
 *
 *   1. Status from a FRESH subscriptions.retrieve, checked before any write:
 *      `past_due` only. After a void Stripe flips the subscription to `active`,
 *      so a re-check after step 2 would read wrong. `unpaid` is refused: its
 *      void/cancel path was not traced in TEST.
 *   2. Every OPEN invoice of THIS subscription (listed by `subscription`, all
 *      pages) is voided FIRST. Stripe refuses to void an invoice with a paid
 *      payment, so a plan the person paid for in the meantime (a smart retry, a
 *      card update in another tab) is never ended:
 *        - refused and the invoice now reads `paid` -> stop, no cancel;
 *        - refused and it is still `open`            -> "try again", no cancel.
 *   3. Before the cancel, the subscription's latest invoice (its id from the
 *      step-1 read) is re-fetched. A renewal paid AFTER the status read and
 *      BEFORE the list leaves nothing open to void, so the void loop alone
 *      cannot see it (SR RC1, reproduced in Stripe TEST). Its status decides,
 *      never a second subscription read (a void flips the sub to `active`):
 *        - `void`  -> continue to the cancel;
 *        - `paid`  -> stop, no cancel ("your payment went through");
 *        - else    -> "try again", no cancel.
 *   4. subscriptions.cancel (no proration, no final invoice).
 *      A cancel that fails AFTER the voids leaves an unpaid, active plan that
 *      would renew: a billing_outbox row retries the cancel and an alert fires.
 *   5. The mirror row (this user, this mode, this subscription) is written
 *      `canceled`, `paused = false` at once; the webhook's own event follows.
 * No refund. Credits are untouched.
 */

import type Stripe from 'stripe';
import type { createServiceClient } from '@/lib/supabase/service';
import type { StripeMode } from './mode';
import { billingAlert } from './alert';
import { enqueueOutbox } from './outboxEnqueue';
import { listAll, stripeId } from './sync';
import { getUserByStripeCustomer } from './customers';
import { NonRetryableOutboxError, outboxIdempotencyKey, type OutboxHandler } from './outboxKinds';

type ServiceClient = ReturnType<typeof createServiceClient>;

export const END_NOW_KIND = 'agent_end_now_cancel';

export type EndNowOutcome = 'ended' | 'not_now' | 'paid_meanwhile' | 'try_again' | 'finalizing';

/**
 * Idempotency window for a void. A key replays Stripe's first answer for 24 h,
 * so a key fixed per invoice made "try again in a minute" fail for a day after
 * one transient error. The minute bucket keeps an accidental double submit on
 * one key and gives a person's retry a fresh one. Repeating a void is safe
 * either way: a second void is refused and the re-fetch then reads `void`.
 */
export const END_NOW_VOID_WINDOW_MS = 60_000;

export function endNowVoidKey(invoiceId: string, now: Date): string {
  return `end-now-void:${invoiceId}:${Math.floor(now.getTime() / END_NOW_VOID_WINDOW_MS)}`;
}

export const END_NOW_MESSAGES: Record<Exclude<EndNowOutcome, 'ended'>, string> = {
  not_now: 'That change is not available for your plan right now. Refresh the page.',
  paid_meanwhile: 'Your payment went through, so your plan is active. Nothing was cancelled.',
  try_again: 'We could not end your plan just now. Nothing was cancelled. Please try again in a minute.',
  finalizing: 'Your unpaid bill is cancelled and your plan is being ended. This can take a few minutes.',
};

/** The open invoices of one subscription, every page. */
export function openInvoicesOf(stripe: Stripe, subscriptionId: string): Promise<Stripe.Invoice[]> {
  return listAll((after) =>
    stripe.invoices.list({ subscription: subscriptionId, status: 'open', limit: 100, ...(after ? { starting_after: after } : {}) })
  );
}

/** Mirror write-through after an immediate end: this row only (user, mode, subscription). */
export async function writeThroughEnded(
  service: ServiceClient,
  args: { userId: string; mode: StripeMode; subscription: Pick<Stripe.Subscription, 'id' | 'canceled_at'> }
): Promise<void> {
  const canceledAt = typeof args.subscription.canceled_at === 'number' ? new Date(args.subscription.canceled_at * 1000).toISOString() : new Date().toISOString();
  const { data, error } = await service
    .from('billing_subscriptions')
    .update({ status: 'canceled', paused: false, cancel_at_period_end: false, canceled_at: canceledAt, updated_at: new Date().toISOString() })
    .eq('stripe_subscription_id', args.subscription.id)
    .eq('stripe_mode', args.mode)
    .eq('user_id', args.userId)
    .select('id');
  if (error) throw new Error(`billing_subscriptions end write-through failed: ${error.message}`);
  if (!Array.isArray(data) || data.length === 0) {
    // Not an error: the webhook's own event writes the row. Logged so a mirror gap is visible.
    console.warn(`[billing/end-now] write-through for ${args.subscription.id} (${args.mode}) matched no mirror row`);
  }
}

export async function endPlanNow(args: {
  stripe: Stripe;
  service: ServiceClient;
  mode: StripeMode;
  userId: string;
  /** The caller's own mirror row's subscription id (never an id from the request). */
  subscriptionId: string;
  /** Clock for the void key's window (tests). */
  now?: Date;
}): Promise<EndNowOutcome> {
  const { stripe, service, mode, userId } = args;
  const sub = await stripe.subscriptions.retrieve(args.subscriptionId);
  // Step 1, before any write.
  if (sub.status !== 'past_due') return 'not_now';
  const latestId = stripeId(sub.latest_invoice);

  // Step 2: void first.
  const voided = new Set<string>();
  for (const inv of await openInvoicesOf(stripe, sub.id)) {
    try {
      await stripe.invoices.voidInvoice(inv.id, {}, { idempotencyKey: endNowVoidKey(inv.id, args.now ?? new Date()) });
      voided.add(inv.id);
    } catch (err) {
      // The invoice as Stripe has it now decides, never the error text.
      const now = await stripe.invoices.retrieve(inv.id);
      if (now.status === 'paid') return 'paid_meanwhile';
      if (now.status === 'void' || now.status === 'uncollectible') {
        if (now.status === 'void') voided.add(inv.id);
        continue;
      }
      console.warn(`[billing/end-now] void of ${inv.id} refused (${(err as { type?: string }).type ?? 'error'}); invoice ${now.status}`);
      return 'try_again';
    }
  }

  // Step 3: the latest invoice as Stripe has it now decides whether the plan may end.
  if (!latestId) return 'try_again';
  const latest = await stripe.invoices.retrieve(latestId);
  if (latest.status === 'paid') return 'paid_meanwhile';
  if (latest.status !== 'void') {
    console.warn(`[billing/end-now] latest invoice ${latestId} of ${sub.id} reads ${latest.status}; not ending`);
    return 'try_again';
  }
  voided.add(latestId);

  // Step 4.
  let ended: Stripe.Subscription;
  try {
    ended = await stripe.subscriptions.cancel(sub.id, { prorate: false, invoice_now: false }, { idempotencyKey: `end-now-cancel:${sub.id}` });
  } catch (err) {
    billingAlert('end_now_cancel_failed', mode, { subscription_id: sub.id, error_type: (err as { type?: string }).type ?? 'error' });
    await enqueueOutbox(service, {
      mode,
      kind: END_NOW_KIND,
      userId,
      dedupeKey: `end-now:${mode}:${sub.id}`,
      // The handler cancels only while the latest invoice is one of these and still void (SR RC1b).
      payload: { subscription_id: sub.id, voided_invoice_ids: [...voided] },
      runAfter: new Date(),
    });
    return 'finalizing';
  }

  // Step 5.
  await writeThroughEnded(service, { userId, mode, subscription: ended });
  return 'ended';
}

function pastDeadline(deadline: Date): void {
  if (Date.now() >= deadline.getTime()) throw new Error('outbox deadline reached');
}

/**
 * billing_outbox kind `agent_end_now_cancel`: retry the cancel that failed
 * after the voids (step 4). Converges: reads Stripe first and only cancels a
 * subscription that is still running with no open invoice and whose latest
 * invoice is one End plan now voided and still reads `void`.
 *   - already canceled           -> mirror written, done;
 *   - not this row's user        -> parked (never cancels someone else's plan);
 *   - an open invoice reappeared -> parked for a person (the state changed);
 *   - latest invoice not one this row voided, or not `void` (a new cycle was
 *     invoiced, perhaps paid, before the drain) -> parked, nothing cancelled;
 *   - active / past_due          -> cancel (key per row), mirror written.
 */
export const handleEndNowCancelRow: OutboxHandler = async (row, ctx) => {
  const subId = typeof row.payload?.subscription_id === 'string' ? row.payload.subscription_id : null;
  const voidedIds = row.payload?.voided_invoice_ids;
  if (!subId || !row.user_id || !Array.isArray(voidedIds)) throw new NonRetryableOutboxError('bad_payload');
  const sub = await ctx.stripe.subscriptions.retrieve(subId);
  const customerId = stripeId(sub.customer);
  const owner = customerId ? await getUserByStripeCustomer(ctx.service, customerId, ctx.mode) : null;
  if (owner !== row.user_id) throw new NonRetryableOutboxError('not_owner');
  if (sub.status === 'canceled') {
    await writeThroughEnded(ctx.service, { userId: row.user_id, mode: ctx.mode, subscription: sub });
    return;
  }
  if (sub.status !== 'active' && sub.status !== 'past_due') throw new NonRetryableOutboxError(`status_${sub.status}`);
  pastDeadline(ctx.deadline);
  if ((await openInvoicesOf(ctx.stripe, sub.id)).length > 0) throw new NonRetryableOutboxError('open_invoice');
  const latestId = stripeId(sub.latest_invoice);
  if (!latestId || !voidedIds.includes(latestId)) throw new NonRetryableOutboxError('latest_invoice_not_voided_here');
  pastDeadline(ctx.deadline);
  const latest = await ctx.stripe.invoices.retrieve(latestId);
  if (latest.status !== 'void') throw new NonRetryableOutboxError(`latest_invoice_${latest.status}`);
  pastDeadline(ctx.deadline);
  const ended = await ctx.stripe.subscriptions.cancel(
    sub.id,
    { prorate: false, invoice_now: false },
    { idempotencyKey: outboxIdempotencyKey(row, 'cancel') }
  );
  await writeThroughEnded(ctx.service, { userId: row.user_id, mode: ctx.mode, subscription: ended });
};
