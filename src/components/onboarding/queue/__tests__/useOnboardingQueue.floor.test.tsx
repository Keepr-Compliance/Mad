/**
 * BACKLOG-1821 — Integration tests for the data-source floor through the REAL
 * useOnboardingQueue hook (real flows + real registered steps).
 *
 * The SR plan review flagged a double-fire risk: connecting a source from the
 * floor step calls goToNext() against the stale (pre-rebuild) queue AND the
 * rebuild drops the floor to complete. This test asserts the observable
 * contract at the hook level:
 *   - while the floor is unmet, the queue is NOT complete (onComplete not
 *     reached by simply being on the last step);
 *   - connecting a source flips isComplete → true;
 *   - onComplete fires (idempotency of the downstream dispatch is guarded in
 *     OnboardingFlow via hasNavigatedRef + status check, covered separately).
 *
 * @module onboarding/queue/__tests__/useOnboardingQueue.floor.test
 */

import { renderHook, act } from "@testing-library/react";
import { useOnboardingQueue } from "../useOnboardingQueue";
import type { OnboardingAppState } from "../useOnboardingQueue";

// usePlatform is IPC-backed in the renderer; mock it to a deterministic value.
let mockPlatform = { platform: "windows" as const };
jest.mock("../../../../contexts/PlatformContext", () => ({
  usePlatform: () => ({
    platform: mockPlatform.platform,
    isWindows: mockPlatform.platform === "windows",
    isMacOS: false,
    isLinux: false,
  }),
}));

jest.mock("../../../../utils/logger", () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

/**
 * App state for a Windows iPhone user at the END of onboarding. Defaults are the
 * ZERO-source dead-end (email skipped + driver skipped) so the floor is active.
 */
function endState(overrides: Partial<OnboardingAppState> = {}): OnboardingAppState {
  return {
    phoneType: "iphone",
    emailConnected: false,
    connectedEmail: null,
    emailProvider: null,
    hasPermissions: false,
    hasSecureStorage: true,
    driverSetupComplete: false,
    termsAccepted: true,
    authProvider: "google",
    isNewUser: true,
    isDatabaseInitialized: true,
    userId: "u1",
    isUserVerifiedInLocalDb: true,
    emailSkipped: true,
    driverSkipped: true,
    isResumedFromFdaRelaunch: false,
    ...overrides,
  };
}

/**
 * Advance the queue forward (simulating the user / auto-advance clicking
 * Continue) past the intermediate steps whose isComplete is always false
 * (contact-source, data-sync), until either the active step is the floor or the
 * queue completes. Guarded by a hard cap so a regression can't infinite-loop.
 */
function advanceToFloorOrComplete(result: { current: ReturnType<typeof useOnboardingQueue> }) {
  for (let i = 0; i < 12; i++) {
    if (result.current.isComplete) return;
    if (result.current.activeStep?.meta.id === "data-source-floor") return;
    act(() => {
      result.current.goToNext();
    });
  }
}

describe("useOnboardingQueue data-source floor (BACKLOG-1821)", () => {
  beforeEach(() => {
    mockPlatform = { platform: "windows" };
  });

  it("with zero sources, advancing lands on the floor and the queue is NOT complete", () => {
    const { result } = renderHook(() =>
      useOnboardingQueue({ appState: endState() }),
    );

    advanceToFloorOrComplete(result);

    expect(result.current.activeStep?.meta.id).toBe("data-source-floor");
    expect(result.current.isComplete).toBe(false);
    // No skip and Continue disabled — no bypass path off the floor.
    expect(result.current.canSkip).toBe(false);
    expect(result.current.isNextDisabled).toBe(true);
  });

  it("the floor is the LAST visible entry when unmet", () => {
    const { result } = renderHook(() =>
      useOnboardingQueue({ appState: endState() }),
    );
    const visible = result.current.visibleEntries;
    expect(visible[visible.length - 1].step.meta.id).toBe("data-source-floor");
  });

  it("connecting email from the floor flips the queue to complete (no dead-end)", () => {
    const onComplete = jest.fn();
    const { result, rerender } = renderHook(
      ({ appState }) => useOnboardingQueue({ appState, onComplete }),
      { initialProps: { appState: endState() } },
    );

    advanceToFloorOrComplete(result);
    expect(result.current.activeStep?.meta.id).toBe("data-source-floor");
    expect(result.current.isComplete).toBe(false);

    // Simulate the source connecting (email OAuth succeeded → context updates).
    act(() => {
      rerender({ appState: endState({ emailConnected: true }) });
    });

    // Floor drops from the queue → queue is complete → no dead-end.
    expect(result.current.isComplete).toBe(true);
    expect(
      result.current.visibleEntries.map((e) => e.step.meta.id),
    ).not.toContain("data-source-floor");
  });

  it("with a source already present, advancing completes WITHOUT ever surfacing the floor", () => {
    const onComplete = jest.fn();
    const { result } = renderHook(() =>
      useOnboardingQueue({
        appState: endState({ driverSetupComplete: true, driverSkipped: false }),
        onComplete,
      }),
    );

    // The floor is never even visible on the happy path (a source exists).
    expect(
      result.current.visibleEntries.map((e) => e.step.meta.id),
    ).not.toContain("data-source-floor");

    // Advance to the end. The floor must never be the active step; completion is
    // signaled via onComplete when goToNext runs off the last visible step.
    for (let i = 0; i < 12 && !onComplete.mock.calls.length; i++) {
      expect(result.current.activeStep?.meta.id).not.toBe("data-source-floor");
      act(() => {
        result.current.goToNext();
      });
    }

    expect(onComplete).toHaveBeenCalled();
  });
});
