/**
 * End the personal Agent plan when the person joins a brokerage — BACKLOG-3850.
 *
 * Plan pm_comments d443fb5b; SR review 989c8798 (R3-R6, R8); founder Q1/Q2 dd904bb8 and
 * 35b3b3ab; rulings 89ef80a7 (F2, F3, F6).
 *
 * The rows come from the database: `_retire_personal_membership` enqueues kind
 * `cancel_agent_on_brokerage_join` when a brokerage membership retires the personal one
 * (migration 20261111130000), one row per stripe_customers mode, payload
 * {brokerage_organization_id, member_id, stripe_customer_id}. The nightly reconcile enqueues the
 * same kind when it finds a brokerage member still on an Agent plan (lib/billing/reconcile.ts).
 *
 * Every joiner's plan ends, licensed or not (35b3b3ab). The brokerage covers checkout from then on:
 * subscription-session refuses every brokerage member, so a running Agent plan is a double payment.
 *
 * Order (R3, R4, R5), converging from our DB and from Stripe, never from the billing_subscriptions
 * mirror (R8):
 *   1. superseded re-read, DB only, ZERO Stripe calls on a miss: the member row still belongs to
 *      this user at this brokerage and is not deactivated, the organization is not a personal one,
 *      and the user has no personal membership again (a deactivation reverts to pay-as-you-go);
 *   2. ownership (F3): the user's current stripe_customers row in this mode is still the
 *      customer in the payload, else NonRetryable `not_owner`; a customer that is a brokerage's
 *      own (org_billing_stripe) is NonRetryable `brokerage_customer`;
 *   3. every OPEN Checkout session of the customer is expired, so none can start a plan later;
 *   4. per non-closed Agent subscription (paused ones included, F2): every OPEN invoice is voided
 *      (founder Q2). A void refused because it was paid meanwhile raises `paid_at_brokerage_join`
 *      and the plan is still ended (no refund, ever). An `incomplete` subscription is only voided
 *      (that ends it). Then `subscriptions.cancel(prorate:false, invoice_now:false)`, the mirror
 *      write-through, and one more pass over open invoices (one that appeared meanwhile is voided).
 *      Never cancel_at_period_end, never a refund or a credit note;
 *   5. the email (R6, 35b3b3ab): once per row (email_delivery_log kind agent_plan_ended_on_join +
 *      outboxKey), only when this run ended a plan or Stripe shows an Agent plan of this customer
 *      canceled at or after the row was queued (a retry after cancel-then-send-failure). Copy by
 *      license_status at run time: 'active' -> licensed, anything else -> unlicensed (F6).
 *
 * Contract (lib/billing/outboxKinds.ts): (a) converge; (b) keys from outboxIdempotencyKey;
 * (c) nothing here charges; (d) NonRetryableOutboxError for a bad row; (e) stripeGate before every
 * Stripe call after the first.
 */

import type Stripe from 'stripe';
import { sendAgentPlanEndedEmail } from '@/lib/email';
import type { createServiceClient } from '@/lib/supabase/service';
import { billingAlert } from './alert';
import { billingContactEmail } from './contact';
import { getPersonalOrganization, getStripeCustomer } from './customers';
import { writeThroughEnded } from './endPlanNow';
import { NonRetryableOutboxError, outboxIdempotencyKey, type OutboxHandler, type OutboxHandlerContext, type OutboxRow } from './outboxKinds';
import { agentSubscriptions, stripeGate } from './suspension';
import { listAll } from './sync';

/** Same base as the payment-failed email's links (paymentFailedNotify.ts). */
function portalBaseUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || 'https://app.keeprcompliance.com';
}
const SUPPORT_NEW_PATH = '/support/new';

type ServiceClient = ReturnType<typeof createServiceClient>;

export { JOIN_CANCEL_KIND } from './joinCancelKind';
export const AGENT_PLAN_ENDED_LOG_KIND = 'agent_plan_ended_on_join';

/** Nothing left to end. */
const CLOSED = new Set(['canceled', 'incomplete_expired']);
/** organization_members statuses that mean the member left (member_status_is_deactivated). */
const DEACTIVATED = new Set(['suspended', 'expired']);

