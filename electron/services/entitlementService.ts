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
 *     • UNLIMITED (BACKLOG-3675) — no unlock row, and a LIVE read says the
 *                 account's organization has `unlimited_transactions` enabled
 *                 (exactly `true`); or, only when that live answer is
 *                 unavailable (offline / read error), a stored offline pass
 *                 that verifies for this user (signature, kid, 48 h window,
 *                 paid-period cap, clock checks). A definite live "no"
 *                 always wins and deletes the pass. Neither path writes the
 *                 unlock cache, and neither reads feature-cache.json.
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
import { verifyOfflinePass } from "./offlinePass/offlinePassVerifier";
import {
  readOfflinePass,
  storeOfflinePass,
  deleteOfflinePass,
} from "./offlinePass/offlinePassStore";
import { OFFLINE_PASS_PUBLIC_KEYS } from "../constants/offlinePassKeys";

const MODULE = "EntitlementService";

// ── Unlimited transactions (BACKLOG-3675) ─────────────────────────────────
/** Plan feature key. Must equal the key the migration inserts. */
export const UNLIMITED_TRANSACTIONS_FEATURE_KEY = "unlimited_transactions";
/** Edge Function that signs the offline pass. */
export const OFFLINE_PASS_ISSUER_FUNCTION = "issue-offline-pass";
/** How long a definite live answer is reused on the export path. */
const ENTITLEMENT_MEMO_TTL_MS = 60_000;
/** Upper bound on one live entitlement read. Timeout ⇒ "error". */
const ENTITLEMENT_READ_TIMEOUT_MS = 5_000;
const OFFLINE_PASS_ISSUE_TIMEOUT_MS = 10_000;
/** Minimum gap between pass refresh attempts triggered by exports. */
const OFFLINE_PASS_REFRESH_MIN_GAP_MS = 10 * 60_000;
const OFFLINE_PASS_REFRESHER_FIRST_DELAY_MS = 20_000;
const OFFLINE_PASS_REFRESHER_INTERVAL_MS = 30 * 60_000;

/**
 * The live answer to "does this account have unlimited transactions?".
 *   entitled      — membership found and get_org_features says enabled === true
 *   not_entitled  — a definite "no" (no membership, not_authorized, key absent
 *                   or not exactly `true`). Beats and deletes the offline pass.
 *   error         — the question could not be answered (network, timeout,
 *                   unexpected shape). Only then may the offline pass apply.
 */
export type LiveUnlimitedEntitlement = "entitled" | "not_entitled" | "error";

