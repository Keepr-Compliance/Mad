/**
 * BACKLOG-2893 (founder rule, 2026-11-04, inherited from BACKLOG-2890): a failed
 * or non-success preferences read must not change what the user chose. The
 * provider stays in the last known state (OFF when nothing is known yet), sets
 * `readFailed`, and `retryRead` re-reads; a later successful read applies the
 * stored values and clears the flag.
 *
 * Before the fix a failed read was read as "nothing stored": on Windows the
 * source fell back to the LOCAL phone type, so an iPhone phone type turned
 * detection ON even for a user whose stored toggle was off (F1).
 *
 * Real provider + real `useIPhoneSync` + real settingsService; `window.api` is
 * the only seam. Fixture shapes are transcribed from the producers:
 *   - `preferences:get` success `{ success: true, preferences }` and non-success
 *     `{ success: false, error }` (electron/handlers/preferenceHandlers.ts:47-50
 *     and :60-63; the non-success branch is what an offline read returns).
 *   - `user:get-phone-type` -> `{ success: true, phoneType }`
 *     (electron/handlers/userSettingsHandlers.ts; local, needs no network).
 * The harness (deferred reads, drain, "running") is the one in
 * iphoneSyncChosenSource-3418.test.tsx.
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
      <IPhoneSyncProvider userId="user-2893">
        <Grab />
      </IPhoneSyncProvider>
    </React.StrictMode>,
  );
  await waitFor(() => expect(w().api.preferences.get).toHaveBeenCalledWith("user-2893"));
  await release();
}

/** Negative: the read has completed (C-3) and detection never started. */
function expectNeverStarted() {
  expect(handle).not.toBeNull();
  expect(handle!.enabled).toBe(false);
  expect(w().api.sync.startDetection).not.toHaveBeenCalled();
}

const FAILED = { success: false, error: "TypeError: fetch failed" };
const CHOSE_ON = { messages: { source: "iphone-sync" }, integrations: { iphoneSyncEnabled: true } };
const CHOSE_OFF = { messages: { source: "iphone-sync" }, integrations: { iphoneSyncEnabled: false } };

/** Serve a NON-success preferences read (deferred, as `serve`). */
function serveFailed(phoneType: "iphone" | "android" | null) {
  const prefs = deferred<unknown>();
  const phone = deferred<unknown>();
  w().api.preferences.get.mockReturnValue(prefs.promise);
  w().api.preferences.update.mockResolvedValue({ success: true });
  w().api.user.getPhoneType.mockReturnValue(phone.promise);
  return async () => {
    await act(async () => {
      prefs.resolve(FAILED);
      phone.resolve({ success: true, phoneType });
      await prefs.promise;
      await phone.promise;
    });
    await drain();
  };
}

/** Run `retryRead` with the next preferences response already queued. */
async function retryWith(response: unknown) {
  w().api.preferences.get.mockResolvedValueOnce(response);
  await act(async () => {
    await handle!.retryRead();
  });
  await drain();
}

function state() {
  return { enabled: handle!.enabled, readFailed: handle!.readFailed, running: running() };
}

