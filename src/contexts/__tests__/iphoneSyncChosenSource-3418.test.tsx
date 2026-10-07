/**
 * BACKLOG-3418 — Windows/Linux iPhone detection is OFF unless the user picked
 * iPhone (founder 2026-10-07: "same opt-in rule as macOS"; Q1 = (a), pm_comments
 * 3df4e6f6, replaces the 2026-10-02 "only while the Sync iPhone window is open").
 *
 * The 8 controls from the Step 0 checkpoint (pm_comments 859445f9 §7), shipped as
 * tests per the SR plan ruling (3433cf56), with its conditions applied:
 *   - C-3: a negative ("never started") is only meaningful once the preference
 *     read has COMPLETED. The reads are served from deferreds the test resolves;
 *     the test awaits them, then drains every pending microtask with a macrotask
 *     (`drain`) before asserting — and asserts the effective `enabled` too.
 *   - C-4: C5a uses the reachable shape (stored iPhone source, toggle turned off
 *     by the user, then turned back on). With nothing chosen the toggle is
 *     disabled in Settings, so the old `{}` fixture could not happen.
 *
 * Load-bearing (each the sole red for one wrong build, 859445f9 §7):
 *   C2b <- M3 (local phone type only, cloud ignored)
 *   C3  <- M2 (OR-gate: an iPhone phone type forces iphone-sync)
 *   C5a <- M4 (Settings toggle persists but does not re-gate live)
 *   C6  <- M6 (any truthy stored source counts)
 *
 * Real provider + real `useIPhoneSync` + real settingsService; `window.api` is the
 * only seam. Fixture shapes are transcribed from the producers:
 *   - `preferences:get` -> `{ success: true, preferences }`
 *     (electron/handlers/preferenceHandlers.ts; `preferences` is the Supabase
 *     `user_preferences.preferences` jsonb, which carries `phone_type`,
 *     `messages.source` and `integrations.iphoneSyncEnabled`).
 *   - `user:get-phone-type` -> `{ success: true, phoneType }`
 *     (electron/handlers/userSettingsHandlers.ts; `users_local.mobile_phone_type`,
 *     `null` until recorded on this machine).
 * "Running" = the last startDetection came after the last stopDetection.
 */

import React, { useEffect } from "react";
import { render, act, waitFor } from "@testing-library/react";
import { IPhoneSyncProvider, useIPhoneSyncEnabled } from "../IPhoneSyncContext";
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

type W = {
  api: {
    sync: { startDetection: jest.Mock; stopDetection: jest.Mock };
    preferences: { get: jest.Mock; update: jest.Mock };
    user: { getPhoneType: jest.Mock };
  };
};
const w = () => window as unknown as W;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Serve the two reads from deferreds the test releases (C-3). Returns a
 * `release()` that resolves both and awaits them, then drains.
 */
function serve(preferences: Record<string, unknown>, phoneType: "iphone" | "android" | null) {
  const prefs = deferred<unknown>();
  const phone = deferred<unknown>();
  w().api.preferences.get.mockReturnValue(prefs.promise);
  w().api.preferences.update.mockResolvedValue({ success: true });
  w().api.user.getPhoneType.mockReturnValue(phone.promise);
  return async () => {
    await act(async () => {
      prefs.resolve({ success: true, preferences });
      phone.resolve({ success: true, phoneType });
      await prefs.promise;
      await phone.promise;
    });
    await drain();
  };
}

