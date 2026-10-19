/**
 * Stripe webhook -> brokerage subscription billing (BACKLOG-3853 PR-2).
 *
 * dispatchBrokerageEvent runs in the webhook route BEFORE the Agent / per-export switch, and
 * only for BROKERAGE_EVENT_TYPES (SR plan review item 4: the $14.99 events never pay an extra
 * Stripe read or a DB lookup here). It re-fetches the object (E0: ids only from the payload),
 * takes its Stripe customer and looks the customer up in org_billing_stripe for this mode.
 *   - Row found -> the brokerage handler runs and the event never reaches the Agent path,
 *     handleChargeRefunded or handleDispute (no 'not_agent_kind' refusal, no
 *     suspend_account_for_dispute).
 *   - No row, but the object says metadata.kind = 'brokerage' -> an orphan (harness cleanup,
 *     a deleted test organization, another environment on the same sandbox): alert and 200,
 *     never the Agent path (SR plan review item 6).
 *   - Otherwise false: today's path runs unchanged.
 *
 * Rules (founder rulings, pm_comments on BACKLOG-3853):
 *   - Overdue NEVER suspends. customer.subscription.* re-fetched as past_due -> one email to the
 *     account manager per overdue invoice (kind notify_account_manager), skipped while the oldest
 *     overdue invoice's payment is processing or needs action (spike #9, #10).
 *   - Auto-reinstate only a 'non_payment' suspension, from invoice.paid AND from
 *     subscription.updated -> active (Stripe sends ->active after invoice.paid, spike #7), and
 *     only when no open invoice is past due. invoice.paid records the payment on the mirror;
 *     _billing_auto_reinstate also requires a payment after the suspension began.
 *   - invoice.payment_failed with the PaymentIntent in requires_action (ACH needs verification)
 *     is not a failure: log only.
 *   - Refund or dispute on a brokerage payment: alert + account-manager email; never a suspension.
 *   - "Now" for due dates is the customer's test clock time when it has one (SR plan review
 *     item 5); due_date is clock time, event.created is wall time.
 *
 * Known limit (SR plan review): while already past_due, a second invoice going overdue emits no
 * subscription event, so its account-manager email waits for the next subscription event.
 */

import type Stripe from 'stripe';
import { billingAlert } from './alert';
import { enqueueOutbox } from './outboxEnqueue';
import { NOTIFY_ACCOUNT_MANAGER_KIND } from './brokerageNotify';
import { type BillingContext, stripeId } from './sync';
import { listOpenInvoices, overdueOf, stripeNow } from './overdue';

export const BROKERAGE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
  'charge.refunded',
  'charge.dispute.created',
]);

const PENDING_PAYMENT = new Set(['processing', 'requires_action']);

type Target =
  | { kind: 'subscription'; customerId: string; brokerageMeta: boolean; sub: Stripe.Subscription }
  | { kind: 'invoice'; customerId: string; brokerageMeta: boolean; inv: Stripe.Invoice }
  | { kind: 'charge'; customerId: string; brokerageMeta: false; charge: Stripe.Charge }
  | { kind: 'dispute'; customerId: string; brokerageMeta: false; dispute: Stripe.Dispute };

function log(ctx: BillingContext, msg: string): void {
  console.info(`[billing/brokerage] ${ctx.event.type} ${ctx.event.id}: ${msg}`);
}

function invoiceSubMeta(inv: Stripe.Invoice): Record<string, string> | undefined {
  const i = inv as unknown as {
    subscription_details?: { metadata?: Record<string, string> } | null;
    parent?: { subscription_details?: { metadata?: Record<string, string> } | null } | null;
  };
  return i.subscription_details?.metadata ?? i.parent?.subscription_details?.metadata ?? undefined;
}

function invoiceSubscriptionId(inv: Stripe.Invoice): string | null {
  const i = inv as unknown as {
    subscription?: string | { id: string } | null;
    parent?: { subscription_details?: { subscription?: string | { id: string } | null } | null } | null;
  };
  return stripeId(i.subscription ?? i.parent?.subscription_details?.subscription ?? null);
}

function invoicePaymentIntentId(inv: Stripe.Invoice): string | null {
  return stripeId((inv as unknown as { payment_intent?: string | { id: string } | null }).payment_intent ?? null);
}

