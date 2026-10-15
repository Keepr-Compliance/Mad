/**
 * Agent plan Checkout, the Stripe side — BACKLOG-3847 (steps 6-9 of the plan).
 *
 * Runs after the server action's refusals (impersonation, flag, access, support
 * grant, suspension, mode guard) and after the customer exists.
 *
 *   6. The customer's subscriptions, every page (R3):
 *        any live one              -> refuse "You already have a plan";
 *        any `incomplete` one      -> end it (R1, voidIncompleteSubscription):
 *                                     expire the open session that holds its
 *                                     invoice first, then void. A refusal that
 *                                     means it was paid meanwhile: re-list and
 *                                     refuse.
 *   7. The customer's Checkout sessions, every page, Agent ones only (R3, Q6):
 *        an open one for the same interval and price is reused, unless step 6
 *        just ended a half-made subscription (R2: that session may be the one
 *        that made it); every other open Agent session is expired.
 *   8. Idempotency key anchored on the newest Agent session, any status (R3).
 *   9. Create.
 */

import type Stripe from 'stripe';
import type { StripeMode } from './mode';
import { listAll, voidIncompleteSubscription } from './sync';
import {
  LIVE_SUBSCRIPTION_STATUSES,
  agentIdempotencyKey,
  buildSubscriptionCheckoutParams,
  isAgentSession,
  type AgentInterval,
} from './agentCheckoutParams';

export const ALREADY_HAVE_PLAN = 'You already have a plan. Refresh the page to see it.';
export const TRY_AGAIN = 'Checkout could not be started. Please try again in a minute.';

export { listAll };

function listSubscriptions(stripe: Stripe, customer: string): Promise<Stripe.Subscription[]> {
  return listAll((after) =>
    stripe.subscriptions.list({ customer, status: 'all', ...(after ? { starting_after: after } : {}) })
  );
}

export type AgentCheckoutResult = { url: string } | { refused: string };

export async function prepareAgentCheckout(a: {
  stripe: Stripe;
  mode: StripeMode;
  customerId: string;
  priceId: string;
  userId: string;
  organizationId: string | null;
  interval: AgentInterval;
  returnBase: string;
}): Promise<AgentCheckoutResult> {
  const { stripe, customerId } = a;

  // 6. Stripe's own view of the customer's subscriptions.
  const subs = await listSubscriptions(stripe, customerId);
  if (subs.some((s) => LIVE_SUBSCRIPTION_STATUSES.has(s.status))) return { refused: ALREADY_HAVE_PLAN };
  let endedIncomplete = false;
  for (const sub of subs.filter((s) => s.status === 'incomplete')) {
    const after = await voidIncompleteSubscription(stripe, sub);
    if (after.status === 'incomplete') return { refused: TRY_AGAIN };
    if (LIVE_SUBSCRIPTION_STATUSES.has(after.status)) {
      const again = await listSubscriptions(stripe, customerId);
      if (again.some((s) => LIVE_SUBSCRIPTION_STATUSES.has(s.status))) return { refused: ALREADY_HAVE_PLAN };
      return { refused: TRY_AGAIN };
    }
    endedIncomplete = true;
  }

  // 7. Open Agent sessions: reuse at most one, expire the rest.
  const sessions = (
    await listAll((after) =>
      stripe.checkout.sessions.list({ customer: customerId, ...(after ? { starting_after: after } : {}) })
    )
  )
    .filter(isAgentSession)
    .sort((x, y) => y.created - x.created);
  const anchor = sessions[0]?.id ?? null;
  const open = sessions.filter((s) => s.status === 'open');
  const reuse = endedIncomplete
    ? undefined
    : open.find((s) => s.metadata?.interval === a.interval && s.metadata?.price_id === a.priceId && !!s.url);
  for (const s of open) {
    if (s !== reuse) await stripe.checkout.sessions.expire(s.id);
  }
  if (reuse?.url) return { url: reuse.url };

  // 8-9. A fresh session under a key no earlier session has used.
  const session = await stripe.checkout.sessions.create(
    buildSubscriptionCheckoutParams({
      customerId,
      priceId: a.priceId,
      userId: a.userId,
      organizationId: a.organizationId,
      interval: a.interval,
      returnBase: a.returnBase,
    }),
    { idempotencyKey: agentIdempotencyKey({ userId: a.userId, mode: a.mode, interval: a.interval, anchorSessionId: anchor }) }
  );
  if (!session.url) throw new Error(`checkout session ${session.id} has no url`);
  return { url: session.url };
}
