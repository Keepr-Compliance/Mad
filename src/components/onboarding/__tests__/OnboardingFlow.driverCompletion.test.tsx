/**
 * BACKLOG-1919: Tests for the onboarding-completion Apple-driver-missing
 * Sentry signal in OnboardingFlow.
 *
 * Context: OnboardingFlow.tsx previously detected Windows via
 * `typeof process !== "undefined" && process.platform === "win32"`. In the
 * real renderer (nodeIntegration:false, contextIsolation:true) `process` is
 * undefined, so this check always evaluated false and the Sentry signal
 * ("Completing onboarding with Apple driver still missing") never fired on
 * real Windows machines — even though it passed in Jest, where `process` is
 * Node's real process object.
 *
 * The fix sources platform from `usePlatform()` (IPC-backed via window.api,
 * works under contextIsolation) instead. These tests mock usePlatform to
 * Windows and assert the completion-time driver check now actually runs and
 * reports to Sentry when the driver is missing.
 *
 * The state-machine / queue / selector layers are mocked out so the test is
 * scoped to OnboardingFlow's own `handleComplete` logic rather than the
 * full onboarding step machinery.
 */

import React from "react";
import { render, act } from "@testing-library/react";
import { OnboardingFlow } from "../OnboardingFlow";
import type { AppStateMachine } from "../../../appCore/state/types";

// --- usePlatform: the renderer-safe platform source (BACKLOG-1919 fix) ---
let mockPlatform: { isWindows: boolean; isMacOS: boolean; isLinux: boolean; platform: string } = {
  isWindows: false,
  isMacOS: false,
  isLinux: true,
  platform: "linux",
};
jest.mock("../../../contexts/PlatformContext", () => ({
  usePlatform: () => mockPlatform,
}));

// --- State machine: force the "onboarding" status so handleComplete can run ---
jest.mock("../../../appCore/state/machine", () => ({
  useOptionalMachineState: () => ({
    state: { status: "onboarding" },
    dispatch: jest.fn(),
  }),
}));

// --- Selectors: OnboardingFlow only threads these through to appState; the
// actual values are irrelevant to the completion-time driver check.
jest.mock("../../../appCore/state/machine/selectors", () => ({
  selectPhoneType: () => "iphone",
  selectHasEmailConnectedNullable: () => true,
  selectHasPermissionsNullable: () => true,
  selectIsDatabaseInitialized: () => true,
}));

jest.mock("../../../appCore/state/machine/debug", () => ({
  logAllFlags: jest.fn(),
  logStateChange: jest.fn(),
}));

// --- Queue: capture onComplete so the test can trigger it directly, instead
// of driving the full step-by-step onboarding UI.
let capturedOnComplete: (() => void) | null = null;
jest.mock("../queue/useOnboardingQueue", () => ({
  useOnboardingQueue: (opts: { onComplete?: () => void }) => {
    capturedOnComplete = opts.onComplete ?? null;
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

jest.mock("../shell/OnboardingShell", () => ({
  OnboardingShell: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="onboarding-shell">{children}</div>
  ),
}));
jest.mock("../shell/ProgressIndicator", () => ({
  ProgressIndicator: () => null,
}));
jest.mock("../shell/NavigationButtons", () => ({
  NavigationButtons: () => null,
}));

const mockReportDriverStillMissingAtCompletion = jest.fn();
jest.mock("../sentryOnboarding", () => ({
  reportDriverStillMissingAtCompletion: (...args: unknown[]) =>
    mockReportDriverStillMissingAtCompletion(...args),
}));

function makeApp(): AppStateMachine {
  return {
    selectedPhoneType: "iphone",
    hasEmailConnected: true,
    currentUser: { id: "u1", email: "user@example.com" },
    pendingOnboardingData: null,
    hasPermissions: true,
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

const setMockPlatform = (platform: "windows" | "macos" | "linux") => {
  mockPlatform = {
    isWindows: platform === "windows",
    isMacOS: platform === "macos",
    isLinux: platform === "linux",
    platform,
  };
};

describe("OnboardingFlow completion-time Apple-driver check (BACKLOG-1919)", () => {
  beforeEach(() => {
    capturedOnComplete = null;
    mockReportDriverStillMissingAtCompletion.mockClear();
    setMockPlatform("linux");
  });

  it("reports to Sentry when completing on Windows with the driver still missing", async () => {
    setMockPlatform("windows");
    (window as unknown as { api: unknown }).api = {
      drivers: {
        checkApple: jest.fn().mockResolvedValue({ isInstalled: false }),
      },
    };

    render(<OnboardingFlow app={makeApp()} />);
    expect(capturedOnComplete).toBeInstanceOf(Function);

    await act(async () => {
      capturedOnComplete!();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockReportDriverStillMissingAtCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ driverSkipped: expect.any(Boolean) }),
    );
  });

  it("does NOT report when completing on Windows with the driver installed", async () => {
    setMockPlatform("windows");
    (window as unknown as { api: unknown }).api = {
      drivers: {
        checkApple: jest.fn().mockResolvedValue({ isInstalled: true }),
      },
    };

    render(<OnboardingFlow app={makeApp()} />);

    await act(async () => {
      capturedOnComplete!();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockReportDriverStillMissingAtCompletion).not.toHaveBeenCalled();
  });

  it("does NOT check/report on macOS even with the driver missing", async () => {
    setMockPlatform("macos");
    const checkApple = jest.fn().mockResolvedValue({ isInstalled: false });
    (window as unknown as { api: unknown }).api = { drivers: { checkApple } };

    render(<OnboardingFlow app={makeApp()} />);

    await act(async () => {
      capturedOnComplete!();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(checkApple).not.toHaveBeenCalled();
    expect(mockReportDriverStillMissingAtCompletion).not.toHaveBeenCalled();
  });

  // Regression guard mirroring the useIPhoneSync one: the renderer has no
  // `process` global under contextIsolation, so this file must never
  // reference it for platform detection.
  it("does not reference `process` in the component source", () => {
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(
      path.resolve(__dirname, "../OnboardingFlow.tsx"),
      "utf-8",
    );
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(codeOnly).not.toMatch(/\bprocess\s*\./);
  });
});
