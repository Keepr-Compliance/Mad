/**
 * Entitlement Service (BACKLOG-2006a)
 *
 * The per-transaction paywall's source of truth in the main process.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * FAIL-CLOSED CONTRACT (the whole ballgame — do not weaken):
 *   Every resolution path defaults to LOCKED. A transaction is UNLOCKED only
 *   on a POSITIVE confirmation:
 *     • ONLINE  — a live `transaction_unlocks` row exists for (user, tx) with
 *                 refunded_at IS NULL. (We then mirror it into the offline cache.)
 *     • OFFLINE — a cache row (itself only ever written from a prior confirmed
 *                 server read) exists for (user, tx).
 *   Loading, error, not-authenticated, offline-with-no-cache, and refunded all
 *   resolve LOCKED. There is NO path where missing information reveals content.
 *
 * This is deliberately DISTINCT from featureGateService (which is fail-OPEN and
 * org-plan-scoped). Reusing that logic here would be a paywall bypass.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { net } from "electron";
import * as Sentry from "@sentry/electron/main";
import supabaseService from "./supabaseService";
import logService from "./logService";
import {
  getCachedUnlock,
  listCachedUnlockIds,
  upsertUnlock,
  removeCachedUnlock,
} from "./db/unlockCacheDbService";
import type {
  EntitlementStatus,
  UnlockStatus,
  UnlockQuote,
  UnlockResult,
  ExportEntitlementDecision,
} from "../types/entitlement";

const MODULE = "EntitlementService";

/**
 * Is the machine online? Uses Electron's net module. Defensive: if the check
 * itself throws (unavailable in some contexts), we assume ONLINE so we attempt
 * the authoritative server read rather than trusting the cache — the server
 * read is the stricter gate, so this bias is still fail-closed.
 */
function isOnline(): boolean {
  try {
    return net.isOnline();
  } catch {
    return true;
  }
}

