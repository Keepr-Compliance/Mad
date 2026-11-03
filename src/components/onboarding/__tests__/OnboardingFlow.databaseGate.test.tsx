/**
 * BACKLOG-3321 C5 + R3 -- OnboardingFlow reads the database state the machine
 * RECORDED, and nothing else.
 *
 * Once the machine records the open (DB_INIT_COMPLETE success), the onboarding
 * context must say the database is open and the secure-storage spinner must stop,
 * with no init-stage event from main. The "no event" case is the one that matters:
 * main sends no new `complete` broadcast when the database was already open, and a
 * subscriber can miss one.
 *
 * Unlike the other OnboardingFlow suites (selector mocked to `() => true`), the
 * selector here is MUTABLE, so a gate that holds the context false after the
 * machine says true is visible.
 *
 * Harness copied from OnboardingFlow.resumeMarker.test.tsx.
 * window.api.system shapes: getInitStage -> { stage } (initializationBroadcaster.ts);
 * onInitStage -> unsubscribe fn, and it never fires (the "missed complete" case).
 */
import React from "react";
import { render, act } from "@testing-library/react";
import { OnboardingFlow } from "../OnboardingFlow";
import type { AppStateMachine } from "../../../appCore/state/types";

let dbOpen = false;

jest.mock("../../../contexts/PlatformContext", () => ({
  usePlatform: () => ({ isWindows: false, isMacOS: true, isLinux: false, platform: "macos" }),
}));
jest.mock("../../../appCore/state/machine/selectors", () => ({
  selectPhoneType: () => "iphone",
  selectHasEmailConnectedNullable: () => true,
  selectHasPermissionsNullable: () => false,
  selectIsDatabaseInitialized: () => dbOpen,
}));
jest.mock("../../../appCore/state/machine/debug", () => ({
  logAllFlags: jest.fn(),
  logStateChange: jest.fn(),
}));
jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock("../sentryOnboarding", () => ({ reportDriverStillMissingAtCompletion: jest.fn() }));
jest.mock("../shell/OnboardingShell", () => ({
  OnboardingShell: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock("../shell/ProgressIndicator", () => ({ ProgressIndicator: () => null }));
jest.mock("../shell/NavigationButtons", () => ({ NavigationButtons: () => null }));

// The secure-storage step, reduced to what OnboardingFlow passes it.
let lastIsLoading: boolean | undefined;
const secureStorageStep = {
  meta: { id: "secure-storage", navigation: {} },
  Content: ({ isLoading }: { isLoading?: boolean }) => {
    lastIsLoading = isLoading;
    return null;
  },
};

type Opts = {
  appState: { isDatabaseInitialized: boolean };
  onAction: (a: { type: string }) => void;
};
let last: Opts | null = null;
jest.mock("../queue/useOnboardingQueue", () => ({
  useOnboardingQueue: (opts: Opts) => {
    last = opts;
    const entry = { step: secureStorageStep };
    return {
      visibleEntries: [entry],
      activeEntry: entry,
      activeStep: secureStorageStep,
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
jest.mock("../../../appCore/state/machine", () => ({
  useOptionalMachineState: () => ({
    state: { status: "onboarding", user: { id: "u1", email: "user@example.com" } },
    dispatch: jest.fn(),
  }),
}));

const app = {
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
  isNewUserFlow: false,
  isDatabaseInitialized: false,
  handleKeychainExplanationContinue: jest.fn().mockResolvedValue(undefined),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any as AppStateMachine;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((res) => setTimeout(res, 20));
  });
}

beforeEach(() => {
  dbOpen = false;
  last = null;
  lastIsLoading = undefined;
  (app.handleKeychainExplanationContinue as jest.Mock).mockClear();
  (window as unknown as { api: unknown }).api = {
    system: {
      consumeOnboardingResumeMarker: jest.fn().mockResolvedValue({ resumeStep: null }),
      getInitStage: jest.fn().mockResolvedValue({ stage: "idle" }),
      onInitStage: jest.fn().mockReturnValue(jest.fn()),
    },
    user: { getPhoneTypeCloud: jest.fn().mockResolvedValue({ success: true }) },
    preferences: { get: jest.fn().mockResolvedValue({ success: true, preferences: {} }) },
  };
});

describe("BACKLOG-3321 OnboardingFlow database gate", () => {
  it("C5/R3: machine records the open -> context reads open and the spinner stops, no init-stage event", async () => {
    const r = render(<OnboardingFlow app={app} />);
    await settle();

    // Before Continue: closed, no spinner.
    expect(last).not.toBeNull();
    expect(last!.appState.isDatabaseInitialized).toBe(false);
    expect(lastIsLoading).toBe(false);

    // Continue on secure-storage while the database is closed: the spinner shows.
    await act(async () => {
      last!.onAction({ type: "SECURE_STORAGE_SETUP" });
    });
    await settle();
    expect(app.handleKeychainExplanationContinue).toHaveBeenCalledTimes(1);
    expect(last!.appState.isDatabaseInitialized).toBe(false);
    expect(lastIsLoading).toBe(true);

    // The machine recorded DB_INIT_COMPLETE(success). No init-stage event fires.
    dbOpen = true;
    r.rerender(<OnboardingFlow app={{ ...app }} />);
    await settle();

    expect(last!.appState.isDatabaseInitialized).toBe(true);
    expect(lastIsLoading).toBe(false);
  });

  it("Continue with the database already recorded open shows no spinner", async () => {
    dbOpen = true;
    render(<OnboardingFlow app={app} />);
    await settle();

    await act(async () => {
      last!.onAction({ type: "SECURE_STORAGE_SETUP" });
    });
    await settle();

    expect(app.handleKeychainExplanationContinue).toHaveBeenCalledTimes(1);
    expect(last!.appState.isDatabaseInitialized).toBe(true);
    expect(lastIsLoading).toBe(false);
  });
});
