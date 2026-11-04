/**
 * Agent plan Checkout parameters — BACKLOG-3847.
 *
 * Pure: no I/O and type-only imports, so the TEST fixtures are captured through
 * the very same builder the server action uses (SR R11).
 *
 *  - RC6: kind / user_id / organization_id ride on BOTH the session metadata and
 *    subscription_data.metadata, so the 3846 webhook's cross-check sees them on
 *    the subscription.
 *  - The price is a Stripe Price looked up by key (`agent_month_usd`), never
 *    price_data: the amount is Stripe's, not ours.
 *  - Idempotency (F4, SR R3): the key is anchored on the newest Agent session of
 *    the customer across ALL statuses. A key that once created a session that
 *    was later expired replays that dead session, so the anchor must move every
 *    time a session is created.
 */

import type Stripe from 'stripe';
import type { StripeMode } from './mode';

export type AgentInterval = 'month' | 'year';

export const AGENT_KIND = 'agent';

/**
 * Where Subscribe was clicked. Omitted = the website. 'desktop' = the Keepr app's
 * export paywall (BACKLOG-3676): the browser returns through /payments/complete,
 * which bounces back into the app, and the session carries `origin: 'desktop'`
 * so a website click never reuses a desktop session (or the reverse).
 */
export type AgentCheckoutOrigin = 'desktop';

/** Stripe Price lookup keys (PM decision on 3847: no price-book table yet). */
export const AGENT_LOOKUP_KEYS: Record<AgentInterval, string> = {
  month: 'agent_month_usd',
  year: 'agent_year_usd',
};

export interface AgentCheckoutInput {
  customerId: string;
  priceId: string;
  userId: string;
  organizationId: string | null;
  interval: AgentInterval;
  /** Origin the browser returns to, e.g. https://app.keeprcompliance.com (no trailing slash). */
  returnBase: string;
  /** Omitted for the website: its params stay exactly as captured in the TEST fixtures. */
  origin?: AgentCheckoutOrigin;
}

export function buildSubscriptionCheckoutParams(i: AgentCheckoutInput): Stripe.Checkout.SessionCreateParams {
  const subscriptionMetadata: Record<string, string> = { kind: AGENT_KIND, user_id: i.userId };
  if (i.organizationId) subscriptionMetadata.organization_id = i.organizationId;
  const desktop = i.origin === 'desktop';
  return {
    mode: 'subscription',
    customer: i.customerId,
    line_items: [{ price: i.priceId, quantity: 1 }],
    payment_method_types: ['card'],
    // interval / price_id: which open session may be reused for which choice.
    // origin rides the session metadata only (BACKLOG-3676); the subscription's metadata is the same for both.
    metadata: { ...subscriptionMetadata, interval: i.interval, price_id: i.priceId, ...(desktop ? { origin: 'desktop' } : {}) },
    subscription_data: { metadata: subscriptionMetadata },
    // The desktop returns through the deep-link bounce page, which wakes the app.
    success_url: desktop
      ? `${i.returnBase}/payments/complete?session={CHECKOUT_SESSION_ID}&kind=agent`
      : `${i.returnBase}/dashboard/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: desktop ? `${i.returnBase}/payments/cancelled?kind=agent` : `${i.returnBase}/dashboard/billing?checkout=cancelled`,
  };
}

export function agentIdempotencyKey(k: {
  userId: string;
  mode: StripeMode;
  interval: AgentInterval;
  /** Newest Agent session of the customer, any status; null when there is none. */
  anchorSessionId: string | null;
  /** Omitted for the website, whose key is pinned by the TEST fixtures. */
  origin?: AgentCheckoutOrigin;
}): string {
  const key = `agent-co:${k.userId}:${k.mode}:${k.interval}:${k.anchorSessionId ?? 'none'}`;
  return k.origin === 'desktop' ? `${key}:desktop` : key;
}

/**
 * An Agent plan session. The Stripe customer is shared with the desktop
 * pay-per-export Checkout (mode 'payment', no kind), which must never be
 * reused, expired or used as the key anchor.
 */
export function isAgentSession(s: Pick<Stripe.Checkout.Session, 'mode' | 'metadata'>): boolean {
  return s.mode === 'subscription' && s.metadata?.kind === AGENT_KIND;
}

/** Subscription statuses that mean the customer already has a plan (refuse a new one). */
export const LIVE_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set([
  'active',
  'trialing',
  'past_due',
  'unpaid',
  'paused',
]);

const DEFAULT_APP_URL = 'https://app.keeprcompliance.com';

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url.includes('://') ? url : `https://${url}`).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Where Checkout sends the browser back (SR R5). The request host is used only
 * when it EXACTLY equals one of: the NEXT_PUBLIC_APP_URL host, VERCEL_URL,
 * VERCEL_BRANCH_URL. No suffix match: any other host (another Vercel project
 * included) falls back to NEXT_PUBLIC_APP_URL. https, except localhost.
 */
export function chooseReturnBase(
  requestHost: string | null | undefined,
  env: { NEXT_PUBLIC_APP_URL?: string; VERCEL_URL?: string; VERCEL_BRANCH_URL?: string }
): { base: string; source: 'request' | 'fallback' } {
  const appUrl = (env.NEXT_PUBLIC_APP_URL || DEFAULT_APP_URL).replace(/\/+$/, '');
  const host = requestHost?.split(',')[0].trim().toLowerCase() || null;
  const allowed = [hostOf(appUrl), hostOf(env.VERCEL_URL), hostOf(env.VERCEL_BRANCH_URL)].filter(
    (h): h is string => !!h
  );
  if (host && allowed.includes(host)) {
    const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
    return { base: `${local ? 'http' : 'https'}://${host}`, source: 'request' };
  }
  return { base: appUrl, source: 'fallback' };
}
