'use server';

/**
 * Agent plan actions on the personal Billing page — BACKLOG-3847.
 *
 * Every action, in this order, before any Stripe call:
 *   1. blockWriteDuringImpersonation(): its RESULT is checked (it returns, it
 *      does not throw; SR R7);
 *   2. the billing flag;
 *   3. who and what, recomputed on the server: signed-in personal owner, the
 *      Agent plan view, billingCapabilities() — the hidden button is not a gate;
 *   4. the action's own preconditions, then the mode guard.
 * The subscription an action changes is always the caller's own mirror row in
 * this mode, never an id from the request.
 */

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import type Stripe from 'stripe';
import { blockWriteDuringImpersonation } from '@/lib/impersonation-guards';
import { getPortalAccess } from '@/lib/auth/portalAccess';
import { createServiceClient } from '@/lib/supabase/service';
import { getStripe } from '@/lib/stripe';
import { billingEnabled } from '@/lib/billing/flag';
import { billingCapabilities, type BillingCapabilities } from '@/lib/billing/capabilities';
import { currentStripeMode, type StripeMode } from '@/lib/billing/mode';
import { ensureStripeCustomer, getStripeCustomer, isModeAllowedForUser } from '@/lib/billing/customers';
import { getAgentPlanView, getAgentPrices, isNonStripeOverride, type AgentPlanView } from '@/lib/billing/agentPlan';
import { prepareAgentCheckout } from '@/lib/billing/agentCheckout';
import { AGENT_KIND, chooseReturnBase, type AgentInterval } from '@/lib/billing/agentCheckoutParams';
import { handleSubscriptionCheckout, stripeId, writeThroughCancelFlag, type BillingContext } from '@/lib/billing/sync';

export type AgentActionResult = { error: string } | { ok: true };

const NOT_AVAILABLE = 'Billing is not available for this account.';
const NOT_NOW = 'That change is not available for your plan right now. Refresh the page.';
const SUSPENDED = 'Your account is suspended. Please contact support.';
const SUPPORT_GRANT = 'Your Unlimited exports come from Keepr. Please contact support to change your plan.';
const MODE_REFUSED = 'Payments are not available for this account.';
const BILLING_PATH = '/dashboard/billing';

interface AgentContext {
  userId: string;
  email: string | null;
  service: ReturnType<typeof createServiceClient>;
  mode: StripeMode;
  view: AgentPlanView;
  caps: BillingCapabilities;
}

async function agentContext(): Promise<AgentContext | { error: string }> {
  if (!billingEnabled()) return { error: NOT_AVAILABLE };
  const portal = await getPortalAccess();
  if (!portal) return { error: 'Please sign in again.' };
  const access = portal.access;
  // Only a personal owner has an Agent plan; refuse before any billing read.
  if (!(access.kind === 'floor' && access.via === 'personal_owner')) return { error: NOT_AVAILABLE };
  const service = createServiceClient();
  const mode = currentStripeMode();
  const view = await getAgentPlanView(service, portal.user.id, mode);
  const caps = billingCapabilities({
    access,
    isImpersonating: false,
    enabled: true,
    agentPlan: view.state,
    accountSuspended: false, // the page gate is BACKLOG-3878's; Subscribe refuses suspension itself.
    orgBillingSetUp: false,
  });
  if (!caps || caps.kind !== 'personal') return { error: NOT_AVAILABLE };
  return { userId: portal.user.id, email: portal.user.email ?? null, service, mode, view, caps };
}

async function returnBase(): Promise<string> {
  const h = await headers();
  const chosen = chooseReturnBase(h.get('x-forwarded-host') ?? h.get('host'), {
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    VERCEL_URL: process.env.VERCEL_URL,
    VERCEL_BRANCH_URL: process.env.VERCEL_BRANCH_URL,
  });
  console.info(
    `[billing/agent] checkout return base ${chosen.base} (${chosen.source}; VERCEL_BRANCH_URL ${process.env.VERCEL_BRANCH_URL ? 'set' : 'unset'})`
  );
  return chosen.base;
}

