/**
 * Stripe webhook -> Agent subscription billing state (BACKLOG-3846).
 *
 * Rules shared by every handler here (plan step 0 §2.0 + SR R1-R11):
 *  - E0: only ids come from the event payload; every field is read from a
 *    re-fetch with the pinned (acacia) client.
 *  - Identity: an Agent subscription is one whose Stripe customer has a
 *    stripe_customers row in the event's mode; the user is that row's user.
 *    sub.metadata.user_id is a cross-check only (mismatch = warning, R1).
 *  - Grant only on invoice.paid (paid, total > 0, create/cycle/update reason,
 *    the non-proration subscription line pays the current period, the charge is
 *    neither refunded nor disputed, sub active/trialing and not paused).
 *  - Revoke only when the user has no OTHER open subscription in this mode
 *    (R2: decided independently of the mirror write, R7).
 *  - billing_subscriptions mirror: insert-if-missing, guarded UPDATE on
 *    last_event_created for customer.subscription.* only.
 *  - Non-retryable refusals -> Sentry + return (the route answers 200).
 *    Anything else throws -> 500 -> Stripe retries.
 */

import * as Sentry from '@sentry/nextjs';
import type Stripe from 'stripe';
import type { createServiceClient } from '@/lib/supabase/service';
import type { StripeMode } from './mode';
import { getPersonalOrganization, getUserByStripeCustomer, modeAllowsTestFlag } from './customers';
import { enqueueAgentReceipt } from './agentReceipt';

type ServiceClient = ReturnType<typeof createServiceClient>;

export interface BillingContext {
  service: ServiceClient;
  stripe: Stripe;
  mode: StripeMode;
  event: Stripe.Event;
}

/** Statuses the one-open-per-user index treats as open. */
export const OPEN_STATUSES = ['active', 'trialing', 'past_due', 'incomplete'] as const;
const OPEN = new Set<string>(OPEN_STATUSES);
/** customer.subscription.* statuses that end paid access now. */
const REVOKE_STATUSES = new Set(['past_due', 'unpaid', 'canceled', 'incomplete_expired', 'paused']);
const GRANT_REASONS = new Set(['subscription_create', 'subscription_cycle', 'subscription_update']);
/** Renewal is charged ~1 h after period end (plan R5); paid_through = period end + 2 h. */
export const PAID_THROUGH_BUFFER_SECONDS = 2 * 60 * 60;
/** RPC error codes a retry cannot change (mode/is_test, no personal org, no plan row). */
const NON_RETRYABLE_RPC_CODES = new Set(['42501', 'P0002']);
const ONE_OPEN_INDEX = 'billing_subscriptions_one_open_per_user_mode';
const SUBSCRIPTION_ID_KEY = 'billing_subscriptions_stripe_subscription_id_key';

export function stripeId(v: string | { id: string } | null | undefined): string | null {
  if (!v) return null;
  return typeof v === 'string' ? v : v.id ?? null;
}

function isPaused(sub: Stripe.Subscription): boolean {
  return sub.pause_collection !== null && sub.pause_collection !== undefined;
}

function iso(seconds: number | null | undefined): string | null {
  return typeof seconds === 'number' ? new Date(seconds * 1000).toISOString() : null;
}

function log(ctx: BillingContext, msg: string): void {
  console.info(`[billing/sync] ${ctx.event.type} ${ctx.event.id}: ${msg}`);
}

/** A business-rule refusal: reported, never retried (SR binding note). */
export function reportBillingRefusal(
  ctx: BillingContext,
  stage: string,
  reason: string,
  extra: Record<string, unknown> = {}
): void {
  console.warn(`[billing/sync] refused at ${stage}: ${reason}`, extra);
  Sentry.captureMessage('Stripe billing event refused', {
    level: 'warning',
    tags: { billing_stage: stage, stripe_mode: ctx.mode },
    extra: { reason, event_id: ctx.event.id, event_type: ctx.event.type, ...extra },
  });
}

/**
 * The Agent user a subscription belongs to, or null (not an Agent subscription,
 * or refused). Identity is the stored stripe_customers row (C-C, R1).
 */
