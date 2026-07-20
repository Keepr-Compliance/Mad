/**
 * License Service
 *
 * Service abstraction for license-related API calls.
 * Centralizes all window.api.license calls and provides type-safe wrappers.
 */

import { type ApiResult, successResult, errorResult, getErrorMessage } from "./index";

// =============================================================================
// Types
// =============================================================================

/**
 * License type for validation (matches IPC interface)
 * Note: This differs from the broader LicenseType in models which includes 'enterprise'
 */
export type ValidationLicenseType = "trial" | "individual" | "team";

/**
 * License info returned from get/refresh operations
 * Uses the broader LicenseType that includes 'enterprise'
 */
export interface LicenseInfo {
  license_type: "individual" | "team" | "enterprise";
  ai_detection_enabled: boolean;
  organization_id?: string;
  organization_name?: string;
}

/**
 * License validation result
 */
export interface LicenseValidationResult {
  isValid: boolean;
  licenseType: ValidationLicenseType;
  trialStatus?: "active" | "expired" | "converted";
  trialDaysRemaining?: number;
  transactionCount: number;
  transactionLimit: number;
  canCreateTransaction: boolean;
  deviceCount: number;
  deviceLimit: number;
  aiEnabled: boolean;
  // BACKLOG-2148: 'load_error' is a soft, non-blocking reason (always isValid:true).
  blockReason?: "expired" | "limit_reached" | "no_license" | "suspended" | "load_error";
}

/**
 * License status info for canPerformAction check.
 * Note: This is a runtime status object, NOT the LicenseAccountStatus union type.
 */
export interface LicenseStatusInfo {
  isValid: boolean;
  licenseType: ValidationLicenseType;
  transactionCount: number;
  transactionLimit: number;
  canCreateTransaction: boolean;
  deviceCount: number;
  deviceLimit: number;
  aiEnabled: boolean;
  // BACKLOG-2148: 'load_error' is a soft, non-blocking reason (always isValid:true).
  blockReason?: "expired" | "limit_reached" | "no_license" | "suspended" | "load_error";
}

/**
 * Actions that can be checked against license status
 */
export type LicenseAction = "create_transaction" | "use_ai" | "export";

// =============================================================================
// License Service
// =============================================================================

/**
 * License Service
 * Provides a clean abstraction over window.api.license
 */
export const licenseService = {
  // ============================================
  // GET / REFRESH
  // ============================================

  /**
   * Get current license info
   */
  async get(): Promise<ApiResult<LicenseInfo>> {
    try {
      if (!window.api?.license?.get) {
        return errorResult("License API not available");
      }
      const result = await window.api.license.get();
      if (result.success && result.license) {
        return successResult<LicenseInfo>({
          license_type: result.license.license_type,
          ai_detection_enabled: result.license.ai_detection_enabled,
          organization_id: result.license.organization_id,
          organization_name: result.license.organization_name,
        });
      }
      return errorResult(result.error || "Failed to get license");
    } catch (error) {
      return errorResult(getErrorMessage(error));
    }
  },

  /**
   * Refresh license data from database
   */
  async refresh(): Promise<ApiResult<LicenseInfo>> {
    try {
      if (!window.api?.license?.refresh) {
        return errorResult("License API not available");
      }
      const result = await window.api.license.refresh();
      if (result.success && result.license) {
        return successResult<LicenseInfo>({
          license_type: result.license.license_type,
          ai_detection_enabled: result.license.ai_detection_enabled,
          organization_id: result.license.organization_id,
          organization_name: result.license.organization_name,
        });
      }
      return errorResult(result.error || "Failed to refresh license");
    } catch (error) {
      return errorResult(getErrorMessage(error));
    }
  },

  // ============================================
  // VALIDATION
  // ============================================

  /**
   * Validate license status for a user
   */
  async validate(userId: string): Promise<ApiResult<LicenseValidationResult>> {
    try {
      if (!window.api?.license?.validate) {
        return errorResult("License API not available");
      }
      const result = await window.api.license.validate(userId);
      return successResult<LicenseValidationResult>(result);
    } catch (error) {
      return errorResult(getErrorMessage(error));
    }
  },

  // ============================================
  // CREATION
  // ============================================

  /**
   * Create a trial license for a new user
   */
  async create(userId: string): Promise<ApiResult<LicenseValidationResult>> {
    try {
      if (!window.api?.license?.create) {
        return errorResult("License API not available");
      }
      const result = await window.api.license.create(userId);
      return successResult<LicenseValidationResult>(result);
    } catch (error) {
      return errorResult(getErrorMessage(error));
    }
  },

  // ============================================
  // TRANSACTION TRACKING
  // ============================================

  /**
   * Increment the user's transaction count
   * Returns the new transaction count
   */
  async incrementTransactionCount(userId: string): Promise<ApiResult<number>> {
    try {
      if (!window.api?.license?.incrementTransactionCount) {
        return errorResult("License API not available");
      }
      const newCount = await window.api.license.incrementTransactionCount(userId);
      return successResult(newCount);
    } catch (error) {
      return errorResult(getErrorMessage(error));
    }
  },

  // ============================================
  // CACHE MANAGEMENT
  // ============================================

  /**
   * Clear the license cache (call on logout)
   */
  async clearCache(): Promise<ApiResult<void>> {
    try {
      if (!window.api?.license?.clearCache) {
        return errorResult("License API not available");
      }
      await window.api.license.clearCache();
      return successResult();
    } catch (error) {
      return errorResult(getErrorMessage(error));
    }
  },

  // NOTE (BACKLOG-1783): `canPerformAction` was removed. It forwarded a local
  // (spoofable) status object to a main-process IPC that echoed the decision
  // back — a bypassable gate with no callers. Derive entitlements from the
  // main-owned `validate()` result instead. The `LicenseStatusInfo` and
  // `LicenseAction` types are retained (re-exported via services/index).
};

export default licenseService;
