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
  type AgentMonthPrice,
  type AgentPlanState,
  type AgentPricesResult,
  type OpenBookCallResult,
  type OpenBillingPortalResult,
  type PlanSummary,
  type PlanSummaryResult,
} from "../types/billing";

const MODULE = "BillingService";

/** Upper bound on one plan-summary read (same bound as the entitlement read). */
export const PLAN_SUMMARY_TIMEOUT_MS = 5_000;
export const PLAN_SUMMARY_PATH = "/api/billing/plan-summary";

/**
 * Where the Upgrade actions go when billing is switched off on the portal
 * (plan-summary answers 404): the pre-billing page. A constant, never an
 * argument (SR R4).
 */
export const BILLING_OFF_FALLBACK_URL = "https://www.keeprcompliance.com/beta";

/** The configured portal address is not one this app will open. */
export const BILLING_PORTAL_URL_REFUSED_ERROR =
  "The billing page address isn't one this app can open.";
/** The address was allowed, but the browser could not be opened. */
export const BILLING_PORTAL_OPEN_FAILED_ERROR = "The browser couldn't be opened.";

const UNAVAILABLE: PlanSummaryResult = Object.freeze({ unavailable: true as const });

/** BACKLOG-3676: the Agent plan price and the booking link, from the portal. */
export const AGENT_PRICES_PATH = "/api/billing/agent-prices";
/** The only host "Book a call" may open (the portal's onboarding booking page). */
export const BOOK_CALL_HOST = "bookings.cloud.microsoft";

/** True only for an https URL on the booking host. */
export function isBookCallUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === BOOK_CALL_HOST;
  } catch {
    return false;
  }
}

/** The agent-prices body, field by field, or null when it is not the portal's shape. */
export function parseAgentPrices(
  body: unknown,
): { month: AgentMonthPrice | null; bookCallUrl: string | null } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const r = body as Record<string, unknown>;
  let month: AgentMonthPrice | null = null;
  if (r.month !== null) {
    const m = r.month as Record<string, unknown> | undefined;
    if (
      !m ||
      typeof m !== "object" ||
      typeof m.display !== "string" ||
      m.display.trim() === "" ||
      typeof m.unitAmount !== "number" ||
      typeof m.currency !== "string"
    ) {
      return null;
    }
    month = { display: m.display, unitAmount: m.unitAmount, currency: m.currency };
  }
  return { month, bookCallUrl: isBookCallUrl(r.bookCallUrl) ? r.bookCallUrl : null };
}

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
  /**
   * Open the portal Billing page. Takes no URL and no path. When the portal
   * says billing is off (plan-summary 404, read now, bounded by the 5 s
   * timeout) it opens BILLING_OFF_FALLBACK_URL instead. 200, 401, 5xx,
   * timeout, offline and no session all open Billing.
   */
  async openPortal(): Promise<OpenBillingPortalResult> {
    if (await this.isBillingOff()) {
      try {
        await shell.openExternal(BILLING_OFF_FALLBACK_URL);
      } catch (error) {
        logService.warn("[Billing] Could not open the fallback page", MODULE, {
          error: error instanceof Error ? error.message : "Unknown error",
        });
        return {
          success: false,
          error: BILLING_PORTAL_OPEN_FAILED_ERROR,
          portalAddress: new URL(BILLING_OFF_FALLBACK_URL).origin,
        };
      }
      return { success: true };
    }
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

  /** True only when the portal answered plan-summary with a 404. */
  private async isBillingOff(): Promise<boolean> {
    // The portal answers 404 before it checks auth, so the probe also works
    // with no session (it then sends no Authorization header).
    return (await this.readPlanSummary(true)).status === 404;
  }

  /** The user's own plan summary, or { unavailable: true }. Never throws. */
  async getPlanSummary(): Promise<PlanSummaryResult> {
    return (await this.readPlanSummary()).result;
  }

  /** One bounded read. `status` is the HTTP status when one was received, else null. */
  private async readPlanSummary(probe = false): Promise<{ result: PlanSummaryResult; status: number | null }> {
    let status: number | null = null;
    const result = await this.readPlanSummaryInner(probe, (s) => {
      status = s;
    });
    return { result, status };
  }

  private async readPlanSummaryInner(
    probe: boolean,
    onStatus: (status: number) => void,
  ): Promise<PlanSummaryResult> {
    const origin = portalOrigin();
    if (!origin) return UNAVAILABLE;
    if (!isOnline()) return UNAVAILABLE;

    let accessToken: string | null = null;
    try {
      const session = await supabaseService.getAuthSession();
      accessToken = session?.accessToken ?? null;
    } catch {
      accessToken = null;
    }
    if (!accessToken && !probe) return UNAVAILABLE;

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
          headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
          signal: controller.signal,
        });
        // 404 = billing off on this portal; 401 = session not accepted;
        // 5xx = the portal could not read. All mean "no summary to show".
        onStatus(res.status);
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
   * BACKLOG-3676: the Agent plan monthly price for the paywall card, read on
   * every paywall open (S1, no cache). Bearer JWT, 5 s bound. Anything but a
   * 200 with the portal's shape is { unavailable: true }.
   */
  async getAgentPrices(): Promise<AgentPricesResult> {
    const prices = await this.readAgentPrices();
    if (!prices) return { unavailable: true };
    return { unavailable: false, month: prices.month, hasBookCall: prices.bookCallUrl !== null };
  }

  /**
   * "Book a call": opens the booking URL the portal's agent-prices route
   * answers, read now in main. Takes no argument; a URL that is not https on
   * the booking host is never opened.
   */
  async openBookCall(): Promise<OpenBookCallResult> {
    const prices = await this.readAgentPrices();
    const url = prices?.bookCallUrl ?? null;
    if (!isBookCallUrl(url)) return { success: false };
    try {
      await shell.openExternal(url);
      return { success: true };
    } catch (error) {
      logService.warn("[Billing] Could not open the booking page", MODULE, {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return { success: false };
    }
  }

  private async readAgentPrices(): Promise<
    { month: AgentMonthPrice | null; bookCallUrl: string | null } | null
  > {
    const origin = portalOrigin();
    if (!origin || !isOnline()) return null;
    let accessToken: string | null = null;
    try {
      accessToken = (await supabaseService.getAuthSession())?.accessToken ?? null;
    } catch {
      accessToken = null;
    }
    if (!accessToken) return null;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("agent prices read timed out"));
        }, PLAN_SUMMARY_TIMEOUT_MS);
      });
      const read = (async () => {
        const res = await net.fetch(`${origin}${AGENT_PRICES_PATH}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: controller.signal,
        });
        if (res.status !== 200) return null;
        return parseAgentPrices(await res.json());
      })();
      return await Promise.race([read, timeout]);
    } catch (error) {
      logService.warn("[Billing] Agent prices unavailable", MODULE, {
        error: error instanceof Error ? error.name : "Unknown error",
      });
      return null;
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
