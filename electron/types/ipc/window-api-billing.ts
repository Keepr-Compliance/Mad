/**
 * WindowApi Billing sub-interface (BACKLOG-3863)
 *
 * Display and navigation only: nothing on this surface gates a feature.
 */

import type {
  AgentPricesResult,
  OpenBillingPortalResult,
  OpenBookCallResult,
  PlanSummaryResult,
} from "../billing";

export interface WindowApiBilling {
  /** Open the portal Billing page. Takes no URL; main builds it. */
  openPortal: () => Promise<OpenBillingPortalResult>;
  /** The user's own plan summary, or { unavailable: true }. */
  getPlanSummary: () => Promise<PlanSummaryResult>;
  /** After a return from the portal: drop cached plan answers, re-read the summary. */
  refresh: () => Promise<PlanSummaryResult>;
  /** BACKLOG-3676: the Agent plan monthly price, read fresh on every paywall open. */
  getAgentPrices: () => Promise<AgentPricesResult>;
  /** BACKLOG-3676: open the booking page. Takes no URL; main reads it from the portal. */
  openBookCall: () => Promise<OpenBookCallResult>;
}