describe("BACKLOG-2893: a failed preferences read holds iPhone sync", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    currentPlatform = "windows";
    installSyncApi();
    handle = null;
  });

  it("F1 Windows, read fails, local phone type iphone -> detection never starts, held", async () => {
    await mount(serveFailed("iphone"));
    expectNeverStarted();
    expect(handle!.readFailed).toBe(true);
  });

  it("F1b Windows, the preferences IPC rejects -> the same hold", async () => {
    w().api.preferences.get.mockRejectedValue(new Error("ipc down"));
    w().api.user.getPhoneType.mockResolvedValue({ success: true, phoneType: "iphone" });
    render(
      <IPhoneSyncProvider userId="user-2893">
        <Grab />
      </IPhoneSyncProvider>,
    );
    await waitFor(() => expect(w().api.preferences.get).toHaveBeenCalled());
    await drain();
    expectNeverStarted();
    expect(handle!.readFailed).toBe(true);
  });

  describe("F2 a failed read is neither 'chose on' nor 'chose off'", () => {
    it("chose on -> running, not held", async () => {
      await mount(serve(CHOSE_ON, "iphone"));
      await waitFor(() => expect(running()).toBe(true));
      expect(state()).toEqual({ enabled: true, readFailed: false, running: true });
    });
    it("chose off -> off, not held", async () => {
      await mount(serve(CHOSE_OFF, "iphone"));
      expectNeverStarted();
      expect(state()).toEqual({ enabled: false, readFailed: false, running: false });
    });
    it("read failed -> off, held", async () => {
      await mount(serveFailed("iphone"));
      expect(state()).toEqual({ enabled: false, readFailed: true, running: false });
    });
  });

  describe("F3 the last known state survives a failed retry (both directions)", () => {
    it("held, then the user picks iPhone in Settings (running), then a retry fails -> still running", async () => {
      await mount(serveFailed(null));
      act(() => handle!.applyImportSource("iphone-sync"));
      await waitFor(() => expect(running()).toBe(true));
      await retryWith(FAILED);
      expect(state()).toEqual({ enabled: true, readFailed: true, running: true });
    });
    it("held, then the user picks Google Messages, then a retry fails -> still off", async () => {
      await mount(serveFailed("iphone"));
      act(() => handle!.applyImportSource("android-messages-web"));
      await retryWith(FAILED);
      expect(state()).toEqual({ enabled: false, readFailed: true, running: false });
      expect(w().api.sync.startDetection).not.toHaveBeenCalled();
    });
  });

  describe("F4 retry", () => {
    it("a successful retry applies the stored choice (on) and clears the hold; a second retry does not re-read", async () => {
      await mount(serveFailed("iphone"));
      // StrictMode runs the mount effect twice, so count from here.
      const before = w().api.preferences.get.mock.calls.length;
      await retryWith({ success: true, preferences: CHOSE_ON });
      await waitFor(() => expect(running()).toBe(true));
      expect(state()).toEqual({ enabled: true, readFailed: false, running: true });
      expect(w().api.preferences.get).toHaveBeenCalledTimes(before + 1);
      await act(async () => {
        await handle!.retryRead();
      });
      expect(w().api.preferences.get).toHaveBeenCalledTimes(before + 1);
    });
    it("a successful retry applies the stored choice (off) and clears the hold", async () => {
      await mount(serveFailed("iphone"));
      await retryWith({ success: true, preferences: CHOSE_OFF });
      expect(state()).toEqual({ enabled: false, readFailed: false, running: false });
      expect(w().api.sync.startDetection).not.toHaveBeenCalled();
    });
    it("a failed retry keeps the hold", async () => {
      await mount(serveFailed("iphone"));
      const before = w().api.preferences.get.mock.calls.length;
      await retryWith(FAILED);
      expect(w().api.preferences.get).toHaveBeenCalledTimes(before + 1);
      expect(state()).toEqual({ enabled: false, readFailed: true, running: false });
    });
  });

  it("F5 macOS: read fails -> off and held; a successful retry with iphone-sync starts it", async () => {
    currentPlatform = "macos";
    await mount(serveFailed("iphone"));
    expect(state()).toEqual({ enabled: false, readFailed: true, running: false });
    await retryWith({ success: true, preferences: { messages: { source: "iphone-sync" } } });
    await waitFor(() => expect(running()).toBe(true));
    expect(handle!.readFailed).toBe(false);
  });

  describe("F6 a new user (no preferences row) is NOT held", () => {
    it("{} with an iPhone phone type -> running, not held", async () => {
      await mount(serve({}, "iphone"));
      await waitFor(() => expect(running()).toBe(true));
      expect(handle!.readFailed).toBe(false);
    });
    it("{} with no phone type -> off, not held", async () => {
      await mount(serve({}, null));
      expectNeverStarted();
      expect(handle!.readFailed).toBe(false);
    });
  });

  it("F8 signing out clears the hold", async () => {
    w().api.user.getPhoneType.mockResolvedValue({ success: true, phoneType: "iphone" });
    w().api.preferences.get.mockResolvedValue(FAILED);
    const { rerender } = render(
      <IPhoneSyncProvider userId="user-2893">
        <Grab />
      </IPhoneSyncProvider>,
    );
    await waitFor(() => expect(w().api.preferences.get).toHaveBeenCalled());
    await drain();
    expect(handle!.readFailed).toBe(true);
    rerender(
      <IPhoneSyncProvider userId={null}>
        <Grab />
      </IPhoneSyncProvider>,
    );
    await drain();
    expect(handle!.readFailed).toBe(false);
  });
});
