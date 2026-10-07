/**
 * BACKLOG-3673 C12 + C13 — OnboardingFlow's two jobs for the account record.
 *
 * C12  The record is written by handleComplete ONLY: exactly once, before
 *      ONBOARDING_QUEUE_DONE. A failed write (success:false, or a rejection)
 *      is logged and the user still reaches the dashboard.
 * C13  The account's recorded answers seed their setup steps on ANY entry into
 *      setup -- not only after an FDA relaunch -- so the contacts question and
 *      the email step are never asked again once answered (new computer, no
 *      mailbox), and data-sync is skipped when both are answered.
 *
 * Real AppStateProvider + reducer + OnboardingFlow. The queue hook is captured
 * (as in OnboardingFlow.driverCompletion.test.tsx) for C12 and for reading the
 * seed OnboardingFlow hands it in C13; one C13 case also runs the REAL queue.
 */
import React from "react";
import { render, act, renderHook } from "@testing-library/react";
import { OnboardingFlow } from "../OnboardingFlow";
import { AppStateProvider } from "../../../appCore/state/machine/AppStateContext";
import { useAppState } from "../../../appCore/state/machine/useAppState";
import type { AppStateMachine } from "../../../appCore/state/types";
import type { OnboardingState, AppState } from "../../../appCore/state/machine/types";
import type { OnboardingAppState } from "../queue/useOnboardingQueue";

jest.mock("../../../appCore/state/machine/utils/featureFlags", () => ({ isNewStateMachineEnabled: () => true }));
const mockPlatform = { isWindows: true, isMacOS: false, isLinux: false, platform: "windows" };
jest.mock("../../../contexts/PlatformContext", () => ({ usePlatform: () => mockPlatform }));
jest.mock("../../../appCore/state/machine/debug", () => ({ logAllFlags: jest.fn(), logStateChange: jest.fn() }));
const mockLoggerWarn = jest.fn();
jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: (...a: unknown[]) => mockLoggerWarn(...a), info: jest.fn(), debug: jest.fn() },
}));

let mockUseRealQueue = false;
let capturedOnComplete: (() => void) | null = null;
let capturedSeed: readonly string[] | undefined | "unset" = "unset";
jest.mock("../queue/useOnboardingQueue", () => {
  const actual = jest.requireActual("../queue/useOnboardingQueue");
  return {
    ...actual,
    useOnboardingQueue: (opts: { onComplete?: () => void; initialManuallyCompletedIds?: readonly string[] }) => {
      if (mockUseRealQueue) return actual.useOnboardingQueue(opts);
      capturedOnComplete = opts.onComplete ?? null;
      capturedSeed = opts.initialManuallyCompletedIds;
      return {
        visibleEntries: [], activeEntry: undefined, activeStep: undefined, currentIndex: 0,
        isComplete: false, context: {}, goToNext: jest.fn(), goToPrevious: jest.fn(),
        handleAction: jest.fn(), handleSkip: jest.fn(), isFirstStep: true, canSkip: false,
        isNextDisabled: false, isViewingPastStep: false,
      };
    },
  };
});
jest.mock("../shell/OnboardingShell", () => ({
  OnboardingShell: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock("../shell/ProgressIndicator", () => ({ ProgressIndicator: () => null }));
jest.mock("../shell/NavigationButtons", () => ({ NavigationButtons: () => null }));
jest.mock("../sentryOnboarding", () => ({ reportDriverStillMissingAtCompletion: jest.fn() }));

const USER = { id: "u-3673", email: "user@example.com" };
const app = {
  selectedPhoneType: "android", hasEmailConnected: false, currentUser: USER, pendingOnboardingData: null,
  hasPermissions: true, hasSecureStorageSetup: true, needsDriverSetup: false, needsTermsAcceptance: false,
  pendingOAuthData: null, authProvider: "google", isNewUserFlow: false, isDatabaseInitialized: true,
} as unknown as AppStateMachine;

let latest: AppState | null = null;
function Probe() { latest = useAppState().state; return null; }

function setApi(completeAccountSetup: jest.Mock) {
  (window as unknown as { api: unknown }).api = {
    system: {
      consumeOnboardingResumeMarker: jest.fn().mockResolvedValue({ resumeStep: null }),
      onInitStage: jest.fn(() => () => {}),
    },
    user: { completeAccountSetup },
    drivers: { checkApple: jest.fn().mockResolvedValue({ isInstalled: true }) },
    contacts: { syncExternal: jest.fn().mockResolvedValue({ success: true }) },
  };
}

function onboarding(accountAnswers?: OnboardingState["accountAnswers"]): OnboardingState {
  return {
    status: "onboarding", step: "email-connect", user: USER,
    platform: { isMacOS: false, isWindows: true, hasIPhone: false },
    completedSteps: ["phone-type"], fda: "not-applicable",
    hasEmailConnected: false, selectedPhoneType: "android",
    ...(accountAnswers ? { accountAnswers } : {}),
  };
}

async function mount(initial: OnboardingState) {
  render(<AppStateProvider initialState={initial}><Probe /><OnboardingFlow app={app} /></AppStateProvider>);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  mockUseRealQueue = false;
  capturedOnComplete = null;
  capturedSeed = "unset";
  mockLoggerWarn.mockClear();
});

describe("C12 — the record is written by the queue end only", () => {
  it("queue end: one write, while still in setup, then the dashboard", async () => {
    const order: string[] = [];
    const completeAccountSetup = jest.fn(async () => { order.push(`write:${latest?.status}`); return { success: true }; });
    setApi(completeAccountSetup);
    await mount(onboarding());
    await act(async () => { capturedOnComplete!(); await Promise.resolve(); });
    order.push(`after:${latest?.status}`);
    expect(completeAccountSetup).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["write:onboarding", "after:ready"]);
  });

  it("a failed write (success:false) is logged and the user still reaches the dashboard", async () => {
    const completeAccountSetup = jest.fn(async () => ({ success: false, error: "rls" }));
    setApi(completeAccountSetup);
    await mount(onboarding());
    await act(async () => { capturedOnComplete!(); await Promise.resolve(); await Promise.resolve(); });
    expect(latest?.status).toBe("ready");
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("Setup-finished record was not written"), "rls",
    );
  });

  it("a rejected write is logged and the user still reaches the dashboard", async () => {
    const completeAccountSetup = jest.fn(async () => { throw new Error("ipc down"); });
    setApi(completeAccountSetup);
    await mount(onboarding());
    await act(async () => { capturedOnComplete!(); await Promise.resolve(); await Promise.resolve(); });
    expect(latest?.status).toBe("ready");
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("Setup-finished record write failed"), expect.any(Error),
    );
  });

  it("mounting setup, with nothing complete, writes nothing", async () => {
    const completeAccountSetup = jest.fn(async () => ({ success: true }));
    setApi(completeAccountSetup);
    await mount(onboarding({ contactSource: true, emailStep: true }));
    expect(completeAccountSetup).not.toHaveBeenCalled();
    expect(latest?.status).toBe("onboarding");
  });
});

