/**
 * Export Gate (BACKLOG-2006a; BACKLOG-2075 Option A)
 *
 * The single, authoritative choke point every transaction-audit export handler
 * calls BEFORE producing an artifact. Because it lives in the main process,
 * NO renderer entry point (details Export, per-row Quick Export, Bulk Export —
 * which loops per-transaction through :export-enhanced) can bypass it.
 *
 * Option A (founder, 2026-07-16): reading is FREE everywhere; only the EXPORT
 * is gated. A locked transaction is blocked outright — there is no free/sample
 * export (that was deferred to BACKLOG-2079 with the read-paywall).
 *
 * Responsibilities:
 *   1. Ask entitlementService for the gate decision (full / none).
 *   2. On "none", throw the typed PAYWALL_LOCKED error so the handler aborts
 *      BEFORE any content is written. The renderer detects the error prefix and
 *      routes to the unlock CTA (BACKLOG-2075).
 *   3. Emit the `export-completed` analytics event after a successful export.
 */

import entitlementService from "./entitlementService";
import supabaseService from "./supabaseService";
import logService from "./logService";
import {
  PAYWALL_ANALYTICS_EVENTS,
  PAYWALL_LOCKED_ERROR,
} from "../types/entitlement";
import type { ExportEntitlementDecision } from "../types/entitlement";

const MODULE = "ExportGate";

/**
 * Error thrown when a locked transaction is exported without a permitted mode.
 * The message is prefixed with the machine-readable PAYWALL_LOCKED code so the
 * renderer (which receives only `error: message` via wrapHandler) can detect the
 * paywall case and route to the unlock CTA rather than showing a generic failure.
 */
export class PaywallLockedError extends Error {
  public readonly code = PAYWALL_LOCKED_ERROR;
  constructor(
    message = `${PAYWALL_LOCKED_ERROR}: This transaction is locked. Unlock it to export.`,
  ) {
    super(message);
    this.name = "PaywallLockedError";
  }
}

/**
 * Enforce the export gate for a transaction and return the communications the
 * caller is permitted to export.
 *
 * Option A: an UNLOCKED tx exports the full record (communications unchanged);
 * a LOCKED tx is blocked outright (throws PAYWALL_LOCKED).
 *
 * @throws PaywallLockedError when the transaction is locked.
 * @returns { decision, communications } — communications is the input unchanged
 *          (there is no sample reduction under Option A).
 */
export async function enforceExportGate<T>(params: {
  transactionId: string;
  userId: string;
  communications: T[];
}): Promise<{ decision: ExportEntitlementDecision; communications: T[] }> {
  const { transactionId, communications } = params;

  const decision = await entitlementService.getExportDecision(transactionId);

  if (!decision.allowed) {
    logService.info("[ExportGate] Export BLOCKED — transaction locked", MODULE, {
      transactionId,
      reason: decision.reason,
    });
    throw new PaywallLockedError();
  }

  // mode === "full" — export the complete record.
  return { decision, communications };
}

/**
 * Emit the `export-completed` analytics event. Main-side, non-throwing —
 * an analytics failure must never fail an export that already succeeded.
 */
export async function emitExportCompleted(params: {
  userId: string;
  transactionId: string;
  mode: ExportEntitlementDecision["mode"];
  format: string;
}): Promise<void> {
  try {
    await supabaseService.trackEvent(params.userId, PAYWALL_ANALYTICS_EVENTS.EXPORT_COMPLETED, {
      transaction_id: params.transactionId,
      mode: params.mode,
      format: params.format,
    });
  } catch (error) {
    logService.warn("[ExportGate] Failed to emit export-completed", MODULE, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
