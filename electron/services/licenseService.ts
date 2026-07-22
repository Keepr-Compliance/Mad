/**
 * License Validation Service
 * SPRINT-062: Auth Flow + Licensing System
 *
 * Validates user licenses against Supabase and manages offline caching.
 */

import { promises as fs } from "fs";
import path from "path";
import { app } from "electron";
import * as Sentry from "@sentry/electron/main";
import supabaseService from "./supabaseService";
import logService from "./logService";
import type {
  License,
  LicenseType,
  TrialStatus,
  LicenseValidationResult,
} from "../types/license";

// Import the constant from electron types
import { OFFLINE_GRACE_PERIOD_HOURS as GRACE_PERIOD_HOURS } from "../types/license";

// Convert grace period to milliseconds
const OFFLINE_GRACE_PERIOD_MS = GRACE_PERIOD_HOURS * 60 * 60 * 1000;

// Cache file name (stored in app userData directory)
const LICENSE_CACHE_FILENAME = "license-cache.json";

/**
 * License cache structure for offline support
 */
interface LicenseCache {
  status: LicenseValidationResult;
  userId: string;
  cachedAt: number; // Unix timestamp in milliseconds
}

/**
 * Get the path to the license cache file
 */
function getCacheFilePath(): string {
  return path.join(app.getPath("userData"), LICENSE_CACHE_FILENAME);
}

/**
 * Validate a user's license status
 * Tries Supabase first, falls back to cache if offline
 */
export async function validateLicense(
  userId: string
): Promise<LicenseValidationResult> {
  try {
    // Try to fetch from Supabase
    const status = await fetchLicenseFromSupabase(userId);

    // Cache the result for offline use
    await cacheLicenseStatus(userId, status);

    return status;
  } catch (error) {
    logService.warn(
      "[License] Failed to validate license from Supabase, checking cache",
      "LicenseService",
      { error: error instanceof Error ? error.message : "Unknown error" }
    );
    Sentry.captureException(error, {
      tags: { service: "license-service", operation: "validateLicense" },
    });

    // Check for cached license (offline mode)
    const cached = await getCachedLicense(userId);
    if (cached) {
      logService.info(
        "[License] Using cached license status (offline mode)",
        "LicenseService"
      );
      return cached;
    }

    // BACKLOG-2148: No cache AND Supabase threw — this is a TRANSIENT load failure
    // (network / DB-init race), NOT a proof that the account is invalid. Previously
    // this returned isValid:false/'no_license', which the deep-link gate rendered as
    // "Trial Expired / Upgrade" for perfectly valid users (ELECTRON-1Z).
    //
    // We reach here only from the catch block (Supabase rejected). An EXPLICIT terminal
    // state (suspended/cancelled/expired) can never reach here — those are computed in
    // calculateLicenseStatus on the success path. So fail OPEN for the authenticated
    // user: allow access with a soft, non-blocking 'load_error' reason and let the app
    // retry validation online. We use licenseType:'individual' (neutral, non-trial) so
    // no false "trial" banner shows, and 'load_error' (NOT 'no_license') so the caller
    // does NOT force trial-license creation — it just retries.
    logService.warn(
      "[License] No cached license available; failing open (transient load error)",
      "LicenseService"
    );

    return {
      isValid: true,
      licenseType: "individual",
      transactionCount: 0,
      transactionLimit: 0,
      canCreateTransaction: true,
      deviceCount: 0,
      deviceLimit: 1,
      aiEnabled: false,
      blockReason: "load_error",
    };
  }
}

/**
 * Fetch license status from Supabase
 */
async function fetchLicenseFromSupabase(
  userId: string
): Promise<LicenseValidationResult> {
  // Fetch user license
  const { data: license, error } = await supabaseService
    .getClient()
    .from("licenses")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (error && error.code !== "PGRST116") {
    // PGRST116 = "No rows returned" which is OK (new user)
    throw error;
  }

  // No license found - user needs one provisioned.
  //
  // BACKLOG-2180: return NEUTRAL individual defaults (not "trial"). This status
  // is transient — the caller keys provisioning on blockReason === 'no_license'
  // and immediately calls createUserLicense() to insert an active individual row.
  // Returning licenseType:'individual' here (instead of 'trial') means that even
  // in the brief window before the row exists, no "14 days left in your free
  // trial" banner or trial-expiry gate can engage for the account.
  if (!license) {
    logService.debug(
      "[License] No license found for user, returning neutral individual defaults",
      "LicenseService"
    );

    return {
      isValid: true, // Valid because we expect a license to be provisioned
      licenseType: "individual",
      transactionCount: 0,
      transactionLimit: 0,
      canCreateTransaction: true,
      deviceCount: 0,
      deviceLimit: 1,
      aiEnabled: false,
      blockReason: "no_license",
    };
  }

  // Count active devices for this user
  const { count: deviceCount } = await supabaseService
    .getClient()
    .from("devices")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("is_active", true);

  // Calculate license status
  return calculateLicenseStatus(license as License, deviceCount || 0);
}

