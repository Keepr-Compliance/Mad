/**
 * Plan summary for the desktop app — BACKLOG-3863 PR-2 (SR R4).
 *
 * The signed-in user's own Agent plan, as the website's Billing page sees it:
 * `state` comes from getAgentPlanView (the shared agentPlanState rule), never
 * re-derived here. Display only; nothing gates on it (exports stay on the
 * feature gate).
 *
 * - BILLING_ENABLED off: 404, checked first (a billing-off deployment may have
 *   no Stripe key, and the mode read would throw).
 * - Auth: the caller's Bearer JWT (verifyBearerUser), 401 otherwise. No user id
 *   is read from the request.
 * - Mode: this deployment's, server-side (currentStripeMode). Never sent or
 *   returned.
 * - The response carries exactly the PlanSummary fields: no Stripe ids, no
 *   customer id, no card data.
 */

import { NextResponse } from 'next/server';
import { verifyBearerUser } from '@/lib/stripe';
import { createServiceClient } from '@/lib/supabase/service';
import { billingEnabled } from '@/lib/billing/flag';
import { currentStripeMode } from '@/lib/billing/mode';
import { getAgentPlanView } from '@/lib/billing/agentPlan';
import { toPlanSummary } from '@/lib/billing/planSummary';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  if (!billingEnabled()) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const user = await verifyBearerUser(req);
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const view = await getAgentPlanView(createServiceClient(), user.userId, currentStripeMode());
    return NextResponse.json(toPlanSummary(view), { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    // Static message only: the thrown text names tables, not secrets, but keep logs minimal.
    console.error('[billing/plan-summary] read failed:', (err as Error).name);
    return NextResponse.json({ error: 'unavailable' }, { status: 503 });
  }
}