export async function resolveAgentUser(
  ctx: BillingContext,
  sub: Stripe.Subscription,
  stage: string
): Promise<string | null> {
  const customerId = stripeId(sub.customer);
  if (!customerId) return null;

  const kind = sub.metadata?.kind;
  if (kind && kind !== 'agent') {
    reportBillingRefusal(ctx, stage, 'not_agent_kind', { subscription_id: sub.id, kind });
    return null;
  }

  const userId = await getUserByStripeCustomer(ctx.service, customerId, ctx.mode);
  if (!userId) {
    log(ctx, `subscription ${sub.id}: customer has no stripe_customers row in ${ctx.mode}; not an Agent subscription`);
    return null;
  }

  const mdUser = sub.metadata?.user_id;
  if (mdUser && mdUser !== userId) {
    // R1: the stored row is the authority; metadata never decides either way.
    Sentry.captureMessage('Stripe subscription metadata user does not match stored customer', {
      level: 'warning',
      tags: { billing_stage: stage, stripe_mode: ctx.mode },
      extra: { event_id: ctx.event.id, subscription_id: sub.id, user_id: userId },
    });
  }

  const org = await getPersonalOrganization(ctx.service, userId);
  if (!modeAllowsTestFlag(ctx.mode, org?.isTest === true)) {
    reportBillingRefusal(ctx, stage, 'mode_not_allowed', { subscription_id: sub.id, user_id: userId });
    return null;
  }
  return userId;
}

type SyncOutcome = 'inserted' | 'updated' | 'unchanged' | 'duplicate' | 'refused';

export function mirrorState(sub: Stripe.Subscription): Record<string, unknown> {
  const interval = sub.items?.data?.[0]?.price?.recurring?.interval;
  return {
    status: sub.status,
    interval: interval === 'month' || interval === 'year' ? interval : null,
    current_period_end: iso(sub.current_period_end),
    cancel_at_period_end: sub.cancel_at_period_end === true,
    canceled_at: iso(sub.canceled_at),
    paused: isPaused(sub),
    updated_at: new Date().toISOString(),
  };
}

function violates(error: { code?: string; message?: string; details?: string } | null, constraint: string): boolean {
  return !!error && error.code === '23505' && `${error.message ?? ''} ${error.details ?? ''}`.includes(constraint);
}

/**
 * Mirror the re-fetched subscription into billing_subscriptions.
 * advanceCursor (customer.subscription.* only): guarded UPDATE that matches
 * only when the stored last_event_created is NULL or older than this event.
 * Without it (invoice.paid, checkout): insert-if-missing, cursor NULL (R7).
 */
export async function syncSubscription(
  ctx: BillingContext,
  sub: Stripe.Subscription,
  userId: string,
  opts: { advanceCursor: boolean }
): Promise<SyncOutcome> {
  const { data: existing, error: readErr } = await ctx.service
    .from('billing_subscriptions')
    .select('id')
    .eq('stripe_subscription_id', sub.id)
    .maybeSingle();
  if (readErr) throw new Error(`billing_subscriptions read failed: ${readErr.message}`);

  if (!existing) {
    const org = await getPersonalOrganization(ctx.service, userId);
    const row = {
      stripe_mode: ctx.mode,
      user_id: userId,
      organization_id: org?.id ?? null,
      stripe_customer_id: stripeId(sub.customer),
      stripe_subscription_id: sub.id,
      ...mirrorState(sub),
      last_event_created: opts.advanceCursor ? ctx.event.created : null,
    };
    const { error } = await ctx.service.from('billing_subscriptions').insert(row);
    if (!error) return 'inserted';
    if (violates(error, ONE_OPEN_INDEX)) return handleSecondOpenSubscription(ctx, sub, userId, row);
    if (error.code === '42501') {
      reportBillingRefusal(ctx, 'subscription_mirror', 'stripe_mode_guard', { subscription_id: sub.id, user_id: userId });
      return 'refused';
    }
    if (!violates(error, SUBSCRIPTION_ID_KEY)) {
      throw new Error(`billing_subscriptions insert failed: ${error.code} ${error.message}`);
    }
    // A concurrent delivery inserted it first; fall through to the update.
  }

  if (!opts.advanceCursor) return 'unchanged';

  const { data: updated, error } = await ctx.service
    .from('billing_subscriptions')
    .update({ ...mirrorState(sub), last_event_created: ctx.event.created })
    .eq('stripe_subscription_id', sub.id)
    .or(`last_event_created.is.null,last_event_created.lt.${ctx.event.created}`)
    .select('id');
  if (error) {
    if (violates(error, ONE_OPEN_INDEX)) {
      reportBillingRefusal(ctx, 'subscription_mirror', 'second_open_subscription_on_update', { subscription_id: sub.id, user_id: userId });
      return 'duplicate';
    }
    throw new Error(`billing_subscriptions update failed: ${error.code} ${error.message}`);
  }
  return Array.isArray(updated) && updated.length > 0 ? 'updated' : 'unchanged';
}

