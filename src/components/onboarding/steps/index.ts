/**
 * Step Registry Infrastructure
 *
 * Central registry for all onboarding steps. Provides registration,
 * lookup, and validation utilities. This is the single source of truth
 * for step definitions in the onboarding system.
 *
 * @module onboarding/steps
 */

import type { OnboardingStep } from "../types";

// Import all steps as default exports
import PhoneTypeStep from "./PhoneTypeStep";
import SecureStorageStep from "./SecureStorageStep";
import AccountVerificationStep from "./AccountVerificationStep";
import EmailConnectStep from "./EmailConnectStep";
import DataSyncStep from "./DataSyncStep";
import PermissionsStep from "./PermissionsStep";
import AppleDriverStep from "./AppleDriverStep";
import AndroidDownloadStep from "./AndroidDownloadStep";
import AndroidComingSoonStep from "./AndroidComingSoonStep";
import ContactSourceStep from "./ContactSourceStep";
import DataSourceFloorStep from "./DataSourceFloorStep";

/**
 * Central registry of all onboarding steps.
 * Key = step ID (must match meta.id in the step file)
 *
 * All steps are registered here at module load time to avoid
 * circular dependency issues.
 */
export const STEP_REGISTRY: Record<string, OnboardingStep> = {
  "phone-type": PhoneTypeStep,
  "secure-storage": SecureStorageStep,
  "account-verification": AccountVerificationStep,
  "email-connect": EmailConnectStep,
  "data-sync": DataSyncStep,
  "permissions": PermissionsStep,
  "apple-driver": AppleDriverStep,
  "android-download": AndroidDownloadStep,
  "android-coming-soon": AndroidComingSoonStep,
  "contact-source": ContactSourceStep,
  "data-source-floor": DataSourceFloorStep,
};

/**
 * Register a step in the registry.
 * Validates that the key matches meta.id (development mode only).
 *
 * @param key - The registry key (should match step.meta.id)
 * @param step - The onboarding step definition
 * @throws Error in development if key !== meta.id
 * @throws Error in development if step is already registered
 *
 * @example
 * ```ts
 * registerStep('welcome', welcomeStep);
 * ```
 */
export function registerStep(key: string, step: OnboardingStep): void {
  if (process.env.NODE_ENV === "development") {
    if (step.meta.id !== key) {
      throw new Error(
        `Registry key "${key}" doesn't match meta.id "${step.meta.id}"`
      );
    }
    if (STEP_REGISTRY[key]) {
      throw new Error(`Step "${key}" is already registered`);
    }
  }
  STEP_REGISTRY[key] = step;
}

/**
 * Get a step by ID.
 *
 * @param id - The step ID to look up
 * @returns The onboarding step definition
 * @throws Error if step not found (includes list of available steps)
 *
 * @example
 * ```ts
 * const welcomeStep = getStep('welcome');
 * ```
 */
export function getStep(id: string): OnboardingStep {
  const step = STEP_REGISTRY[id];
  if (!step) {
    throw new Error(
      `Step "${id}" not found in registry. Available steps: [${Object.keys(STEP_REGISTRY).join(", ")}]`
    );
  }
  return step;
}

/**
 * Get all registered steps.
 *
 * @returns Array of all registered onboarding steps
 *
 * @example
 * ```ts
 * const allSteps = getAllSteps();
 * console.log(`${allSteps.length} steps registered`);
 * ```
 */
export function getAllSteps(): OnboardingStep[] {
  return Object.values(STEP_REGISTRY);
}