/** Let every queued microtask run (a macrotask cannot start before they finish). */
async function drain() {
  for (let i = 0; i < 2; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

let handle: ReturnType<typeof useIPhoneSyncEnabled> | null = null;
function Grab() {
  const ctx = useIPhoneSyncEnabled();
  useEffect(() => {
    handle = ctx;
  });
  return null;
}

function running(): boolean {
  const st = w().api.sync.startDetection.mock.invocationCallOrder;
  const sp = w().api.sync.stopDetection.mock.invocationCallOrder;
  const lastStart = st.length ? Math.max(...st) : -1;
  const lastStop = sp.length ? Math.max(...sp) : -1;
  return lastStart > lastStop;
}

async function mount(release: () => Promise<void>) {
  render(
    <React.StrictMode>
      <IPhoneSyncProvider userId="user-3418">
        <Grab />
      </IPhoneSyncProvider>
    </React.StrictMode>,
  );
  await waitFor(() => expect(w().api.preferences.get).toHaveBeenCalledWith("user-3418"));
  await release();
}

/** Negative: the read has completed (C-3) and detection never started. */
function expectNeverStarted() {
  expect(handle).not.toBeNull();
  expect(handle!.enabled).toBe(false);
  expect(w().api.sync.startDetection).not.toHaveBeenCalled();
}

describe("BACKLOG-3418: iPhone detection only for a user who chose iPhone (Windows)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    currentPlatform = "windows";
    installSyncApi();
    handle = null;
  });

  it("C1 signed in, nothing stored, no phone type -> never started", async () => {
    await mount(serve({}, null));
    expectNeverStarted();
    // The phone-type fallback was consulted — the "no" is an answer, not a skip.
    expect(w().api.user.getPhoneType).toHaveBeenCalledWith("user-3418");
  });

  it("C2 nothing stored, local phone type iphone -> running", async () => {
    await mount(serve({}, "iphone"));
    await waitFor(() => expect(running()).toBe(true));
    expect(handle!.enabled).toBe(true);
  });

  it("C2b cloud phone_type iphone, local phone type not recovered yet (null) -> running", async () => {
    await mount(serve({ phone_type: "iphone" }, null));
    await waitFor(() => expect(running()).toBe(true));
  });

  it("C3 Store reviewer shape: phone type iphone, stored source android-messages-web -> never started", async () => {
    await mount(
      serve({ phone_type: "iphone", messages: { source: "android-messages-web" } }, "iphone"),
    );
    expectNeverStarted();
  });

  it("C4 legacy: stored toggle true, no source, no phone type -> running (explicit pref wins)", async () => {
    await mount(serve({ integrations: { iphoneSyncEnabled: true } }, null));
    await waitFor(() => expect(running()).toBe(true));
  });

  it("C5a stored iPhone source with the toggle turned off, then turned ON -> starts live", async () => {
    await mount(
      serve(
        { messages: { source: "iphone-sync" }, integrations: { iphoneSyncEnabled: false } },
        "iphone",
      ),
    );
    expectNeverStarted();

    await act(async () => {
      await handle!.setIphoneSyncEnabled(true);
    });
    await waitFor(() => expect(running()).toBe(true));
  });

  it("C5b stored iphone-sync, then the Settings radio to Google Messages -> stops live", async () => {
    await mount(serve({ messages: { source: "iphone-sync" } }, "iphone"));
    await waitFor(() => expect(running()).toBe(true));

    await act(async () => {
      handle!.applyImportSource("android-messages-web");
    });
    await waitFor(() => expect(running()).toBe(false));
  });

  it("C6 a stored source this build does not know, no phone type -> never started", async () => {
    await mount(serve({ messages: { source: "some-future-source" } }, null));
    expectNeverStarted();
  });

  it("an Android phone type with nothing stored -> never started", async () => {
    await mount(serve({}, "android"));
    expectNeverStarted();
  });
});

describe("BACKLOG-3418: macOS is unchanged", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    currentPlatform = "macos";
    installSyncApi();
    handle = null;
  });

  it("nothing stored (even with an iPhone phone type) -> macos-native -> never started", async () => {
    await mount(serve({ phone_type: "iphone" }, "iphone"));
    expectNeverStarted();
  });

  it("stored iphone-sync -> running", async () => {
    await mount(serve({ messages: { source: "iphone-sync" } }, "iphone"));
    await waitFor(() => expect(running()).toBe(true));
  });
});
