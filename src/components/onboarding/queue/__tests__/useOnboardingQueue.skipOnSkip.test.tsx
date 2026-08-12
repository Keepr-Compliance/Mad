/**
 * BACKLOG-2476 — `handleSkip` runs the active step's `onSkip` through the REAL
 * hook the app actually renders.
 *
 * This test exists because of a near-miss. The obvious home for the skip-time
 * write is `hooks/useOnboardingFlow.ts`, which still exports a `handleSkip` and
 * is still re-exported from two barrels — but nothing renders it.
 * `OnboardingFlow.tsx` imports `useOnboardingQueue` and passes ITS `handleSkip`
 * to NavigationButtons. Wiring the write into the other hook would have shipped
 * dead code with a green unit test behind it.
 *
 * So these assertions go through `useOnboardingQueue`, and through the step
 * registry rather than a hand-made step, so they fail if the wiring moves.
 *
 * @module onboarding/queue/__tests__/useOnboardingQueue.skipOnSkip.test
 */

import { renderHook, act } from "@testing-library/react";
import { useOnboardingQueue } from "../useOnboardingQueue";
import type { OnboardingAppState } from "../useOnboardingQueue";

let mockPlatform = { platform: "macos" as "macos" | "windows" };
jest.mock("../../../../contexts/PlatformContext", () => ({
  usePlatform: () => ({
    platform: mockPlatform.platform,
    isWindows: mockPlatform.platform === "windows",
    isMacOS: mockPlatform.platform === "macos",
    isLinux: false,
  }),
}));

jest.mock("../../../../utils/logger", () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

function macUserWithIPhone(
  overrides: Partial<OnboardingAppState> = {}
): OnboardingAppState {
  return {
    phoneType: "iphone",
    emailConnected: true,
    connectedEmail: "agent@example.com",
    emailProvider: "microsoft",
    hasPermissions: true,
    hasSecureStorage: true,
    driverSetupComplete: true,
    termsAccepted: true,
    authProvider: "microsoft",
    isNewUser: true,
    isDatabaseInitialized: true,
    userId: "test-user-123",
    isUserVerifiedInLocalDb: true,
    emailSkipped: false,
    driverSkipped: false,
    isResumedFromFdaRelaunch: false,
    ...overrides,
  };
}

/** Walk the queue forward until the contact-source step is active. */
function advanceToContactSource(result: {
  current: ReturnType<typeof useOnboardingQueue>;
}): boolean {
  for (let i = 0; i < 12; i++) {
    if (result.current.activeStep?.meta.id === "contact-source") return true;
    if (result.current.isComplete) return false;
    act(() => {
      result.current.goToNext();
    });
  }
  return false;
}

describe("useOnboardingQueue handleSkip runs the step's onSkip (BACKLOG-2476)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPlatform = { platform: "macos" };
    jest.mocked(window.api.preferences.update).mockResolvedValue({ success: true });
  });

  it("persists the contact-source defaults when the user skips the step", async () => {
    const { result } = renderHook(() =>
      useOnboardingQueue({ appState: macUserWithIPhone() })
    );

    expect(advanceToContactSource(result)).toBe(true);

    await act(async () => {
      await result.current.handleSkip();
    });

    // The whole point of BACKLOG-2476: skipping records a decision instead of
    // leaving the preference absent for the backend to answer with "all on".
    expect(window.api.preferences.update).toHaveBeenCalledTimes(1);
    expect(window.api.preferences.update).toHaveBeenCalledWith("test-user-123", {
      contactSources: {
        direct: {
          macosContacts: true,
          outlookContacts: true,
          googleContacts: false,
          iphoneContacts: false,
        },
      },
    });
  });

  it("still advances past the step when the write fails", async () => {
    jest
      .mocked(window.api.preferences.update)
      .mockRejectedValue(new Error("Supabase offline"));

    const { result } = renderHook(() =>
      useOnboardingQueue({ appState: macUserWithIPhone() })
    );
    expect(advanceToContactSource(result)).toBe(true);

    await act(async () => {
      await result.current.handleSkip();
    });

    // The user asked to move on. A failed write leaves the preference absent,
    // which the derived backend default already handles.
    expect(result.current.activeStep?.meta.id).not.toBe("contact-source");
  });

  it("writes once when the skip control is double-clicked mid-write", async () => {
    // NavigationButtons renders the skip control with no disabled state, so a
    // second click during the round trip would otherwise fire a second write
    // AND a second navigation — advancing two steps.
    let releaseWrite: (() => void) | undefined;
    jest.mocked(window.api.preferences.update).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseWrite = () => resolve({ success: true });
        })
    );

    const { result } = renderHook(() =>
      useOnboardingQueue({ appState: macUserWithIPhone() })
    );
    expect(advanceToContactSource(result)).toBe(true);

    await act(async () => {
      const first = result.current.handleSkip();
      const second = result.current.handleSkip();
      releaseWrite?.();
      await Promise.all([first, second]);
    });

    expect(window.api.preferences.update).toHaveBeenCalledTimes(1);
  });

  it("does not disturb steps that declare no onSkip", async () => {
    // email-connect is skippable and has no onSkip; skipping it must not
    // suddenly start writing preferences.
    const { result } = renderHook(() =>
      useOnboardingQueue({
        appState: macUserWithIPhone({
          emailConnected: false,
          connectedEmail: null,
          emailProvider: null,
        }),
      })
    );

    for (let i = 0; i < 12; i++) {
      if (result.current.activeStep?.meta.id === "email-connect") break;
      if (result.current.isComplete) break;
      act(() => {
        result.current.goToNext();
      });
    }

    if (result.current.activeStep?.meta.id === "email-connect") {
      await act(async () => {
        await result.current.handleSkip();
      });
      expect(window.api.preferences.update).not.toHaveBeenCalled();
    }
  });
});