/** Subscribe: open Stripe Checkout for the Agent plan (same tab). */
export async function startAgentCheckout(interval: AgentInterval = 'month'): Promise<AgentActionResult> {
  const blocked = await blockWriteDuringImpersonation();
  if (blocked) return { error: blocked.error };
  const ctx = await agentContext();
  if ('error' in ctx) return ctx;
  const { userId, service, mode, view, caps } = ctx;

  // A payment that the grant would refuse buys nothing (SR R4: the RPC's own rules).
  if (view.suspended) return { error: SUSPENDED };
  if (isNonStripeOverride(view.override)) return { error: SUPPORT_GRANT };
  // Subscribe lives on the Agent card of "Choose a plan" (block 2), not on "Your plan".
  if (!caps.blocks.includes('choose_plan') || !caps.canPurchase) return { error: NOT_NOW };

  if (!(await isModeAllowedForUser(service, userId, mode))) return { error: MODE_REFUSED };

  const stripe = getStripe();
  const choice: AgentInterval = interval === 'year' ? 'year' : 'month';
  const price = (await getAgentPrices(stripe))[choice];
  if (!price) return { error: 'This plan is not available right now.' };

  const customerId = await ensureStripeCustomer(service, stripe, userId, ctx.email, mode);
  const result = await prepareAgentCheckout({
    stripe,
    mode,
    customerId,
    priceId: price.id,
    userId,
    organizationId: view.personalOrganizationId,
    interval: choice,
    returnBase: await returnBase(),
  });
  if ('refused' in result) return { error: result.refused };
  // Outside any try/catch: redirect() works by throwing.
  redirect(result.url);
}

async function ownSubscription(ctx: AgentContext): Promise<{ stripe: Stripe; sub: Stripe.Subscription } | { error: string }> {
  const id = ctx.view.row?.stripe_subscription_id;
  if (!id) return { error: NOT_NOW };
  if (!(await isModeAllowedForUser(ctx.service, ctx.userId, ctx.mode))) return { error: MODE_REFUSED };
  const stripe = getStripe();
  return { stripe, sub: await stripe.subscriptions.retrieve(id) };
}

/**
 * Cancel plan: ends at the end of the paid period (never an immediate cancel).
 * No idempotency key: setting the flag twice is the same request, and a fixed
 * key would replay a stale answer after End -> Keep -> End.
 */
export async function endAgentPlanAtPeriodEnd(): Promise<AgentActionResult> {
  const blocked = await blockWriteDuringImpersonation();
  if (blocked) return { error: blocked.error };
  const ctx = await agentContext();
  if ('error' in ctx) return ctx;
  if (ctx.caps.primaryAction !== 'cancel_plan') return { error: NOT_NOW };

  const own = await ownSubscription(ctx);
  if ('error' in own) return own;
  const { stripe, sub } = own;
  if ((sub.status !== 'active' && sub.status !== 'trialing') || sub.cancel_at_period_end) return { error: NOT_NOW };

  const updated = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });
  await writeThroughCancelFlag(ctx.service, updated);
  revalidatePath(BILLING_PATH);
  return { ok: true };
}

/** Keep my plan: undo a pending end while the period is still running. */
export async function keepAgentPlan(): Promise<AgentActionResult> {
  const blocked = await blockWriteDuringImpersonation();
  if (blocked) return { error: blocked.error };
  const ctx = await agentContext();
  if ('error' in ctx) return ctx;
  if (ctx.caps.primaryAction !== 'keep_plan') return { error: NOT_NOW };

  const own = await ownSubscription(ctx);
  if ('error' in own) return own;
  const { stripe, sub } = own;
  if (
    (sub.status !== 'active' && sub.status !== 'trialing') ||
    sub.cancel_at_period_end !== true ||
    !(sub.current_period_end * 1000 > Date.now())
  ) {
    return { error: NOT_NOW };
  }

  const updated = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: false });
  await writeThroughCancelFlag(ctx.service, updated);
  revalidatePath(BILLING_PATH);
  return { ok: true };
}

/**
 * Back from Checkout before the webhook: make sure the mirror row exists so the
 * page shows the plan. Grants nothing (the grant is invoice.paid's alone). The
 * context carries an id that is unmistakably not a Stripe event (SR R8).
 */
export async function confirmAgentCheckout(sessionId: string): Promise<AgentActionResult> {
  const blocked = await blockWriteDuringImpersonation();
  if (blocked) return { error: blocked.error };
  const ctx = await agentContext();
  if ('error' in ctx) return ctx;
  if (typeof sessionId !== 'string' || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return { error: NOT_NOW };

  const customer = await getStripeCustomer(ctx.service, ctx.userId, ctx.mode);
  if (!customer) return { error: NOT_NOW };
  const stripe = getStripe();
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (
    stripeId(session.customer) !== customer.stripe_customer_id ||
    session.mode !== 'subscription' ||
    session.status !== 'complete' ||
    session.metadata?.kind !== AGENT_KIND
  ) {
    return { error: NOT_NOW };
  }

  const billing: BillingContext = {
    service: ctx.service,
    stripe,
    mode: ctx.mode,
    event: {
      id: `action:confirm:${session.id}`,
      type: 'checkout.session.completed',
      created: 0,
      livemode: ctx.mode === 'live',
      data: { object: { id: session.id } },
    } as unknown as Stripe.Event,
  };
  await handleSubscriptionCheckout(billing, session);
  revalidatePath(BILLING_PATH);
  return { ok: true };
}