interface MemberRow {
  id: string;
  user_id: string | null;
  organization_id: string;
  license_status: string | null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function skip(row: OutboxRow, code: string): void {
  console.info(`[billing/join-cancel] ${row.id}: ${code}; nothing to do`);
}

/**
 * Step 1: the member row when the join still stands, else null (the row is superseded).
 * DB reads only. Throws on a read error (retried).
 */
async function standingJoin(
  service: ServiceClient,
  userId: string,
  memberId: string,
  brokerageId: string
): Promise<{ member: MemberRow; brokerageName: string } | null> {
  const { data: m, error: mErr } = await service
    .from('organization_members')
    .select('id, user_id, organization_id, license_status')
    .eq('id', memberId)
    .maybeSingle();
  if (mErr) throw new Error(`organization_members read failed: ${mErr.code ?? 'unknown'}`);
  const member = m as MemberRow | null;
  if (!member || member.user_id !== userId || member.organization_id !== brokerageId) return null;
  if (DEACTIVATED.has(member.license_status ?? '')) return null;

  const { data: o, error: oErr } = await service
    .from('organizations')
    .select('id, name, personal_owner_user_id')
    .eq('id', brokerageId)
    .maybeSingle();
  if (oErr) throw new Error(`organizations read failed: ${oErr.code ?? 'unknown'}`);
  const org = o as { id: string; name?: string | null; personal_owner_user_id?: string | null } | null;
  if (!org || org.personal_owner_user_id) return null;

  const personal = await getPersonalOrganization(service, userId);
  if (personal) {
    const { data: pm, error: pErr } = await service
      .from('organization_members')
      .select('id')
      .eq('organization_id', personal.id)
      .eq('user_id', userId)
      .limit(1);
    if (pErr) throw new Error(`organization_members read failed: ${pErr.code ?? 'unknown'}`);
    if (Array.isArray(pm) && pm.length > 0) return null; // reverted to pay-as-you-go
  }
  return { member, brokerageName: (org.name ?? '').trim() || 'your brokerage' };
}

/** Step 2 (F3 + R4): the payload's customer is still this user's, and not a brokerage's own. */
async function assertOwnCustomer(row: OutboxRow, ctx: OutboxHandlerContext, userId: string, customerId: string): Promise<void> {
  const current = await getStripeCustomer(ctx.service, userId, ctx.mode);
  if (!current || current.stripe_customer_id !== customerId) throw new NonRetryableOutboxError('not_owner');
  const { data, error } = await ctx.service
    .from('org_billing_stripe')
    .select('organization_id')
    .eq('stripe_customer_id', customerId)
    .eq('stripe_mode', ctx.mode)
    .limit(1);
  if (error) throw new Error(`org_billing_stripe read failed: ${error.code ?? 'unknown'}`);
  if (Array.isArray(data) && data.length > 0) throw new NonRetryableOutboxError('brokerage_customer');
}

/** Step 4 (Q2 / R5): void every open invoice of one subscription. A paid one is reported, never refunded. */
async function voidOpenInvoices(row: OutboxRow, ctx: OutboxHandlerContext, subId: string, gate: () => void): Promise<void> {
  const open = await listAll((after) => {
    gate();
    return ctx.stripe.invoices.list({ subscription: subId, status: 'open', limit: 100, ...(after ? { starting_after: after } : {}) });
  });
  for (const inv of open) {
    gate();
    try {
      await ctx.stripe.invoices.voidInvoice(inv.id, {}, { idempotencyKey: outboxIdempotencyKey(row, `void:${inv.id}`) });
    } catch (err) {
      gate();
      const now = await ctx.stripe.invoices.retrieve(inv.id);
      if (now.status === 'paid') {
        billingAlert('paid_at_brokerage_join', ctx.mode, { subscription_id: subId, invoice_id: inv.id, outbox_id: row.id });
        continue;
      }
      if (now.status === 'void' || now.status === 'uncollectible') continue;
      throw err;
    }
  }
}

async function alreadySent(service: ServiceClient, outboxKey: string): Promise<boolean> {
  const { data, error } = await service
    .from('email_delivery_log')
    .select('id')
    .eq('metadata->>kind', AGENT_PLAN_ENDED_LOG_KIND)
    .eq('metadata->>outboxKey', outboxKey)
    .in('status', ['sent', 'queued'])
    .limit(1);
  if (error) throw new Error(`email_delivery_log read failed: ${error.code ?? 'unknown'}`);
  return Array.isArray(data) && data.length > 0;
}

export const handleJoinCancelRow: OutboxHandler = async (row, ctx) => {
  const userId = row.user_id;
  const brokerageId = str(row.payload?.brokerage_organization_id);
  const memberId = str(row.payload?.member_id);
  const customerId = str(row.payload?.stripe_customer_id);
  if (!userId || !brokerageId || !memberId || !customerId) throw new NonRetryableOutboxError('bad_payload');

  // Step 1: superseded -> nothing, and no Stripe call.
  const join = await standingJoin(ctx.service, userId, memberId, brokerageId);
  if (!join) return skip(row, 'superseded');
  // Step 2.
  await assertOwnCustomer(row, ctx, userId, customerId);

  const gate = stripeGate(ctx);
  const queuedAt = Math.floor(Date.parse(row.created_at) / 1000);

  // Step 3: open Checkout sessions first, so no new plan appears after the list below.
  const sessions = await listAll((after) => {
    gate();
    return ctx.stripe.checkout.sessions.list({ customer: customerId, status: 'open', limit: 100, ...(after ? { starting_after: after } : {}) });
  });
  for (const s of sessions) {
    gate();
    try {
      await ctx.stripe.checkout.sessions.expire(s.id);
    } catch (err) {
      gate();
      const now = await ctx.stripe.checkout.sessions.retrieve(s.id);
      if (now.status === 'open') throw err;
    }
  }

  // Step 4.
  let endedHere = 0;
  let endedEarlier = false;
  for (const sub of await agentSubscriptions(ctx, customerId, gate)) {
    if (CLOSED.has(sub.status)) {
      if (sub.status === 'canceled' && typeof sub.canceled_at === 'number' && sub.canceled_at >= queuedAt) {
        // A previous try ended it: converge the mirror (the webhook may have missed it).
        endedEarlier = true;
        await writeThroughEnded(ctx.service, { userId, mode: ctx.mode, subscription: sub });
      }
      continue;
    }
    await voidOpenInvoices(row, ctx, sub.id, gate);
    if (sub.status === 'incomplete') continue; // the void ends it
    gate();
    const ended: Stripe.Subscription = await ctx.stripe.subscriptions.cancel(
      sub.id,
      { prorate: false, invoice_now: false },
      { idempotencyKey: outboxIdempotencyKey(row, `cancel:${sub.id}`) }
    );
    endedHere++;
    await writeThroughEnded(ctx.service, { userId, mode: ctx.mode, subscription: ended });
    await voidOpenInvoices(row, ctx, sub.id, gate);
  }

  // Step 5.
  if (endedHere === 0 && !endedEarlier) return skip(row, 'no_plan_ended');
  if (await alreadySent(ctx.service, row.dedupe_key)) return;
  gate();
  const customer = await ctx.stripe.customers.retrieve(customerId);
  let signIn: string | null = null;
  if (!billingContactEmail(customer, null)) {
    const { data } = await ctx.service.auth.admin.getUserById(userId);
    signIn = data?.user?.email ?? null;
  }
  const recipientEmail = billingContactEmail(customer, signIn);
  if (!recipientEmail) throw new NonRetryableOutboxError('no_recipient');

  const result = await sendAgentPlanEndedEmail({
    recipientEmail,
    brokerageName: join.brokerageName,
    licensed: join.member.license_status === 'active',
    supportUrl: `${portalBaseUrl()}${SUPPORT_NEW_PATH}`,
    outboxKey: row.dedupe_key,
    userId,
  });
  if (result.outcome === 'sent' || result.outcome === 'queued') return;
  if (result.outcome === 'skipped') throw new NonRetryableOutboxError('email_not_configured');
  throw new Error('email send failed');
};