/**
 * A second open Agent subscription for a user (RC5/D4). The stored incumbent is
 * re-fetched first (R3): if Stripe says it is closed, the stored row was stale,
 * so it is synced closed and the newcomer is kept. Otherwise the newcomer is
 * cancelled without proration or a final invoice.
 */
async function handleSecondOpenSubscription(
  ctx: BillingContext,
  newcomer: Stripe.Subscription,
  userId: string,
  row: Record<string, unknown>
): Promise<SyncOutcome> {
  const { data: inc, error } = await ctx.service
    .from('billing_subscriptions')
    .select('stripe_subscription_id')
    .eq('user_id', userId)
    .eq('stripe_mode', ctx.mode)
    .in('status', [...OPEN_STATUSES])
    .maybeSingle();
  if (error) throw new Error(`billing_subscriptions incumbent read failed: ${error.message}`);
  const incumbentId = (inc as { stripe_subscription_id?: string } | null)?.stripe_subscription_id;
  if (!incumbentId) throw new Error(`second open subscription ${newcomer.id} but no incumbent row; retry`);

  let incumbent: Stripe.Subscription = await ctx.stripe.subscriptions.retrieve(incumbentId);
  if (incumbent.status === 'incomplete' && (newcomer.status === 'active' || newcomer.status === 'trialing')) {
    // BACKLOG-3847 (F2, SR R1b): a half-made incumbent (declined card or
    // abandoned 3DS) must not cost the user the plan they just paid for. Void
    // its unpaid invoice: Stripe refuses that once the invoice is paid, so a
    // plan completed in another tab is never ended here; it then falls through
    // to the newcomer branch below, which is right if the incumbent completed.
    incumbent = await voidIncompleteSubscription(ctx.stripe, incumbent);
  }
  if (!OPEN.has(incumbent.status)) {
    const { error: closeErr } = await ctx.service
      .from('billing_subscriptions')
      .update(mirrorState(incumbent))
      .eq('stripe_subscription_id', incumbentId);
    if (closeErr) throw new Error(`billing_subscriptions incumbent close failed: ${closeErr.message}`);
    const { error: retryErr } = await ctx.service.from('billing_subscriptions').insert(row);
    if (retryErr) throw new Error(`billing_subscriptions insert after incumbent close failed: ${retryErr.code} ${retryErr.message}`);
    log(ctx, `stored incumbent ${incumbentId} was ${incumbent.status} in Stripe; kept ${newcomer.id}`);
    return 'inserted';
  }

  await ctx.stripe.subscriptions.cancel(
    newcomer.id,
    { prorate: false, invoice_now: false },
    { idempotencyKey: `dup-cancel:${newcomer.id}` }
  );
  console.error(`[billing/sync] duplicate subscription ${newcomer.id} cancelled; kept ${incumbentId}`);
  Sentry.captureMessage('Duplicate Agent subscription cancelled', {
    level: 'error',
    tags: { billing_stage: 'duplicate_subscription', stripe_mode: ctx.mode },
    extra: { event_id: ctx.event.id, user_id: userId, kept: incumbentId, cancelled: newcomer.id },
  });
  return 'duplicate';
}

/** Every item of a Stripe list, following has_more / starting_after. */
export async function listAll<T extends { id: string }>(
  page: (_startingAfter: string | undefined) => Promise<Stripe.ApiList<T>>
): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  for (;;) {
    const res = await page(after);
    out.push(...res.data);
    if (!res.has_more || res.data.length === 0) return out;
    after = res.data[res.data.length - 1].id;
  }
}

