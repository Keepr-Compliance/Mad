/**
 * Payment Service (BACKLOG-2015 — desktop PAYG card-purchase flow, 2005b)
 *
 * Owns every money / JWT / portal call for the zero-balance card path. Consumed
 * by paymentHandlers; drives the PurchaseUnlockHandoff renderer via IPC.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * FAIL-CLOSED CONTRACT (shared with entitlementService — do not weaken):
 *   A portal 200 NEVER unlocks a transaction on its own. The ONLY unlock
 *   authority is `entitlementService.getUnlockStatus(tx)` re-read as "unlocked".
 *   `confirm` polls the portal /status (session-keyed self-heal) AND/OR re-reads
 *   the authoritative `transaction_unlocks` gate, and returns unlocked ONLY on a
 *   positive gate confirmation. Timeout / offline / error → NOT unlocked.
 *
 *   The deep-link `sessionId` is UNTRUSTED input (any local app can fire
 *   keepr://payment-callback) — it is sanitized here and never trusted to grant
 *   anything; confirmation is JWT-authed /status + the gate re-read.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Server contract (BACKLOG-2005a, merged) at ${BROKER_PORTAL_URL}/api/payments:
 *   POST /checkout-session {local_transaction_id} → {checkout_url, deep_link}
 *   POST /charge          {local_transaction_id} → {succeeded} | {requires_action,redirect_url}
 *                                                 | 402 {declined,code,message}
 *                                                 | 409 {error:'no_saved_payment_method'}
 *   GET  /status?session=<id> → {status, unlocked}
 * All three verify the Bearer JWT server-side and re-quote the price (never
 * client-supplied). See broker-portal/app/api/payments/*.
 */

import { net, shell } from "electron";
import * as Sentry from "@sentry/electron/main";
import supabaseService from "./supabaseService";
import entitlementService from "./entitlementService";
import logService from "./logService";
import { PAYWALL_ANALYTICS_EVENTS } from "../types/entitlement";
import type {
  BeginCheckoutResult,
  ChargeResult,
  PaymentConfirmResult,
  SavedCardStatus,
} from "../types/payment";

const MODULE = "PaymentService";

/** Bounded polling for the gate re-read after a browser return / off-session charge. */
const CONFIRM_POLL_ATTEMPTS = 15; // ~15 * 2s ≈ 30s; webhook typically < 10s
const CONFIRM_POLL_INTERVAL_MS = 2000;

function portalBase(): string {
  return process.env.BROKER_PORTAL_URL || "https://app.keeprcompliance.com";
}

