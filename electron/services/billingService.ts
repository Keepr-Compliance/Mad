/**
 * Billing Service (BACKLOG-3863 PR-2, slice 2 — desktop main process).
 *
 * Three things, all display or navigation; nothing here gates a feature:
 *   openPortal()     opens the portal Billing page in the browser. The URL is
 *                    built only by portalUrl("billing"); no caller supplies one.
 *   getPlanSummary() reads GET {portal}/api/billing/plan-summary with the
 *                    user's Bearer JWT, bounded by a 5 s timeout. Any answer
 *                    other than a 200 with a valid body is { unavailable: true }.
 *   refresh()        after a return from the portal: forget the 60 s
 *                    entitlement memo and the feature-gate cache, then read
 *                    the summary again.
 *
 * The JWT is only ever sent to an allow-listed portal origin (portalOrigin()),
 * never to whatever BROKER_PORTAL_URL happens to say. No Stripe mode is sent,
 * read or stored: the portal decides its own (SR R4.2).
 */

import { net, shell } from "electron";
import supabaseService from "./supabaseService";
import entitlementService from "./entitlementService";
import featureGateService from "./featureGateService";
import logService from "./logService";
import { portalOrigin, portalUrl } from "../utils/portalUrl";
import {
  AGENT_PLAN_STATES,
  type AgentPlanState,
  type OpenBillingPortalResult,
  type PlanSummary,
  type PlanSummaryResult,
} from "../types/billing";

const MODULE = "BillingService";

/** Upper bound on one plan-summary read (same bound as the entitlement read). */
export const PLAN_SUMMARY_TIMEOUT_MS = 5_000;
export const PLAN_SUMMARY_PATH = "/api/billing/plan-summary";

/** The configured portal address is not one this app will open. */
export const BILLING_PORTAL_URL_REFUSED_ERROR =
  "The billing page address isn't one this app can open.";
/** The address was allowed, but the browser could not be opened. */
export const BILLING_PORTAL_OPEN_FAILED_ERROR = "The browser couldn't be opened.";

const UNAVAILABLE: PlanSummaryResult = Object.freeze({ unavailable: true as const });

function isOnline(): boolean {
  try {
    return net.isOnline();
  } catch {
    return true; // try the request; a failure still reads as unavailable
  }
}

function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

/**
 * The DTO, field by field, or null when the body is not the portal's shape.
 * Only the six known fields are copied; anything else in the body is dropped.
 */
export function parsePlanSummary(body: unknown): PlanSummary | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const r = body as Record<string, unknown>;
  if (!AGENT_PLAN_STATES.includes(r.state as AgentPlanState)) return null;
  if (!isStringOrNull(r.interval) || !isStringOrNull(r.current_period_end)) return null;
  if (
    typeof r.cancel_at_period_end !== "boolean" ||
    typeof r.paymentIncomplete !== "boolean" ||
    typeof r.supportGrantEffective !== "boolean"
  ) {
    return null;
  }
  return {
    state: r.state as AgentPlanState,
    interval: r.interval,
    current_period_end: r.current_period_end,
    cancel_at_period_end: r.cancel_at_period_end,
    paymentIncomplete: r.paymentIncomplete,
    supportGrantEffective: r.supportGrantEffective,
  };
}

class BillingService {
  /** Open the portal Billing page. Takes no URL and no path. */
  async openPortal(): Promise<OpenBillingPortalResult> {
    const url = portalUrl("billing");
    if (!url) {
      logService.warn("[Billing] Portal address refused", MODULE);
      return { success: false, error: BILLING_PORTAL_URL_REFUSED_ERROR };
    }
    try {
      await shell.openExternal(url);
    } catch (error) {
      logService.warn("[Billing] Could not open the billing page", MODULE, {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return {
        success: false,
        error: BILLING_PORTAL_OPEN_FAILED_ERROR,
        portalAddress: new URL(url).origin,
      };
    }
    return { success: true };
  }

  /** The user's own plan summary, or { unavailable: true }. Never throws. */
  async getPlanSummary(): Promise<PlanSummaryResult> {
    const origin = portalOrigin();
    if (!origin) return UNAVAILABLE;
    if (!isOnline()) return UNAVAILABLE;

    let accessToken: string;
    try {
      const session = await supabaseService.getAuthSession();
      if (!session?.accessToken) return UNAVAILABLE;
      accessToken = session.accessToken;
    } catch {
      return UNAVAILABLE;
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("plan summary read timed out"));
        }, PLAN_SUMMARY_TIMEOUT_MS);
      });
      const read = (async (): Promise<PlanSummaryResult> => {
        const res = await net.fetch(`${origin}${PLAN_SUMMARY_PATH}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: controller.signal,
        });
        // 404 = billing off on this portal; 401 = session not accepted;
        // 5xx = the portal could not read. All mean "no summary to show".
        if (res.status !== 200) return UNAVAILABLE;
        const summary = parsePlanSummary(await res.json());
        return summary ? { unavailable: false, summary } : UNAVAILABLE;
      })();
      return await Promise.race([read, timeout]);
    } catch (error) {
      logService.warn("[Billing] Plan summary unavailable", MODULE, {
        error: error instanceof Error ? error.name : "Unknown error",
      });
      return UNAVAILABLE;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * After the user returns from the portal: drop the cached plan answers so
   * the next export check and feature read are live, then read the summary.
   */
  async refresh(): Promise<PlanSummaryResult> {
    entitlementService.invalidateMemo();
    featureGateService.invalidateCache();
    return this.getPlanSummary();
  }
}

const billingService = new BillingService();
export default billingService;
