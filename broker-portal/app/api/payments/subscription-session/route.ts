/**
 * Agent plan Checkout for the desktop app — BACKLOG-3676.
 *
 * POST, Bearer JWT only. The request body is never read: the user comes from
 * the verified token, the interval is the monthly plan, the price is Stripe's
 * (looked up by key), and the return URL is built on the server.
 *
 * Every refusal is answered before any Stripe call that could create anything,
 * as `{ code }` (never a sentence; the app has its own screen per code):
 *
 *   billing off                         404 not_available
 *   no / bad Bearer                     401 unauthorized
 *   mode guard (is_test)                403 mode_refused
 *   licence or brokerage read fails     503 try_again       (fails closed)
 *   licence suspended / brokerage
 *     purchase-blocked                  403 suspended
 *   membership read fails               503 try_again
 *   brokerage member or full role       403 brokerage_managed
 *   brokerage member, no license        403 no_license
 *   not a personal owner                403 not_available
 *   support grant, or a plan already    409 already_have_plan
 *   no Agent price on sale              503 price_unavailable
 *   Stripe fails                        502 try_again
 *
 * Success: 200 `{ checkout_url }`, a Stripe-hosted page that returns through
 * /payments/complete (deep link back into the app). Unlimited is granted by
 * the invoice.paid webhook alone; nothing here grants it.
 */

import { NextResponse } from 'next/server';
import { getStripe, verifyBearerUserWithToken } from '@/lib/stripe';
import { createServiceClient } from '@/lib/supabase/service';
import { readOwnLicenceSuspended } from '@/lib/auth/suspension';
import { billingEnabled } from '@/lib/billing/flag';
import { currentStripeMode } from '@/lib/billing/mode';
import { ensureStripeCustomer, isModeAllowedForUser } from '@/lib/billing/customers';
import { readBrokeragePurchaseBlocked } from '@/lib/billing/purchaseBlocked';
import { readBearerPortalAccess } from '@/lib/billing/bearerPortalAccess';
import { agentContextForUser } from '@/lib/billing/agentContextCore';
import { getAgentPrices, isNonStripeOverride } from '@/lib/billing/agentPlan';
import { ALREADY_HAVE_PLAN, prepareAgentCheckout } from '@/lib/billing/agentCheckout';
import { chooseReturnBase } from '@/lib/billing/agentCheckoutParams';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export type SubscriptionRefusalCode =
  | 'unauthorized'
  | 'not_available'
  | 'brokerage_managed'
  | 'no_license'
  | 'suspended'
  | 'mode_refused'
  | 'already_have_plan'
  | 'price_unavailable'
  | 'try_again';

function refuse(code: SubscriptionRefusalCode, status: number): Response {
  return NextResponse.json({ code }, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: Request): Promise<Response> {
  if (!billingEnabled()) return refuse('not_available', 404);

  const user = await verifyBearerUserWithToken(req);
  if (!user) return refuse('unauthorized', 401);

  const service = createServiceClient();
  const mode = currentStripeMode();

  // BACKLOG-3845: a test-mode deployment serves only is_test users.
  if (!(await isModeAllowedForUser(service, user.userId, mode))) return refuse('mode_refused', 403);

  // BACKLOG-3878 / 3853: the same two fail-closed reads as the per-deal checkout.
  const suspended = await readOwnLicenceSuspended(service, user.userId);
  if (suspended === null) {
    console.error('[payments/subscription-session] licence read failed');
    return refuse('try_again', 503);
  }
  const brokerageBlocked = await readBrokeragePurchaseBlocked(service, user.userId);
  if (brokerageBlocked === null) {
    console.error('[payments/subscription-session] brokerage block read failed');
    return refuse('try_again', 503);
  }
  if (suspended || brokerageBlocked) return refuse('suspended', 403);

  const access = await readBearerPortalAccess(user.token, user.userId);
  let ctx: Awaited<ReturnType<typeof agentContextForUser>>;
  try {
    ctx = await agentContextForUser({ userId: user.userId, email: user.email, access, service, mode });
  } catch (err) {
    console.error('[payments/subscription-session] plan read failed:', (err as Error).name);
    return refuse('try_again', 503);
  }
  if ('refusal' in ctx) {
    const status = ctx.refusal === 'try_again' ? 503 : 403;
    return refuse(ctx.refusal, status);
  }
  const { view, caps } = ctx;

  if (view.suspended) return refuse('suspended', 403);
  // A support grant already gives Unlimited; a payment would buy nothing.
  if (isNonStripeOverride(view.override)) return refuse('already_have_plan', 409);
  if (view.state !== 'none') return refuse('already_have_plan', 409);
  if (!caps.blocks.includes('choose_plan') || !caps.canPurchase) return refuse('not_available', 403);

  try {
    const stripe = getStripe();
    const price = (await getAgentPrices(stripe)).month;
    if (!price) return refuse('price_unavailable', 503);

    const customerId = await ensureStripeCustomer(service, stripe, user.userId, user.email, mode);
    const returnBase = chooseReturnBase(req.headers.get('x-forwarded-host') ?? req.headers.get('host'), {
      NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
      VERCEL_URL: process.env.VERCEL_URL,
      VERCEL_BRANCH_URL: process.env.VERCEL_BRANCH_URL,
    }).base;
    const result = await prepareAgentCheckout({
      stripe,
      mode,
      customerId,
      priceId: price.id,
      userId: user.userId,
      organizationId: view.personalOrganizationId,
      interval: 'month',
      returnBase,
      origin: 'desktop',
    });
    if ('refused' in result) {
      return result.refused === ALREADY_HAVE_PLAN ? refuse('already_have_plan', 409) : refuse('try_again', 502);
    }
    return NextResponse.json({ checkout_url: result.url }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    console.error('[payments/subscription-session] checkout failed:', (err as Error).name);
    return refuse('try_again', 502);
  }
}