async function resolveTarget(ctx: BillingContext, objectId: string): Promise<Target | null> {
  const type = ctx.event.type;
  if (type.startsWith('customer.subscription.')) {
    const sub = await ctx.stripe.subscriptions.retrieve(objectId);
    const customerId = stripeId(sub.customer);
    return customerId ? { kind: 'subscription', customerId, brokerageMeta: sub.metadata?.kind === 'brokerage', sub } : null;
  }
  if (type.startsWith('invoice.')) {
    const inv = await ctx.stripe.invoices.retrieve(objectId);
    const customerId = stripeId(inv.customer);
    return customerId ? { kind: 'invoice', customerId, brokerageMeta: invoiceSubMeta(inv)?.kind === 'brokerage', inv } : null;
  }
  if (type === 'charge.refunded') {
    const charge = await ctx.stripe.charges.retrieve(objectId);
    const customerId = stripeId(charge.customer);
    return customerId ? { kind: 'charge', customerId, brokerageMeta: false, charge } : null;
  }
  if (type === 'charge.dispute.created') {
    const dispute = await ctx.stripe.disputes.retrieve(objectId);
    // The PaymentIntent carries the customer (the Agent dispute path reads the same object).
    const piId = stripeId(dispute.payment_intent);
    if (!piId) return null;
    const pi = await ctx.stripe.paymentIntents.retrieve(piId);
    const customerId = stripeId(pi.customer);
    return customerId ? { kind: 'dispute', customerId, brokerageMeta: false, dispute } : null;
  }
  return null;
}

async function orgForCustomer(ctx: BillingContext, customerId: string): Promise<string | null> {
  const { data, error } = await ctx.service
    .from('org_billing_stripe')
    .select('organization_id')
    .eq('stripe_customer_id', customerId)
    .eq('stripe_mode', ctx.mode)
    .maybeSingle();
  // A failed read is not "no row": throw so Stripe retries (never fall to the Agent path).
  if (error) throw new Error(`org_billing_stripe lookup failed: ${error.code ?? 'unknown'}`);
  return (data as { organization_id?: string } | null)?.organization_id ?? null;
}

async function rpc<T>(ctx: BillingContext, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await ctx.service.rpc(fn, args);
  if (error) throw new Error(`${fn} failed: ${error.code ?? 'unknown'}`);
  return data as T;
}

export { stripeNow } from './overdue';

/** Open invoices whose due date has passed, oldest due first (the rule lives in ./overdue.ts). */
async function overdueInvoices(ctx: BillingContext, customerId: string, now: number): Promise<Stripe.Invoice[]> {
  return overdueOf(await listOpenInvoices(ctx, customerId), now);
}

async function notifyAccountManager(
  ctx: BillingContext,
  org: string,
  reason: 'overdue' | 'payment_failed' | 'refund' | 'dispute',
  stripeObjectId: string,
  dedupeSuffix: string
): Promise<void> {
  const res = await enqueueOutbox(ctx.service, {
    mode: ctx.mode,
    kind: NOTIFY_ACCOUNT_MANAGER_KIND,
    organizationId: org,
    dedupeKey: `${NOTIFY_ACCOUNT_MANAGER_KIND}:${ctx.mode}:${org}:${reason}:${dedupeSuffix}`,
    payload: { organization_id: org, reason, stripe_object_id: stripeObjectId },
    runAfter: new Date(),
  });
  log(ctx, `account-manager ${reason} email ${res}`);
}

async function maybeNotifyOverdue(ctx: BillingContext, org: string, customerId: string): Promise<void> {
  const now = await stripeNow(ctx, customerId);
  const overdue = await overdueInvoices(ctx, customerId, now);
  const oldest = overdue[0];
  if (!oldest) {
    log(ctx, 'past_due but no open invoice is past its due date');
    return;
  }
  const piId = invoicePaymentIntentId(oldest);
  if (piId) {
    const pi = await ctx.stripe.paymentIntents.retrieve(piId);
    if (PENDING_PAYMENT.has(pi.status)) {
      log(ctx, `overdue invoice ${oldest.id} has a payment ${pi.status}; no email`);
      return;
    }
  }
  await notifyAccountManager(ctx, org, 'overdue', oldest.id, oldest.id);
}

async function tryAutoReinstate(ctx: BillingContext, org: string, sub: Stripe.Subscription, customerId: string): Promise<void> {
  if (sub.status !== 'active') return;
  const { data, error } = await ctx.service
    .from('org_deals')
    .select('status, suspended_reason')
    .eq('organization_id', org)
    .maybeSingle();
  if (error) throw new Error(`org_deals read failed: ${error.code ?? 'unknown'}`);
  const deal = data as { status?: string; suspended_reason?: string | null } | null;
  if (deal?.status !== 'suspended' || deal.suspended_reason !== 'non_payment') return;
  const now = await stripeNow(ctx, customerId);
  if ((await overdueInvoices(ctx, customerId, now)).length > 0) {
    log(ctx, 'suspended for non-payment and an invoice is still past due; stays suspended');
    return;
  }
  const res = await rpc<{ success?: boolean; error?: string }>(ctx, '_billing_auto_reinstate', { p_org: org, p_mode: ctx.mode });
  log(ctx, `auto-reinstate: ${res?.success ? 'reinstated' : `refused (${res?.error ?? 'unknown'})`}`);
}

