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
// ============================================

import { ipcMain } from "electron";
import billingService from "../services/billingService";
import type { OpenBillingPortalResult, PlanSummaryResult } from "../types/billing";

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
}
