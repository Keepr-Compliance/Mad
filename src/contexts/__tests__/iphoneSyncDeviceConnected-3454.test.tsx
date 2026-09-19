/**
 * BACKLOG-3454 — a phone that is plugged in is never shown as connected.
 *
 * Founder, 2026-09-19, macOS dev build of int/release-2.38.1 @ 5afff634a.
 * Device detection was live in the renderer from 16:07:52 (`[useIPhoneSync]
 * Starting device detection...`) until 16:30:17 (`[SyncHandlers] Stopping
 * device detection`). Inside that window the main process sent
 * `sync:device-connected` five times (16:17:37, 16:19:15, 16:19:31, 16:21:22,
 * 16:29:02) and every subsequent mount of the sync window read
 * `isConnected=false`. After the source switch at 16:30:22 the re-emit for the
 * already-connected device (syncHandlers.ts:309-316) produced the same nothing.
 *
 * These two tests drive the renderer half of that path with the preload bridge
 * replaced by a mock — the real provider, the real `useIPhoneSync`, the real
 * gate. The seam is `window.api`, mirroring
 * `iphoneSyncSourceGate-3423.test.tsx`.
 *
 * READ THIS BEFORE CITING THEM AS CONTROLS: they are GREEN against unfixed
 * code. They therefore establish only that the renderer's subscribe → callback
 * → state path is sound when the bridge delivers; they say nothing about
 * whether it delivers, because the mock bypasses `webContents.send` → preload
 * `ipcRenderer.on` → contextBridge entirely. That layer is the part still
 * untraced.
 */