/**
 * End a half-made (`incomplete`) subscription the only safe way (SR R1): never
 * subscriptions.cancel, which would end a plan the user paid for in the moment
 * between our read and this call. Returns the subscription as Stripe reports it
 * afterwards: `incomplete_expired` when it was ended; `active`/`trialing` when
 * its invoice had been paid (Stripe refuses both steps below once it is paid).
 *
 *   1. Expire every open Checkout session of this subscription FIRST. Stripe
 *      refuses to void an invoice that an open session still holds; expiring
 *      that session voids the invoice and ends the subscription itself
 *      (measured in TEST, BACKLOG-3847). An expire refused because the session
 *      is no longer open (a concurrent request, or it completed) is not an
 *      error: the subscription's own status below decides.
 *   2. If any was open, re-fetch. No longer `incomplete` -> done, nothing to
 *      void.
 *   3. Still `incomplete` (a subscription no session holds) -> void its unpaid
 *      latest invoice. A void Stripe refuses is judged by the re-fetched
 *      subscription: ended or paid is returned; still `incomplete` is rethrown
 *      (a transient error: the caller retries).
 */
export async function voidIncompleteSubscription(stripe: Stripe, sub: Stripe.Subscription): Promise<Stripe.Subscription> {
  const invoiceId = stripeId(sub.latest_invoice);
  if (!invoiceId) throw new Error(`incomplete subscription ${sub.id} has no latest invoice`);

  const sessions = await listAll((after) =>
    stripe.checkout.sessions.list({ subscription: sub.id, ...(after ? { starting_after: after } : {}) })
  );
  const open = sessions.filter((x) => x.status === 'open');
  for (const s of open) {
    try {
      await stripe.checkout.sessions.expire(s.id);
    } catch {
      // Judged by the subscription below (step 2/3), never by this response.
    }
  }
  if (open.length > 0) {
    const after = await stripe.subscriptions.retrieve(sub.id);
    if (after.status !== 'incomplete') return after;
  }

  try {
    await stripe.invoices.voidInvoice(invoiceId, {}, { idempotencyKey: `incomplete-void:${invoiceId}` });
  } catch (err) {
    const now = await stripe.subscriptions.retrieve(sub.id);
    if (now.status === 'incomplete') throw err;
    return now;
  }
  return stripe.subscriptions.retrieve(sub.id);
}

/**
 * Write-through after the page ends or keeps a plan (BACKLOG-3847, SR R6):
 * only cancel_at_period_end and canceled_at, only on a row that is still
 * active/trialing, and never last_event_created. Status and period stay the
 * webhook's; leaving the cursor alone lets the action's own
 * customer.subscription.updated event still apply.
 */
export async function writeThroughCancelFlag(
  service: ServiceClient,
  sub: Pick<Stripe.Subscription, 'id' | 'cancel_at_period_end' | 'canceled_at'>
): Promise<void> {
  const { error } = await service
    .from('billing_subscriptions')
    .update({ cancel_at_period_end: sub.cancel_at_period_end === true, canceled_at: iso(sub.canceled_at) })
    .eq('stripe_subscription_id', sub.id)
    .in('status', ['active', 'trialing']);
  if (error) throw new Error(`billing_subscriptions write-through failed: ${error.message}`);
}

/** True when the user has an open subscription in this mode other than subId. */
export async function hasOtherOpenSubscription(ctx: BillingContext, userId: string, subId: string): Promise<boolean> {
  const { data, error } = await ctx.service
    .from('billing_subscriptions')
    .select('stripe_subscription_id')
    .eq('user_id', userId)
    .eq('stripe_mode', ctx.mode)
    .in('status', [...OPEN_STATUSES])
    .not('stripe_subscription_id', 'eq', subId)
    .limit(1);
  if (error) throw new Error(`billing_subscriptions open read failed: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

async function entitlementRpc(
  ctx: BillingContext,
  fn: 'grant_unlimited_from_subscription' | 'revoke_unlimited_from_subscription',
  args: Record<string, unknown>,
  stage: string
): Promise<void> {
  const { data, error } = await ctx.service.rpc(fn, args);
  if (error) {
    if (error.code && NON_RETRYABLE_RPC_CODES.has(error.code)) {
      reportBillingRefusal(ctx, stage, `${fn}_${error.code}`, { user_id: args.p_user_id, message: error.message });
      return;
    }
    throw new Error(`${fn} failed: ${error.code} ${error.message}`);
  }
  const result = (data ?? {}) as { status?: string; reason?: string };
  if (result.status === 'refused') {
    reportBillingRefusal(ctx, stage, result.reason ?? 'refused', { user_id: args.p_user_id });
  } else {
    log(ctx, `${fn} -> ${result.status ?? 'unknown'}${result.reason ? ` (${result.reason})` : ''}`);
  }
}

/** Revoke unless the user has a different open subscription (R2). */
export async function revokeIfCurrent(ctx: BillingContext, userId: string, subId: string, stage: string): Promise<void> {
  if (await hasOtherOpenSubscription(ctx, userId, subId)) {
    log(ctx, `${subId} is not the user's current subscription; no revoke`);
    return;
  }
  await entitlementRpc(ctx, 'revoke_unlimited_from_subscription', { p_user_id: userId, p_mode: ctx.mode }, stage);
}