function isOnline(): boolean {
  try {
    return net.isOnline();
  } catch {
    return true; // bias to attempting the authoritative server call (still fail-closed)
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

class PaymentService {
  /** Resolve the current user's id + JWT from the live Supabase session. */
  private async getAuth(): Promise<{ userId: string; accessToken: string } | null> {
    try {
      const session = await supabaseService.getAuthSession();
      if (!session?.userId || !session.accessToken) return null;
      return { userId: session.userId, accessToken: session.accessToken };
    } catch (error) {
      logService.warn("[Payment] Failed to resolve auth session", MODULE, {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** Emit the `unlock-clicked` funnel event (best-effort, non-throwing). */
  private async emitUnlockClicked(userId: string, localTransactionId: string): Promise<void> {
    try {
      await supabaseService.trackEvent(userId, PAYWALL_ANALYTICS_EVENTS.UNLOCK_CLICKED, {
        transaction_id: localTransactionId,
      });
    } catch (error) {
      logService.warn("[Payment] Failed to emit unlock-clicked", MODULE, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Flow A — first purchase. Create a Checkout Session and open it in the
   * external browser. The renderer then waits for `payment:deep-link-callback`
   * and calls `confirm`.
   */
  async beginCheckout(localTransactionId: string): Promise<BeginCheckoutResult> {
    if (!isOnline()) return { started: false, error: "offline" };
    const auth = await this.getAuth();
    if (!auth) return { started: false, error: "unauthenticated" };

    void this.emitUnlockClicked(auth.userId, localTransactionId);

    try {
      const res = await net.fetch(`${portalBase()}/api/payments/checkout-session`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${auth.accessToken}`,
        },
        body: JSON.stringify({ local_transaction_id: localTransactionId }),
      });

      if (!res.ok) {
        const body = await res.text();
        logService.warn("[Payment] checkout-session failed", MODULE, {
          status: res.status,
          body: body.slice(0, 200),
        });
        return { started: false, error: res.status === 401 ? "unauthenticated" : "no_quote" };
      }

      const data = (await res.json()) as { checkout_url?: string };
      if (!data.checkout_url) {
        return { started: false, error: "error" };
      }

      await shell.openExternal(data.checkout_url);
      return { started: true };
    } catch (error) {
      logService.warn("[Payment] Unexpected error starting Checkout", MODULE, {
        error: error instanceof Error ? error.message : String(error),
      });
      Sentry.captureException(error, {
        tags: { service: "payment-service", operation: "beginCheckout" },
      });
      return { started: false, error: "error" };
    }
  }

  /**
   * Flow B — one-click off-session charge of the saved card. The webhook
   * fulfills; the caller confirms via the gate re-read. Maps SCA / decline / no
   * saved card to distinct outcomes. On requires_action WITH a hosted URL, the
   * URL is opened externally here (returns via the deep link); on
   * requires_action with NO URL, the caller falls back to Flow A Checkout.
   */
  async chargeSavedCard(localTransactionId: string): Promise<ChargeResult> {
    if (!isOnline()) return { outcome: "offline" };
    const auth = await this.getAuth();
    if (!auth) return { outcome: "error" };

    void this.emitUnlockClicked(auth.userId, localTransactionId);

    try {
      const res = await net.fetch(`${portalBase()}/api/payments/charge`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${auth.accessToken}`,
        },
        body: JSON.stringify({ local_transaction_id: localTransactionId }),
      });

      // 409 → no saved card ⇒ caller runs Flow A.
      if (res.status === 409) return { outcome: "no_saved_card" };

      // 402 → recoverable payment failure. Two distinct sub-cases:
      //   invalid_payment_method (BACKLOG-2088) — the saved card is unusable
      //     (detached/deleted); the portal already cleared the stale cache. The
      //     caller shows "add a new card" and routes to Checkout.
      //   declined — a genuine hard decline (card_declined, insufficient_funds…).
      if (res.status === 402) {
        const data = (await res.json().catch(() => ({}))) as {
          declined?: boolean;
          invalid_payment_method?: boolean;
          code?: string;
          message?: string;
        };
        if (data.invalid_payment_method) {
          return {
            outcome: "invalid_payment_method",
            code: data.code ?? "invalid_payment_method",
            message: data.message,
          };
        }
        return { outcome: "declined", code: data.code ?? "card_declined", message: data.message };
      }

      if (!res.ok) {
        logService.warn("[Payment] charge failed", MODULE, { status: res.status });
        return { outcome: "error" };
      }

      const data = (await res.json()) as {
        succeeded?: boolean;
        requires_action?: boolean;
        redirect_url?: string | null;
      };

      if (data.requires_action) {
        const redirectUrl = data.redirect_url ?? null;
        // Null URL (merged /charge can return this — no return_url on the PI):
        // caller falls back to Flow A Checkout (which handles 3DS itself).
        if (!redirectUrl) {
          return { outcome: "requires_action", redirectUrl: null };
        }
        await shell.openExternal(redirectUrl);
        return { outcome: "requires_action", redirectUrl };
      }

      // succeeded / processing → the webhook fulfills; caller confirms via gate.
      return { outcome: "succeeded" };
    } catch (error) {
      logService.warn("[Payment] Unexpected error charging saved card", MODULE, {
        error: error instanceof Error ? error.message : String(error),
      });
      Sentry.captureException(error, {
        tags: { service: "payment-service", operation: "chargeSavedCard" },
      });
      return { outcome: "error" };
    }
  }

  /**
   * Confirm a purchase after the browser return. THE unlock authority.
   *
   * Strategy: bounded polling. Each attempt (a) if a sessionId is present, hits
   * the portal /status (session-keyed; self-heals a charged-but-unfulfilled
   * unlock), then (b) re-reads the authoritative `transaction_unlocks` gate.
   * Returns unlocked ONLY when the gate says "unlocked". Never trusts /status or
   * the sessionId alone.
   */
  async confirm(
    localTransactionId: string,
    sessionId: string | null,
  ): Promise<PaymentConfirmResult> {
    if (!isOnline()) return { unlocked: false, reason: "offline" };
    const auth = await this.getAuth();
    if (!auth) return { unlocked: false, reason: "unauthenticated" };

    const safeSession = sanitizeSessionId(sessionId);

    for (let attempt = 0; attempt < CONFIRM_POLL_ATTEMPTS; attempt++) {
      // (a) Nudge the portal to self-heal (session-keyed). Best-effort.
      if (safeSession) {
        await this.pokePortalStatus(auth.accessToken, safeSession);
      }

      // (b) Authoritative gate re-read — the ONLY thing that unlocks.
      const gate = await entitlementService.getUnlockStatus(localTransactionId);
      if (gate.status === "unlocked") {
        return { unlocked: true };
      }

      if (attempt < CONFIRM_POLL_ATTEMPTS - 1) {
        await sleep(CONFIRM_POLL_INTERVAL_MS);
      }
    }

    return { unlocked: false, reason: "timeout" };
  }

  /** Best-effort GET /status to trigger the portal's self-heal. Return ignored. */
  private async pokePortalStatus(accessToken: string, sessionId: string): Promise<void> {
    try {
      await net.fetch(
        `${portalBase()}/api/payments/status?session=${encodeURIComponent(sessionId)}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );
    } catch {
      // Non-fatal — the gate re-read is authoritative regardless.
    }
  }

  /**
   * Whether the user has a saved card (Flow B eligibility). Pure optimization —
   * the /charge 409 is authoritative. RLS-scoped read of stripe_customers
   * (own-row only; the columns are opaque Stripe ids, never card data).
   */
  async hasSavedCard(): Promise<SavedCardStatus> {
    if (!isOnline()) return { hasSavedCard: false };
    const auth = await this.getAuth();
    if (!auth) return { hasSavedCard: false };

    try {
      const client = supabaseService.getClient();
      const { data, error } = await client
        .from("stripe_customers")
        .select("default_payment_method_id")
        .eq("user_id", auth.userId)
        .maybeSingle();
      if (error) {
        logService.warn("[Payment] stripe_customers read failed", MODULE, {
          error: error.message,
        });
        return { hasSavedCard: false };
      }
      return { hasSavedCard: Boolean(data?.default_payment_method_id) };
    } catch (error) {
      logService.warn("[Payment] Unexpected error reading saved card", MODULE, {
        error: error instanceof Error ? error.message : String(error),
      });
      return { hasSavedCard: false };
    }
  }
}

/**
 * Sanitize an UNTRUSTED deep-link session id before use. Stripe Checkout Session
 * ids look like `cs_test_...` / `cs_live_...`: `cs_` + alphanumerics. We accept a
 * conservative charset and cap length; anything else → null (no /status poke,
 * confirmation relies purely on the gate re-read). Never used to grant anything.
 */
export function sanitizeSessionId(sessionId: string | null | undefined): string | null {
  if (typeof sessionId !== "string") return null;
  const trimmed = sessionId.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return null;
  if (!/^[A-Za-z0-9_]+$/.test(trimmed)) return null;
  return trimmed;
}

const paymentService = new PaymentService();
export default paymentService;
