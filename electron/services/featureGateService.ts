/**
 * Feature Gate Service
 * SPRINT-122: Plan Admin + Feature Gate Enforcement
 *
 * Checks feature flags via Supabase RPCs, caches results locally,
 * and exposes feature access checks to the renderer via IPC.
 *
 * Design principles:
 * - Cache with 5-minute TTL, persisted for offline fallback
 * - Fail-open when offline with no cache (allow all)
 * - NEVER block app startup waiting for feature flags
 * - Default to allowed for unknown features
 */

import { promises as fs } from "fs";
import path from "path";
import { app } from "electron";
import * as Sentry from "@sentry/electron/main";
import supabaseService from "./supabaseService";
import logService from "./logService";
import type { FeatureAccess } from "../types/featureGate";

// Re-export so existing consumers can still import from here
export type { FeatureAccess } from "../types/featureGate";

// ============================================
// Types
// ============================================

interface FeatureCache {
  features: Record<string, FeatureAccess>;
  fetchedAt: number;
  orgId: string;
}

// ============================================
// Constants
// ============================================

/** Cache time-to-live: 5 minutes */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Maximum age for persisted disk cache: 7 days.
 *  If the app is offline longer than this, discard stale cache and fail-open. */
const PERSISTED_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Cache file name (stored in app userData directory) */
const FEATURE_CACHE_FILENAME = "feature-cache.json";

// ============================================
// Service
// ============================================

class FeatureGateService {
  private cache: FeatureCache | null = null;
  private fetchInProgress: Promise<void> | null = null;

  /**
   * Check access to a specific feature for an organization.
   *
   * Resolution order:
   * 1. In-memory cache (if fresh)
   * 2. Supabase RPC fetch (refreshes cache)
   * 3. Persisted cache on disk (offline fallback)
   * 4. Default: allowed (fail-open)
   */
  async checkFeature(
    orgId: string,
    featureKey: string
  ): Promise<FeatureAccess> {
    // 1. Check in-memory cache
    if (this.isCacheFresh(orgId)) {
      const cached = this.cache!.features[featureKey];
      if (cached) {
        return cached;
      }
      // Feature not in cache => unknown feature, default to allowed
      return this.defaultAccess();
    }

    // 2. Try to refresh from Supabase
    try {
      await this.ensureFresh(orgId);
      if (this.cache && this.cache.orgId === orgId) {
        const result = this.cache.features[featureKey];
        return result || this.defaultAccess();
      }
    } catch (error) {
      logService.warn(
        "[FeatureGate] Failed to fetch from Supabase, trying persisted cache",
        "FeatureGateService",
        { error: error instanceof Error ? error.message : "Unknown error" }
      );
    }

    // 3. Try persisted cache
    const persisted = await this.loadPersistedCache(orgId);
    if (persisted) {
      this.cache = persisted;
      const result = persisted.features[featureKey];
      return result || this.defaultAccess();
    }

    // 4. No cache at all => fail-open
    logService.info(
      "[FeatureGate] No cache available, defaulting to allowed (fail-open)",
      "FeatureGateService",
      { orgId, featureKey }
    );
    return this.defaultAccess();
  }

  /**
   * Get all features for an organization.
   * Same resolution order as checkFeature.
   */
  async getAllFeatures(
    orgId: string
  ): Promise<Record<string, FeatureAccess>> {
    const features = await this.getAllFeaturesOrNull(orgId);
    if (features) {
      return features;
    }

    // 4. No cache => empty (fail-open means nothing is blocked)
    logService.info(
      "[FeatureGate] No cache available, returning empty features (fail-open)",
      "FeatureGateService",
      { orgId }
    );
    return {};
  }