/** The line that pays the subscription period (R5): never lines[0]. */
export function subscriptionLine(invoice: Stripe.Invoice): Stripe.InvoiceLineItem | null {
  return invoice.lines?.data?.find((l) => l.type === 'subscription' && l.proration === false) ?? null;
}

async function chargeOf(ctx: BillingContext, invoice: Stripe.Invoice): Promise<Stripe.Charge | null> {
  const c = invoice.charge;
  if (!c) return null;
  return typeof c === 'string' ? ctx.stripe.charges.retrieve(c) : c;
}

async function invoiceOf(ctx: BillingContext, v: string | Stripe.Invoice | null): Promise<Stripe.Invoice | null> {
  if (!v) return null;
  return typeof v === 'string' ? ctx.stripe.invoices.retrieve(v) : v;
}

// ---------------------------------------------------------------- handlers

/** customer.subscription.created / updated / deleted. */
export async function handleSubscriptionEvent(ctx: BillingContext, subscriptionId: string): Promise<void> {
  const sub = await ctx.stripe.subscriptions.retrieve(subscriptionId);
  const userId = await resolveAgentUser(ctx, sub, 'subscription_event');
  if (!userId) return;
  const outcome = await syncSubscription(ctx, sub, userId, { advanceCursor: true });
  if (outcome === 'duplicate' || outcome === 'refused') return;
  // R7: decided from the re-fetch, whatever the guarded UPDATE matched.
  if (REVOKE_STATUSES.has(sub.status) || isPaused(sub)) {
    await revokeIfCurrent(ctx, userId, sub.id, 'subscription_event');
  }
}

/** invoice.paid: the only grant path. */
export async function handleInvoicePaid(ctx: BillingContext, invoiceId: string): Promise<void> {
  const invoice = await ctx.stripe.invoices.retrieve(invoiceId, { expand: ['charge'] });
  if (invoice.status !== 'paid') return log(ctx, `invoice ${invoice.id} is ${invoice.status}; no grant`);
  if (!(invoice.total > 0)) return log(ctx, `invoice ${invoice.id} total ${invoice.total}; no grant`);
  const subId = stripeId(invoice.subscription);
  if (!subId) return;

  const sub = await ctx.stripe.subscriptions.retrieve(subId);
  const userId = await resolveAgentUser(ctx, sub, 'grant');
  if (!userId) return;
  // BACKLOG-3848 (SR R9): one receipt per paid Agent invoice, before and
  // whatever the grant below decides. Deduped per invoice; sent ~10 min later.
  const queued = await enqueueAgentReceipt(ctx.service, { mode: ctx.mode, userId, invoice });
  log(ctx, `receipt for ${invoice.id}: ${queued}`);
  if (!invoice.billing_reason || !GRANT_REASONS.has(invoice.billing_reason)) {
    return log(ctx, `invoice ${invoice.id} reason ${invoice.billing_reason}; no grant`);
  }
  const outcome = await syncSubscription(ctx, sub, userId, { advanceCursor: false });
  if (outcome === 'duplicate' || outcome === 'refused') return;

  if ((sub.status !== 'active' && sub.status !== 'trialing') || isPaused(sub)) {
    return log(ctx, `subscription ${sub.id} is ${sub.status}${sub.pause_collection ? ' (paused)' : ''}; no grant`);
  }
  const line = subscriptionLine(invoice);
  if (!line) return log(ctx, `invoice ${invoice.id} has no subscription line; no grant`);
  if (line.period.end < sub.current_period_end) {
    return log(ctx, `invoice ${invoice.id} pays a period ending before the current one; no grant`);
  }
  const charge = await chargeOf(ctx, invoice);
  if (charge && (charge.refunded === true || charge.disputed === true)) {
    return log(ctx, `invoice ${invoice.id} charge is refunded/disputed; no grant`);
  }
  if (await hasOtherOpenSubscription(ctx, userId, sub.id)) {
    return log(ctx, `${sub.id} is not the user's current subscription; no grant`);
  }
  await entitlementRpc(
    ctx,
    'grant_unlimited_from_subscription',
    { p_user_id: userId, p_paid_through: iso(line.period.end + PAID_THROUGH_BUFFER_SECONDS), p_mode: ctx.mode },
    'grant'
  );
}

