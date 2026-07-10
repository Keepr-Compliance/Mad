/**
 * Sentry instrumentation utilities for onboarding failure paths.
 *
 * Provides classified failure reporting to Sentry when users encounter
 * errors during the onboarding flow. No PII is included in any events.
 *
 * @module onboarding/sentryOnboarding
 */

import * as Sentry from '@sentry/electron/renderer';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Classified reasons for onboarding failures.
 * Extended with specific categories for diagnostic precision (BACKLOG-1347).
 */
export type OnboardingFailureReason =
  | 'db_failed'
  | 'network_error'
  | 'auth_failed'
  | 'session_invalid'
  | 'driver_install_failed'
  | 'driver_cancelled'
  | 'audit_constraint_failure'
  | 'schema_validation_failure'
  | 'db_locked'
  | 'profile_not_found'
  | 'network_timeout'
  | 'encryption_unavailable'
  | 'unknown';

/**
 * Context available at the point of failure for classification.
 */
export interface FailureClassificationContext {
  dbInitialized: boolean;
  networkOnline: boolean;
  error?: unknown;
}

/**
 * Parameters for reporting an onboarding failure to Sentry.
 */
export interface OnboardingFailureReport {
  step: string;
  reason: OnboardingFailureReason;
  dbInitialized: boolean;
  networkOnline: boolean;
  hasSession: boolean;
  errorMessage?: string;
}

// =============================================================================
// CLASSIFICATION
// =============================================================================

/**
 * Classifies the root cause of an onboarding failure based on available context.
 *
 * Priority order:
 * 1. Database not initialized -> db_failed
 * 2. Network offline -> network_error
 * 3. Error message contains auth-related keywords -> auth_failed
 * 4. Error message contains session-related keywords -> session_invalid
 * 5. Everything else -> unknown
 */
export function classifyFailureReason(
  context: FailureClassificationContext
): OnboardingFailureReason {
  if (!context.dbInitialized) {
    return 'db_failed';
  }

  if (!context.networkOnline) {
    return 'network_error';
  }

  if (context.error) {
    const message =
      context.error instanceof Error
        ? context.error.message.toLowerCase()
        : String(context.error).toLowerCase();

    // Check constraint / audit log failures
    if (
      message.includes('check constraint') ||
      message.includes('audit') && message.includes('constraint')
    ) {
      return 'audit_constraint_failure';
    }

    // Schema / validation failures
    if (
      message.includes('schema validation') ||
      message.includes('validation failed') ||
      message.includes('zod')
    ) {
      return 'schema_validation_failure';
    }

    // Database locked / busy
    if (
      message.includes('busy') ||
      message.includes('locked') ||
      message.includes('sqlite_busy') ||
      message.includes('database is locked')
    ) {
      return 'db_locked';
    }

    // Profile not found in cloud
    if (
      message.includes('not found in cloud') ||
      message.includes('profile') && message.includes('not found') ||
      message.includes('profile may not exist')
    ) {
      return 'profile_not_found';
    }

    // Network timeout
    if (
      message.includes('timeout') ||
      message.includes('etimedout') ||
      message.includes('econnrefused') ||
      message.includes('network') && message.includes('fail')
    ) {
      return 'network_timeout';
    }

    // Encryption / safeStorage
    if (
      message.includes('encryption') ||
      message.includes('safestorage') ||
      message.includes('keychain') ||
      message.includes('not available')
    ) {
      return 'encryption_unavailable';
    }

    // Auth failures
    if (
      message.includes('auth') ||
      message.includes('unauthorized') ||
      message.includes('forbidden') ||
      message.includes('login')
    ) {
      return 'auth_failed';
    }

    // Session failures
    if (
      message.includes('session') ||
      message.includes('token') ||
      message.includes('expired')
    ) {
      return 'session_invalid';
    }
  }

  return 'unknown';
}

// =============================================================================
// SENTRY REPORTING
// =============================================================================

/**
 * Reports an onboarding failure to Sentry with classified reason and context.
 *
 * This function should be called exactly once per failure occurrence
 * (not on every render). Use a ref or state guard to prevent duplicate reports.
 *
 * No PII is included: no emails, names, or token values.
 */
export function reportOnboardingFailure(report: OnboardingFailureReport): void {
  Sentry.captureMessage('Onboarding failure: account setup failed', {
    level: 'error',
    tags: {
      component: 'onboarding',
      step: report.step,
      failure_reason: report.reason,
    },
    extra: {
      db_initialized: report.dbInitialized,
      network_online: report.networkOnline,
      has_session: report.hasSession,
      ...(report.errorMessage ? { error_message: report.errorMessage } : {}),
    },
  });
}

/**
 * BACKLOG-1919: Reports to Sentry when onboarding completes but the Apple
 * Mobile Device Support driver is STILL not installed for an iPhone user.
 *
 * This is the signal that the AppleDriverStep failed to do its job — the user
 * either skipped it or declined the UAC prompt — and will land on the
 * "Connect Your iPhone" screen unable to detect a device. Emitting this lets us
 * measure the onboarding-driver-failure rate (how often the recovery path in
 * ConnectionStatus is actually needed).
 *
 * Windows-only concern; callers should gate on platform + phoneType === 'iphone'
 * before calling. No PII is included.
 *
 * @param context - Lightweight context for triaging the event.
 */
export function reportDriverStillMissingAtCompletion(context: {
  /** Whether the user explicitly skipped the driver step. */
  driverSkipped: boolean;
}): void {
  Sentry.captureMessage('Onboarding completed with Apple driver still missing', {
    level: 'warning',
    tags: {
      component: 'onboarding',
      step: 'apple_driver',
      failure_reason: 'driver_missing_at_completion',
    },
    extra: {
      driver_skipped: context.driverSkipped,
    },
  });
}