  /**
   * Get all features for an organization, or `null` when there is no answer.
   *
   * BACKLOG-3349. Identical to {@link getAllFeatures} except at the end: where
   * that method's fail-open contract turns "I could not reach the plan and
   * there is no cache" into `{}` — indistinguishable from "your plan grants
   * nothing" — this one returns `null` and lets the caller decide.
   *
   * A strict (fail-closed) reader needs that difference. `{}` from a failed
   * fetch and `{}` from a real answer lead to opposite sentences on screen:
   * "we can't check your plan right now" versus "not in your plan". Only the
   * second is a claim about the plan, and making it on the strength of a failed
   * network read tells a paying, offline user that he did not pay.
   *
   * Every existing caller keeps its behaviour: `getAllFeatures` still answers
   * `{}`, with the same log line, at the same point.
   */
  async getAllFeaturesOrNull(
    orgId: string
  ): Promise<Record<string, FeatureAccess> | null> {
    // 1. Check in-memory cache
    if (this.isCacheFresh(orgId)) {
      return { ...this.cache!.features };
    }

    // 2. Try to refresh from Supabase
    try {
      await this.ensureFresh(orgId);
      if (this.cache && this.cache.orgId === orgId) {
        return { ...this.cache.features };
      }
    } catch (error) {
      logService.warn(
        "[FeatureGate] Failed to fetch all features from Supabase",
        "FeatureGateService",
        { error: error instanceof Error ? error.message : "Unknown error" }
      );
    }

    // 3. Try persisted cache
    const persisted = await this.loadPersistedCache(orgId);
    if (persisted) {
      this.cache = persisted;
      return { ...persisted.features };
    }

    // 4. No fetch, no cache: no answer. NOT an empty plan.
    return null;
  }

  /**
   * Invalidate the in-memory cache, forcing a refresh on next check.
   */
  invalidateCache(): void {
    this.cache = null;
    logService.debug(
      "[FeatureGate] In-memory cache invalidated",
      "FeatureGateService"
    );
  }

