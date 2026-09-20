/**
 * BACKLOG-3423 — the import source gates iPhone USB detection, and the toggle
 * shows that gated (effective) value.
 *
 * Founder, 2026-09-17, QA on a fresh profile with import source = macOS
 * Messages: the "iPhone Sync (USB)" toggle sat in the ON state and the renderer
 * logged `[useIPhoneSync] Starting device detection...` at startup, with the
 * main process polling for devices every 2s.
 *
 * Mechanism (traced, recorded on the item): his stored preferences hold
 * `integrations.iphoneSyncEnabled: true` AND `messages.source: "macos-native"`.
 * Under BACKLOG-1706 an explicit preference always won, so the source never got
 * a vote — and because preferences live in Supabase, that value follows the
 * account into every fresh local profile. The fixture below is that state
 * verbatim.
 *
 * Everything here is real except the IPC: the real provider, the real
 * `useIPhoneSync`, the real `settingsService`, the real toggle. `window.api` is
 * the only seam, exactly as in
 * `appCore/modals/__tests__/IPhoneSyncModal.unitAcrossReopen-3416.test.tsx`,
 * whose `installSyncApi` shape this mirrors.
 */

import React, { useEffect } from "react";
import { render, screen, act, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { IPhoneSyncProvider, useIPhoneSyncEnabled } from "../IPhoneSyncContext";
import { IphoneSyncSettings } from "../../components/settings/IphoneSyncSettings";
import type { ImportSource } from "../../services/settingsService";
import type { Platform } from "../../utils/platform";

jest.mock("../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Platform is a renderer-side fact (contextIsolation → no process.platform), so
// it is stubbed rather than derived from jsdom's navigator.
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

type SyncApiMock = {
  startDetection: jest.Mock;
  stopDetection: jest.Mock;
  getUnifiedStatus: jest.Mock;
};

const syncApi = (): SyncApiMock =>
  (window as unknown as { api: { sync: SyncApiMock } }).api.sync;

const prefsApi = () =>
  (window as unknown as {
    api: { preferences: { get: jest.Mock; update: jest.Mock } };
  }).api.preferences;

/** His stored row, verbatim (Supabase `user_preferences`, 2026-09-17). */
const FOUNDER_PREFERENCES = {
  integrations: { iphoneSyncEnabled: true },
  messages: { source: "macos-native" as ImportSource },
};

function setStoredPreferences(preferences: Record<string, unknown>) {
  prefsApi().get.mockResolvedValue({ success: true, preferences });
  prefsApi().update.mockResolvedValue({ success: true });
}

/** Mirrors the one line in `Settings.tsx` that re-gates on a source change. */
function SourceSwitcher({ to }: { to: ImportSource | null }) {
  const { applyImportSource } = useIPhoneSyncEnabled();
  useEffect(() => {
    if (to) applyImportSource(to);
  }, [to, applyImportSource]);
  return null;
}

const renderProvider = (ui: React.ReactElement) =>
  render(
    <React.StrictMode>
      <IPhoneSyncProvider userId="user-3423">{ui}</IPhoneSyncProvider>
    </React.StrictMode>,
  );

const toggle = () =>
  screen.getByRole("switch", { name: /enable iphone sync over usb/i });

describe("BACKLOG-3423: import source gates iPhone USB detection", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    currentPlatform = "macos";
    installSyncApi();
    setStoredPreferences(FOUNDER_PREFERENCES);
  });

  describe("macOS Messages user whose stored preference is ON (the founder's state)", () => {
    it("shows the toggle OFF — the stored ON does not survive a non-iPhone source", async () => {
      renderProvider(<IphoneSyncSettings disabled />);

      await waitFor(() => expect(prefsApi().get).toHaveBeenCalled());
      // Settle the provider's async resolution before reading the toggle.
      await act(async () => { await Promise.resolve(); });

      expect(toggle()).toHaveAttribute("aria-checked", "false");
    });

    it("starts NO device detection and never polls sync status", async () => {
      renderProvider(<IphoneSyncSettings disabled />);

      await waitFor(() => expect(prefsApi().get).toHaveBeenCalled());
      await act(async () => { await Promise.resolve(); });

      expect(syncApi().startDetection).not.toHaveBeenCalled();
      expect(syncApi().getUnifiedStatus).not.toHaveBeenCalled();
    });

    it("does NOT rewrite the stored preference — switching back must restore it", async () => {
      renderProvider(<IphoneSyncSettings disabled />);

      await waitFor(() => expect(prefsApi().get).toHaveBeenCalled());
      await act(async () => { await Promise.resolve(); });

      // Nothing may write `integrations` in the course of gating.
      const integrationWrites = prefsApi().update.mock.calls.filter(
        (call) => call[1] && Object.keys(call[1]).includes("integrations"),
      );
      expect(integrationWrites).toHaveLength(0);
    });
  });

  describe("iPhone-source user", () => {
    beforeEach(() => {
      setStoredPreferences({
        integrations: { iphoneSyncEnabled: true },
        messages: { source: "iphone-sync" as ImportSource },
      });
    });

    it("shows the toggle ON and starts device detection", async () => {
      renderProvider(<IphoneSyncSettings />);

      await waitFor(() => expect(syncApi().startDetection).toHaveBeenCalled());

      expect(toggle()).toHaveAttribute("aria-checked", "true");
      expect(syncApi().getUnifiedStatus).toHaveBeenCalled();
    });
  });

  describe("runtime source switch", () => {
    beforeEach(() => {
      setStoredPreferences({
        integrations: { iphoneSyncEnabled: true },
        messages: { source: "iphone-sync" as ImportSource },
      });
    });

    it("stops detection when the source moves off iPhone, and leaves no poll behind", async () => {
      jest.useFakeTimers();
      try {
        const { rerender } = render(
          <IPhoneSyncProvider userId="user-3423">
            <SourceSwitcher to={null} />
            <IphoneSyncSettings />
          </IPhoneSyncProvider>,
        );

        await act(async () => { await Promise.resolve(); await Promise.resolve(); });
        expect(syncApi().startDetection).toHaveBeenCalled();

        const pollsWhileOnIPhone = syncApi().getUnifiedStatus.mock.calls.length;
        expect(pollsWhileOnIPhone).toBeGreaterThan(0);

        // The source radio moves to macOS Messages.
        await act(async () => {
          rerender(
            <IPhoneSyncProvider userId="user-3423">
              <SourceSwitcher to={"macos-native" as ImportSource} />
              <IphoneSyncSettings />
            </IPhoneSyncProvider>,
          );
          await Promise.resolve();
        });

        expect(syncApi().stopDetection).toHaveBeenCalled();
        expect(toggle()).toHaveAttribute("aria-checked", "false");

        // POLL_BASE_MS is 5s; four windows is ample for a leaked timer to fire.
        const pollsAtSwitch = syncApi().getUnifiedStatus.mock.calls.length;
        await act(async () => { jest.advanceTimersByTime(20_000); });
        expect(syncApi().getUnifiedStatus.mock.calls.length).toBe(pollsAtSwitch);
      } finally {
        jest.useRealTimers();
      }
    });

    it("starts detection again when the source moves back to iPhone", async () => {
      setStoredPreferences(FOUNDER_PREFERENCES);

      const { rerender } = render(
        <IPhoneSyncProvider userId="user-3423">
          <SourceSwitcher to={null} />
          <IphoneSyncSettings />
        </IPhoneSyncProvider>,
      );

      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(syncApi().startDetection).not.toHaveBeenCalled();

      await act(async () => {
        rerender(
          <IPhoneSyncProvider userId="user-3423">
            <SourceSwitcher to={"iphone-sync" as ImportSource} />
            <IphoneSyncSettings />
          </IPhoneSyncProvider>,
        );
        await Promise.resolve();
      });

      expect(syncApi().startDetection).toHaveBeenCalled();
      // His stored ON is still what decides it once the source allows iPhone.
      expect(toggle()).toHaveAttribute("aria-checked", "true");
      const integrationWrites = prefsApi().update.mock.calls.filter(
        (call) => call[1] && Object.keys(call[1]).includes("integrations"),
      );
      expect(integrationWrites).toHaveLength(0);
    });
  });

  describe("Windows, where detection starts before preferences are known", () => {
    beforeEach(() => {
      currentPlatform = "windows";
      setStoredPreferences({ messages: { source: "android-companion" as ImportSource } });
    });

    it("starts once on the platform default, then stops once the Android source resolves", async () => {
      renderProvider(<IphoneSyncSettings disabled />);

      // Windows/Linux stay ON while the source is unknown (their primary import
      // path must not wait on an IPC round-trip), so detection does start.
      expect(syncApi().startDetection).toHaveBeenCalled();

      // BACKLOG-3437: StrictMode mounts the detection effect, tears it down and
      // remounts it, and that teardown ALREADY calls stopDetection once — so
      // "stopDetection has been called" is true before the source has resolved
      // and waiting on it waits for nothing. Wait for the gated state itself,
      // and require a stop BEYOND the StrictMode one, which is what the Android
      // source actually produces.
      const stopsAtMount = syncApi().stopDetection.mock.calls.length;
      await waitFor(() => {
        expect(toggle()).toHaveAttribute("aria-checked", "false");
        expect(syncApi().stopDetection.mock.calls.length).toBeGreaterThan(
          stopsAtMount,
        );
      });
    });
  });
});
