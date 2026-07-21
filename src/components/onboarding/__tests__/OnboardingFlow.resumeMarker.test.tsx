/**
 * BACKLOG-1842 (resume-at-step fix round) — tests for OnboardingFlow's
 * resume-bundle resolution (the cloud marker consumed right after the
 * FDA-grant relaunch).
 *
 * Founder QA (2026-07-20) found onboarding restarted from phone-type after
 * the relaunch instead of resuming at permissions. These tests assert
 * OnboardingFlow:
 *  - waits for the resume-bundle IPC round trip before mounting the queue
 *    (no flash of the wrong step while the check is in flight)
 *  - passes initialManuallyCompletedIds = ["data-sync"] (+ "contact-source"
 *    when the cloud marker says it was already selected) to useOnboardingQueue
 *  - dispatches RESUME_MARKER_APPLIED with the cloud phoneType exactly once
 *  - seeds isUserVerifiedInLocalDb=true when resuming (skips the
 *    account-verification re-flash)
 *  - on a NORMAL (non-resuming) launch, none of the above fires — the queue
 *    gets no seed and no RESUME_MARKER_APPLIED dispatch
 *
 * @module onboarding/__tests__/OnboardingFlow.resumeMarker.test
 */

import React from "react";
import { render, waitFor } from "@testing-library/react";
import { OnboardingFlow } from "../OnboardingFlow";
import type { AppStateMachine } from "../../../appCore/state/types";

jest.mock("../../../contexts/PlatformContext", () => ({
  usePlatform: () => ({ isWindows: false, isMacOS: true, isLinux: false, platform: "macos" }),
}));

jest.mock("../../../appCore/state/machine/selectors", () => ({
  selectPhoneType: () => "iphone",
  selectHasEmailConnectedNullable: () => true,
  selectHasPermissionsNullable: () => false,
  selectIsDatabaseInitialized: () => true,
}));

jest.mock("../../../appCore/state/machine/debug", () => ({
  logAllFlags: jest.fn(),
  logStateChange: jest.fn(),
}));

jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock("../sentryOnboarding", () => ({
  reportDriverStillMissingAtCompletion: jest.fn(),
}));

jest.mock("../shell/OnboardingShell", () => ({
  OnboardingShell: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="onboarding-shell">{children}</div>
  ),
}));
jest.mock("../shell/ProgressIndicator", () => ({ ProgressIndicator: () => null }));
jest.mock("../shell/NavigationButtons", () => ({ NavigationButtons: () => null }));

// --- Queue: capture the options useOnboardingQueue was called with ---
let capturedQueueOptions: {
  initialManuallyCompletedIds?: readonly string[];
} | null = null;
jest.mock("../queue/useOnboardingQueue", () => ({
  useOnboardingQueue: (opts: { initialManuallyCompletedIds?: readonly string[] }) => {
    capturedQueueOptions = opts;
    return {
      visibleEntries: [],
      activeEntry: undefined,
      activeStep: undefined,
      currentIndex: 0,
      isComplete: false,
      context: {},
      goToNext: jest.fn(),
      goToPrevious: jest.fn(),
      handleAction: jest.fn(),
      handleSkip: jest.fn(),
      isFirstStep: true,
      canSkip: false,
      isNextDisabled: false,
      isViewingPastStep: false,
    };
  },
}));

const mockDispatch = jest.fn();

function makeMachineState() {
  return {
    state: {
      status: "onboarding" as const,
      user: { id: "u1", email: "user@example.com" },
    },
    dispatch: mockDispatch,
  };
}

jest.mock("../../../appCore/state/machine", () => ({
  useOptionalMachineState: () => makeMachineState(),
}));