/**
 * Calculate license status from database record.
 *
 * Exported for unit testing (BACKLOG-2077): the chargeback-suspension path relies
 * on licenses.status === 'suspended' mapping to blockReason === 'suspended', which
 * the renderer (AppRouter / LicenseGate) renders as the humane "License Suspended"
 * screen. This is pure and side-effect-free.
 */
export function calculateLicenseStatus(
  license: License,
  deviceCount: number
): LicenseValidationResult {
  const licenseType = license.license_type as LicenseType;
  const trialStatus = license.trial_status as TrialStatus | null;

  // Check trial expiry.
  //
  // BACKLOG-2180: trial-expiry gating is scoped STRICTLY to genuine trial
  // licenses that actually carry a trial_expires_at. An individual (or team)
  // license — the pay-per-deal / active state — can NEVER enter this branch,
  // so it can never flip to "Trial Expired" at day 14 regardless of any stale
  // trial_expires_at value that may linger on the row (defense-in-depth against
  // the day-14 lockout, same failure family as BACKLOG-2148).
  let isExpired = false;
  let trialDaysRemaining: number | undefined;

  const isTrialLicense = licenseType === "trial";

  if (isTrialLicense && license.trial_expires_at) {
    const expiresAt = new Date(license.trial_expires_at);
    const now = new Date();
    isExpired = expiresAt < now;

    if (!isExpired) {
      const msRemaining = expiresAt.getTime() - now.getTime();
      trialDaysRemaining = Math.ceil(msRemaining / (24 * 60 * 60 * 1000));
    }
  }

  // Check transaction limit
  // SPRINT-127 / TASK-2160: Deprecated — the renderer now reads transaction_limit
  // exclusively from plan features via useFeatureGate. This license column value
  // is still returned for audit/display purposes but is not used by the client.
  const atTransactionLimit =
    license.transaction_count >= license.transaction_limit;

  // Read device limit from license record (with fallback for legacy data)
  const deviceLimit = license.max_devices ??
    (licenseType === "trial" ? 1 : licenseType === "individual" ? 2 : 10);

  // Determine validity and block reason
  let isValid = true;
  let blockReason: LicenseValidationResult["blockReason"];

  if (isTrialLicense && isExpired) {
    isValid = false;
    blockReason = "expired";
  } else if (license.status === "suspended") {
    isValid = false;
    blockReason = "suspended";
  } else if (license.status === "cancelled" || license.status === "expired") {
    isValid = false;
    blockReason = "expired";
  }

  return {
    isValid,
    licenseType,
    trialStatus: trialStatus || undefined,
    trialDaysRemaining,
    transactionCount: license.transaction_count,
    transactionLimit: license.transaction_limit,
    canCreateTransaction: !atTransactionLimit,
    deviceCount,
    deviceLimit,
    // SPRINT-127 / TASK-2160: Deprecated — the renderer now reads ai_detection
    // exclusively from plan features via useFeatureGate. This license column value
    // is still returned for audit/display purposes but is not used by the client.
    aiEnabled: license.ai_detection_enabled,
    blockReason,
  };
}

/**
 * Provision a license for a new user on first sign-in.
 *
 * BACKLOG-2180 (2026-07-21): New individuals are now created ACTIVE under the
 * pay-per-deal credit model — NOT as a 14-day trial. We call the
 * `create_active_individual_license` RPC (see migration
 * 20260721_backlog_2180_active_individual_provisioning.sql), which inserts a
 * license_type='individual', status='active' row with NO trial_expires_at /
 * trial_status, so the account can never flip to "Trial Expired" at day 14
 * (the day-14 lockout risk, same failure family as BACKLOG-2148).
 *
 * MIGRATION GATING: the `create_active_individual_license` RPC must exist in
 * the target database before this ships. The accompanying migration is written
 * but intentionally NOT applied to prod (flagged for founder/DB review). Until
 * it is applied, this call will error and provisioning falls through to the
 * catch block below (Sentry-reported); it does NOT silently create a trial.
 */
