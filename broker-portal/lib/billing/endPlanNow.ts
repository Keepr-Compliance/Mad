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
 *        - `uncollectible` -> continue to the cancel WITHOUT voiding it
 *          (Stripe has stopped collecting; SR ruling Q3, traced in TEST).
 *          Accepted residual: it stays payable, so a manual payment landing
 *          between this read and the cancel would end a just-paid plan; the
 *          window is one API round-trip and nothing automatic pays it;
 *        - `paid`  -> stop, no cancel ("your payment went through");
 *        - `draft` of this subscription (the next cycle's invoice, in the
 *          hour before Stripe finalizes it) -> the most recent FINALIZED
 *          renewal decides (decideDraftHour); a cancel with the draft
 *          present stops it (Stripe sets auto_advance false; SR, TEST);
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

/**
 * The latest invoice is a draft of this subscription (next cycle, before
 * Stripe finalizes it). The draft says nothing about whether the plan was
 * paid, so the most recent FINALIZED renewal (billing_reason
 * subscription_cycle, any status but draft; newest by `created`) decides:
 *   - `void` / `uncollectible` -> 'cancel';
 *   - `paid`                   -> 'paid_meanwhile' (a retry paid it after
 *                                  the status read: never end that plan);
 *   - `open` / none            -> 'try_again'.
 * The draft is never finalized or voided here.
 */
export type DraftHourDecision = { decision: 'cancel' | 'paid_meanwhile' | 'try_again'; previousRenewalId: string | null };

export async function decideDraftHour(stripe: Stripe, subscriptionId: string): Promise<DraftHourDecision> {
  const all = await listAll((after) =>
    stripe.invoices.list({ subscription: subscriptionId, limit: 100, ...(after ? { starting_after: after } : {}) })
  );
  const previous = all
    .filter((inv) => inv.billing_reason === 'subscription_cycle' && inv.status !== 'draft')
    .sort((a, b) => b.created - a.created)[0];
  if (!previous) return { decision: 'try_again', previousRenewalId: null };
  if (previous.status === 'void' || previous.status === 'uncollectible') return { decision: 'cancel', previousRenewalId: previous.id };
  if (previous.status === 'paid') return { decision: 'paid_meanwhile', previousRenewalId: previous.id };
  return { decision: 'try_again', previousRenewalId: previous.id };
}

function isDraftOf(inv: Stripe.Invoice, subscriptionId: string): boolean {
  return inv.status === 'draft' && stripeId(inv.subscription) === subscriptionId;
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
  let draftHour: { draft_invoice_id: string; previous_renewal_id: string } | null = null;
  let uncollectibleId: string | null = null;
  if (isDraftOf(latest, sub.id)) {
    const { decision, previousRenewalId } = await decideDraftHour(stripe, sub.id);
    if (decision === 'paid_meanwhile') return 'paid_meanwhile';
    if (decision !== 'cancel' || !previousRenewalId) {
      console.warn(`[billing/end-now] latest invoice ${latestId} of ${sub.id} is a draft and the previous renewal is not settled; not ending`);
      return 'try_again';
    }
    draftHour = { draft_invoice_id: latestId, previous_renewal_id: previousRenewalId };
  } else if (latest.status === 'uncollectible') {
    // SR ruling Q3: cancel, never void it (an extra money-path call for nothing).
    uncollectibleId = latestId;
  } else if (latest.status !== 'void') {
    console.warn(`[billing/end-now] latest invoice ${latestId} of ${sub.id} reads ${latest.status}; not ending`);
    return 'try_again';
  } else {
    voided.add(latestId);
  }

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
      // The handler cancels only while the latest invoice is one of these and still void (SR RC1b),
      // or is the uncollectible one this run read (still void or uncollectible), or, in the draft
      // hour, is still this draft and the previous renewal still decides 'cancel'.
      payload: {
        subscription_id: sub.id,
        voided_invoice_ids: [...voided],
        ...(uncollectibleId ? { uncollectible_invoice_id: uncollectibleId } : {}),
        ...(draftHour ?? {}),
      },
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
 * invoice is one End plan now voided (or read `uncollectible`) and still reads
 * `void` or `uncollectible`.
 *   - already canceled           -> mirror written, done;
 *   - not this row's user        -> parked (never cancels someone else's plan);
 *   - an open invoice reappeared -> parked for a person (the state changed);
 *   - latest invoice is this row's draft (draft hour): it must still read
 *     `draft` and decideDraftHour must still say 'cancel' for the same
 *     previous renewal, else parked, nothing cancelled;
 *   - otherwise: latest invoice not one this row voided or read uncollectible,
 *     or not `void` / `uncollectible` (a new cycle was invoiced, perhaps paid,
 *     before the drain) -> parked;
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
  const draftId = typeof row.payload?.draft_invoice_id === 'string' ? row.payload.draft_invoice_id : null;
  if (latestId && draftId && latestId === draftId) {
    pastDeadline(ctx.deadline);
    const draft = await ctx.stripe.invoices.retrieve(latestId);
    if (!isDraftOf(draft, sub.id)) throw new NonRetryableOutboxError(`draft_now_${draft.status}`);
    pastDeadline(ctx.deadline);
    const { decision, previousRenewalId } = await decideDraftHour(ctx.stripe, sub.id);
    if (decision !== 'cancel') throw new NonRetryableOutboxError(`previous_renewal_${decision}`);
    if (previousRenewalId !== row.payload?.previous_renewal_id) throw new NonRetryableOutboxError('previous_renewal_changed');
  } else {
    const uncollectibleId = typeof row.payload?.uncollectible_invoice_id === 'string' ? row.payload.uncollectible_invoice_id : null;
    if (!latestId || !(voidedIds.includes(latestId) || latestId === uncollectibleId)) {
      throw new NonRetryableOutboxError('latest_invoice_not_voided_here');
    }
    pastDeadline(ctx.deadline);
    const latest = await ctx.stripe.invoices.retrieve(latestId);
    if (latest.status !== 'void' && latest.status !== 'uncollectible') throw new NonRetryableOutboxError(`latest_invoice_${latest.status}`);
  }
  pastDeadline(ctx.deadline);
  const ended = await ctx.stripe.subscriptions.cancel(
    sub.id,
    { prorate: false, invoice_now: false },
    { idempotencyKey: outboxIdempotencyKey(row, 'cancel') }
  );
  await writeThroughEnded(ctx.service, { userId: row.user_id, mode: ctx.mode, subscription: ended });
};
