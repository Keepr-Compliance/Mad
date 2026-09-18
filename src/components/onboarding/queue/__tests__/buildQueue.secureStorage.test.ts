/**
 * BACKLOG-3253 — the secure-storage queue entry must follow its real predicate.
 *
 * Why this file exists, measured rather than asserted: with
 * `SecureStorageStep.meta.isComplete` replaced by `() => true`, the entire
 * `src/components/onboarding` suite stayed green — 24 suites, 307 tests, zero
 * red. That is the most likely wrong implementation of "auto-mark the step",
 * and nothing could see it.
 *
 * The existing `buildQueue.test.ts` cannot cover this: it does
 * `jest.mock("../../flows", ...)` and feeds `buildOnboardingQueue` synthetic
 * steps, so no real step predicate is ever called. This file deliberately does
 * NOT mock the flows, so it runs the real MACOS_FLOW and the real predicate.
 *
 * It discriminates against three wrong implementations:
 *   - `isComplete: () => true`             -> the "not initialized" case fails
 *   - `isComplete: () => false`            -> the "initialized" case fails
 *   - dropping secure-storage from MACOS_FLOW -> both fail on `undefined`,
 *     which is why `applicable` is asserted alongside `status`.
 *
 * @module onboarding/queue/__tests__/buildQueue.secureStorage.test
 */

import { buildOnboardingQueue } from "../buildQueue";
import type { OnboardingContext } from "../../types";

// NOTE: no jest.mock("../../flows") here. That is the point of this file.

/**
 * Context fixture transcribed from `buildQueue.test.ts:42-60` (its `makeContext`
 * helper) rather than invented, so it stays the shape the real producer emits.
 */
function makeContext(overrides: Partial<OnboardingContext> = {}): OnboardingContext {
  return {
    platform: "macos",
    phoneType: null,
    emailConnected: undefined,
    connectedEmail: null,
    emailSkipped: false,
    driverSkipped: false,
    driverSetupComplete: false,
    permissionsGranted: undefined,
    termsAccepted: false,
    emailProvider: null,
    authProvider: "google",
    isNewUser: true,
    isDatabaseInitialized: false,
    userId: null,
    isUserVerifiedInLocalDb: false,
    isResumedFromFdaRelaunch: false,
    ...overrides,
  };
}

/**
 * `phoneType: "iphone"` is load-bearing. With `phoneType: null` the phone-type
 * step claims `active` first and secure-storage reads `pending` in BOTH cases,
 * which cannot tell a correct predicate from `isComplete: () => true`.
 */
function secureStorageEntry(isDatabaseInitialized: boolean) {
  const queue = buildOnboardingQueue(
    "macos",
    makeContext({ isDatabaseInitialized, phoneType: "iphone" })
  );
  return queue.find((entry) => entry.step.meta.id === "secure-storage");
}

describe("BACKLOG-3253 — secure-storage queue status follows the real predicate", () => {
  it("marks secure-storage COMPLETE when the context says the database is initialized", () => {
    expect(secureStorageEntry(true)).toMatchObject({
      status: "complete",
      applicable: true,
    });
  });

  it("leaves secure-storage ACTIVE when the context says the database is NOT initialized", () => {
    // This is the case the founder kept the step for: a genuinely failed
    // database open must still have a screen to land on.
    //
    // BACKLOG-3253 honesty note: post-merge, no reachable route produces this
    // context value, because every producer of `status: "onboarding"` arrives
    // with `selectIsDatabaseInitialized` true. The step exists in code for the
    // failure case, not yet in practice. BACKLOG-3321 (record whether the
    // database opened instead of inferring it) is what makes it reachable.
    expect(secureStorageEntry(false)).toMatchObject({
      status: "active",
      applicable: true,
    });
  });

  it("keeps secure-storage in the macOS flow at all (guards the ruled-out 'delete the step' variant)", () => {
    expect(secureStorageEntry(true)).toBeDefined();
    expect(secureStorageEntry(false)).toBeDefined();
  });
});