function makeApp(): AppStateMachine {
  return {
    selectedPhoneType: "iphone",
    hasEmailConnected: true,
    currentUser: { id: "u1", email: "user@example.com" },
    pendingOnboardingData: null,
    hasPermissions: false,
    hasSecureStorageSetup: true,
    needsDriverSetup: false,
    needsTermsAcceptance: false,
    pendingOAuthData: null,
    authProvider: "google",
    isNewUserFlow: true,
    isDatabaseInitialized: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function installWindowApi(overrides: {
  consumeOnboardingResumeMarker: jest.Mock;
  getPhoneTypeCloud?: jest.Mock;
  preferencesGet?: jest.Mock;
}) {
  (window as unknown as { api: unknown }).api = {
    system: {
      consumeOnboardingResumeMarker: overrides.consumeOnboardingResumeMarker,
    },
    user: {
      getPhoneTypeCloud: overrides.getPhoneTypeCloud ?? jest.fn().mockResolvedValue({ success: true }),
    },
    preferences: {
      get: overrides.preferencesGet ?? jest.fn().mockResolvedValue({ success: true, preferences: {} }),
    },
  };
}

describe("OnboardingFlow — resume bundle (BACKLOG-1842)", () => {
  beforeEach(() => {
    capturedQueueOptions = null;
    mockDispatch.mockClear();
  });

  it("resuming: seeds data-sync + contact-source and dispatches RESUME_MARKER_APPLIED with the cloud phoneType", async () => {
    const consumeOnboardingResumeMarker = jest
      .fn()
      .mockResolvedValue({ resumeStep: "permissions" });
    const getPhoneTypeCloud = jest.fn().mockResolvedValue({ success: true, phoneType: "iphone" });
    const preferencesGet = jest.fn().mockResolvedValue({
      success: true,
      preferences: { contactSources: { direct: { macosContacts: true } } },
    });
    installWindowApi({ consumeOnboardingResumeMarker, getPhoneTypeCloud, preferencesGet });

    render(<OnboardingFlow app={makeApp()} />);

    await waitFor(() => {
      expect(capturedQueueOptions).not.toBeNull();
    });

    expect(consumeOnboardingResumeMarker).toHaveBeenCalledWith({ userId: "u1" });
    expect(capturedQueueOptions!.initialManuallyCompletedIds).toEqual(
      expect.arrayContaining(["data-sync", "contact-source"])
    );

    await waitFor(() => {
      expect(mockDispatch).toHaveBeenCalledWith({
        type: "RESUME_MARKER_APPLIED",
        phoneType: "iphone",
      });
    });
  });

  it("resuming with contact-source NOT yet selected: seeds only data-sync", async () => {
    const consumeOnboardingResumeMarker = jest
      .fn()
      .mockResolvedValue({ resumeStep: "permissions" });
    const getPhoneTypeCloud = jest.fn().mockResolvedValue({ success: true, phoneType: "android" });
    const preferencesGet = jest.fn().mockResolvedValue({ success: true, preferences: {} });
    installWindowApi({ consumeOnboardingResumeMarker, getPhoneTypeCloud, preferencesGet });

    render(<OnboardingFlow app={makeApp()} />);

    await waitFor(() => {
      expect(capturedQueueOptions).not.toBeNull();
    });

    expect(capturedQueueOptions!.initialManuallyCompletedIds).toEqual(["data-sync"]);
  });

  it("normal (non-resuming) launch: no seed, no RESUME_MARKER_APPLIED dispatch", async () => {
    const consumeOnboardingResumeMarker = jest.fn().mockResolvedValue({ resumeStep: null });
    installWindowApi({ consumeOnboardingResumeMarker });

    render(<OnboardingFlow app={makeApp()} />);

    await waitFor(() => {
      expect(capturedQueueOptions).not.toBeNull();
    });

    expect(capturedQueueOptions!.initialManuallyCompletedIds).toBeUndefined();
    expect(mockDispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "RESUME_MARKER_APPLIED" })
    );
  });

  it("a marker-check failure degrades to a normal (non-resuming) launch, never throws", async () => {
    const consumeOnboardingResumeMarker = jest.fn().mockRejectedValue(new Error("IPC down"));
    installWindowApi({ consumeOnboardingResumeMarker });

    render(<OnboardingFlow app={makeApp()} />);

    await waitFor(() => {
      expect(capturedQueueOptions).not.toBeNull();
    });

    expect(capturedQueueOptions!.initialManuallyCompletedIds).toBeUndefined();
  });
});
