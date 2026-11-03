// ============================================
// BILLING IPC HANDLERS (BACKLOG-3863 PR-2, slice 2)
//
//   billing:open-portal   opens the portal Billing page. Takes NO argument:
//                         the handler declares none and ignores anything the
//                         renderer sends; the URL comes only from
//                         portalUrl("billing"). Never system:open-external.
//   billing:plan-summary  the user's own plan summary (display only).
//   billing:refresh       after a return from the portal: drop the entitlement
//                         memo + feature cache, answer a fresh summary.
//   billing:agent-prices  the Agent plan monthly price (BACKLOG-3676).
//   billing:open-book-call  opens the portal's booking URL; takes NO argument.
// ============================================

import { ipcMain } from "electron";
import billingService from "../services/billingService";
import type {
  AgentPricesResult,
  OpenBillingPortalResult,
  OpenBookCallResult,
  PlanSummaryResult,
} from "../types/billing";

/** Register all billing IPC handlers. */
export function registerBillingHandlers(): void {
  ipcMain.handle(
    "billing:open-portal",
    async (): Promise<OpenBillingPortalResult> => billingService.openPortal(),
  );

  ipcMain.handle(
    "billing:plan-summary",
    async (): Promise<PlanSummaryResult> => billingService.getPlanSummary(),
  );

  ipcMain.handle(
    "billing:refresh",
    async (): Promise<PlanSummaryResult> => billingService.refresh(),
  );

  // BACKLOG-3676: the Agent plan price for the export paywall (no cache).
  ipcMain.handle(
    "billing:agent-prices",
    async (): Promise<AgentPricesResult> => billingService.getAgentPrices(),
  );

  // BACKLOG-3676 (S4): "Book a call". Takes NO argument: the handler declares
  // none and ignores anything the renderer sends; main opens only the URL the
  // portal's agent-prices route answers, on the booking host.
  ipcMain.handle(
    "billing:open-book-call",
    async (): Promise<OpenBookCallResult> => billingService.openBookCall(),
  );
}
