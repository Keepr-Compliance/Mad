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

    // No cache available - return invalid license
    logService.warn(
      "[License] No cached license available, returning invalid",
      "LicenseService"
    );

    return {
      isValid: false,
      licenseType: "trial",
      transactionCount: 0,
      transactionLimit: 5,
      canCreateTransaction: false,
      deviceCount: 0,
      deviceLimit: 1,
      aiEnabled: false,
      blockReason: "no_license",
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

  // No license found - user needs one created (will create a trial)
  if (!license) {
    logService.debug(
      "[License] No license found for user, returning trial defaults",
      "LicenseService"
    );

    return {
      isValid: true, // Valid because we expect a trial to be created
      licenseType: "trial",
      transactionCount: 0,
      transactionLimit: 5,
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

  // Check trial expiry
  let isExpired = false;
  let trialDaysRemaining: number | undefined;

  if (licenseType === "trial" && license.trial_expires_at) {
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

  if (licenseType === "trial" && isExpired) {
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
 * Create a trial license for a new user
 * Uses the Supabase RPC function to atomically create the license
 */
export async function createUserLicense(
  userId: string
): Promise<LicenseValidationResult> {
  try {
    logService.info(
      "[License] Creating trial license for user",
      "LicenseService",
      { userId }
    );

    const { error } = await supabaseService
      .getClient()
      .rpc("create_trial_license", { p_user_id: userId });

    if (error) {
      throw new Error(`Failed to create license: ${error.message}`);
    }

    logService.info(
      "[License] Trial license created successfully",
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

      // Cache expired - return invalid status
      return {
        ...cache.status,
        isValid: false,
        blockReason: "expired",
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
