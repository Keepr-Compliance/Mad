/**
 * The plan-summary DTO — BACKLOG-3863 PR-2. Lives outside the route file because a
 * Next.js route may export only handlers and route config.
 */

import type { AgentPlanView } from '@/lib/billing/agentPlan';

export interface PlanSummary {
  state: AgentPlanView['state'];
  interval: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  paymentIncomplete: boolean;
  supportGrantEffective: boolean;
}

/** The DTO, field by field from the view. Nothing else from the row is copied. */
export function toPlanSummary(view: AgentPlanView): PlanSummary {
  return {
    state: view.state,
    interval: view.row?.interval ?? null,
    current_period_end: view.row?.current_period_end ?? null,
    cancel_at_period_end: view.row?.cancel_at_period_end === true,
    paymentIncomplete: view.paymentIncomplete,
    supportGrantEffective: view.supportGrantEffective,
  };
}
