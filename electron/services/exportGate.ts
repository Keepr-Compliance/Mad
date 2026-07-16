/**
 * Export Gate (BACKLOG-2006a)
 *
 * The single, authoritative choke point every transaction-audit export handler
 * calls BEFORE producing an artifact. Because it lives in the main process,
 * NO renderer entry point (details Export, per-row Quick Export, Bulk Export —
 * which loops per-transaction through :export-enhanced) can bypass it.
 *
 * Responsibilities:
 *   1. Ask entitlementService for the gate decision (full / sample / none).
 *   2. On "none", throw the typed PAYWALL_LOCKED error so the handler aborts
 *      BEFORE any content is written.
 *   3. On "sample", reduce the communications to exactly the first email thread
 *      + first text thread (the same reveal the in-app teaser shows), so a free
 *      sample export can never contain the full record.
 *   4. Emit the `export-completed` analytics event after a successful export.
 */

import entitlementService from "./entitlementService";
import transactionService from "./transactionService";
import supabaseService from "./supabaseService";
import logService from "./logService";
import { isEmailMessage, isTextMessage } from "../utils/channelHelpers";
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

/** A communication row, loosely typed to what the gate needs. */
interface CommLike {
  channel?: string;
  communication_type?: string;
  thread_id?: string | null;
  sent_at?: string | null;
  received_at?: string | null;
}

/** Chronological key for a comm (sent, else received, else epoch). */
function commTimeMs(c: CommLike): number {
  const raw = c.sent_at ?? c.received_at ?? "";
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Reduce a communications array to exactly the FIRST email thread + FIRST text
 * thread for the free sample export. "First thread per channel" = the thread of
 * the CHRONOLOGICALLY EARLIEST message in that channel; ALL messages sharing
 * that thread_id are included so the sample thread reads coherently.
 *
 * Messages with no thread_id are treated as their own singleton thread (keyed
 * by a synthetic id) so a channel with only untreaded messages still yields
 * exactly one sample message rather than leaking all of them.
 */
export function selectSampleCommunications<T extends CommLike>(comms: T[]): T[] {
  const pickFirstThread = (channelComms: T[]): T[] => {
    if (channelComms.length === 0) return [];
    // Earliest message determines the sample thread.
    const sorted = [...channelComms].sort((a, b) => commTimeMs(a) - commTimeMs(b));
    const earliest = sorted[0];
    const threadKey = earliest.thread_id && earliest.thread_id.trim() !== ""
      ? `t:${earliest.thread_id}`
      : null;
    if (threadKey === null) {
      // Untreaded → the single earliest message is the whole sample thread.
      return [earliest];
    }
    return channelComms.filter(
      (c) => c.thread_id && `t:${c.thread_id}` === threadKey,
    );
  };

  const emails = comms.filter((c) => isEmailMessage(c));
  const texts = comms.filter((c) => isTextMessage(c));

  return [...pickFirstThread(emails), ...pickFirstThread(texts)];
}

/**
 * Enforce the export gate for a transaction and return the communications the
 * caller is permitted to export.
 *
 * @throws PaywallLockedError when the transaction is locked and no sample is permitted.
 * @returns { mode, communications } — communications is the (possibly sample-reduced)
 *          list to hand to the export service. For "full" it is the input unchanged.
 */
export async function enforceExportGate<T extends CommLike>(params: {
  transactionId: string;
  userId: string;
  communications: T[];
  /** true when the caller explicitly requested the free first-transaction sample. */
  requestSample?: boolean;
}): Promise<{ decision: ExportEntitlementDecision; communications: T[] }> {
  const { transactionId, userId, communications, requestSample = false } = params;

  // Derive the user's transaction list for the deterministic first-transaction rule.
  const allUserTransactions = await transactionService.getTransactions(userId);

  const decision = await entitlementService.getExportDecision(
    transactionId,
    allUserTransactions,
    requestSample,
  );

  if (!decision.allowed) {
    logService.info("[ExportGate] Export BLOCKED — transaction locked", MODULE, {
      transactionId,
      reason: decision.reason,
    });
    throw new PaywallLockedError();
  }

  if (decision.mode === "sample") {
    const sample = selectSampleCommunications(communications);
    logService.info("[ExportGate] Sample export permitted (first transaction)", MODULE, {
      transactionId,
      sampleCount: sample.length,
    });
    return { decision, communications: sample };
  }

  // mode === "full"
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