class EntitlementReadTimeoutError extends Error {
  constructor() {
    super("entitlement read timed out");
    this.name = "EntitlementReadTimeoutError";
  }
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new EntitlementReadTimeoutError()), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Read `get_org_features`'s answer for the unlimited key. */
function readUnlimitedFromOrgFeatures(data: unknown): LiveUnlimitedEntitlement {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "error";
  const record = data as Record<string, unknown>;
  if (record.error !== undefined && record.error !== null) {
    // `{error: "not_authorized", features: []}` is the function's definite refusal.
    return record.error === "not_authorized" ? "not_entitled" : "error";
  }
  const features = record.features;
  if (!features || typeof features !== "object" || Array.isArray(features)) return "error";
  const entry = (features as Record<string, unknown>)[UNLIMITED_TRANSACTIONS_FEATURE_KEY];
  if (!entry || typeof entry !== "object") return "not_entitled";
  return (entry as Record<string, unknown>).enabled === true ? "entitled" : "not_entitled";
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

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
  /** userId → last definite live answer (never persisted). */
  private entitlementMemo = new Map<string, { answer: "entitled" | "not_entitled"; at: number }>();
  /** userId → last time an export-triggered pass refresh was attempted. */
  private passRefreshAttemptAt = new Map<string, number>();
  private refresherStarted = false;

  /**
   * Live read of the unlimited-transactions entitlement (BACKLOG-3675).
   * Membership → get_org_features. Bounded by a timeout; any failure is
   * "error", never "entitled". A definite "no" deletes the offline pass.
   *
   * @param useMemo true on the export path (60 s memo of definite answers);
   *                false on the debit path and the refresher.
   */
  private async readLiveUnlimitedEntitlement(
    userId: string,
    useMemo: boolean,
  ): Promise<LiveUnlimitedEntitlement> {
    if (useMemo) {
      const memo = this.entitlementMemo.get(userId);
      if (memo && Date.now() - memo.at < ENTITLEMENT_MEMO_TTL_MS) {
        return memo.answer;
      }
    }

    let answer: LiveUnlimitedEntitlement;
    try {
      answer = await withTimeout(this.queryUnlimitedEntitlement(userId), ENTITLEMENT_READ_TIMEOUT_MS);
    } catch (error) {
      logService.warn("[Entitlement] Unlimited entitlement read failed", MODULE, {
        error: error instanceof Error ? error.message : String(error),
      });
      answer = "error";
    }

    if (answer === "error") {
      this.entitlementMemo.delete(userId);
      return answer;
    }
    this.entitlementMemo.set(userId, { answer, at: Date.now() });
    if (answer === "not_entitled") {
      await deleteOfflinePass();
    }
    return answer;
  }

  private async queryUnlimitedEntitlement(userId: string): Promise<LiveUnlimitedEntitlement> {
    const membership = await supabaseService.getActiveOrganizationMembershipOutcome(userId);
    if (membership.status === "none") return "not_entitled";
    if (membership.status !== "member") return "error";

    const client = supabaseService.getClient();
    const { data, error } = await client.rpc("get_org_features", {
      p_org_id: membership.organization_id,
    });
    if (error) return "error";
    return readUnlimitedFromOrgFeatures(data);
  }

  /**
   * Is there a stored offline pass that verifies for this user right now?
   * Consulted ONLY when the live answer is unavailable (offline or a read
   * error) — never after a definite live "no".
   */
  private async hasValidOfflinePass(userId: string): Promise<boolean> {
    try {
      const nowSec = nowSeconds();
      const stored = await readOfflinePass(nowSec);
      if (!stored) return false;
      const verdict = verifyOfflinePass({
        token: stored.token,
        nowSec,
        keys: OFFLINE_PASS_PUBLIC_KEYS,
        userId,
        highWaterSec: stored.highWaterSec,
      });
      if (!verdict.ok) {
        logService.info("[Entitlement] Offline pass not accepted", MODULE, {
          reason: verdict.reason,
        });
        return false;
      }
      return true;
    } catch (error) {
      logService.warn("[Entitlement] Offline pass check failed", MODULE, {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Ask the issuer for a fresh pass and store it if it verifies for the
   * current user. Called only after a live "entitled" answer. Never throws.
   */
  private async fetchAndStoreOfflinePass(userId: string): Promise<void> {
    try {
      const client = supabaseService.getClient();
      const { data, error } = await withTimeout(
        client.functions.invoke(OFFLINE_PASS_ISSUER_FUNCTION, { body: {} }),
        OFFLINE_PASS_ISSUE_TIMEOUT_MS,
      );
      if (error) {
        logService.info("[Entitlement] Offline pass issuer unavailable", MODULE, {
          error: error instanceof Error ? error.message : String(error),
        });
        return; // keep whatever is stored
      }
      const body = (data ?? {}) as { pass?: unknown; reason?: unknown };
      if (typeof body.pass !== "string") {
        if (body.reason === "not_entitled" || body.reason === "paid_period_ended") {
          await deleteOfflinePass();
        }
        return;
      }
      const verdict = verifyOfflinePass({
        token: body.pass,
        nowSec: nowSeconds(),
        keys: OFFLINE_PASS_PUBLIC_KEYS,
        userId,
        // A fresh pass is checked against the device clock only; storing it
        // resets the high-water mark to the pass's issue time.
        highWaterSec: 0,
      });
      if (!verdict.ok) {
        logService.warn("[Entitlement] Issued offline pass rejected", MODULE, {
          reason: verdict.reason,
        });
        return;
      }
      const stored = await storeOfflinePass(body.pass, verdict.payload.iat);
      if (stored) {
        logService.info("[Entitlement] Offline pass stored", MODULE, {
          kid: verdict.kid,
          exp: verdict.payload.exp,
        });
      }
    } catch (error) {
      logService.warn("[Entitlement] Offline pass refresh failed", MODULE, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Export-path refresh, throttled to one attempt per user per 10 minutes. */
  private maybeRefreshOfflinePass(userId: string): void {
    const last = this.passRefreshAttemptAt.get(userId);
    if (last !== undefined && Date.now() - last < OFFLINE_PASS_REFRESH_MIN_GAP_MS) return;
    this.passRefreshAttemptAt.set(userId, Date.now());
    void this.fetchAndStoreOfflinePass(userId);
  }

  /**
   * One refresher tick: offline or signed out → nothing; live "entitled" →
   * fetch and store a pass; live "no" → the pass is deleted (by the read);
   * error → keep whatever is stored. Never throws.
   */
  async runOfflinePassRefreshTick(): Promise<void> {
    try {
      if (!isOnline()) return;
      const userId = await this.getUserId();
      if (!userId) return;
      const live = await this.readLiveUnlimitedEntitlement(userId, false);
      if (live !== "entitled") return;
      this.passRefreshAttemptAt.set(userId, Date.now());
      await this.fetchAndStoreOfflinePass(userId);
    } catch (error) {
      logService.warn("[Entitlement] Offline pass refresher tick failed", MODULE, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Start the background pass refresher (first tick after 20 s, then every
   * 30 min). Main process only; idempotent; disabled under jest.
   */
  startOfflinePassRefresher(): void {
    if (this.refresherStarted || process.env.NODE_ENV === "test") return;
    this.refresherStarted = true;
    const first = setTimeout(() => {
      void this.runOfflinePassRefreshTick();
    }, OFFLINE_PASS_REFRESHER_FIRST_DELAY_MS);
    first.unref?.();
    const interval = setInterval(() => {
      void this.runOfflinePassRefreshTick();
    }, OFFLINE_PASS_REFRESHER_INTERVAL_MS);
    interval.unref?.();
  }

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
  ): Promise<{
    status: UnlockStatus;
    fromCache: boolean;
    lockReason?: EntitlementStatus["lockReason"];
    /** Diagnostic only: unlocked by the offline pass (BACKLOG-3675). */
    fromPass?: boolean;
  }> {
    const userId = await this.getUserId();
    if (!userId) {
      return { status: "locked", fromCache: false, lockReason: "not_authenticated" };
    }

    // ONLINE: server is the source of truth.
    if (isOnline()) {
      const server = await this.readServerUnlock(userId, localTransactionId);

      if (server === null) {
        // Read FAILED despite being "online" — fall back to a prior confirmed
        // cache mirror (reading an already-purchased deal), else a valid
        // offline pass (BACKLOG-3675; no live entitlement read here), else LOCKED.
        const cached = await getCachedUnlock(localTransactionId, userId);
        if (cached) {
          return { status: "unlocked", fromCache: true };
        }
        if (await this.hasValidOfflinePass(userId)) {
          return { status: "unlocked", fromCache: false, fromPass: true };
        }
        return { status: "locked", fromCache: false, lockReason: "error" };
      }

      if (server.unlocked) {
        // Positive confirmation → mirror into cache for future offline reads.
        try {
          await upsertUnlock({
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
        await removeCachedUnlock(localTransactionId, userId);
      } catch {
        /* best-effort */
      }

      // BACKLOG-3675: no unlock row — does the account have unlimited
      // transactions? Asked only here, after a definite row "no" (the session
      // is already attached by readServerUnlock). Nothing is written to the
      // unlock cache on this path.
      const live = await this.readLiveUnlimitedEntitlement(userId, true);
      if (live === "entitled") {
        this.maybeRefreshOfflinePass(userId);
        return { status: "unlocked", fromCache: false };
      }
      if (live === "error" && (await this.hasValidOfflinePass(userId))) {
        return { status: "unlocked", fromCache: false, fromPass: true };
      }
      return { status: "locked", fromCache: false, lockReason: "no_unlock" };
    }

    // OFFLINE: a prior confirmed cache mirror, else a valid offline pass
    // (BACKLOG-3675), are the only ways to be unlocked.
    const cached = await getCachedUnlock(localTransactionId, userId);
    if (cached) {
      return { status: "unlocked", fromCache: true };
    }
    if (await this.hasValidOfflinePass(userId)) {
      return { status: "unlocked", fromCache: false, fromPass: true };
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

    // BACKLOG-3675: never spend a credit for an account with unlimited
    // transactions. Fresh live read (memo bypassed). Only a definite "no"
    // reaches the debit below.
    const live = await this.readLiveUnlimitedEntitlement(userId, false);
    if (live === "entitled") {
      return { success: true, status: "unlocked" };
    }
    if (live === "error") {
      if (await this.hasValidOfflinePass(userId)) {
        return { success: true, status: "unlocked" };
      }
      return { success: false, status: "locked", error: "entitlement_unverified" };
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