function iso(seconds: number | null | undefined): string | null {
  return typeof seconds === 'number' ? new Date(seconds * 1000).toISOString() : null;
}

/** Mirror a re-fetched brokerage subscription. Returns false when it is not this org's subscription. */
async function mirrorSubscription(ctx: BillingContext, org: string, sub: Stripe.Subscription): Promise<boolean> {
  if (sub.metadata?.kind !== 'brokerage') {
    log(ctx, `subscription ${sub.id} on a brokerage customer is not a brokerage subscription; ignored`);
    return false;
  }
  const { data, error } = await ctx.service
    .from('org_billing_stripe')
    .select('stripe_subscription_id')
    .eq('organization_id', org)
    .eq('stripe_mode', ctx.mode)
    .maybeSingle();
  if (error) throw new Error(`org_billing_stripe read failed: ${error.code ?? 'unknown'}`);
  const stored = (data as { stripe_subscription_id?: string | null } | null)?.stripe_subscription_id ?? null;
  if (stored && stored !== sub.id) {
    log(ctx, `subscription ${sub.id} is not the stored one; ignored`);
    return false;
  }
  const s = sub as unknown as { current_period_end?: number | null };
  await rpc(ctx, '_billing_apply_org_subscription', {
    p_org: org,
    p_mode: ctx.mode,
    p_fields: {
      stripe_customer_id: stripeId(sub.customer),
      stripe_subscription_id: sub.id,
      status: sub.status,
      current_period_end: iso(s.current_period_end),
      cancel_at_period_end: sub.cancel_at_period_end === true,
      collection_method: sub.collection_method,
    },
    p_event_created: ctx.event.created,
  });
  return true;
}

export async function dispatchBrokerageEvent(ctx: BillingContext, objectId: string): Promise<boolean> {
  if (!BROKERAGE_EVENT_TYPES.has(ctx.event.type)) return false;
  const target = await resolveTarget(ctx, objectId);
  if (!target) return false;
  const org = await orgForCustomer(ctx, target.customerId);
  if (!org) {
    if (target.brokerageMeta) {
      billingAlert('brokerage_orphan_object', ctx.mode, { event_id: ctx.event.id, event_type: ctx.event.type, object_id: objectId });
      return true;
    }
    return false;
  }

  switch (target.kind) {
    case 'subscription': {
      if (!(await mirrorSubscription(ctx, org, target.sub))) return true;
      if (target.sub.status === 'past_due') await maybeNotifyOverdue(ctx, org, target.customerId);
      else if (target.sub.status === 'active') await tryAutoReinstate(ctx, org, target.sub, target.customerId);
      return true;
    }
    case 'invoice': {
      const inv = target.inv;
      if (ctx.event.type === 'invoice.paid') {
        if (inv.status !== 'paid') {
          log(ctx, `invoice ${inv.id} re-fetched as ${inv.status}; nothing to do`);
          return true;
        }
        await rpc(ctx, '_billing_record_invoice_paid', { p_org: org, p_mode: ctx.mode, p_event_created: ctx.event.created });
        const subId = invoiceSubscriptionId(inv);
        if (!subId) return true;
        const sub = await ctx.stripe.subscriptions.retrieve(subId);
        if (await mirrorSubscription(ctx, org, sub)) await tryAutoReinstate(ctx, org, sub, target.customerId);
        return true;
      }
      // invoice.payment_failed
      const piId = invoicePaymentIntentId(inv);
      if (piId) {
        const pi = await ctx.stripe.paymentIntents.retrieve(piId);
        if (pi.status === 'requires_action') {
          log(ctx, `invoice ${inv.id}: payment needs verification (requires_action); not a failure`);
          return true;
        }
      }
      await notifyAccountManager(ctx, org, 'payment_failed', inv.id, inv.id);
      return true;
    }
    case 'charge':
      billingAlert('brokerage_refund_or_dispute', ctx.mode, { organization_id: org, kind: 'refund', charge_id: target.charge.id });
      await notifyAccountManager(ctx, org, 'refund', target.charge.id, ctx.event.id);
      return true;
    case 'dispute':
      billingAlert('brokerage_refund_or_dispute', ctx.mode, { organization_id: org, kind: 'dispute', dispute_id: target.dispute.id });
      await notifyAccountManager(ctx, org, 'dispute', target.dispute.id, target.dispute.id);
      return true;
  }
}
