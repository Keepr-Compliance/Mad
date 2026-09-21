/**
 * BACKLOG-3418 — when iPhone device detection may run.
 *
 * Founder decision 2026-09-21 (pm_comments f59ce258):
 *   1. Keep the iPhone default for signed-in non-Android Windows users, so
 *      nobody signed in loses auto-detect.
 *   2. No detection before a user and their preferences are loaded, on every
 *      platform. The login screen used to run the Windows device poll, because
 *      the resolver returned `true` for any non-macOS platform while the source
 *      was unknown.
 *   3. When onboarding records the phone type as Android, detection stops at
 *      once, without a restart. Before, the provider re-read the source only
 *      when `[userId, platform]` changed, so an Android user ran the poll for
 *      their whole first session.
 *
 * Everything here is real except the IPC and the onboarding machinery around
 * the one handler under test: the real provider, the real `useIPhoneSync`, the
 * real `settingsService`, the real `OnboardingFlow`. `window.api` is the seam,
 * as in iphoneSyncSourceGate-3423.test.tsx, whose `installSyncApi` this copies.
 *
 * Fixture provenance (transcribed from the producers, not invented):
 *   - `preferences.get` -> `{ success: true, preferences }`, and `{}` for a user
 *     with nothing stored (electron/handlers/preferenceHandlers.ts, the
 *     `preferences:get` handler: `getPreferences(...) ?? {}`).
 *   - `user.getPhoneType` -> `{ success: true, phoneType: "iphone" | "android" | null }`,
 *     `null` before the onboarding answer is stored
 *     (electron/handlers/userSettingsHandlers.ts, `user:get-phone-type`).
 *   - `SELECT_PHONE` is the action PhoneTypeStep emits
 *     (src/components/onboarding/steps/PhoneTypeStep.tsx) and the onboarding
 *     queue forwards to OnboardingFlow's handler (queue/useOnboardingQueue.ts).
 */

import React from "react";
import { render, act, waitFor } from "@testing-library/react";
import { IPhoneSyncProvider } from "../IPhoneSyncContext";
import { OnboardingFlow } from "../../components/onboarding/OnboardingFlow";
import type { AppStateMachine } from "../../appCore/state/types";
import type { StepAction } from "../../components/onboarding/types";
import type { Platform } from "../../utils/platform";

