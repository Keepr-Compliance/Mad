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
import type { AgentPlanState } from './capabilities';
import type { StripeMode } from './mode';
import { getPersonalOrganization } from './customers';
import { AGENT_LOOKUP_KEYS, type AgentInterval } from './agentCheckoutParams';

type ServiceClient = ReturnType<typeof createServiceClient>;

export interface AgentSubscriptionRow {
  stripe_subscription_id: string;
  status: string;
  interval: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  canceled_at: string | null;
}

export type UnlimitedOverride = Record<string, unknown> | null;

/** Rows the page can act on, best first. Closed and half-made rows are "no plan". */
const ROW_PRIORITY = ['active', 'trialing', 'past_due', 'unpaid'] as const;

/** The grant RPC's non_stripe_override rule: key present and source is not 'stripe'. */
export function isNonStripeOverride(override: UnlimitedOverride | undefined): boolean {
  if (override === undefined) return false;
  return (override?.source ?? null) !== 'stripe';
}

/** _override_effective: absent/null paid_through -> effective; otherwise an ISO date-time in the future. */
export function overrideEffective(override: UnlimitedOverride, now: Date): boolean {
  const raw = override?.paid_through;
  if (raw === undefined || raw === null) return true;
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(raw)) return false;
  const t = Date.parse(raw);
  return Number.isFinite(t) && t > now.getTime();
}

/**
 * Literal truth table (step 0 §2.4):
 *   active/trialing, cancel_at_period_end false -> active
 *   active/trialing, cancel_at_period_end true  -> cancel_pending
 *   past_due / unpaid                           -> payment_failed
 *   none (incl. incomplete, incomplete_expired, canceled):
 *     non-stripe override present               -> support_grant
 *     otherwise                                 -> none
 */
export function agentPlanState(
  row: Pick<AgentSubscriptionRow, 'status' | 'cancel_at_period_end'> | null,
  override: UnlimitedOverride | undefined
): AgentPlanState {
  if (row) {
    if (row.status === 'active' || row.status === 'trialing') {
      return row.cancel_at_period_end === true ? 'cancel_pending' : 'active';
    }
    if (row.status === 'past_due' || row.status === 'unpaid') return 'payment_failed';
  }
  return isNonStripeOverride(override) ? 'support_grant' : 'none';
}

export interface AgentPlanView {
  state: AgentPlanState;
  row: AgentSubscriptionRow | null;
  personalOrganizationId: string | null;
  /** undefined: no unlimited_transactions key on the personal organization. */
  override: UnlimitedOverride | undefined;
  /** support_grant only: the grant still gives Unlimited. When false the page shows "contact support". */
  supportGrantEffective: boolean;
  suspended: boolean;
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
    .in('status', [...ROW_PRIORITY]);
  if (subErr) throw new Error(`billing_subscriptions read failed: ${subErr.message}`);
  const list = (rows as AgentSubscriptionRow[] | null) ?? [];
  const row =
    ROW_PRIORITY.map((st) => list.find((r) => r.status === st)).find((r): r is AgentSubscriptionRow => !!r) ?? null;

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