export async function createUserLicense(
  userId: string
): Promise<LicenseValidationResult> {
  try {
    logService.info(
      "[License] Provisioning active individual license for user",
      "LicenseService",
      { userId }
    );

    const { error } = await supabaseService
      .getClient()
      .rpc("create_active_individual_license", { p_user_id: userId });

    if (error) {
      throw new Error(`Failed to create license: ${error.message}`);
    }

    logService.info(
      "[License] Active individual license provisioned successfully",
      "LicenseService",
      { userId }
    );

    // Re-validate to get full status
    return validateLicense(userId);
  } catch (error) {
    logService.error("[License] Failed to create license", "LicenseService", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    Sentry.captureException(error, {
      tags: { service: "license-service", operation: "createUserLicense" },
    });
    throw error;
  }
}

/**
 * Increment transaction count (call when user creates a transaction)
 * Returns the new transaction count
 */
export async function incrementTransactionCount(
  userId: string
): Promise<number> {
  try {
    const { data, error } = await supabaseService
      .getClient()
      .rpc("increment_transaction_count", { p_user_id: userId });

    if (error) {
      throw new Error(`Failed to increment transaction count: ${error.message}`);
    }

    const newCount = data as number;
    logService.debug(
      "[License] Transaction count incremented",
      "LicenseService",
      { userId, newCount }
    );

    return newCount;
  } catch (error) {
    logService.error(
      "[License] Failed to increment transaction count",
      "LicenseService",
      { error: error instanceof Error ? error.message : "Unknown error" }
    );
    Sentry.captureException(error, {
      tags: { service: "license-service", operation: "incrementTransactionCount" },
    });
    throw error;
  }
}

/**
 * Cache license status for offline use
 * Saves to local file system
 */
async function cacheLicenseStatus(
  userId: string,
  status: LicenseValidationResult
): Promise<void> {
  try {
    const cache: LicenseCache = {
      status,
      userId,
      cachedAt: Date.now(),
    };

    await fs.writeFile(
      getCacheFilePath(),
      JSON.stringify(cache, null, 2),
      "utf8"
    );

    logService.debug("[License] License status cached", "LicenseService");
  } catch (error) {
    logService.warn("[License] Failed to cache license status", "LicenseService", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    Sentry.captureException(error, {
      tags: { service: "license-service", operation: "cacheLicenseStatus" },
    });
  }
}

/**
 * Get cached license status (for offline mode)
 * Returns null if cache is expired or invalid
 */
async function getCachedLicense(
  userId: string
): Promise<LicenseValidationResult | null> {
  try {
    const data = await fs.readFile(getCacheFilePath(), "utf8");
    const cache: LicenseCache = JSON.parse(data);

    // Verify cache is for the correct user
    if (cache.userId !== userId) {
      logService.debug(
        "[License] Cache is for different user, ignoring",
        "LicenseService"
      );
      return null;
    }

    // Check if cache is within grace period
    const age = Date.now() - cache.cachedAt;
    if (age > OFFLINE_GRACE_PERIOD_MS) {
      logService.info(
        "[License] Cache expired (beyond grace period)",
        "LicenseService",
        { ageHours: Math.round(age / (60 * 60 * 1000)) }
      );

      // BACKLOG-2148: An aged cache is a TRANSIENT signal ("we couldn't reach the
      // server recently"), NOT a terminal one. It must NOT flip a previously-VALID
      // license to expired and gate a paying user (the ELECTRON-1Z regression).
      //
      // Carve-out (fail CLOSED on terminal state): if the cached status was itself
      // already blocking (isValid === false — e.g. a suspended/cancelled account per
      // BACKLOG-2077), we keep honoring it. Checking the boolean (not a reason list)
      // means a cached-suspended OR cached-expired-trial stays blocked, but a cached
      // healthy license is never falsely gated.
      if (cache.status.isValid === false) {
        // Cached status was terminal — preserve the block verbatim.
        return cache.status;
      }

      // Cached status was valid — fail OPEN. Preserve every field (licenseType,
      // transactionCount, canCreateTransaction, etc.) and only attach the soft,
      // non-blocking 'load_error' tag so callers can retry online. We do NOT force
      // canCreateTransaction:true here — a user at quota keeps their real quota.
      return {
        ...cache.status,
        isValid: true,
        blockReason: "load_error",
      };
    }

    // Return cached status
    return cache.status;
  } catch (error: unknown) {
    // File doesn't exist or is invalid
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      logService.debug("[License] No cache file found", "LicenseService");
    } else {
      logService.warn("[License] Failed to read license cache", "LicenseService", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
    return null;
  }
}

/**
 * Clear license cache (call on logout)
 */
export async function clearLicenseCache(): Promise<void> {
  try {
    await fs.unlink(getCacheFilePath());
    logService.debug("[License] License cache cleared", "LicenseService");
  } catch (error: unknown) {
    // Ignore if file doesn't exist
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logService.warn(
        "[License] Failed to clear license cache",
        "LicenseService",
        { error: error instanceof Error ? error.message : "Unknown error" }
      );
    }
  }
}

/**
 * Check if user can perform an action based on license
 * Utility function for quick permission checks
 */
export function canPerformAction(
  status: LicenseValidationResult,
  action: "create_transaction" | "use_ai" | "export"
): boolean {
  if (!status.isValid) {
    return false;
  }

  switch (action) {
    case "create_transaction":
      return status.canCreateTransaction;
    case "use_ai":
      return status.aiEnabled;
    case "export":
      // Export is blocked for trial users
      return status.licenseType !== "trial";
    default:
      return true;
  }
}
