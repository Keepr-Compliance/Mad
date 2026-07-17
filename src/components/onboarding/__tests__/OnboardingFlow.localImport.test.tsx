/**
 * BACKLOG-1817: Tests for the onboarding-completion INITIAL import of local
 * (macOS) contact sources in OnboardingFlow.
 *
 * Context: Outlook/Google contacts import after account connect via the
 * BACKLOG-1759 post-connect trigger, but local (macOS) sources have no
 * "connect moment." The recurring auto-refresh that would otherwise import
 * them is suppressed during onboarding and only runs on the dashboard, so a
 * fresh macOS install never got a guaranteed first import.
 *
 * The fix fires `window.api.contacts.syncExternal(userId)` at onboarding
 * completion on macOS — the same handler the working manual "Settings →
 * Import" button uses. That handler self-gates on the `macosContacts` enabled
 * preference, so it is safe to call unconditionally w.r.t. the auto-sync pref.
 *
 * These tests mock the state-machine / queue / selector layers so the test is
 * scoped to OnboardingFlow's own `handleComplete` logic, and assert:
 *  - macOS completion calls window.api.contacts.syncExternal(userId)
 *  - Windows completion does NOT call it (local import is macOS-only)
 *  - an import rejection never throws out of completion (non-fatal)
 */

import React from "react";
import { render, act } from "@testing-library/react";
import { OnboardingFlow } from "../OnboardingFlow";
import type { AppStateMachine } from "../../../appCore/state/types";

// --- usePlatform: renderer-safe platform source ---
let mockPlatform: { isWindows: boolean; isMacOS: boolean; isLinux: boolean; platform: string } = {
  isWindows: false,
  isMacOS: false,
  isLinux: true,
  platform: "linux",
};
jest.mock("../../../contexts/PlatformContext", () => ({
  usePlatform: () => mockPlatform,
}));

// --- State machine: force "onboarding" status so handleComplete can run ---
jest.mock("../../../appCore/state/machine", () => ({
  useOptionalMachineState: () => ({
    state: { status: "onboarding" },
    dispatch: jest.fn(),
  }),
}));

jest.mock("../../../appCore/state/machine/selectors", () => ({
  selectPhoneType: () => "android",
  selectHasEmailConnectedNullable: () => true,
  selectHasPermissionsNullable: () => true,
  selectIsDatabaseInitialized: () => true,
}));

jest.mock("../../../appCore/state/machine/debug", () => ({
  logAllFlags: jest.fn(),
  logStateChange: jest.fn(),
}));

// --- Queue: capture onComplete so the test triggers it directly ---
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

jest.mock("../sentryOnboarding", () => ({
  reportDriverStillMissingAtCompletion: jest.fn(),
}));

function makeApp(): AppStateMachine {
  return {
    selectedPhoneType: "android",
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

function installContactsApi(
  syncExternal: jest.Mock,
  drivers?: { checkApple: jest.Mock },
) {
  (window as unknown as { api: unknown }).api = {
    contacts: { syncExternal },
    ...(drivers ? { drivers } : {}),
  };
}

describe("OnboardingFlow completion-time local-source initial import (BACKLOG-1817)", () => {
  beforeEach(() => {
    capturedOnComplete = null;
    setMockPlatform("linux");
  });

  it("fires window.api.contacts.syncExternal(userId) on macOS completion", async () => {
    setMockPlatform("macos");
    const syncExternal = jest
      .fn()
      .mockResolvedValue({ success: true, inserted: 5, deleted: 0, total: 5 });
    installContactsApi(syncExternal);

    render(<OnboardingFlow app={makeApp()} />);
    expect(capturedOnComplete).toBeInstanceOf(Function);

    await act(async () => {
      capturedOnComplete!();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(syncExternal).toHaveBeenCalledTimes(1);
    expect(syncExternal).toHaveBeenCalledWith("u1");
  });

  it("does NOT fire the local import on Windows (macOS-only)", async () => {
    setMockPlatform("windows");
    const syncExternal = jest
      .fn()
      .mockResolvedValue({ success: true, inserted: 0 });
    // Windows path also runs the Apple-driver check; provide it so that branch
    // is exercised without error.
    installContactsApi(syncExternal, {
      checkApple: jest.fn().mockResolvedValue({ isInstalled: true }),
    });

    render(<OnboardingFlow app={makeApp()} />);

    await act(async () => {
      capturedOnComplete!();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(syncExternal).not.toHaveBeenCalled();
  });

  it("does not throw out of completion when the local import rejects", async () => {
    setMockPlatform("macos");
    const syncExternal = jest
      .fn()
      .mockRejectedValue(new Error("Contacts unavailable"));
    installContactsApi(syncExternal);

    render(<OnboardingFlow app={makeApp()} />);

    // The completion callback must resolve cleanly despite the rejected import.
    await act(async () => {
      capturedOnComplete!();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(syncExternal).toHaveBeenCalledTimes(1);
  });
});
