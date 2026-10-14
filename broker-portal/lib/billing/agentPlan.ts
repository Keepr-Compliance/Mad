/**
 * The personal Agent plan as the Billing page and its actions see it — BACKLOG-3847.
 *
 * Sources (service client, always keyed by the signed-in user's id and the
 * deployment's Stripe mode):
 *   - billing_subscriptions: the webhook's mirror (3846);
 *   - organization_plans.feature_overrides.unlimited_transactions on the
 *     personal organization: a support grant;
 *   - licenses.status: suspension.
 *
 * Refusal predicates are the grant RPC's, verbatim (SR R4,
 * grant_unlimited_from_subscription in 20261011230913):
 *   - support grant: an unlimited_transactions override EXISTS whose `source`
 *     is not 'stripe' (any `enabled`, any `paid_through`);
 *   - suspended: ANY licenses row of the user with status 'suspended'.
 * Either one means a payment would buy nothing, so Subscribe refuses first.
 *
 * "Ending" is read from cancel_at_period_end only: Stripe sets canceled_at as
 * soon as a period-end cancel is requested, while the plan is still active (F5).
 */

import type Stripe from 'stripe';
import type { createServiceClient } from '@/lib/supabase/service';
import {
  ROW_PRIORITY,
  agentPlanState,
  overrideEffective,
  pickAgentRow,
  type AgentPlanState,
  type AgentSubscriptionRow,
  type UnlimitedOverride,
} from '@keepr/shared';
import type { StripeMode } from './mode';
import { getPersonalOrganization } from './customers';
import { AGENT_LOOKUP_KEYS, type AgentInterval } from './agentCheckoutParams';

// BACKLOG-3859: the pure rule lives in packages/shared/src/billing/planRule.ts,
// one copy for both portals. Re-exported so importers of this file are unchanged.
export {
  agentPlanState,
  isNonStripeOverride,
  overrideEffective,
  pickAgentRow,
} from '@keepr/shared';
export type { AgentSubscriptionRow, UnlimitedOverride } from '@keepr/shared';

type ServiceClient = ReturnType<typeof createServiceClient>;

export interface AgentPlanView {
  state: AgentPlanState;
  row: AgentSubscriptionRow | null;
  personalOrganizationId: string | null;
  /** undefined: no unlimited_transactions key on the personal organization. */
  override: UnlimitedOverride | undefined;
  /** support_grant only: the grant still gives Unlimited. When false the page shows "contact support". */
  supportGrantEffective: boolean;
  suspended: boolean;
  /** A mirror row is `incomplete`: a Checkout payment failed or was abandoned. Does not change `state` or `row`. */
  paymentIncomplete: boolean;
}

export async function getAgentPlanView(
  service: ServiceClient,
  userId: string,
  mode: StripeMode,
  now: Date = new Date()
): Promise<AgentPlanView> {
  const org = await getPersonalOrganization(service, userId);

  const { data: rows, error: subErr } = await service
    .from('billing_subscriptions')
    .select('stripe_subscription_id, status, interval, current_period_end, cancel_at_period_end, canceled_at')
    .eq('user_id', userId)
    .eq('stripe_mode', mode)
    .in('status', [...ROW_PRIORITY, 'incomplete']);
  if (subErr) throw new Error(`billing_subscriptions read failed: ${subErr.message}`);
  const list = (rows as AgentSubscriptionRow[] | null) ?? [];
  const paymentIncomplete = list.some((r) => r.status === 'incomplete');
  const row = pickAgentRow(list);

  let override: UnlimitedOverride | undefined;
  if (org) {
    const { data: plan, error: planErr } = await service
      .from('organization_plans')
      .select('feature_overrides')
      .eq('organization_id', org.id)
      .maybeSingle();
    if (planErr) throw new Error(`organization_plans read failed: ${planErr.message}`);
    const fo = (plan as { feature_overrides?: Record<string, unknown> | null } | null)?.feature_overrides;
    if (fo && Object.prototype.hasOwnProperty.call(fo, 'unlimited_transactions')) {
      override = (fo.unlimited_transactions as UnlimitedOverride) ?? null;
    }
  }

  const { data: susp, error: lErr } = await service
    .from('licenses')
    .select('id')
    .eq('user_id', userId)
    .eq('status', 'suspended')
    .limit(1);
  if (lErr) throw new Error(`licenses read failed: ${lErr.message}`);

  const state = agentPlanState(row, override);
  return {
    state,
    row,
    personalOrganizationId: org?.id ?? null,
    override,
    supportGrantEffective: state === 'support_grant' && overrideEffective(override ?? null, now),
    suspended: Array.isArray(susp) && susp.length > 0,
    paymentIncomplete,
  };
}

export interface AgentPrice {
  id: string;
  unitAmount: number;
  currency: string;
  interval: AgentInterval;
}

/**
 * The Agent prices on sale in this mode, by lookup key. A missing key means
 * that option is not offered (annual is hidden until agent_year_usd exists, D3).
 */
export async function getAgentPrices(stripe: Stripe): Promise<Partial<Record<AgentInterval, AgentPrice>>> {
  const res = await stripe.prices.list({
    lookup_keys: [AGENT_LOOKUP_KEYS.month, AGENT_LOOKUP_KEYS.year],
    active: true,
  });
  const out: Partial<Record<AgentInterval, AgentPrice>> = {};
  for (const interval of ['month', 'year'] as const) {
    const p = res.data.find((x) => x.lookup_key === AGENT_LOOKUP_KEYS[interval]);
    if (p && typeof p.unit_amount === 'number' && p.recurring?.interval === interval) {
      out[interval] = { id: p.id, unitAmount: p.unit_amount, currency: p.currency, interval };
    }
  }
  return out;
}

export function formatPrice(p: Pick<AgentPrice, 'unitAmount' | 'currency'>): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: p.currency.toUpperCase() }).format(p.unitAmount / 100);
}
