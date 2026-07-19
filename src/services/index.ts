/**
 * Service Layer - Barrel Export
 *
 * This module provides a centralized service abstraction layer for all
 * renderer-side IPC calls. Instead of scattered window.api.* calls,
 * components should import services from this module.
 *
 * Benefits:
 * - Consistent error handling
 * - Type-safe API access
 * - Easier testing (mockable services)
 * - Single source of truth for API contracts
 */

// ============================================
// SHARED TYPES
// ============================================

/**
 * Standard result type for all API operations.
 * Provides consistent error handling across all services.
 */
export interface ApiResult<T = void> {
  success: boolean;
  error?: string;
  data?: T;
}

/**
 * Helper to create a success result
 */
export function successResult<T>(data?: T): ApiResult<T> {
  return { success: true, data };
}

/**
 * Helper to create an error result
 */
export function errorResult(error: string): ApiResult<never> {
  return { success: false, error };
}

/**
 * Helper to extract error message from unknown error
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unknown error";
}

// ============================================
// SERVICE EXPORTS
// ============================================

// Transaction service (existing)
export { transactionService } from "./transactionService";
export type {
  DetectionStatus,
  TransactionStatus,
  TransactionUpdatePayload,
  FeedbackAction,
  TransactionFeedbackPayload,
} from "./transactionService";

// Contact service
export { contactService } from "./contactService";

// Auth service
export { authService } from "./authService";

// Communication/Feedback service
export { feedbackService } from "./feedbackService";

// Settings service (preferences + user)
export { settingsService } from "./settingsService";

// LLM service
export { llmService } from "./llmService";

// System service
export { systemService } from "./systemService";

// Device service (device + backup + drivers + sync)
export { deviceService } from "./deviceService";

// Address service
export { addressService } from "./addressService";

// License service
export { licenseService } from "./licenseService";
export type {
  LicenseInfo,
  LicenseValidationResult,
  LicenseStatusInfo,
  LicenseAction,
  ValidationLicenseType,
} from "./licenseService";

// Outlook service
export { outlookService } from "./outlookService";

// Message service (iMessage/macOS Messages)
export { messageService } from "./messageService";
export type { MessageImportStatus, MacOSImportServiceResult } from "./messageService";

// App cleanup service (reset / uninstall — BACKLOG-2112)
export { appCleanupService } from "./appCleanupService";
export type { CleanupResult } from "./appCleanupService";