jest.mock("../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

let currentPlatform: Platform = "windows";
jest.mock("../PlatformContext", () => ({
  usePlatform: () => ({
    platform: currentPlatform,
    isMacOS: currentPlatform === "macos",
    isWindows: currentPlatform === "windows",
    isLinux: currentPlatform === "linux",
    isElectron: true,
    isFeatureAvailable: () => false,
  }),
}));

// --- OnboardingFlow's surroundings, mocked as in
// components/onboarding/__tests__/OnboardingFlow.driverCompletion.test.tsx.
// The handler under test (OnboardingFlow's `handleAction`) is real; the queue
// mock only captures it so the test can deliver the step's action.
jest.mock("../../appCore/state/machine", () => ({
  useOptionalMachineState: () => ({
    state: { status: "onboarding" },
    dispatch: jest.fn(),
  }),
}));
jest.mock("../../appCore/state/machine/selectors", () => ({
  selectPhoneType: () => null,
  selectHasEmailConnectedNullable: () => null,
  selectHasPermissionsNullable: () => null,
  selectIsDatabaseInitialized: () => true,
}));
jest.mock("../../appCore/state/machine/debug", () => ({
  logAllFlags: jest.fn(),
  logStateChange: jest.fn(),
}));
let deliverStepAction: ((action: StepAction) => void) | null = null;
jest.mock("../../components/onboarding/queue/useOnboardingQueue", () => ({
  useOnboardingQueue: (opts: { onAction?: (action: StepAction) => void }) => {
    deliverStepAction = opts.onAction ?? null;
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
jest.mock("../../components/onboarding/shell/OnboardingShell", () => ({
  OnboardingShell: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock("../../components/onboarding/shell/ProgressIndicator", () => ({
  ProgressIndicator: () => null,
}));
jest.mock("../../components/onboarding/shell/NavigationButtons", () => ({
  NavigationButtons: () => null,
}));
jest.mock("../../components/onboarding/sentryOnboarding", () => ({
  reportDriverStillMissingAtCompletion: jest.fn(),
}));

/** The preload's `window.api.sync` surface that `useIPhoneSync` consumes. */
function installSyncApi() {
  const listen = () => jest.fn(() => jest.fn());
  const api = (window as unknown as { api: Record<string, unknown> }).api;
  api.sync = {
    startDetection: jest.fn(),
    stopDetection: jest.fn(),
    start: jest.fn().mockResolvedValue({ success: true }),
    cancel: jest.fn().mockResolvedValue(undefined),
    getUnifiedStatus: jest
      .fn()
      .mockResolvedValue({ isAnyOperationRunning: false, currentOperation: null }),
    onDeviceConnected: listen(),
    onDeviceDisconnected: listen(),
    onProgress: listen(),
    onPasswordRequired: listen(),
    onError: listen(),
    onComplete: listen(),
    onWaitingForPasscode: listen(),
    onPasscodeEntered: listen(),
    onStorageComplete: listen(),
    onStorageError: listen(),
  };
}

type SyncApiMock = { startDetection: jest.Mock; stopDetection: jest.Mock };
const syncApi = (): SyncApiMock =>
  (window as unknown as { api: { sync: SyncApiMock } }).api.sync;

type WindowApi = {
  preferences: { get: jest.Mock; update: jest.Mock };
  user: { getPhoneType: jest.Mock };
};
const api = (): WindowApi => (window as unknown as { api: WindowApi }).api;

/** A new user: nothing stored, phone type not answered yet. */
function serveNewUser() {
  api().preferences.get.mockResolvedValue({ success: true, preferences: {} });
  api().preferences.update.mockResolvedValue({ success: true });
  api().user.getPhoneType.mockResolvedValue({ success: true, phoneType: null });
}

/** Hold the preference read open until the test releases it. */
function holdPreferenceRead() {
  let release: (value: unknown) => void = () => undefined;
  api().preferences.get.mockReturnValue(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  return () => release({ success: true, preferences: {} });
}

const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });

const renderProvider = (userId: string | null) =>
  render(
    <React.StrictMode>
      <IPhoneSyncProvider userId={userId}>
        <div />
      </IPhoneSyncProvider>
    </React.StrictMode>,
  );

function makeApp(): AppStateMachine {
  return {
    selectedPhoneType: null,
    hasEmailConnected: null,
    currentUser: { id: "user-3418", email: "user@example.com" },
    pendingOnboardingData: null,
    hasPermissions: null,
    hasSecureStorageSetup: true,
    needsDriverSetup: false,
    needsTermsAcceptance: false,
    pendingOAuthData: null,
    authProvider: "google",
    isNewUserFlow: true,
    isDatabaseInitialized: true,
    handleSelectIPhone: jest.fn().mockResolvedValue(undefined),
    handleSelectAndroid: jest.fn().mockResolvedValue(undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const renderOnboarding = (app: AppStateMachine) =>
  render(
    <IPhoneSyncProvider userId="user-3418">
      <OnboardingFlow app={app} />
    </IPhoneSyncProvider>,
  );

async function answerPhoneType(phoneType: "iphone" | "android") {
  expect(deliverStepAction).toBeInstanceOf(Function);
  await act(async () => {
    deliverStepAction!({ type: "SELECT_PHONE", payload: { phoneType } });
    await Promise.resolve();
  });
}

describe("BACKLOG-3418: no iPhone detection before sign-in; stop it when onboarding records Android", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    currentPlatform = "windows";
    deliverStepAction = null;
    installSyncApi();
    serveNewUser();
  });

  describe("signed out (the login screen)", () => {
    it.each(["windows", "linux", "macos"] as const)(
      "%s: starts no device detection",
      async (platform) => {
        currentPlatform = platform;
        renderProvider(null);
        await settle();

        expect(syncApi().startDetection).not.toHaveBeenCalled();
        // Signed out there is no user to read preferences for.
        expect(api().preferences.get).not.toHaveBeenCalled();
      },
    );
  });

  describe("signed in on Windows (nobody signed in loses auto-detect)", () => {
    it("a new user — nothing stored, phone type not Android — gets detection once preferences are read", async () => {
      renderProvider("user-3418");
      await settle();

      expect(api().preferences.get).toHaveBeenCalledWith("user-3418");
      expect(syncApi().startDetection).toHaveBeenCalled();
    });

    it("a user who answered iPhone (phone type stored, no source) gets detection", async () => {
      api().user.getPhoneType.mockResolvedValue({ success: true, phoneType: "iphone" });
      renderProvider("user-3418");
      await settle();

      expect(syncApi().startDetection).toHaveBeenCalled();
    });

    it("starts nothing while the preference read is in flight, and starts once it lands", async () => {
      const releasePreferences = holdPreferenceRead();
      renderProvider("user-3418");
      await settle();

      // Signed in, but preferences not loaded: still no detection. This is the
      // state a gate on `userId` alone would get wrong.
      expect(api().preferences.get).toHaveBeenCalled();
      expect(syncApi().startDetection).not.toHaveBeenCalled();

      await act(async () => {
        releasePreferences();
      });
      await waitFor(() => expect(syncApi().startDetection).toHaveBeenCalled());
    });
  });

  describe("onboarding phone-type answer re-gates live, without a restart", () => {
    it("Android stops detection at once; going back and answering iPhone starts it again", async () => {
      const app = makeApp();
      renderOnboarding(app);
      await settle();

      // Before the answer the new Windows user gets the iPhone default.
      expect(syncApi().startDetection).toHaveBeenCalledTimes(1);
      const stopsBeforeAnswer = syncApi().stopDetection.mock.calls.length;

      await answerPhoneType("android");

      expect(app.handleSelectAndroid).toHaveBeenCalledTimes(1);
      expect(syncApi().stopDetection.mock.calls.length).toBe(stopsBeforeAnswer + 1);

      // Nothing restarts it while the Android answer stands.
      await settle();
      expect(syncApi().startDetection).toHaveBeenCalledTimes(1);

      await answerPhoneType("iphone");

      expect(app.handleSelectIPhone).toHaveBeenCalledTimes(1);
      expect(syncApi().startDetection).toHaveBeenCalledTimes(2);
    });

    it("an Android answer given while the preference read is in flight is not undone when the read lands", async () => {
      const releasePreferences = holdPreferenceRead();
      renderOnboarding(makeApp());
      await settle();
      expect(syncApi().startDetection).not.toHaveBeenCalled();

      await answerPhoneType("android");

      // The read started before the answer, so it knows nothing of it and
      // derives the pre-answer default (`iphone-sync` on Windows).
      await act(async () => {
        releasePreferences();
      });
      await settle();

      expect(syncApi().startDetection).not.toHaveBeenCalled();
    });
  });
});