  /**
   * Clear all caches (in-memory + persisted). Call on logout.
   */
  async clearCache(): Promise<void> {
    this.cache = null;
    try {
      await fs.unlink(this.getCacheFilePath());
      logService.debug(
        "[FeatureGate] Cache cleared (memory + disk)",
        "FeatureGateService"
      );
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logService.warn(
          "[FeatureGate] Failed to clear persisted cache",
          "FeatureGateService",
          { error: error instanceof Error ? error.message : "Unknown error" }
        );
      }
    }
  }

  // ============================================
  // Private: Cache management
  // ============================================

  /**
   * Ensure the cache is fresh. If a fetch is already in progress,
   * wait for it rather than making duplicate requests.
   */
  private async ensureFresh(orgId: string): Promise<void> {
    if (this.isCacheFresh(orgId)) {
      return;
    }

    if (this.fetchInProgress) {
      await this.fetchInProgress;
      return;
    }

    this.fetchInProgress = this.fetchFromSupabase(orgId);
    try {
      await this.fetchInProgress;
    } finally {
      this.fetchInProgress = null;
    }
  }

  private isCacheFresh(orgId: string): boolean {
    if (!this.cache) return false;
    if (this.cache.orgId !== orgId) return false;
    const age = Date.now() - this.cache.fetchedAt;
    return age < CACHE_TTL_MS;
  }

  // ============================================
  // Private: Supabase fetch
  // ============================================

  private async fetchFromSupabase(orgId: string): Promise<void> {
    logService.info(
      "[FeatureGate] Fetching features from Supabase",
      "FeatureGateService",
      { orgId }
    );

    const client = supabaseService.getClient();

    // BACKLOG-1348: Ensure the Supabase client has a valid auth session before calling the RPC.
    // The get_org_features RPC uses auth.uid() server-side, which requires an active session.
    // With persistSession: false, the session is only in-memory and may not be set if:
    //   - The feature gate check runs before session restoration completes
    //   - The token expired and wasn't auto-refreshed
    const { data: sessionData } = await client.auth.getSession();
    if (!sessionData?.session) {
      logService.warn(
        "[FeatureGate] No active Supabase auth session — RPC will likely fail. " +
        "Attempting session refresh from stored tokens.",
        "FeatureGateService",
        { orgId }
      );
      // Try to get auth session from supabaseService cache (may trigger SDK refresh)
      const authSession = await supabaseService.getAuthSession();
      if (!authSession) {
        logService.warn(
          "[FeatureGate] Cannot restore Supabase auth session — no cached session available. " +
          "Feature gate RPC will fail (no auth.uid()).",
          "FeatureGateService",
          { orgId }
        );
        throw new Error("No Supabase auth session available for RPC call");
      }
      logService.info(
        "[FeatureGate] Auth session found in cache, proceeding with RPC",
        "FeatureGateService",
        { orgId, userId: authSession.userId }
      );
    } else {
      logService.debug(
        "[FeatureGate] Auth session active, calling RPC",
        "FeatureGateService",
        { orgId, userId: sessionData.session.user?.id }
      );
    }

    const { data, error } = await client.rpc("get_org_features", {
      p_org_id: orgId,
    });

    if (error) {
      logService.warn(
        "[FeatureGate] RPC get_org_features failed",
        "FeatureGateService",
        { orgId, errorMessage: error.message, errorCode: error.code }
      );
      throw new Error(`get_org_features RPC failed: ${error.message}`);
    }

    logService.debug(
      "[FeatureGate] RPC get_org_features response received",
      "FeatureGateService",
      { orgId, hasData: !!data, dataType: typeof data }
    );

    // Transform RPC response into feature map
    // get_org_features returns JSONB: { org_id, plan_name, plan_tier, features: { [key]: { enabled, value, source, ... } } }
    const features: Record<string, FeatureAccess> = {};
    const featuresData = data?.features;

    if (featuresData && typeof featuresData === "object") {
      for (const [key, feature] of Object.entries(featuresData)) {
        const f = feature as { enabled: boolean; value: string; source: string };
        features[key] = {
          allowed: f.enabled === true,
          value: String(f.value ?? ""),
          source: (f.source as "plan" | "override" | "default") ?? "plan",
        };
      }
    }

    this.cache = {
      features,
      fetchedAt: Date.now(),
      orgId,
    };

    // Persist to disk for offline fallback
    await this.persistCache();

    logService.debug(
      "[FeatureGate] Features fetched and cached",
      "FeatureGateService",
      { orgId, featureCount: Object.keys(features).length }
    );
  }

  // ============================================
  // Private: Persistence
  // ============================================

  private getCacheFilePath(): string {
    return path.join(app.getPath("userData"), FEATURE_CACHE_FILENAME);
  }

  private async persistCache(): Promise<void> {
    if (!this.cache) return;

    try {
      await fs.writeFile(
        this.getCacheFilePath(),
        JSON.stringify(this.cache, null, 2),
        "utf8"
      );
      logService.debug(
        "[FeatureGate] Cache persisted to disk",
        "FeatureGateService"
      );
    } catch (error) {
      logService.warn(
        "[FeatureGate] Failed to persist cache to disk",
        "FeatureGateService",
        { error: error instanceof Error ? error.message : "Unknown error" }
      );
      Sentry.captureException(error, {
        tags: {
          service: "feature-gate-service",
          operation: "persistCache",
        },
      });
    }
  }

  private async loadPersistedCache(
    orgId: string
  ): Promise<FeatureCache | null> {
    try {
      const data = await fs.readFile(this.getCacheFilePath(), "utf8");
      const cache: FeatureCache = JSON.parse(data);

      // Verify cache is for the correct org
      if (cache.orgId !== orgId) {
        logService.debug(
          "[FeatureGate] Persisted cache is for different org, ignoring",
          "FeatureGateService"
        );
        return null;
      }

      // Discard cache older than 7 days (fail-open safety net)
      const cacheAge = Date.now() - cache.fetchedAt;
      if (cacheAge > PERSISTED_CACHE_MAX_AGE_MS) {
        logService.info(
          "[FeatureGate] Persisted cache too old, discarding (fail-open)",
          "FeatureGateService",
          {
            orgId,
            ageDays: Math.round(cacheAge / (24 * 60 * 60 * 1000)),
          }
        );
        // Clean up stale cache file
        try {
          await fs.unlink(this.getCacheFilePath());
        } catch {
          // Ignore cleanup errors
        }
        return null;
      }

      logService.info(
        "[FeatureGate] Using persisted cache (offline fallback)",
        "FeatureGateService",
        {
          orgId,
          ageMinutes: Math.round(
            (Date.now() - cache.fetchedAt) / (60 * 1000)
          ),
        }
      );

      return cache;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        logService.debug(
          "[FeatureGate] No persisted cache file found",
          "FeatureGateService"
        );
      } else {
        logService.warn(
          "[FeatureGate] Failed to read persisted cache",
          "FeatureGateService",
          { error: error instanceof Error ? error.message : "Unknown error" }
        );
      }
      return null;
    }
  }

  // ============================================
  // Private: Defaults
  // ============================================

  private defaultAccess(): FeatureAccess {
    return {
      allowed: true,
      value: "",
      source: "default",
    };
  }
}

// Export singleton instance
const featureGateService = new FeatureGateService();
export default featureGateService;