import React, { useEffect } from "react";
import { render, screen, act, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import {
  IPhoneSyncProvider,
  useIPhoneSyncContext,
  useIPhoneSyncEnabled,
} from "../IPhoneSyncContext";
import type { ImportSource } from "../../services/settingsService";
import type { Platform } from "../../utils/platform";

jest.mock("../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

let currentPlatform: Platform = "macos";
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

/** The device the founder had plugged in, shape as main emits it. */
const CONNECTED_DEVICE = {
  udid: "test-udid-3454",
  name: "Test iPhone",
  productType: "iPhone16,1",
  productVersion: "26.0",
  serialNumber: "SERIAL3454",
  isConnected: true,
};

/**
 * Every callback the hook hands to `window.api.sync.onDeviceConnected`, in
 * registration order, plus whether each has since been unsubscribed. The real
 * preload keys `ipcRenderer.removeListener` on function identity, so an
 * unsubscribed callback is one main can no longer reach.
 */
type Subscription = { cb: (device: unknown) => void; live: boolean };
let deviceConnectedSubs: Subscription[] = [];

/** Main's `sendToRenderer("sync:device-connected", device)`, as the bridge delivers it. */
function emitDeviceConnected(device: unknown = CONNECTED_DEVICE) {
  deviceConnectedSubs.filter((s) => s.live).forEach((s) => s.cb(device));
}

const liveSubCount = () => deviceConnectedSubs.filter((s) => s.live).length;

function installSyncApi({ deviceAlreadyConnected }: { deviceAlreadyConnected: boolean }) {
  const listen = () => jest.fn(() => jest.fn());
  const api = (window as unknown as { api: Record<string, unknown> }).api;
  api.sync = {
    // syncHandlers.ts:309-316 — start-detection re-emits device-connected for
    // every already-connected device, synchronously inside the handler.
    startDetection: jest.fn(() => {
      if (deviceAlreadyConnected) emitDeviceConnected();
      return Promise.resolve({ success: true, devices: [CONNECTED_DEVICE] });
    }),
    stopDetection: jest.fn(() => Promise.resolve({ success: true })),
    start: jest.fn().mockResolvedValue({ success: true }),
    cancel: jest.fn().mockResolvedValue(undefined),
    getUnifiedStatus: jest
      .fn()
      .mockResolvedValue({ isAnyOperationRunning: false, currentOperation: null }),
    getIPhoneLastSyncTime: jest.fn().mockResolvedValue({ lastSyncTime: null }),
    onDeviceConnected: jest.fn((cb: (device: unknown) => void) => {
      const sub: Subscription = { cb, live: true };
      deviceConnectedSubs.push(sub);
      return () => {
        sub.live = false;
      };
    }),
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

const prefsApi = () =>
  (window as unknown as {
    api: { preferences: { get: jest.Mock; update: jest.Mock } };
  }).api.preferences;

function setStoredPreferences(preferences: Record<string, unknown>) {
  prefsApi().get.mockResolvedValue({ success: true, preferences });
  prefsApi().update.mockResolvedValue({ success: true });
}

/** Mirrors the one line in Settings.tsx that re-gates on a source change. */
function SourceSwitcher({ to }: { to: ImportSource | null }) {
  const { applyImportSource } = useIPhoneSyncEnabled();
  useEffect(() => {
    if (to) applyImportSource(to);
  }, [to, applyImportSource]);
  return null;
}

/** What ConnectionStatus reads, via IPhoneSyncFlow, via the context. */
function ConnectionProbe() {
  const { isConnected, device } = useIPhoneSyncContext();
  return (
    <div data-testid="probe">
      {isConnected ? `connected:${device?.name ?? "?"}` : "not-connected"}
    </div>
  );
}

const probe = () => screen.getByTestId("probe").textContent;

const renderProvider = (ui: React.ReactElement) =>
  render(
    <React.StrictMode>
      <IPhoneSyncProvider userId="user-3454">{ui}</IPhoneSyncProvider>
    </React.StrictMode>,
  );

describe("BACKLOG-3454: an already-plugged-in phone must show as connected", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    currentPlatform = "macos";
    deviceConnectedSubs = [];
  });

  it("switching the source to iPhone Sync with a device already connected sets isConnected", async () => {
    installSyncApi({ deviceAlreadyConnected: true });
    // His state before the switch: source is macOS Messages, so the gate is shut.
    setStoredPreferences({
      integrations: { iphoneSyncEnabled: true },
      messages: { source: "macos-native" as ImportSource },
    });

    const { rerender } = renderProvider(
      <>
        <SourceSwitcher to={null} />
        <ConnectionProbe />
      </>,
    );

    await waitFor(() => expect(prefsApi().get).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(probe()).toBe("not-connected");

    // Settings persists messages.source = iphone-sync, then re-gates.
    await act(async () => {
      rerender(
        <React.StrictMode>
          <IPhoneSyncProvider userId="user-3454">
            <SourceSwitcher to="iphone-sync" />
            <ConnectionProbe />
          </IPhoneSyncProvider>
        </React.StrictMode>,
      );
      await Promise.resolve();
    });

    expect(liveSubCount()).toBeGreaterThan(0);
    await waitFor(() => expect(probe()).toBe(`connected:${CONNECTED_DEVICE.name}`));
  });

  it("a device connected long after subscription sets isConnected (the 16:50 re-plug)", async () => {
    installSyncApi({ deviceAlreadyConnected: false });
    // Source already iPhone Sync — the gate is open from the first prefs read,
    // which is what the 16:07:52 "Starting device detection..." line shows.
    setStoredPreferences({
      integrations: { iphoneSyncEnabled: true },
      messages: { source: "iphone-sync" as ImportSource },
    });

    renderProvider(<ConnectionProbe />);

    await waitFor(() => expect(prefsApi().get).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });

    // Exactly one live subscription — a StrictMode double-invoke must not leave
    // the surviving listener unsubscribed, nor two listeners attached.
    expect(liveSubCount()).toBe(1);
    expect(probe()).toBe("not-connected");

    await act(async () => {
      emitDeviceConnected();
      await Promise.resolve();
    });

    expect(probe()).toBe(`connected:${CONNECTED_DEVICE.name}`);
  });
});
