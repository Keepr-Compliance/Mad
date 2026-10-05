/**
 * BACKLOG-3733 — ONE data-prep step for a transaction's communications.
 *
 * Every export channel used to write out the same three steps inline:
 *
 *   1. load the deal and its communications (`getTransactionDetails`, no channel
 *      filter, no limit — the same reader the Texts tab uses);
 *   2. run the paywall gate (`enforceExportGate`, fail-closed: throws when the
 *      deal is locked, otherwise returns its input unchanged);
 *   3. resolve the include set (`resolveExportPlan`: date window, content type,
 *      hidden texts, reactions to hidden texts).
 *
 * This function is those three steps, in that order, once. The order matters:
 * the gate sees the full read, and the plan is resolved exactly once over the
 * gate's output (BACKLOG-3367 — a second resolve would zero the hidden count).
 *
 * The request is built from the loaded deal, because the windowed channels take
 * their audit dates from it.
 */

import transactionService from "./transactionService";
import type { TransactionWithDetails } from "./transactionService";
import { enforceExportGate } from "./exportGate";
import { resolveExportPlan, type ExportPlan, type ExportPlanRequest } from "./exportPlan";
import type { ExportEntitlementDecision } from "../types/entitlement";

export interface PreparedTransactionCommunications {
  /** The deal as loaded in step 1 (or the caller's fallback). */
  details: TransactionWithDetails;
  /** The paywall decision from step 2. */
  decision: ExportEntitlementDecision;
  /** The resolved include set from step 3. */
  plan: ExportPlan;
}

export async function prepareTransactionCommunications(args: {
  transactionId: string;
  /** Builds the plan request from the loaded deal. */
  request: (details: TransactionWithDetails) => ExportPlanRequest;
  /**
   * Used when the load returns nothing. The export channels load the deal once
   * before their sync backstops and pass that copy here, so a failed re-load
   * still exports what was there before the sync.
   */
  fallback?: TransactionWithDetails;
}): Promise<PreparedTransactionCommunications | null> {
  const { transactionId, request, fallback } = args;

  // 1. Load.
  const details = (await transactionService.getTransactionDetails(transactionId)) ?? fallback ?? null;
  if (!details) return null;

  // 2. Gate. Throws PaywallLockedError for a locked deal.
  const gate = await enforceExportGate({
    transactionId,
    userId: details.user_id,
    communications: details.communications || [],
  });

  // 3. Resolve, once, over the gate's output.
  const plan = resolveExportPlan(request(details), gate.communications);

  return { details, decision: gate.decision, plan };
}