/** invoice.payment_failed: revoke now (founder 2026-10-09), unless the invoice has since been paid. */
export async function handleInvoicePaymentFailed(ctx: BillingContext, invoiceId: string): Promise<void> {
  const invoice = await ctx.stripe.invoices.retrieve(invoiceId);
  if (invoice.status === 'paid') return log(ctx, `invoice ${invoice.id} is now paid; no revoke`);
  const subId = stripeId(invoice.subscription);
  if (!subId) return;
  const sub = await ctx.stripe.subscriptions.retrieve(subId);
  const userId = await resolveAgentUser(ctx, sub, 'payment_failed');
  if (!userId) return;
  const outcome = await syncSubscription(ctx, sub, userId, { advanceCursor: false });
  if (outcome === 'duplicate' || outcome === 'refused') return;
  await revokeIfCurrent(ctx, userId, sub.id, 'payment_failed');
}

/**
 * charge.refunded on a subscription invoice charge. A full refund of the
 * invoice paying the current period revokes (D6 + founder 2026-10-11); a
 * partial refund or an older period's invoice does not.
 */
export async function handleInvoiceChargeRefunded(
  ctx: BillingContext,
  charge: Stripe.Charge,
  invoiceRef: string | Stripe.Invoice
): Promise<void> {
  if (charge.refunded !== true) return log(ctx, `charge ${charge.id} partially refunded; no revoke`);
  const invoice = await invoiceOf(ctx, invoiceRef);
  const subId = invoice ? stripeId(invoice.subscription) : null;
  if (!invoice || !subId) return;
  const sub = await ctx.stripe.subscriptions.retrieve(subId);
  const userId = await resolveAgentUser(ctx, sub, 'refund');
  if (!userId) return;
  const line = subscriptionLine(invoice);
  if (!line || line.period.end < sub.current_period_end) {
    return log(ctx, `refunded invoice ${invoice.id} is not for the current period; no revoke`);
  }
  const outcome = await syncSubscription(ctx, sub, userId, { advanceCursor: false });
  if (outcome === 'duplicate' || outcome === 'refused') return;
  await revokeIfCurrent(ctx, userId, sub.id, 'refund');
}

/**
 * charge.dispute.created on a subscription invoice (R4 of plan v3): suspend the
 * stored Agent user and revoke. The Stripe-side pause is the licences trigger's
 * job (3878), not the webhook's.
 */
export async function handleInvoiceDispute(
  ctx: BillingContext,
  dispute: Stripe.Dispute,
  piId: string,
  invoice: Stripe.Invoice
): Promise<void> {
  const subId = stripeId(invoice.subscription);
  if (!subId) {
    console.error(`[billing/sync] dispute ${dispute.id}: invoice ${invoice.id} has no subscription; nothing to suspend`);
    return;
  }
  const sub = await ctx.stripe.subscriptions.retrieve(subId);
  const userId = await resolveAgentUser(ctx, sub, 'dispute');
  if (!userId) return;

  const { error } = await ctx.service.rpc('suspend_account_for_dispute', {
    p_user_id: userId,
    p_stripe_dispute_id: dispute.id,
    p_payment_intent_id: piId,
    p_local_transaction_id: null,
    p_amount_cents: dispute.amount ?? null,
    p_dispute_created_at: iso(dispute.created),
  });
  if (error) throw new Error(`suspend_account_for_dispute failed: ${error.message}`);

  const outcome = await syncSubscription(ctx, sub, userId, { advanceCursor: false });
  if (outcome === 'duplicate' || outcome === 'refused') return;
  await revokeIfCurrent(ctx, userId, sub.id, 'dispute');
}

/** checkout.session.completed in subscription mode: make sure the row exists. */
export async function handleSubscriptionCheckout(ctx: BillingContext, session: Stripe.Checkout.Session): Promise<void> {
  const subId = stripeId(session.subscription);
  if (!subId) return log(ctx, `subscription session ${session.id} has no subscription yet`);
  const sub = await ctx.stripe.subscriptions.retrieve(subId);
  const userId = await resolveAgentUser(ctx, sub, 'checkout');
  if (!userId) return;
  await syncSubscription(ctx, sub, userId, { advanceCursor: false });
}
