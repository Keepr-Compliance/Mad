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
 *
 * The submit to the broker uses the same function for its text set
 * ({@link selectSubmissionTextIds}), with the paywall step off: submitting is
 * not an export and has never been gated (BACKLOG-3733 PR-2).
 */

import transactionService from "./transactionService";
import type { TransactionWithDetails } from "./transactionService";
import { enforceExportGate } from "./exportGate";
import {
  resolveExportPlan,
  selectedTextIdsFromPlan,
  type ExportPlan,
  type ExportPlanRequest,
  type SelectedTextIds,
} from "./exportPlan";
import type { ExportEntitlementDecision } from "../types/entitlement";

export interface PreparedTransactionCommunications {
  /** The deal as loaded in step 1 (or the caller's fallback). */
  details: TransactionWithDetails;
  /** The paywall decision from step 2. */
  decision: ExportEntitlementDecision;
  /** The resolved include set from step 3. */
  plan: ExportPlan;
}

interface PrepareArgs {
  transactionId: string;
  /** Builds the plan request from the loaded deal. */
  request: (details: TransactionWithDetails) => ExportPlanRequest;
  /**
   * Used when the load returns nothing. The export channels load the deal once
   * before their sync backstops and pass that copy here, so a failed re-load
   * still exports what was there before the sync.
   */
  fallback?: TransactionWithDetails;
  /**
   * "export" (default): run the paywall gate. "none": skip it — only for the
   * submit, which is not an export.
   */
  gate?: "export" | "none";
}

/** The submit's result: same load and plan, no paywall decision. */
export type PreparedWithoutGate = Omit<PreparedTransactionCommunications, "decision"> & {
  decision: null;
};

export async function prepareTransactionCommunications(
  args: PrepareArgs & { gate?: "export" },
): Promise<PreparedTransactionCommunications | null>;
export async function prepareTransactionCommunications(
  args: PrepareArgs & { gate: "none" },
): Promise<PreparedWithoutGate | null>;
export async function prepareTransactionCommunications(
  args: PrepareArgs,
): Promise<PreparedTransactionCommunications | PreparedWithoutGate | null> {
  const { transactionId, request, fallback, gate: gateMode = "export" } = args;

  // 1. Load.
  const details = (await transactionService.getTransactionDetails(transactionId)) ?? fallback ?? null;
  if (!details) return null;

  // 2. Gate. Throws PaywallLockedError for a locked deal.
  const gate =
    gateMode === "export"
      ? await enforceExportGate({
          transactionId,
          userId: details.user_id,
          communications: details.communications || [],
        })
      : { decision: null, communications: details.communications || [] };

  // 3. Resolve, once, over the gate's output.
  const plan = resolveExportPlan(request(details), gate.communications);

  return { details, decision: gate.decision, plan };
}

/**
 * The texts-only request the submit resolves. No dates: the submit keeps its
 * own audit-window query and intersects it with this set. Every plan filter is
 * per row, and the hidden-parent lookup reads the whole input, so the order of
 * the window and this set does not change the result.
 */
export const SUBMISSION_TEXT_REQUEST: ExportPlanRequest = {
  format: "folder",
  contentType: "texts",
  attachmentType: "none",
  emailMode: "thread",
  startDate: null,
  endDate: null,
};

/**
 * BACKLOG-3733 — the text ids a submission may send: the ids the export of
 * this deal would include. Empty when the deal does not load.
 */
export async function selectSubmissionTextIds(transactionId: string): Promise<SelectedTextIds> {
  const prepared = await prepareTransactionCommunications({
    transactionId,
    request: () => SUBMISSION_TEXT_REQUEST,
    gate: "none",
  });
  return selectedTextIdsFromPlan(prepared?.plan ?? { communications: [] });
}
