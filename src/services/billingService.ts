/**
 * Billing service (renderer) — BACKLOG-3863.
 *
 * The only renderer code that calls `window.api.billing`. Components and hooks
 * use this instead. Display and navigation only: nothing here gates a feature.
 * A thrown IPC call reads as "unavailable" / "not opened", never as a plan.
 */

import type {
  OpenBillingPortalResult,
  PlanSummaryResult,
} from "@electron/types/billing";

export type { PlanSummary, PlanSummaryResult, AgentPlanState } from "@electron/types/billing";

const UNAVAILABLE: PlanSummaryResult = { unavailable: true };

export const billingService = {
  /** Open the portal Billing page in the browser (main builds the URL). */
  async openPortal(): Promise<OpenBillingPortalResult> {
    try {
      return await window.api.billing.openPortal();
    } catch {
      return { success: false };
    }
  },

  /** The user's own plan summary, or { unavailable: true }. */
  async getPlanSummary(): Promise<PlanSummaryResult> {
    try {
      return await window.api.billing.getPlanSummary();
    } catch {
      return UNAVAILABLE;
    }
  },

  /** After a return from the portal: main drops cached plan answers, then re-reads. */
  async refresh(): Promise<PlanSummaryResult> {
    try {
      return await window.api.billing.refresh();
    } catch {
      return UNAVAILABLE;
    }
  },
};

export default billingService;
