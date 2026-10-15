/**
 * BACKLOG-3418 — when iPhone device detection may run.
 *
 * Founder decision 2026-09-21 (pm_comments f59ce258):
 *   1. SUPERSEDED 2026-10-07 (pm_comments 1d7ab5ff; Q1 answered "a",
 *      3df4e6f6): a signed-in Windows user gets detection only after choosing
 *      iPhone (a stored iPhone source, or an iPhone phone type with no source
 *      stored) — the macOS opt-in. A user who chose nothing gets none. The
 *      three tests that encoded the old default are rewritten below and say so;
 *      the full set of controls is iphoneSyncChosenSource-3418.test.tsx.
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
 *   - A user who turned the Settings "iPhone Sync (USB)" toggle ON:
 *     `preferences.get` -> `{ success: true, preferences: { messages: { source:
 *     "iphone-sync" }, integrations: { iphoneSyncEnabled: true } } }`. The toggle
 *     (settings/IphoneSyncSettings.tsx, mounted by Settings.tsx and enabled only
 *     while the source is `iphone-sync`) calls the provider's
 *     `setIphoneSyncEnabled`, which writes `{ integrations: { iphoneSyncEnabled } }`
 *     (settingsService.ts `setIphoneSyncEnabled`). The onboarding save writes
 *     `{ messages: { source } }` (usePhoneTypeApi.ts). `preferences:update`
 *     deep-merges each write into the stored object (`deepMerge`,
 *     preferenceHandlers.ts), so `preferences:get` returns both keys together.
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

/** Hold the preference read open until the test releases it with `preferences`. */
function holdPreferenceRead(preferences: Record<string, unknown> = {}) {
  let release: (value: unknown) => void = () => undefined;
  api().preferences.get.mockReturnValue(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  return () => release({ success: true, preferences });
}

/** Let every queued microtask run (a macrotask cannot start before they finish). */
const drain = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

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

  describe("signed in on Windows (only a user who chose iPhone gets detection)", () => {
    // Rewritten for the 2026-10-07 rule (3df4e6f6): this test used to assert
    // that a new user with nothing chosen GETS detection.
    it("a new user — nothing stored, no phone type — gets NO detection once preferences are read", async () => {
      renderProvider("user-3418");
      // Barrier: the read has gone all the way to the phone-type fallback.
      await waitFor(() => expect(api().user.getPhoneType).toHaveBeenCalledWith("user-3418"));
      await drain();
      await drain();

      expect(api().preferences.get).toHaveBeenCalledWith("user-3418");
      expect(syncApi().startDetection).not.toHaveBeenCalled();
    });

    it("a user who answered iPhone (phone type stored, no source) gets detection", async () => {
      api().user.getPhoneType.mockResolvedValue({ success: true, phoneType: "iphone" });
      renderProvider("user-3418");
      await settle();

      expect(syncApi().startDetection).toHaveBeenCalled();
    });

    // Rewritten for the 2026-10-07 rule (3df4e6f6): the read now lands with
    // an iPhone source, since a user who chose nothing would never start.
    it("starts nothing while the preference read is in flight, and starts once an iPhone source lands", async () => {
      const releasePreferences = holdPreferenceRead({ messages: { source: "iphone-sync" } });
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

  describe("signing out (back to the login screen)", () => {
    // How sign-out reaches the provider, transcribed from the app:
    //   - App.tsx:49 renders `<IPhoneSyncProvider userId={app.currentUser?.id ?? null}>`.
    //   - AuthContext.tsx `logout()` sets `{ ...defaultAuthState }`, so
    //     `currentUser` becomes null and the provider's `userId` becomes null.
    //   - LicenseGate.tsx returns `<>{children}</>` once the license has
    //     initialised, so the provider is NOT unmounted: the same instance
    //     sees its `userId` prop change. An unmount would stop detection in
    //     the hook's cleanup whatever the provider does, so this test
    //     re-renders the same tree instead.
    const signedInTree = (userId: string | null) => (
      <React.StrictMode>
        <IPhoneSyncProvider userId={userId}>
          <div />
        </IPhoneSyncProvider>
      </React.StrictMode>
    );

    it("a Windows iPhone user who signs out has detection stopped, and it does not start again while signed out", async () => {
      // A signed-in user whose stored source is iPhone (the onboarding save
      // writes `{ messages: { source } }`, usePhoneTypeApi.ts).
      api().preferences.get.mockResolvedValue({
        success: true,
        preferences: { messages: { source: "iphone-sync" } },
      });
      const { rerender } = render(signedInTree("user-3418"));
      await settle();

      expect(syncApi().startDetection).toHaveBeenCalledTimes(1);
      const stopsBeforeSignOut = syncApi().stopDetection.mock.calls.length;
      const readsBeforeSignOut = api().preferences.get.mock.calls.length;

      rerender(signedInTree(null));
      await settle();

      expect(syncApi().stopDetection.mock.calls.length).toBe(stopsBeforeSignOut + 1);
      expect(syncApi().startDetection).toHaveBeenCalledTimes(1);
      // Signed out there is no user to read preferences for.
      expect(api().preferences.get.mock.calls.length).toBe(readsBeforeSignOut);

      // Still signed out: nothing starts it again.
      await settle();
      expect(syncApi().startDetection).toHaveBeenCalledTimes(1);
    });

    // The explicit toggle is resolver rule 2 ("an explicit preference wins").
    // Rule 1 only switches off a KNOWN non-iPhone source, and the signed-out
    // source is unknown (`null`), so a stored `true` that survived sign-out
    // would keep detection running on the login screen — on macOS too. The
    // source must be `iphone-sync` in the fixture: on macOS a missing source
    // derives `macos-native`, and rule 1 would switch detection off before the
    // preference is ever consulted.
    it.each(["windows", "macos"] as const)(
      "%s: a user who turned the iPhone Sync (USB) toggle ON has detection stopped at sign-out, and it does not start again while signed out",
      async (platform) => {
        currentPlatform = platform;
        api().preferences.get.mockResolvedValue({
          success: true,
          preferences: {
            messages: { source: "iphone-sync" },
            integrations: { iphoneSyncEnabled: true },
          },
        });
        const { rerender } = render(signedInTree("user-3418"));
        await settle();

        expect(syncApi().startDetection).toHaveBeenCalledTimes(1);
        // The stored source was used as-is; the phone-type fallback never ran.
        expect(api().user.getPhoneType).not.toHaveBeenCalled();
        const stopsBeforeSignOut = syncApi().stopDetection.mock.calls.length;
        const readsBeforeSignOut = api().preferences.get.mock.calls.length;

        rerender(signedInTree(null));
        await settle();

        expect(syncApi().stopDetection.mock.calls.length).toBe(stopsBeforeSignOut + 1);
        expect(syncApi().startDetection).toHaveBeenCalledTimes(1);
        expect(api().preferences.get.mock.calls.length).toBe(readsBeforeSignOut);

        // Still signed out: the stored `true` does not start it again.
        await settle();
        expect(syncApi().startDetection).toHaveBeenCalledTimes(1);
      },
    );
  });

  describe("onboarding phone-type answer re-gates live, without a restart", () => {
    // Rewritten for the 2026-10-07 rule (3df4e6f6): before any answer a new
    // Windows user now has NO detection (it used to start on the iPhone default).
    it("nothing before the answer; iPhone starts detection; Android stops it at once; iPhone again restarts it", async () => {
      const app = makeApp();
      renderOnboarding(app);
      await waitFor(() => expect(api().user.getPhoneType).toHaveBeenCalled());
      await drain();
      await drain();

      // Before the answer: nothing chosen, nothing running.
      expect(syncApi().startDetection).not.toHaveBeenCalled();

      await answerPhoneType("iphone");

      expect(app.handleSelectIPhone).toHaveBeenCalledTimes(1);
      expect(syncApi().startDetection).toHaveBeenCalledTimes(1);
      const stopsBeforeAndroid = syncApi().stopDetection.mock.calls.length;

      await answerPhoneType("android");

      expect(app.handleSelectAndroid).toHaveBeenCalledTimes(1);
      expect(syncApi().stopDetection.mock.calls.length).toBe(stopsBeforeAndroid + 1);

      // Nothing restarts it while the Android answer stands.
      await settle();
      expect(syncApi().startDetection).toHaveBeenCalledTimes(1);

      await answerPhoneType("iphone");

      expect(app.handleSelectIPhone).toHaveBeenCalledTimes(2);
      expect(syncApi().startDetection).toHaveBeenCalledTimes(2);
    });

    it("an Android answer given while the preference read is in flight is not undone when the read lands", async () => {
      // The read lands with an iPhone phone type in the cloud preferences, so
      // on its own it WOULD start detection (BACKLOG-3418: an iPhone phone type
      // with no source stored is an iPhone choice) — only the in-flight guard
      // keeps the newer Android answer.
      const releasePreferences = holdPreferenceRead({ phone_type: "iphone" });
      renderOnboarding(makeApp());
      await settle();
      expect(syncApi().startDetection).not.toHaveBeenCalled();

      await answerPhoneType("android");

      // The read started before the answer, so it knows nothing of it and
      // derives the pre-answer source (`iphone-sync` from the phone type).
      await act(async () => {
        releasePreferences();
      });
      await waitFor(() => expect(api().user.getPhoneType).toHaveBeenCalled());
      await drain();
      await drain();

      expect(syncApi().startDetection).not.toHaveBeenCalled();
    });
  });
});
