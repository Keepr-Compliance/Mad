/**
 * BACKLOG-3673 C17f (SR delta N1) — the isComplete effect is a real way out.
 *
 * A queue that is already complete when it mounts (every answer seeded) or
 * whose last step drops out (the data-source floor, satisfied by connecting
 * email on it) never calls onComplete. Only OnboardingFlow's isComplete effect
 * completes setup for that user, so it must write the record once and leave.
 * Wrong fix W5: deleting or narrowing that effect, believing onComplete is the
 * only caller -- the user would sit on the floor screen forever.
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
let mockIsComplete = false;
let capturedOnComplete: (() => void) | null = null;
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

describe("C17f — queue already complete (floor dropped / resume) -> effect path writes once and leaves", () => {
  it("isComplete=true at mount: completeAccountSetup x1, then ready, without any onComplete call", async () => {
    mockIsComplete = true;
    const completeAccountSetup = jest.fn(async () => ({ success: true }));
    (window as unknown as { api: unknown }).api = {
      system: { consumeOnboardingResumeMarker: jest.fn().mockResolvedValue({ resumeStep: null }), onInitStage: jest.fn(() => () => {}) },
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
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(completeAccountSetup).toHaveBeenCalledTimes(1);
    expect(latest?.status).toBe("ready");
  });
});
