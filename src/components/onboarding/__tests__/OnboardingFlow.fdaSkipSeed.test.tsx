/**
 * BACKLOG-3212 — OnboardingFlow seeds `permissions` as already-answered when
 * the user declined Full Disk Access in an earlier session.
 *
 * The reducer keeps such a user out of onboarding entirely when they have a
 * mailbox (reducer.fdaSkip.test.ts). This file covers the case where they DO
 * legitimately re-enter onboarding — no mailbox connected yet, so the
 * BACKLOG-1821 data-source floor still has to adjudicate — and asserts they
 * are not asked for Full Disk Access again on the way through.
 *
 * The gate this corrects: `initialManuallyCompletedIds` used to return early
 * on `!resumeBundle.isResuming`, so the seed only ever applied on the launch
 * immediately after the FDA-grant relaunch. A launch with no resume marker is
 * exactly when a persisted skip has to be honoured, so `permissions` is now
 * seeded independently of that gate — it reads the flag off the state machine,
 * which resolved it in Phase 4.
 *
 * Harness mirrors OnboardingFlow.resumeMarker.test.tsx (same mocks, same
 * capture of the options handed to useOnboardingQueue).
 *
 * @module onboarding/__tests__/OnboardingFlow.fdaSkipSeed.test
 */

import React from "react";
import { render, waitFor } from "@testing-library/react";
import { OnboardingFlow } from "../OnboardingFlow";
import type { AppStateMachine } from "../../../appCore/state/types";
import type { FdaState } from "../../../appCore/state/machine/fdaState";

jest.mock("../../../contexts/PlatformContext", () => ({
  usePlatform: () => ({ isWindows: false, isMacOS: true, isLinux: false, platform: "macos" }),
}));

jest.mock("../../../appCore/state/machine/selectors", () => ({
  selectPhoneType: () => "iphone",
  selectHasEmailConnectedNullable: () => false,
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

/**
 * The value USER_DATA_LOADED put on onboarding state. `undefined` means the
 * Full Disk Access state was never established (the pre-BACKLOG-3212 shape);
 * BACKLOG-3275 replaced the `fdaSkipped` boolean with this named state.
 */
let machineFda: FdaState | undefined;

jest.mock("../../../appCore/state/machine", () => ({
  useOptionalMachineState: () => ({
    state: {
      status: "onboarding" as const,
      user: { id: "u1", email: "user@example.com" },
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      fda: machineFda,
    },
    dispatch: mockDispatch,
  }),
}));

function makeApp(): AppStateMachine {
  return {
    selectedPhoneType: "iphone",
    hasEmailConnected: false,
    currentUser: { id: "u1", email: "user@example.com" },
    pendingOnboardingData: null,
    hasPermissions: false,
    hasSecureStorageSetup: true,
    needsDriverSetup: false,
    needsTermsAcceptance: false,
    pendingOAuthData: null,
    authProvider: "google",
    isNewUserFlow: false,
    isDatabaseInitialized: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function installWindowApi(resumeStep: "permissions" | null) {
  (window as unknown as { api: unknown }).api = {
    system: {
      consumeOnboardingResumeMarker: jest.fn().mockResolvedValue({ resumeStep }),
    },
    user: {
      getPhoneTypeCloud: jest.fn().mockResolvedValue({ success: true, phoneType: "iphone" }),
    },
    preferences: {
      get: jest.fn().mockResolvedValue({ success: true, preferences: {} }),
    },
  };
}

async function renderAndCapture() {
  render(<OnboardingFlow app={makeApp()} />);
  await waitFor(() => {
    expect(capturedQueueOptions).not.toBeNull();
  });
  return capturedQueueOptions!.initialManuallyCompletedIds;
}

describe("OnboardingFlow — seeding `permissions` from a persisted skip (BACKLOG-3212)", () => {
  beforeEach(() => {
    capturedQueueOptions = null;
    mockDispatch.mockClear();
    machineFda = undefined;
  });

  it("seeds `permissions` on a NORMAL launch (no resume marker) when the skip is on record", async () => {
    // The whole point: this is the launch the old `isResuming` gate excluded.
    machineFda = "declined";
    installWindowApi(null);

    const seeded = await renderAndCapture();

    expect(seeded).toEqual(["permissions"]);
  });

  it("CONTROL: seeds NOTHING on a normal launch when no skip is on record", async () => {
    // Same launch, same everything, flag absent. If this ever starts seeding,
    // the app has quietly stopped asking anyone for Full Disk Access.
    machineFda = undefined;
    installWindowApi(null);

    const seeded = await renderAndCapture();

    expect(seeded).toBeUndefined();
  });

  it("CONTROL: an explicit false is not treated as a skip", async () => {
    machineFda = "not-asked";
    installWindowApi(null);

    const seeded = await renderAndCapture();

    expect(seeded).toBeUndefined();
  });

  it("adds `permissions` alongside the BACKLOG-1842 resume seeds when both apply", async () => {
    // Resuming from the FDA-grant relaunch AND carrying an older skip: the
    // 1842 seeds must survive, not be replaced.
    machineFda = "declined";
    installWindowApi("permissions");

    const seeded = await renderAndCapture();

    expect(seeded).toEqual(expect.arrayContaining(["data-sync", "permissions"]));
  });

  it("leaves the resuming-without-a-skip seed exactly as BACKLOG-1842 left it", async () => {
    machineFda = undefined;
    installWindowApi("permissions");

    const seeded = await renderAndCapture();

    expect(seeded).toEqual(["data-sync"]);
    expect(seeded).not.toContain("permissions");
  });
});
