/**
 * Onboarding Step Type Definitions
 *
 * Core step identifiers and platform types for the onboarding system.
 *
 * @module onboarding/types/steps
 */

// =============================================================================
// CORE TYPES
// =============================================================================

/**
 * Supported platform identifiers for the application.
 * Used to determine which onboarding steps are relevant for the current platform.
 */
export type Platform = "macos" | "windows" | "linux" | "android" | "ios";

/**
 * Unique identifiers for each onboarding step.
 * These IDs are used for step navigation, persistence, and configuration lookup.
 */
export type OnboardingStepId =
  | "welcome"
  | "terms"
  | "phone-type"
  | "android-download"
  | "android-coming-soon"
  | "secure-storage"
  | "account-verification"
  | "driver-setup"
  | "apple-driver"
  | "email-connect"
  | "contact-source"
  | "data-sync"
  | "permissions"
  | "data-source-floor"
  | "complete";

/**
 * Extract step IDs that match certain criteria.
 * Useful for type-safe step filtering.
 */
export type SkippableStepId = Extract<
  OnboardingStepId,
  "email-connect" | "driver-setup" | "contact-source"
>;
