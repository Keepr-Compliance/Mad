/**
 * Missed-webhook backstop for auto-renew off — BACKLOG-4019 (SR plan review change 5).
 *
 * Runs from the payment-reconcile cron. A lost customer.subscription.deleted would leave a deal
 * 'canceling' with the service still on until some later version bump. Each run lists this mode's
 * deals that are effectively canceling ('canceling', or 'suspended' with status_before_suspension
 * 'canceling') whose mirrored current_period_end is more than an hour past, re-fetches the stored
 * subscription and, when Stripe says 'canceled', ends the deal through the webhook's own path
 * (endedSubscription -> _billing_end_org_deal, idempotent). A subscription Stripe still has open
 * is left alone and counted.
 */

import type Stripe from 'stripe';
import type { createServiceClient } from '@/lib/supabase/service';
import type { StripeMode } from './mode';
import { endedSubscription } from './brokerage';

type ServiceClient = ReturnType<typeof createServiceClient>;

/** Grace after the period end before the backstop looks (the webhook normally arrives first). */
export const END_BACKSTOP_GRACE_MS = 60 * 60 * 1000;
export const END_BACKSTOP_MAX = 200;

export interface EndBackstopResult {
  scanned: number;
  ended: number;
  stillOpen: number;
}

interface DealRow {
  organization_id: string;
  status: string;
  status_before_suspension: string | null;
}

interface MirrorRow {
  organization_id: string;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
}

export async function endLapsedBrokerageDeals(deps: {
  service: ServiceClient;
  stripe: Stripe;
  mode: StripeMode;
  now?: () => Date;
}): Promise<EndBackstopResult> {
  const { service, stripe, mode } = deps;
  const now = (deps.now ?? (() => new Date()))().getTime();
  const result: EndBackstopResult = { scanned: 0, ended: 0, stillOpen: 0 };

  const { data: dealData, error: dealErr } = await service
    .from('org_deals')
    .select('organization_id, status, status_before_suspension')
    .eq('stripe_mode', mode)
    .in('status', ['canceling', 'suspended'])
    .limit(END_BACKSTOP_MAX);
  if (dealErr) throw new Error(`org_deals read failed: ${dealErr.code ?? 'unknown'}`);
  const ending = ((dealData as DealRow[] | null) ?? []).filter(
    (d) => d.status === 'canceling' || (d.status === 'suspended' && d.status_before_suspension === 'canceling')
  );
  if (ending.length === 0) return result;

  const { data: mirrorData, error: mirrorErr } = await service
    .from('org_billing_stripe')
    .select('organization_id, stripe_subscription_id, current_period_end')
    .eq('stripe_mode', mode)
    .in(
      'organization_id',
      ending.map((d) => d.organization_id)
    );
  if (mirrorErr) throw new Error(`org_billing_stripe read failed: ${mirrorErr.code ?? 'unknown'}`);

  for (const m of (mirrorData as MirrorRow[] | null) ?? []) {
    const end = m.current_period_end ? Date.parse(m.current_period_end) : NaN;
    if (!m.stripe_subscription_id || !Number.isFinite(end) || end > now - END_BACKSTOP_GRACE_MS) continue;
    result.scanned += 1;
    const sub = await stripe.subscriptions.retrieve(m.stripe_subscription_id);
    if (sub.status !== 'canceled') {
      result.stillOpen += 1;
      continue;
    }
    const res = await endedSubscription({ service, mode }, m.organization_id, sub.id);
    if (res.outcome === 'ended') result.ended += 1;
  }
  return result;
}
