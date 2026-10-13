/**
 * Pause an Agent plan while the account is suspended, resume it on
 * reinstatement — BACKLOG-3878 PR-2.
 *
 * The rows come from the licences trigger (migration 20261013170000):
 * `licenses.status` -> 'suspended' enqueues `pause_agent_subscription`,
 * 'suspended' -> 'active' enqueues `resume_agent_subscription`, one row per
 * stripe_customers row of the user (one per mode). The nightly reconcile
 * enqueues a pause too when it finds a suspended licence with an unpaused plan
 * (SR R7). Both handlers converge from the licence and from Stripe, never from
 * the mirror (SR R6: the mirror lags the webhook).
 *
 * PAUSE (founder Q2 2026-10-13: forgive the open bill, then pause; measured in
 * Stripe TEST: a pause alone lets Stripe's retry charge the open renewal while
 * suspended, and the resume charges again):
 *   1. licence no longer suspended -> nothing (reinstated before the drain);
 *   2. every OPEN Checkout session of the customer is expired first, so a
 *      session opened before the suspension cannot start a new plan or buy an
 *      export afterwards (SR R6);
 *   3. per open Agent subscription: every OPEN invoice is voided (drafts are
 *      left alone: the pause finalizes them void, Y1), then
 *      `pause_collection{behavior:'void'}` unless already paused. An
 *      `incomplete` subscription is only voided (that ends it, BACKLOG-3847);
 *   4. SR R8: a paid invoice with paid_at at or after the suspension (the row's
 *      created_at), or a void refused because the invoice was paid meanwhile,
 *      raises `paid_while_suspended`. Never an automatic refund.
 *
 * RESUME (step 0 rule 3 + SR R5), per Agent subscription of the customer:
 *   - licence not `active` -> nothing (a reinstatement to `expired` or a new
 *     suspension: the plan stays paused, support decides);
 *   - canceled / incomplete_expired, or not paused -> nothing (never re-anchor
 *     a live plan; X3: Stripe refuses to update a canceled one);
 *   - `cancel_at_period_end` -> `pause_collection:''` only; no charge, the plan
 *     ends on its date; the grant is repaired as below when it is still paid;
 *   - latest invoice `paid` and its subscription line ends after now (the paid
 *     period is still running) -> `pause_collection:''` only, then the grant is
 *     repaired with handleInvoicePaid(latest) (X4: no invoice, same period end);
 *   - otherwise -> one new month from today: `pause_collection:''`,
 *     `billing_cycle_anchor:'now'`, `proration_behavior:'none'`,
 *     `metadata.keepr_resume = row.id`. Stripe copies the marker to the
 *     invoice's `subscription_details.metadata`, and that exact id is what lets
 *     the resume charge grant (sync.ts D2). A recent invoice already carrying
 *     this row's marker means the charge was made: nothing more (contract (c)).
 *     A failing card leaves the normal payment-failed path (Y2).
 *
 * Contract (lib/billing/outboxKinds.ts): (a) converge from current state;
 * (b) keys from outboxIdempotencyKey; (c) above; (d) NonRetryableOutboxError
 * for a bad row; (e) ctx.deadline checked before every Stripe call after the
 * first.
 */

import type Stripe from 'stripe';
import type { createServiceClient } from '@/lib/supabase/service';
import { billingAlert } from './alert';
import { getStripeCustomer } from './customers';
import { NonRetryableOutboxError, outboxIdempotencyKey, type OutboxHandler, type OutboxHandlerContext, type OutboxRow } from './outboxKinds';
import { handleInvoicePaid, listAll, RESUME_KIND, stripeId, subscriptionLine, type BillingContext } from './sync';

type ServiceClient = ReturnType<typeof createServiceClient>;

export const PAUSE_KIND = 'pause_agent_subscription';
export { RESUME_KIND };

/** Subscription statuses with nothing left to pause or resume. */
const CLOSED = new Set(['canceled', 'incomplete_expired']);
/** Statuses that take a pause (an `incomplete` one is ended by its void instead). */
const PAUSABLE = new Set(['active', 'trialing', 'past_due', 'unpaid']);
/** Recent invoices read for the R8 check and the resume marker (contract (c)). */
const RECENT_INVOICES = 10;

/** The user's licence status, or null when there is no licence row. Throws on a read error (retried). */
export async function licenceStatus(service: ServiceClient, userId: string): Promise<string | null> {
  const { data, error } = await service.from('licenses').select('status').eq('user_id', userId).maybeSingle();
  if (error) throw new Error(`licenses read failed: ${error.code ?? 'unknown'}`);
  return (data as { status?: string } | null)?.status ?? null;
}

function isAgent(sub: Pick<Stripe.Subscription, 'metadata'>): boolean {
  return !sub.metadata?.kind || sub.metadata.kind === 'agent';
}

/** Contract (e): the first Stripe call runs; every later one only before the deadline. */
function stripeGate(ctx: OutboxHandlerContext): () => void {
  let first = true;
  return () => {
    if (!first && Date.now() >= ctx.deadline.getTime()) throw new Error('outbox deadline reached');
    first = false;
  };
}

async function customerOf(row: OutboxRow, ctx: OutboxHandlerContext): Promise<string | null> {
  const c = await getStripeCustomer(ctx.service, row.user_id as string, ctx.mode);
  return c?.stripe_customer_id ?? null;
}

