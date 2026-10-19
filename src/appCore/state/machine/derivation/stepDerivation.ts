/**
 * Step Derivation Module
 *
 * Pure functions for deriving onboarding step information from state.
 * These functions enable components to determine the current step,
 * calculate next steps, and check step completion without side effects.
 *
 * @module appCore/state/machine/derivation/stepDerivation
 */

import type { AppState, OnboardingStep, PlatformInfo } from "../types";

// =============================================================================
// STEP ORDER CONFIGURATION
// =============================================================================

/**
 * Canonical step order for all platforms.
 * Individual steps may be skipped based on platform/phone type.
 *
 * Platform-specific logic:
 * - secure-storage: macOS only (Keychain setup)
 * - permissions: macOS only (Full Disk Access)
 * - apple-driver: Windows + iPhone only
 */
export const STEP_ORDER: readonly OnboardingStep[] = [
  "phone-type",
  "secure-storage",
  "account-verification",
  "contact-source",
  "email-connect",
  "data-sync",
  "permissions",
  "apple-driver",
] as const;

// =============================================================================
// STEP DERIVATION FUNCTIONS
// =============================================================================

/**
 * Derives the current onboarding step from state.
 * Returns null if not in onboarding status.
 *
 * @param state - Current application state
 * @returns Current onboarding step, or null if not onboarding
 *
 * @example
 * ```ts
 * const step = deriveCurrentStep(state);
 * if (step === 'phone-type') {
 *   // Show phone type selection
 * }
 * ```
 */
export function deriveCurrentStep(state: AppState): OnboardingStep | null {
  if (state.status !== "onboarding") {
    return null;
  }
  return state.step;
}

/**
 * Determines if a step should be skipped for the given platform/phone configuration.
 *
 * Skip rules:
 * - secure-storage: Skip if not macOS
 * - permissions: Skip if not macOS
 * - apple-driver: Skip if not Windows+iPhone
 *
 * @param step - Step to check
 * @param platform - Platform information
 * @param phoneType - Selected phone type, if known
 * @returns true if step should be skipped
 */
export function shouldSkipStep(
  step: OnboardingStep,
  platform: PlatformInfo,
  phoneType: "iphone" | "android" | null
): boolean {
  switch (step) {
    case "secure-storage":
      // macOS only step
      return !platform.isMacOS;

    case "permissions":
      // macOS only step
      return !platform.isMacOS;

    case "apple-driver":
      // Windows + iPhone only step
      return !(platform.isWindows && phoneType === "iphone");

    // These steps are always shown
    case "phone-type":
    case "account-verification":
    case "contact-source":
    case "email-connect":
    case "data-sync":
      return false;

    default:
      // Exhaustive check - TypeScript will error if a case is missing
      return false;
  }
}

/**
 * Derives the next step after the given step.
 * Skips platform-inappropriate steps automatically.
 *
 * @param currentStep - Current onboarding step
 * @param platform - Platform information (macOS/Windows)
 * @param phoneType - User's selected phone type, or null if not yet selected
 * @returns Next step in sequence, or null if onboarding is complete
 *
 * @example
 * ```ts
 * const next = deriveNextStep('phone-type', platform, 'iphone');
 * // On macOS: 'secure-storage'
 * // On Windows: 'email-connect'
 * ```
 */
export function deriveNextStep(
  currentStep: OnboardingStep,
  platform: PlatformInfo,
  phoneType: "iphone" | "android" | null
): OnboardingStep | null {
  const currentIndex = STEP_ORDER.indexOf(currentStep);
  if (currentIndex === -1) {
    return null;
  }

  // Find the next non-skipped step
  for (let i = currentIndex + 1; i < STEP_ORDER.length; i++) {
    const nextStep = STEP_ORDER[i];
    if (!shouldSkipStep(nextStep, platform, phoneType)) {
      return nextStep;
    }
  }

  // No more steps - onboarding complete
  return null;
}

/**
 * Derives the first step for the given platform.
 * Always starts with phone-type selection.
 *
 * @param platform - Platform information
 * @returns First onboarding step
 */
export function deriveFirstStep(platform: PlatformInfo): OnboardingStep {
  // Phone type is always first and never skipped
  return "phone-type";
}

/**
 * Determines if the given step is complete based on current state.
 *
 * A step is considered complete if:
 * - App status is 'ready' (all steps complete)
 * - Step appears in completedSteps array
 * - Current step is after the given step in the order
 *
 * @param step - Step to check
 * @param state - Current application state
 * @returns true if step has been completed
 */
export function isStepComplete(step: OnboardingStep, state: AppState): boolean {
  // If app is ready, all steps are complete
  if (state.status === "ready") {
    return true;
  }

  // Not in onboarding = no steps complete (still loading or error)
  if (state.status !== "onboarding") {
    return false;
  }

  // Check if step is in completed steps array
  if (state.completedSteps.includes(step)) {
    return true;
  }

  // Check if we're past this step in the order
  const stepIndex = STEP_ORDER.indexOf(step);
  const currentIndex = STEP_ORDER.indexOf(state.step);

  return stepIndex < currentIndex;
}

/**
 * Gets the total number of non-skipped steps for progress calculation.
 *
 * @param platform - Platform information
 * @param phoneType - Selected phone type
 * @returns Total number of steps in the flow
 */
export function getTotalSteps(
  platform: PlatformInfo,
  phoneType: "iphone" | "android" | null
): number {
  return STEP_ORDER.filter(
    (step) => !shouldSkipStep(step, platform, phoneType)
  ).length;
}

/**
 * Gets the current step number (1-indexed) for progress display.
 *
 * @param currentStep - Current onboarding step
 * @param platform - Platform information
 * @param phoneType - Selected phone type
 * @returns Current step number (1-indexed), or 0 if not found
 */
export function getCurrentStepNumber(
  currentStep: OnboardingStep,
  platform: PlatformInfo,
  phoneType: "iphone" | "android" | null
): number {
  const visibleSteps = STEP_ORDER.filter(
    (step) => !shouldSkipStep(step, platform, phoneType)
  );
  const index = visibleSteps.indexOf(currentStep);
  return index === -1 ? 0 : index + 1;
}

/**
 * Determines if the current step is the last step in the flow.
 *
 * @param currentStep - Current onboarding step
 * @param platform - Platform information
 * @param phoneType - Selected phone type
 * @returns true if this is the last step
 */
export function isLastStep(
  currentStep: OnboardingStep,
  platform: PlatformInfo,
  phoneType: "iphone" | "android" | null
): boolean {
  return deriveNextStep(currentStep, platform, phoneType) === null;
}
