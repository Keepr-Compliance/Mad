/**
 * Billing Bridge (BACKLOG-3863 PR-2, slice 2)
 *
 * Renderer→main surface for the Settings Plan & Billing card and the Upgrade
 * buttons. `openPortal` sends no arguments: main builds the URL.
 */

import { ipcRenderer } from "electron";
import type { OpenBillingPortalResult, PlanSummaryResult } from "../types/billing";

export const billingBridge = {
  /** Open the portal Billing page in the browser. */
  openPortal: (): Promise<OpenBillingPortalResult> => ipcRenderer.invoke("billing:open-portal"),

  /** The user's own plan summary, or { unavailable: true }. Display only. */
  getPlanSummary: (): Promise<PlanSummaryResult> => ipcRenderer.invoke("billing:plan-summary"),

  /** After a return from the portal: drop cached plan answers, re-read the summary. */
  refresh: (): Promise<PlanSummaryResult> => ipcRenderer.invoke("billing:refresh"),
};