async function agentSubscriptions(ctx: OutboxHandlerContext, customerId: string, gate: () => void): Promise<Stripe.Subscription[]> {
  const subs = await listAll((after) => {
    gate();
    return ctx.stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100, ...(after ? { starting_after: after } : {}) });
  });
  return subs.filter(isAgent);
}

// ------------------------------------------------------------------- pause

export const handlePauseRow: OutboxHandler = async (row, ctx) => {
  if (!row.user_id) throw new NonRetryableOutboxError('bad_payload');
  if ((await licenceStatus(ctx.service, row.user_id)) !== 'suspended') return;
  const customerId = await customerOf(row, ctx);
  if (!customerId) return;
  const gate = stripeGate(ctx);
  const suspendedAt = Math.floor(Date.parse(row.created_at) / 1000);

  // Step 2: open Checkout sessions first, so no new plan appears after the list below.
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

  // Step 3.
  for (const sub of await agentSubscriptions(ctx, customerId, gate)) {
    if (CLOSED.has(sub.status)) continue;
    const open = await listAll((after) => {
      gate();
      return ctx.stripe.invoices.list({ subscription: sub.id, status: 'open', limit: 100, ...(after ? { starting_after: after } : {}) });
    });
    for (const inv of open) {
      gate();
      try {
        await ctx.stripe.invoices.voidInvoice(inv.id, {}, { idempotencyKey: outboxIdempotencyKey(row, `void:${inv.id}`) });
      } catch (err) {
        gate();
        const now = await ctx.stripe.invoices.retrieve(inv.id);
        if (now.status === 'paid') {
          billingAlert('paid_while_suspended', ctx.mode, { subscription_id: sub.id, invoice_id: inv.id, outbox_id: row.id });
          continue;
        }
        if (now.status !== 'void') throw err;
      }
    }

    // Step 4 (SR R8): paid at or after the suspension.
    gate();
    const recent = await ctx.stripe.invoices.list({ subscription: sub.id, status: 'paid', limit: RECENT_INVOICES });
    for (const inv of recent.data) {
      const paidAt = inv.status_transitions?.paid_at;
      if (typeof paidAt === 'number' && paidAt >= suspendedAt) {
        billingAlert('paid_while_suspended', ctx.mode, { subscription_id: sub.id, invoice_id: inv.id, outbox_id: row.id });
      }
    }

    if (!PAUSABLE.has(sub.status) || sub.pause_collection) continue;
    gate();
    await ctx.stripe.subscriptions.update(
      sub.id,
      { pause_collection: { behavior: 'void' } },
      { idempotencyKey: outboxIdempotencyKey(row, `pause:${sub.id}`) }
    );
  }
};

// ------------------------------------------------------------------ resume

function grantContext(row: OutboxRow, ctx: OutboxHandlerContext): BillingContext {
  // A synthetic event, like the nightly reconcile's: handleInvoicePaid reads
  // only the id and type for its log lines and never moves the webhook cursor.
  return {
    service: ctx.service,
    stripe: ctx.stripe,
    mode: ctx.mode,
    event: { id: `resume:${row.id}`, type: 'reconcile', livemode: ctx.mode === 'live', created: Math.floor(Date.now() / 1000) },
  };
}

/** The latest invoice when it is paid and pays a period that is still running, else null. */
async function paidRunningInvoice(ctx: OutboxHandlerContext, sub: Stripe.Subscription, gate: () => void): Promise<Stripe.Invoice | null> {
  const latestId = stripeId(sub.latest_invoice);
  if (!latestId) return null;
  gate();
  const latest = await ctx.stripe.invoices.retrieve(latestId);
  if (latest.status !== 'paid') return null;
  const line = subscriptionLine(latest);
  return line && line.period.end > Math.floor(Date.now() / 1000) ? latest : null;
}

async function unpauseOnly(row: OutboxRow, ctx: OutboxHandlerContext, sub: Stripe.Subscription, gate: () => void): Promise<void> {
  gate();
  await ctx.stripe.subscriptions.update(sub.id, { pause_collection: '' }, { idempotencyKey: outboxIdempotencyKey(row, `unpause:${sub.id}`) });
}

export const handleResumeRow: OutboxHandler = async (row, ctx) => {
  if (!row.user_id) throw new NonRetryableOutboxError('bad_payload');
  if ((await licenceStatus(ctx.service, row.user_id)) !== 'active') return;
  const customerId = await customerOf(row, ctx);
  if (!customerId) return;
  const gate = stripeGate(ctx);

  for (const sub of await agentSubscriptions(ctx, customerId, gate)) {
    if (CLOSED.has(sub.status) || !sub.pause_collection) continue;

    const running = await paidRunningInvoice(ctx, sub, gate);
    if (sub.cancel_at_period_end || running) {
      await unpauseOnly(row, ctx, sub, gate);
      if (running) {
        gate();
        await handleInvoicePaid(grantContext(row, ctx), running.id);
      }
      continue;
    }

    // Contract (c): this row's resume already charged.
    gate();
    const recent = await ctx.stripe.invoices.list({ subscription: sub.id, limit: RECENT_INVOICES });
    if (recent.data.some((i) => i.subscription_details?.metadata?.keepr_resume === row.id)) continue;

    const params: Stripe.SubscriptionUpdateParams = {
      pause_collection: '',
      billing_cycle_anchor: 'now',
      proration_behavior: 'none',
      metadata: { keepr_resume: row.id },
    };
    gate();
    await ctx.stripe.subscriptions.update(sub.id, params, { idempotencyKey: outboxIdempotencyKey(row, `resume:${sub.id}`, params) });
  }
};
