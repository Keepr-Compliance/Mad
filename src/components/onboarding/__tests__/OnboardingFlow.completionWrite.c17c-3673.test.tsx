/**
 * BACKLOG-3673 C17c — the queue end is the way out, and it writes the
 * per-account "setup finished" record exactly once, before leaving.
 *
 * Real AppStateProvider + real reducer + real OnboardingFlow.handleComplete.
 * The queue is captured (as in OnboardingFlow.driverCompletion.test.tsx) so the
 * test drives its onComplete and its isComplete flag directly.
 *
 * Case 2 (SR delta N3) drives the real double-call path: macOS, FDA granted on
 * the last visible step. The grant flips the queue's isComplete (-> the
 * OnboardingFlow effect) AND advances the queue (-> onComplete, from the
 * render that still saw onboarding). Without one shared guard: two writes.
 */
import React from "react";
import { render, act } from "@testing-library/react";
import { OnboardingFlow } from "../OnboardingFlow";
import { AppStateProvider } from "../../../appCore/state/machine/AppStateContext";
import { useAppState } from "../../../appCore/state/machine/useAppState";
import type { AppStateMachine } from "../../../appCore/state/types";
import type { OnboardingState, AppState } from "../../../appCore/state/machine/types";

jest.mock("../../../appCore/state/machine/utils/featureFlags", () => ({ isNewStateMachineEnabled: () => true }));
let mockPlatform = { isWindows: true, isMacOS: false, isLinux: false, platform: "windows" };
jest.mock("../../../contexts/PlatformContext", () => ({ usePlatform: () => mockPlatform }));
jest.mock("../../../appCore/state/machine/debug", () => ({ logAllFlags: jest.fn(), logStateChange: jest.fn() }));
let capturedOnComplete: (() => void) | null = null;
let mockIsComplete = false;
jest.mock("../queue/useOnboardingQueue", () => ({
  useOnboardingQueue: (opts: { onComplete?: () => void }) => {
    capturedOnComplete = opts.onComplete ?? null;
    return {
      visibleEntries: [], activeEntry: undefined, activeStep: undefined, currentIndex: 0,
      isComplete: mockIsComplete, context: {}, goToNext: jest.fn(), goToPrevious: jest.fn(),
      handleAction: jest.fn(), handleSkip: jest.fn(), isFirstStep: true, canSkip: false,
      isNextDisabled: false, isViewingPastStep: false,
    };
  },
}));
jest.mock("../shell/OnboardingShell", () => ({
  OnboardingShell: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock("../shell/ProgressIndicator", () => ({ ProgressIndicator: () => null }));
jest.mock("../shell/NavigationButtons", () => ({ NavigationButtons: () => null }));
jest.mock("../sentryOnboarding", () => ({ reportDriverStillMissingAtCompletion: jest.fn() }));

const USER = { id: "u-1", email: "user@example.com" };
const app = {
  selectedPhoneType: "android", hasEmailConnected: true, currentUser: USER, pendingOnboardingData: null,
  hasPermissions: true, hasSecureStorageSetup: true, needsDriverSetup: false, needsTermsAcceptance: false,
  pendingOAuthData: null, authProvider: "google", isNewUserFlow: true, isDatabaseInitialized: true,
} as unknown as AppStateMachine;

let latest: AppState | null = null;
function Probe() { latest = useAppState().state; return null; }

describe("C17c — the queue end is the way out, and it writes the record exactly once first", () => {
  it("Windows + Android: onComplete -> completeAccountSetup x1 (while onboarding) -> ready", async () => {
    const statusAtWrite: string[] = [];
    const completeAccountSetup = jest.fn(async () => { statusAtWrite.push(latest?.status ?? "none"); return { success: true }; });
    (window as unknown as { api: unknown }).api = {
      system: {
        consumeOnboardingResumeMarker: jest.fn().mockResolvedValue({ resumeStep: null }),
        onInitStage: jest.fn(() => () => {}),
      },
      user: { completeAccountSetup },
      drivers: { checkApple: jest.fn().mockResolvedValue({ isInstalled: true }) },
      contacts: { syncExternal: jest.fn().mockResolvedValue({ success: true }) },
    };
    const initial: OnboardingState = {
      status: "onboarding", step: "email-connect", user: USER,
      platform: { isMacOS: false, isWindows: true, hasIPhone: false },
      completedSteps: ["phone-type", "email-connect"], fda: "not-applicable",
      hasEmailConnected: true, selectedPhoneType: "android",
    };
    render(<AppStateProvider initialState={initial}><Probe /><OnboardingFlow app={app} /></AppStateProvider>);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(capturedOnComplete).toBeInstanceOf(Function);
    await act(async () => { capturedOnComplete!(); await Promise.resolve(); await Promise.resolve(); });
    expect(completeAccountSetup).toHaveBeenCalledTimes(1);
    expect(statusAtWrite).toEqual(["onboarding"]);
    expect(latest?.status).toBe("ready");
  });
  it("both completion callers fire for one completion (isComplete effect + queue onComplete) -> still exactly one write", async () => {
    mockIsComplete = false;
    mockPlatform = { isWindows: false, isMacOS: true, isLinux: false, platform: "macos" };
    const statusAtWrite: string[] = [];
    const completeAccountSetup = jest.fn(async () => { statusAtWrite.push(latest?.status ?? "none"); return { success: true }; });
    (window as unknown as { api: unknown }).api = {
      system: {
        consumeOnboardingResumeMarker: jest.fn().mockResolvedValue({ resumeStep: null }),
        onInitStage: jest.fn(() => () => {}),
      },
      user: { completeAccountSetup },
      drivers: { checkApple: jest.fn().mockResolvedValue({ isInstalled: true }) },
      contacts: { syncExternal: jest.fn().mockResolvedValue({ success: true }) },
    };
    const initial: OnboardingState = {
      status: "onboarding", step: "permissions", user: USER,
      platform: { isMacOS: true, isWindows: false, hasIPhone: false },
      completedSteps: ["phone-type", "secure-storage", "email-connect"], fda: "not-asked",
      hasEmailConnected: true, selectedPhoneType: "iphone",
    };
    let dispatchRef: ((a: { type: "FDA_GRANTED" }) => void) | null = null;
    function Dispatcher() { dispatchRef = useAppState().dispatch as never; return null; }
    render(<AppStateProvider initialState={initial}><Probe /><Dispatcher /><OnboardingFlow app={app} /></AppStateProvider>);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(capturedOnComplete).toBeInstanceOf(Function);

    // The grant: FDA_GRANTED re-renders with the queue now complete, so the
    // isComplete effect runs handleComplete (first caller).
    const onCompleteFromLastOnboardingRender = () => capturedOnComplete;
    await act(async () => {
      mockIsComplete = true;
      dispatchRef!({ type: "FDA_GRANTED" });
      await Promise.resolve();
    });
    // The same grant also advanced the queue: its onComplete -- captured from a
    // render that still saw "onboarding" -- arrives second.
    const lateOnComplete = onCompleteFromLastOnboardingRender();
    await act(async () => { lateOnComplete!(); await Promise.resolve(); await Promise.resolve(); });

    expect(completeAccountSetup).toHaveBeenCalledTimes(1);
    expect(statusAtWrite).toEqual(["onboarding"]);
    expect(latest?.status).toBe("ready");
    mockIsComplete = false;
    mockPlatform = { isWindows: true, isMacOS: false, isLinux: false, platform: "windows" };
  });
});
