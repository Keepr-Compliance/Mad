/**
 * BACKLOG-1842 (resume-at-step fix round) — integration tests for resuming
 * onboarding at the `permissions` step through the REAL useOnboardingQueue
 * hook (real flows + real registered steps), after the FDA-grant relaunch.
 *
 * Founder QA (2026-07-20) found that after the relaunch, onboarding restarted
 * from phone-type instead of resuming at permissions — the user had to
 * manually re-click through phone-type, account-verification, contact-source,
 * and data-sync. These tests lock in the fix: given a resumed context (all
 * prior steps' state restored, as it would be after OnboardingFlow consumes
 * the cloud resume marker and seeds initialManuallyCompletedIds), the queue's
 * active step must be EXACTLY "permissions" on the very first build — no
 * replay of any earlier step.
 *
 * @module onboarding/queue/__tests__/useOnboardingQueue.resume.test
 */

import { renderHook } from "@testing-library/react";
import { useOnboardingQueue } from "../useOnboardingQueue";
import type { OnboardingAppState } from "../useOnboardingQueue";

jest.mock("../../../../contexts/PlatformContext", () => ({
  usePlatform: () => ({
    platform: "macos" as const,
    isWindows: false,
    isMacOS: true,
    isLinux: false,
  }),
}));

jest.mock("../../../../utils/logger", () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

/**
 * App state for a macOS user who has fully completed everything up through
 * data-sync (i.e. reached `permissions`) BEFORE the FDA-grant relaunch, and
 * whose state has now been restored on the fresh process — exactly what
 * OnboardingFlow builds from the resume bundle (cloud phoneType +
 * contactSources + isUserVerifiedInLocalDb seeded true).
 */
function resumedAppState(overrides: Partial<OnboardingAppState> = {}): OnboardingAppState {
  return {
    phoneType: "iphone",
    emailConnected: true,
    connectedEmail: "user@example.com",
    emailProvider: "google",
    hasPermissions: false, // The whole point of being on this step — not granted yet
    hasSecureStorage: true,
    driverSetupComplete: true,
    termsAccepted: true,
    authProvider: "google",
    isNewUser: true,
    isDatabaseInitialized: true,
    userId: "u1",
    isUserVerifiedInLocalDb: true, // seeded by OnboardingFlow from resumeBundle.isResuming
    emailSkipped: false,
    driverSkipped: false,
    isResumedFromFdaRelaunch: true,
    ...overrides,
  };
}

describe("useOnboardingQueue — resume at permissions (BACKLOG-1842)", () => {
  it("lands on EXACTLY the permissions step on first build when resuming, with no earlier step active", () => {
    const { result } = renderHook(() =>
      useOnboardingQueue({
        appState: resumedAppState(),
        // Mirrors OnboardingFlow's initialManuallyCompletedIds seeding from
        // the resume bundle: data-sync always seeded, contact-source seeded
        // when the marker said it was already selected.
        initialManuallyCompletedIds: ["data-sync", "contact-source"],
      })
    );

    expect(result.current.activeEntry?.step.meta.id).toBe("permissions");

    // Exact-ID assertion on the full visible queue, not just a count —
    // every step before permissions must show as complete/skipped, not active.
    const statuses = Object.fromEntries(
      result.current.visibleEntries.map((e) => [e.step.meta.id, e.status])
    );
    expect(statuses["phone-type"]).toBe("complete");
    expect(statuses["secure-storage"]).toBe("complete");
    expect(statuses["account-verification"]).toBe("complete");
    expect(statuses["contact-source"]).toBe("complete");
    expect(statuses["email-connect"]).toBe("complete");
    expect(statuses["data-sync"]).toBe("complete");
    expect(statuses["permissions"]).toBe("active");
  });

  it("without the resume seed (normal flow reaching the same context), contact-source and data-sync would NOT show complete", () => {
    // Sanity check that the seeding is actually doing the work — same
    // context, but no initialManuallyCompletedIds, matches pre-fix behavior
    // where contact-source/data-sync have no context-derivable isComplete.
    const { result } = renderHook(() =>
      useOnboardingQueue({
        appState: resumedAppState(),
      })
    );

    // contact-source is now the active step (first entry whose isComplete
    // is false) even though the user already selected sources before the
    // relaunch — this is the bug this fix round addresses.
    expect(result.current.activeEntry?.step.meta.id).toBe("contact-source");
  });

  it("does not replay phone-type when resuming even though isNewUser is true", () => {
    // Regression guard for the root cause: AUTH_LOADED's isNewUser branch
    // used to hardcode phoneType: null for "new" users (a mid-onboarding
    // user is still isNewUser=true), wiping the selection. The queue itself
    // must not re-show phone-type once appState.phoneType is populated,
    // regardless of isNewUser.
    const { result } = renderHook(() =>
      useOnboardingQueue({
        appState: resumedAppState({ isNewUser: true }),
        initialManuallyCompletedIds: ["data-sync", "contact-source"],
      })
    );

    expect(result.current.activeEntry?.step.meta.id).toBe("permissions");
    expect(result.current.activeEntry?.step.meta.id).not.toBe("phone-type");
  });
});
