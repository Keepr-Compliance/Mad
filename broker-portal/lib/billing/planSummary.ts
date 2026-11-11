/**
 * The plan-summary DTO — BACKLOG-3863 PR-2. Lives outside the route file because a
 * Next.js route may export only handlers and route config.
 */

import type { AgentPlanView } from '@/lib/billing/agentPlan';

/**
 * The five states the desktop accepts (electron/types/billing.ts AGENT_PLAN_STATES;
 * parsePlanSummary rejects anything else). BACKLOG-3860: 'trial' is never sent.
 */
export type DesktopPlanState = Exclude<AgentPlanView['state'], 'trial'>;

export interface PlanSummary {
  state: DesktopPlanState;
  interval: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  paymentIncomplete: boolean;
  supportGrantEffective: boolean;
  /**
   * BACKLOG-4088: a live solo free trial's end (ISO), else null. Sent with state
   * 'support_grant' (old desktops ignore unknown fields, and reject unknown states).
   */
  trialEndsOn: string | null;
  /**
   * BACKLOG-4088: when the subscription is in its Stripe trial (row 'trialing'), the trial
   * end = when billing starts, else null. Stripe's current period is the trial while trialing.
   */
  subscriptionTrialEndsOn: string | null;
}

/** The DTO, field by field from the view. Nothing else from the row is copied. */
export function toPlanSummary(view: AgentPlanView): PlanSummary {
  // BACKLOG-3860: a live trial goes to the desktop as an effective Keepr grant
  // ("Unlimited exports", Active). An ended trial is already 'none'.
  const state = view.state;
  const trial = state === 'trial';
  return {
    state: state === 'trial' ? 'support_grant' : state,
    interval: view.row?.interval ?? null,
    current_period_end: view.row?.current_period_end ?? null,
    cancel_at_period_end: view.row?.cancel_at_period_end === true,
    paymentIncomplete: view.paymentIncomplete,
    supportGrantEffective: trial ? true : view.supportGrantEffective,
    trialEndsOn: trial ? view.trialEndsOn : null,
    subscriptionTrialEndsOn: view.row?.status === 'trialing' ? (view.row.current_period_end ?? null) : null,
  };
}