describe("C13 — recorded answers seed their steps on every entry into setup", () => {
  beforeEach(() => setApi(jest.fn(async () => ({ success: true }))));

  it("contacts answered -> contact-source seeded; email not -> email-connect asked", async () => {
    await mount(onboarding({ contactSource: true, emailStep: false }));
    expect(capturedSeed).toEqual(["contact-source"]);
  });

  it("email answered -> email-connect seeded; contacts not -> contact-source asked", async () => {
    await mount(onboarding({ contactSource: false, emailStep: true }));
    expect(capturedSeed).toEqual(["email-connect"]);
  });

  it("both answered -> contact-source, email-connect and data-sync seeded", async () => {
    await mount(onboarding({ contactSource: true, emailStep: true }));
    expect([...(capturedSeed as string[])].sort()).toEqual(["contact-source", "data-sync", "email-connect"]);
  });

  it("nothing recorded -> nothing seeded", async () => {
    await mount(onboarding({ contactSource: false, emailStep: false }));
    expect(capturedSeed).toBeUndefined();
  });

  it("REAL queue, new computer, no mailbox: answered steps are never the active step", async () => {
    mockUseRealQueue = false;
    await mount(onboarding({ contactSource: true, emailStep: true }));
    const seed = capturedSeed as string[];

    // Same context OnboardingFlow builds for this state: Windows, Android
    // answered, no mailbox, email NOT skipped this run, DB ready + verified.
    mockUseRealQueue = true;
    const actual = jest.requireActual("../queue/useOnboardingQueue");
    const appState: OnboardingAppState = {
      phoneType: "android", emailConnected: false, connectedEmail: null, emailProvider: null,
      hasPermissions: true, hasSecureStorage: true, driverSetupComplete: true, termsAccepted: true,
      authProvider: "google", isNewUser: false, isDatabaseInitialized: true, userId: USER.id,
      isUserVerifiedInLocalDb: true, emailSkipped: false, driverSkipped: false,
      isResumedFromFdaRelaunch: false,
    } as OnboardingAppState;
    const walk = (ids: readonly string[] | undefined) => {
      const visited: string[] = [];
      const { result, unmount } = renderHook(() =>
        actual.useOnboardingQueue({ appState, onAction: jest.fn(), onComplete: jest.fn(), initialManuallyCompletedIds: ids }),
      );
      for (let i = 0; i < 6 && result.current.activeStep && !result.current.isComplete; i++) {
        visited.push(result.current.activeStep.meta.id);
        act(() => { result.current.goToNext(); });
      }
      unmount();
      return visited;
    };

    // ANTI-VACUITY: unseeded, the same queue DOES ask the contacts question.
    expect(walk(undefined)).toContain("contact-source");

    const visited = walk(seed);
    expect(visited).not.toContain("contact-source");
    expect(visited).not.toContain("email-connect");
    expect(visited).not.toContain("data-sync");
  });
});
