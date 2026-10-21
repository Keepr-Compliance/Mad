/**
 * Billing types shared by main, preload and renderer (BACKLOG-3863).
 *
 * The plan summary is DISPLAY ONLY. Nothing gates on it: exports stay on
 * get_org_features / entitlementService. The desktop never sends, receives or
 * stores a Stripe mode; the portal picks its own (SR R4).
 */

/**
 * The Agent plan state as the portal's Billing page computes it
 * (agentPlanState in packages/shared/src/billing/planRule.ts). Copied here
 * because electron/ cannot import @keepr/shared. The desktop never derives it.
 */
export type AgentPlanState =
  | "none"
  | "active"
  | "cancel_pending"
  | "payment_failed"
  | "support_grant";

export const AGENT_PLAN_STATES: readonly AgentPlanState[] = [
  "none",
  "active",
  "cancel_pending",
  "payment_failed",
  "support_grant",
];

/** GET /api/billing/plan-summary — exactly these fields, nothing else. */
export interface PlanSummary {
  state: AgentPlanState;
  interval: string | null;
  /** ISO timestamp from the subscription row, or null. */
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  paymentIncomplete: boolean;
  supportGrantEffective: boolean;
}

/**
 * Answer of `billing:plan-summary` and `billing:refresh`.
 *   { unavailable: false, summary } — the portal answered 200 with a valid DTO.
 *   { unavailable: true }           — billing off (404), signed out (no session
 *                                     or 401), offline, 5xx, a 5 s timeout, a
 *                                     refused portal address, or a malformed
 *                                     body. The card falls back to the feature
 *                                     gate's plan line.
 */
export type PlanSummaryResult =
  | { unavailable: false; summary: PlanSummary }
  | { unavailable: true };

/** Answer of `billing:open-portal`. */
export interface OpenBillingPortalResult {
  success: boolean;
  error?: string;
  /** Only when the address was allowed but the browser did not open. */
  portalAddress?: string;
}
