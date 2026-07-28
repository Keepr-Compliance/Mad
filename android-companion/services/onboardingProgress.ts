/**
 * Onboarding Progress Service (Android Companion)
 *
 * BACKLOG-2216: the companion onboarding is a linear 3-screen Expo-Router stack
 * (permissions -> pair-device -> first-sync). Before this module the ONLY
 * persisted onboarding state was a single "complete" flag, and the auth gate in
 * `app/_layout.tsx` always redirected an un-onboarded user to step 1. So an
 * interruption mid-flow (app killed/backgrounded) dropped the user back to the
 * start and re-ran already-completed steps.
 *
 * This module is the single source of truth for onboarding *progress*: it owns
 * both the "furthest step reached" marker and the "complete" flag (the latter
 * was previously a string literal duplicated across `_layout.tsx` and
 * `first-sync.tsx`). Screens call `setOnboardingStep` on mount; the auth gate
 * reads the persisted step and resumes there; completion clears the marker.
 *
 * Scope note: this is companion-local. The DESKTOP onboarding rework
 * (BACKLOG-2288/2289, `src/components/onboarding/*`) is a separate codebase with
 * no shared progress primitive — nothing to reuse here.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

/** Persisted flag set when the user finishes onboarding. */
export const ONBOARDING_COMPLETE_KEY = '@keepr/onboarding-complete';

/** Persisted marker for the furthest onboarding step the user has reached. */
export const ONBOARDING_STEP_KEY = '@keepr/onboarding-step';

/**
 * The onboarding steps, in order. This is the resume-able unit: an interrupted
 * onboarding resumes at the last-persisted step rather than restarting at step 1.
 */
export type OnboardingStep = 'permissions' | 'pair-device' | 'first-sync';

/** Ordered onboarding steps (source of truth for the sequence). */
export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  'permissions',
  'pair-device',
  'first-sync',
] as const;

/**
 * Route for each onboarding step. Kept as `as const` literals so the values
 * satisfy expo-router's `Href` type at every call site.
 */
export const ONBOARDING_ROUTES = {
  permissions: '/onboarding/permissions',
  'pair-device': '/onboarding/pair-device',
  'first-sync': '/onboarding/first-sync',
} as const;

/** The step to resume at when no valid progress is stored (fresh first run). */
export const DEFAULT_ONBOARDING_STEP: OnboardingStep = 'permissions';

function isOnboardingStep(value: string | null): value is OnboardingStep {
  return (
    value === 'permissions' ||
    value === 'pair-device' ||
    value === 'first-sync'
  );
}

/**
 * Persist the furthest onboarding step the user has reached.
 * Called by each onboarding screen on mount. Failures are non-fatal — a lost
 * write just means we resume one step earlier than ideal, never a crash.
 */
export async function setOnboardingStep(step: OnboardingStep): Promise<void> {
  try {
    await AsyncStorage.setItem(ONBOARDING_STEP_KEY, step);
  } catch (error) {
    console.error('[Onboarding] Failed to persist step:', error);
  }
}

/**
 * Read the persisted onboarding step, or `null` when nothing valid is stored
 * (fresh install, or a corrupt/legacy value). Callers treat `null` as step 1.
 */
export async function getOnboardingStep(): Promise<OnboardingStep | null> {
  try {
    const stored = await AsyncStorage.getItem(ONBOARDING_STEP_KEY);
    return isOnboardingStep(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** The step to resume onboarding at: the persisted step, or step 1 if none. */
export async function getResumeStep(): Promise<OnboardingStep> {
  return (await getOnboardingStep()) ?? DEFAULT_ONBOARDING_STEP;
}

/** Whether onboarding has been completed. */
export async function isOnboardingComplete(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(ONBOARDING_COMPLETE_KEY)) === 'true';
  } catch {
    return false;
  }
}

/**
 * Mark onboarding complete and clear the resume marker. Setting the complete
 * flag first means that even if clearing the step fails, the (now-ignored) step
 * marker can never resurrect a finished onboarding — the complete flag wins in
 * the auth gate.
 */
export async function completeOnboarding(): Promise<void> {
  await AsyncStorage.setItem(ONBOARDING_COMPLETE_KEY, 'true');
  await AsyncStorage.removeItem(ONBOARDING_STEP_KEY);
}