class EntitlementService {
  /**
   * Resolve the current user's id from the live Supabase auth session.
   * @returns userId or null (null ⇒ cannot verify ownership ⇒ LOCKED).
   */
  private async getUserId(): Promise<string | null> {
    try {
      const session = await supabaseService.getAuthSession();
      return session?.userId ?? null;
    } catch (error) {
      logService.warn("[Entitlement] Failed to resolve auth session", MODULE, {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Read the live, non-refunded unlock row for (user, tx) from Supabase.
   * RLS (`transaction_unlocks_select_own`) restricts to the caller's own rows,
   * so we still filter by user_id defensively.
   *
   * @returns
   *   - { unlocked: true, unlockedAt, fundingSource } when a live non-refunded row exists
   *   - { unlocked: false }                           when the server confirms none
   *   - null                                          when the read FAILED (network/error)
   *                                                    — caller must fall back to cache, never unlock
   */
  private async readServerUnlock(
    userId: string,
    localTransactionId: string,
  ): Promise<
    | { unlocked: true; unlockedAt: string; fundingSource: string | null }
    | { unlocked: false }
    | null
  > {
    try {
      const client = supabaseService.getClient();

      // The select RLS policy uses auth.uid(); make sure a session is attached.
      const { data: sessionData } = await client.auth.getSession();
      if (!sessionData?.session) {
        // Try to restore from cached tokens (mirrors featureGateService).
        const restored = await supabaseService.getAuthSession();
        if (!restored) {
          logService.warn(
            "[Entitlement] No Supabase session for unlock read — cannot verify",
            MODULE,
          );
          return null; // fail-closed: treat as read failure
        }
      }

      const { data, error } = await client
        .from("transaction_unlocks")
        .select("unlocked_at, funding_source, refunded_at")
        .eq("user_id", userId)
        .eq("local_transaction_id", localTransactionId)
        .is("refunded_at", null)
        .limit(1)
        .maybeSingle();

      if (error) {
        logService.warn("[Entitlement] transaction_unlocks read failed", MODULE, {
          error: error.message,
          code: error.code,
        });
        return null; // read failed ⇒ fall back to cache, never unlock
      }

      if (data) {
        return {
          unlocked: true,
          unlockedAt: String(data.unlocked_at),
          fundingSource: (data.funding_source as string | null) ?? null,
        };
      }
      return { unlocked: false };
    } catch (error) {
      logService.warn("[Entitlement] Unexpected error reading unlock", MODULE, {
        error: error instanceof Error ? error.message : String(error),
      });
      Sentry.captureException(error, {
        tags: { service: "entitlement-service", operation: "readServerUnlock" },
      });
      return null;
    }
  }

  /**
   * THE gate decision for a single transaction. Fail-closed at every branch.
   * Does NOT fetch quote/balance (those are separate, cheaper-to-skip calls);
   * callers that need the full renderer snapshot use getEntitlementStatus.
   */
  async getUnlockStatus(
    localTransactionId: string,
  ): Promise<{ status: UnlockStatus; fromCache: boolean; lockReason?: EntitlementStatus["lockReason"] }> {
    const userId = await this.getUserId();
    if (!userId) {
      return { status: "locked", fromCache: false, lockReason: "not_authenticated" };
    }

    // ONLINE: server is the source of truth.
    if (isOnline()) {
      const server = await this.readServerUnlock(userId, localTransactionId);

      if (server === null) {
        // Read FAILED despite being "online" — fall back to a prior confirmed
        // cache mirror (reading an already-purchased deal), else LOCKED.
        const cached = getCachedUnlock(localTransactionId, userId);
        if (cached) {
          return { status: "unlocked", fromCache: true };
        }
        return { status: "locked", fromCache: false, lockReason: "error" };
      }

      if (server.unlocked) {
        // Positive confirmation → mirror into cache for future offline reads.
        try {
          upsertUnlock({
            localTransactionId,
            userId,
            unlockedAt: server.unlockedAt,
            fundingSource: server.fundingSource,
          });
        } catch (error) {
          // Cache write failure must NOT block the (already-confirmed) unlock.
          logService.warn("[Entitlement] Failed to write unlock cache", MODULE, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return { status: "unlocked", fromCache: false };
      }

      // Server AUTHORITATIVELY says no (non-refunded) unlock. Purge any stale
      // cache mirror so an offline read can't resurrect a refunded/revoked unlock.
      try {
        removeCachedUnlock(localTransactionId, userId);
      } catch {
        /* best-effort */
      }
      return { status: "locked", fromCache: false, lockReason: "no_unlock" };
    }

    // OFFLINE: a prior confirmed cache mirror is the ONLY way to be unlocked.
    const cached = getCachedUnlock(localTransactionId, userId);
    if (cached) {
      return { status: "unlocked", fromCache: true };
    }
    return { status: "locked", fromCache: false, lockReason: "offline_uncached" };
  }

  /**
   * Live PAYG quote for the paid unlock CTA. Null when offline/unavailable —
   * the UI must degrade to "online required", never to a free unlock.
   */
  async getNextUnlockQuote(): Promise<UnlockQuote | null> {
    if (!isOnline()) return null;
    const userId = await this.getUserId();
    if (!userId) return null;

    try {
      const client = supabaseService.getClient();
      const { data, error } = await client.rpc("get_next_unlock_quote", {
        p_user_id: userId,
      });
      if (error || !data) {
        logService.warn("[Entitlement] get_next_unlock_quote failed", MODULE, {
          error: error?.message,
        });
        return null;
      }
      // The RPC returns a TABLE (one row); the SDK surfaces it as an array.
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) return null;
      // Tier-progress fields (BACKLOG-2086) are additive + nullable: on the
      // open-ended top band the RPC returns NULL for all four (best price
      // reached). Map defensively — a missing column (older DB not yet migrated)
      // resolves undefined and the UI simply omits the incentive bar.
      const hasValue = (v: unknown): boolean => v !== null && v !== undefined;
      const currentBandMaxUnits = hasValue(row.current_band_max_units)
        ? Number(row.current_band_max_units)
        : null;
      const unitsUntilNextBand = hasValue(row.units_until_next_band)
        ? Number(row.units_until_next_band)
        : null;
      const nextBandUnitPriceCents = hasValue(row.next_band_unit_price_cents)
        ? Number(row.next_band_unit_price_cents)
        : null;
      const nextBandCurrency = hasValue(row.next_band_currency)
        ? String(row.next_band_currency)
        : null;
      const baseUnitPriceCents = hasValue(row.base_unit_price_cents)
        ? Number(row.base_unit_price_cents)
        : null;

      return {
        nextUnitIndex: Number(row.next_unit_index),
        unitPriceCents: Number(row.unit_price_cents),
        currency: String(row.currency ?? "USD"),
        pricingTierId: (row.pricing_tier_id as string | null) ?? null,
        currentBandMaxUnits,
        unitsUntilNextBand,
        nextBandUnitPriceCents,
        nextBandCurrency,
        baseUnitPriceCents,
      };
    } catch (error) {
      logService.warn("[Entitlement] Unexpected error fetching quote", MODULE, {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Grant-credit balance (credits spend BEFORE card). Null when unavailable.
   */
  async getCreditBalance(): Promise<number | null> {
    if (!isOnline()) return null;
    const userId = await this.getUserId();
    if (!userId) return null;

    try {
      const client = supabaseService.getClient();
      const { data, error } = await client.rpc("get_credit_balance", {
        p_user_id: userId,
      });
      if (error) {
        logService.warn("[Entitlement] get_credit_balance failed", MODULE, {
          error: error.message,
        });
        return null;
      }
      return typeof data === "number" ? data : Number(data ?? 0);
    } catch (error) {
      logService.warn("[Entitlement] Unexpected error fetching balance", MODULE, {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * The set of local transaction ids this device has a CONFIRMED unlock mirror
   * for (BACKLOG-2090 — the transaction-list "Unlocked" badge). Reads the local
   * `transaction_unlocks_cache` mirror only, so it is cheap (one query, no server
   * round-trip per row) and offline-safe.
   *
   * FAIL-CLOSED: a tx absent from this list is LOCKED as far as the badge is
   * concerned. The mirror is only ever written after a live server read confirmed
   * a non-refunded unlock, so a returned id is a positively-confirmed unlock on
   * THIS device. Never throws — returns [] on any failure (badge shows all locked
   * rather than falsely "unlocked").
   */
  async getUnlockedIds(): Promise<string[]> {
    try {
      const userId = await this.getUserId();
      if (!userId) return [];
      return listCachedUnlockIds(userId);
    } catch (error) {
      logService.warn("[Entitlement] getUnlockedIds failed", MODULE, {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Full entitlement snapshot for the renderer: gate decision + quote + balance.
   * Quote/balance are fetched only when LOCKED (an unlocked tx needs no CTA).
   */
  async getEntitlementStatus(
    localTransactionId: string,
  ): Promise<EntitlementStatus> {
    const decision = await this.getUnlockStatus(localTransactionId);

    if (decision.status === "unlocked") {
      return {
        localTransactionId,
        status: "unlocked",
        fromCache: decision.fromCache,
        quote: null,
        creditBalance: null,
      };
    }

    // LOCKED — fetch CTA inputs in parallel (both fail-safe to null offline/error).
    const [quote, creditBalance] = await Promise.all([
      this.getNextUnlockQuote(),
      this.getCreditBalance(),
    ]);

    return {
      localTransactionId,
      status: "locked",
      lockReason: decision.lockReason,
      fromCache: decision.fromCache,
      quote,
      creditBalance,
    };
  }

  /**
   * AUTHORITATIVE export gate (BACKLOG-2006a; BACKLOG-2075 Option A). Decides
   * whether a transaction may be exported. Called from the MAIN-process export
   * handlers, so NO renderer entry point (details / quick / bulk) can bypass it.
   *
   * Rules (founder-decided — Option A: gate export only, reading is free):
   *   - UNLOCKED tx → mode "full" (complete record).
   *   - LOCKED tx   → mode "none" (nothing may be exported; the handler throws
   *                   PAYWALL_LOCKED and the renderer routes to the unlock CTA).
   *
   * There is no free/sample export — that (and the first-transaction reveal) was
   * deferred to BACKLOG-2079 with the read-paywall.
   */
  async getExportDecision(
    localTransactionId: string,
  ): Promise<ExportEntitlementDecision> {
    const decision = await this.getUnlockStatus(localTransactionId);

    if (decision.status === "unlocked") {
      return { allowed: true, mode: "full" };
    }

    return {
      allowed: false,
      mode: "none",
      reason: decision.lockReason,
    };
  }

  /**
   * Unlock a transaction using a granted credit (grants-first path via
   * unlock_transaction). Card purchases are BACKLOG-2015's responsibility.
   * Strictly online.
   */
  async unlockWithCredit(localTransactionId: string): Promise<UnlockResult> {
    if (!isOnline()) {
      return { success: false, status: "locked", error: "offline" };
    }
    const userId = await this.getUserId();
    if (!userId) {
      return { success: false, status: "locked", error: "not_authenticated" };
    }

    try {
      const client = supabaseService.getClient();
      const { data, error } = await client.rpc("unlock_transaction", {
        p_local_transaction_id: localTransactionId,
      });

      if (error) {
        logService.warn("[Entitlement] unlock_transaction failed", MODULE, {
          error: error.message,
        });
        return { success: false, status: "locked", error: error.message };
      }

      // unlock_transaction returns jsonb; a successful debit created a
      // transaction_unlocks row. Re-read authoritatively to confirm + cache,
      // rather than trusting the RPC's return shape.
      const confirmed = await this.getUnlockStatus(localTransactionId);
      if (confirmed.status === "unlocked") {
        return { success: true, status: "unlocked" };
      }

      logService.warn(
        "[Entitlement] unlock_transaction returned but re-read still locked",
        MODULE,
        { data: JSON.stringify(data) },
      );
      return { success: false, status: "locked", error: "unlock_not_confirmed" };
    } catch (error) {
      logService.warn("[Entitlement] Unexpected error unlocking", MODULE, {
        error: error instanceof Error ? error.message : String(error),
      });
      Sentry.captureException(error, {
        tags: { service: "entitlement-service", operation: "unlockWithCredit" },
      });
      return { success: false, status: "locked", error: "error" };
    }
  }
}

const entitlementService = new EntitlementService();
export default entitlementService;
