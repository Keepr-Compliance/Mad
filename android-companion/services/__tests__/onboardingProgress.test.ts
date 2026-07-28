/**
 * Behavioral guard for BACKLOG-2216 — onboarding progress persistence.
 *
 * The bug it accompanies: the companion onboarding is a linear 3-screen stack
 * (permissions -> pair-device -> first-sync), but the ONLY persisted state was a
 * single "complete" flag. The auth gate always redirected an un-onboarded user
 * to step 1, so an interruption mid-flow (app killed/backgrounded) restarted
 * onboarding from the beginning and re-ran completed steps.
 *
 * This module is the fix's single source of truth for onboarding PROGRESS: it
 * records the furthest step reached (so the gate can resume there), exposes the
 * step->route map the gate consumes, and — on completion — clears the marker so
 * a finished onboarding is never re-entered.
 *
 * WHAT THIS TEST verifies:
 *   1. fresh run (nothing persisted) -> resume step is 'permissions' (step 1).
 *   2. persisting a step -> it is read back, and getResumeStep resumes THERE
 *      (not step 1) — the core "resume where interrupted" behavior.
 *   3. completeOnboarding -> sets the complete flag AND clears the step marker.
 *   4. a corrupt/legacy stored value is treated as "no progress" (defensive).
 *   5. ONBOARDING_ROUTES maps every step to its screen route.
 */

// --- In-memory AsyncStorage so the persistence semantics are exercised for
// real (set/get/remove) without a native module. ---
jest.mock('@react-native-async-storage/async-storage', () => {
  let store: Record<string, string> = {};
  return {
    __reset: () => {
      store = {};
    },
    setItem: jest.fn(async (k: string, v: string) => {
      store[k] = v;
    }),
    getItem: jest.fn(async (k: string) => (k in store ? store[k] : null)),
    removeItem: jest.fn(async (k: string) => {
      delete store[k];
    }),
  };
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ONBOARDING_COMPLETE_KEY,
  ONBOARDING_STEP_KEY,
  ONBOARDING_ROUTES,
  ONBOARDING_STEPS,
  getOnboardingStep,
  setOnboardingStep,
  getResumeStep,
  isOnboardingComplete,
  completeOnboarding,
} from '../onboardingProgress';

// The mock exposes a private reset helper.
const resetStore = (
  AsyncStorage as unknown as { __reset: () => void }
).__reset;

describe('onboardingProgress — resume persistence (BACKLOG-2216)', () => {
  beforeEach(() => {
    resetStore();
    jest.clearAllMocks();
  });

  it('resumes at step 1 (permissions) on a fresh run with nothing persisted', async () => {
    expect(await getOnboardingStep()).toBeNull();
    expect(await getResumeStep()).toBe('permissions');
    expect(await isOnboardingComplete()).toBe(false);
  });

  it('persists the furthest step reached and resumes THERE, not at step 1', async () => {
    await setOnboardingStep('pair-device');

    expect(await getOnboardingStep()).toBe('pair-device');
    // The resume target is the interrupted step — NOT the start of the flow.
    expect(await getResumeStep()).toBe('pair-device');
    expect(await getResumeStep()).not.toBe('permissions');
  });

  it('advances the resume marker as later steps are reached', async () => {
    await setOnboardingStep('pair-device');
    await setOnboardingStep('first-sync');
    expect(await getResumeStep()).toBe('first-sync');
  });

  it('clears the step marker and sets the complete flag on completion', async () => {
    await setOnboardingStep('first-sync');

    await completeOnboarding();

    // Completing onboarding clears the persisted progress...
    expect(await getOnboardingStep()).toBeNull();
    expect(await getResumeStep()).toBe('permissions');
    // ...and records completion.
    expect(await isOnboardingComplete()).toBe(true);
    // Direct key checks: complete=true, step removed.
    expect(await AsyncStorage.getItem(ONBOARDING_COMPLETE_KEY)).toBe('true');
    expect(await AsyncStorage.getItem(ONBOARDING_STEP_KEY)).toBeNull();
  });

  it('treats a corrupt/legacy stored step value as no progress', async () => {
    await AsyncStorage.setItem(ONBOARDING_STEP_KEY, 'not-a-real-step');
    expect(await getOnboardingStep()).toBeNull();
    expect(await getResumeStep()).toBe('permissions');
  });

  it('maps every onboarding step to its screen route', () => {
    expect(ONBOARDING_ROUTES.permissions).toBe('/onboarding/permissions');
    expect(ONBOARDING_ROUTES['pair-device']).toBe('/onboarding/pair-device');
    expect(ONBOARDING_ROUTES['first-sync']).toBe('/onboarding/first-sync');
    // Every declared step has a route.
    for (const step of ONBOARDING_STEPS) {
      expect(ONBOARDING_ROUTES[step]).toBe(`/onboarding/${step}`);
    }
  });
});
