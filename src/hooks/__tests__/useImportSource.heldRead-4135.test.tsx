/**
 * BACKLOG-4135: a failed preferences read must not change the import source
 * the app shows (founder rule from BACKLOG-2890 / 2893). `useImportSource`
 * keeps the last known value for the signed-in user, and re-reads when the
 * BACKLOG-2893 hold clears (a successful Retry), so the title-bar pill follows.
 *
 * Before the fix a failed read was passed on as "nothing stored", so the
 * source fell back to the LOCAL phone type: on Windows an iPhone phone type
 * showed the iPhone pill to a user whose stored source was Google Messages.
 *
 * The three app consumers (AppRouter.tsx:69, useTitleBarSync.ts:63,
 * AuditTransactionModal.tsx:59) are all mocked out in their own suites, so
 * THIS suite is the gate for the behaviour.
 *
 * Real hook + real IPhoneSyncProvider + real settingsService; `window.api` is
 * the only seam. Fixture shapes are transcribed from the producers:
 *   - `preferences:get` cloud success `{ success: true, preferences, source: "cloud" }`,
 *     served copy `{ success: true, preferences, source: "copy", copiedAt }`
 *     and no-copy failure `{ success: false, error }`
 *     (electron/handlers/preferenceHandlers.ts:55-90).
 *   - `user:get-phone-type` -> `{ success: true, phoneType }`
 *     (electron/handlers/userSettingsHandlers.ts; local, needs no network).
 */

import React, { useEffect } from "react";
import { render, renderHook, act, waitFor } from "@testing-library/react";
import { useImportSource } from "../useImportSource";
import { IPhoneSyncProvider, useIPhoneSyncEnabled } from "../../contexts/IPhoneSyncContext";
import { deriveIPhonePill } from "../../appCore/shell/syncPillState";
import { IPHONE_BASE, NOW } from "../../appCore/shell/__tests__/syncPillFixtures";
import type { ImportSource } from "../../services/settingsService";
import type { Platform } from "../../utils/platform";

jest.mock("../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

let currentPlatform: Platform = "windows";
jest.mock("../../contexts/PlatformContext", () => ({
  usePlatform: () => ({
    platform: currentPlatform,
    isMacOS: currentPlatform === "macos",
    isWindows: currentPlatform === "windows",
    isLinux: currentPlatform === "linux",
    isElectron: true,
    isFeatureAvailable: () => false,
  }),
}));

type W = {
  api: {
    sync: Record<string, unknown>;
    preferences: { get: jest.Mock; update: jest.Mock };
    user: { getPhoneType: jest.Mock };
  };
};
const w = () => window as unknown as W;

function installSyncApi() {
  const listen = () => jest.fn(() => jest.fn());
  w().api.sync = {
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

/** Let every queued microtask run (a macrotask cannot start before they finish). */
async function drain() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const FAILED = { success: false, error: "TypeError: fetch failed" };
const GOOGLE = { messages: { source: "android-messages-web" } };
const cloud = (preferences: Record<string, unknown>) => ({ success: true, preferences, source: "cloud" });
const copy = (preferences: Record<string, unknown>) => ({
  success: true,
  preferences,
  source: "copy",
  copiedAt: "2026-11-04T09:00:00.000Z",
});

function setPhoneType(phoneType: "iphone" | "android" | null) {
  w().api.user.getPhoneType.mockResolvedValue({ success: true, phoneType });
}

/** Mount the hook alone (no provider: readFailed is false, as outside the app). */
async function mountHook(userId = "user-4135", showSettings = false) {
  const view = renderHook(
    (p: { userId: string | undefined; showSettings: boolean }) => useImportSource(p.userId, p.showSettings),
    { initialProps: { userId, showSettings } },
  );
  await waitFor(() => expect(w().api.preferences.get).toHaveBeenCalled());
  await drain();
  return view;
}

describe("BACKLOG-4135: useImportSource keeps the last known source on a failed read", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    currentPlatform = "windows";
    installSyncApi();
    w().api.preferences.update.mockResolvedValue({ success: true });
  });

  it("C1 Windows, read fails, nothing known, phone type iphone -> null (no iPhone pill)", async () => {
    setPhoneType("iphone");
    w().api.preferences.get.mockResolvedValue(FAILED);
    const { result } = await mountHook();
    expect(result.current).toBeNull();
  });

  it("C1-mac macOS, read fails, nothing known, phone type android -> stays macos-native", async () => {
    currentPlatform = "macos";
    setPhoneType("android");
    w().api.preferences.get.mockResolvedValue(FAILED);
    const { result } = await mountHook();
    expect(result.current).toBe("macos-native");
  });

  it("C2 a served local copy is a normal read -> follows the copy", async () => {
    setPhoneType("iphone");
    w().api.preferences.get.mockResolvedValue(copy(GOOGLE));
    const { result } = await mountHook();
    expect(result.current).toBe("android-messages-web");
  });

  it("C3 good read (Google Messages), then a failed re-read on Settings close -> holds it, never iPhone", async () => {
    setPhoneType("iphone");
    w().api.preferences.get.mockResolvedValue(cloud(GOOGLE));
    const { result, rerender } = await mountHook("user-4135", false);
    expect(result.current).toBe("android-messages-web");

    w().api.preferences.get.mockResolvedValue(FAILED);
    const before = w().api.preferences.get.mock.calls.length;
    rerender({ userId: "user-4135", showSettings: true });
    rerender({ userId: "user-4135", showSettings: false });
    await waitFor(() => expect(w().api.preferences.get.mock.calls.length).toBeGreaterThan(before));
    await drain();
    expect(result.current).not.toBe("iphone-sync");
    expect(result.current).toBe("android-messages-web");
  });

  it("C4 after a failed read, a re-render with the same inputs makes no second read (no polling)", async () => {
    setPhoneType("iphone");
    w().api.preferences.get.mockResolvedValue(FAILED);
    const { rerender } = await mountHook();
    const before = w().api.preferences.get.mock.calls.length;
    rerender({ userId: "user-4135", showSettings: false });
    await drain();
    expect(w().api.preferences.get).toHaveBeenCalledTimes(before);
  });

  it("C6 a different user's failed read does not show the previous user's source", async () => {
    setPhoneType(null);
    w().api.preferences.get.mockResolvedValue(cloud({ messages: { source: "iphone-sync" } }));
    const { result, rerender } = await mountHook("user-a");
    expect(result.current).toBe("iphone-sync");

    w().api.preferences.get.mockResolvedValue(FAILED);
    rerender({ userId: "user-b", showSettings: false });
    await waitFor(() => expect(w().api.preferences.get).toHaveBeenCalledWith("user-b"));
    await drain();
    expect(result.current).toBeNull();
  });
});

