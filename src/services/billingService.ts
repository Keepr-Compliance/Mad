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

// Return-from-billing one-shot (SR R3). Every successful openPortal() arms it,
// whichever component asked. The next window focus (the user coming back from
// the browser) calls billing:refresh once, tells subscribers, and disarms.
// No polling.
let armed = false;
let listening = false;
const refreshListeners = new Set<(result: PlanSummaryResult) => void>();

function onWindowFocus(): void {
  if (!armed) return;
  armed = false; // one-shot
  void billingService.refresh().then((result) => {
    refreshListeners.forEach((listener) => listener(result));
  });
}

function arm(): void {
  armed = true;
  if (!listening && typeof window !== "undefined") {
    window.addEventListener("focus", onWindowFocus);
    listening = true;
  }
}

export const billingService = {
  /** Open the portal Billing page in the browser (main builds the URL). */
  async openPortal(): Promise<OpenBillingPortalResult> {
    try {
      const result = await window.api.billing.openPortal();
      if (result.success) arm();
      return result;
    } catch {
      return { success: false };
    }
  },

  /** Be told the fresh summary after a return from the portal. Returns unsubscribe. */
  onReturnRefresh(listener: (result: PlanSummaryResult) => void): () => void {
    refreshListeners.add(listener);
    return () => {
      refreshListeners.delete(listener);
    };
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