describe("BACKLOG-4135 C5: the hook re-reads when the 2893 hold clears", () => {
  const seen: { a: ImportSource | null; b: ImportSource | null } = { a: null, b: null };
  let handle: ReturnType<typeof useIPhoneSyncEnabled> | null = null;

  function Probe() {
    // Two instances, as in the app (AppRouter + the title-bar pill): the
    // re-read must live inside the hook so every instance follows.
    const a = useImportSource("user-4135", false);
    const b = useImportSource("user-4135", false);
    const ctx = useIPhoneSyncEnabled();
    useEffect(() => {
      seen.a = a;
      seen.b = b;
      handle = ctx;
    });
    return null;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    currentPlatform = "windows";
    installSyncApi();
    handle = null;
    seen.a = seen.b = null;
    w().api.preferences.update.mockResolvedValue({ success: true });
  });

  it("offline with no copy -> both null and held; a successful Retry -> both follow the read", async () => {
    setPhoneType("iphone");
    w().api.preferences.get.mockResolvedValue(FAILED);
    render(
      <IPhoneSyncProvider userId="user-4135">
        <Probe />
      </IPhoneSyncProvider>,
    );
    await waitFor(() => expect(w().api.preferences.get).toHaveBeenCalled());
    await drain();
    expect(handle!.readFailed).toBe(true);
    expect(seen).toEqual({ a: null, b: null });

    // Reconnect: every read now succeeds. Only the provider's Retry is called.
    w().api.preferences.get.mockResolvedValue(cloud(GOOGLE));
    await act(async () => {
      await handle!.retryRead();
    });
    await drain();
    expect(handle!.readFailed).toBe(false);
    await waitFor(() => expect(seen).toEqual({ a: "android-messages-web", b: "android-messages-web" }));
  });
});

describe("BACKLOG-4135 L1: the iPhone pill while the 2893 hold is on", () => {
  it("held + detection off -> 'Messages sync paused' (matches the dashboard banner)", () => {
    const p = deriveIPhonePill({ ...IPHONE_BASE, isConnected: true }, false, NOW, { readFailed: true });
    expect(p.label).toBe("iPhone");
    expect(p.tooltip).toBe("Messages sync paused");
    expect(p.canStart).toBe(false);
  });
  it("not held + detection off -> the Settings wording, unchanged", () => {
    const p = deriveIPhonePill({ ...IPHONE_BASE, isConnected: true }, false, NOW, { readFailed: false });
    expect(p.tooltip).toBe("iPhone sync is off in Settings");
  });
  it("held but detection on (the held choice) -> the normal connected pill", () => {
    const p = deriveIPhonePill({ ...IPHONE_BASE, isConnected: true }, true, NOW, { readFailed: true });
    expect(p.canStart).toBe(true);
  });
});
