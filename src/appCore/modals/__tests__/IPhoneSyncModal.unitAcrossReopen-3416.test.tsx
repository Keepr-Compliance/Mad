/**
 * BACKLOG-3416 — one unit for the whole sync, across minimize and reopen.
 *
 * Minimize sets `showIPhoneSync` false (`useModalFlow.ts` closeIPhoneSync) and
 * `AppModals.tsx` renders the modal only while that flag is true, so minimizing
 * UNMOUNTS the modal, the flow and SyncProgress. The sync itself keeps running
 * in `IPhoneSyncProvider`, which sits above the modal in `App.tsx`.
 *
 * When the unit was held inside SyncProgress, reopening re-picked it from the
 * current count: SR measured "800.0 MB" before minimizing and "1.5 GB" after
 * reopening, in one sync. The founder ruled (2026-09-17) that the unit must hold
 * for the whole sync, so the unit now lives on the sync's progress state.
 *
 * Everything here is real except the IPC: the provider and `useIPhoneSync`, the
 * modal, its minimize button, the flow, ConnectionStatus's sync button and
 * SyncProgress's Cancel button. `Harness` mirrors the one line in AppModals that
 * mounts the modal, so minimize and reopen are a real unmount and remount.
 */

import React, { useState } from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { IPhoneSyncModal } from "../IPhoneSyncModal";
import { IPhoneSyncProvider } from "../../../contexts/IPhoneSyncContext";
import { syncStateRef } from "../../../hooks/useIPhoneSync";

jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Linux, signed in, with a stored iPhone source. BACKLOG-3418 turned off device
// detection until a user's preferences are loaded (an unknown source is OFF on
// every platform), so this fixture — which used to render the provider signed
// out and rely on Linux being always-on — now signs a user in and serves the
// preference read. Fixture only: nothing these tests assert changed.
jest.mock("../../../contexts/PlatformContext", () => ({
  usePlatform: () => ({ isWindows: false, isMacOS: false, isLinux: true, platform: "linux" }),
}));

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;

let onDeviceConnected: ((device: unknown) => void) | null = null;
let onProgress: ((progress: unknown) => void) | null = null;
let onStorageComplete: ((result: unknown) => void) | null = null;

function installSyncApi() {
  const listen = (assign: (cb: never) => void) =>
    jest.fn((cb: never) => {
      assign(cb);
      return jest.fn();
    });

  (window as unknown as { api: unknown }).api = {
    sync: {
      startDetection: jest.fn(),
      stopDetection: jest.fn(),
      start: jest.fn().mockResolvedValue({ success: true }),
      cancel: jest.fn().mockResolvedValue(undefined),
      getUnifiedStatus: jest
        .fn()
        .mockResolvedValue({ isAnyOperationRunning: false, currentOperation: null }),
      onDeviceConnected: listen((cb) => (onDeviceConnected = cb)),
      onDeviceDisconnected: listen(() => undefined),
      onProgress: listen((cb) => (onProgress = cb)),
      onPasswordRequired: listen(() => undefined),
      onError: listen(() => undefined),
      onComplete: listen(() => undefined),
      onWaitingForPasscode: listen(() => undefined),
      onPasscodeEntered: listen(() => undefined),
      onStorageComplete: listen((cb) => (onStorageComplete = cb)),
      onStorageError: listen(() => undefined),
    },
    backup: { checkStatus: jest.fn().mockResolvedValue({ success: true, lastSyncTime: null }) },
    // Shaped as the `preferences:get` handler returns it
    // (electron/handlers/preferenceHandlers.ts: `{ success: true, preferences }`).
    preferences: {
      get: jest.fn().mockResolvedValue({
        success: true,
        preferences: { messages: { source: "iphone-sync" } },
      }),
      update: jest.fn().mockResolvedValue({ success: true }),
    },
    // `user:get-phone-type` (electron/handlers/userSettingsHandlers.ts). Not
    // reached while a source is stored; present so a change to that is loud.
    user: {
      getPhoneType: jest.fn().mockResolvedValue({ success: true, phoneType: "iphone" }),
    },
  };
}

/** AppModals.tsx: `{modalState.showIPhoneSync && <IPhoneSyncModal onClose={closeIPhoneSync} />}` */
function Harness() {
  const [showIPhoneSync, setShowIPhoneSync] = useState(true);
  return (
    <IPhoneSyncProvider userId="user-3416">
      <button onClick={() => setShowIPhoneSync(true)}>Open iPhone sync</button>
      {showIPhoneSync && <IPhoneSyncModal onClose={() => setShowIPhoneSync(false)} />}
    </IPhoneSyncProvider>
  );
}

const flush = () => act(async () => { await Promise.resolve(); });

/** Render, then let the provider's preference read settle so detection (and the device listeners) are up. */
async function renderHarness() {
  render(<Harness />);
  await flush();
  await flush();
  await flush();
}

async function connectPhone() {
  await act(async () => {
    onDeviceConnected?.({
      udid: "test-udid",
      name: "Test iPhone",
      productType: "iPhone14,2",
      productVersion: "17.0",
      serialNumber: "ABC123",
      isConnected: true,
    });
    await Promise.resolve();
  });
}

async function clickSync() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Sync (Messages & Contacts|New Data)/ }));
  });
  await flush();
}

/** A backup progress event, shaped as deviceSyncOrchestrator.ts emits it. */
function transfer(bytesTransferred: number) {
  act(() => {
    onProgress?.({
      phase: "backup",
      overallProgress: 10,
      message: "Transferring...",
      backupProgress: { bytesTransferred, filesTransferred: 12 },
    });
  });
}

/** The big transferred-bytes readout, or null when the modal is not showing it. */
function readout(): string | null {
  return screen.queryByText(/^[\d,.]+ (B|KB|MB|GB)$/)?.textContent?.trim() ?? null;
}

describe("BACKLOG-3416: the unit holds for the whole sync, not for one view of it", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    syncStateRef.isActive = false;
    onDeviceConnected = null;
    onProgress = null;
    onStorageComplete = null;
    installSyncApi();
  });

  afterEach(() => {
    jest.useRealTimers();
    syncStateRef.isActive = false;
  });

  it("keeps MB after minimize and reopen, although the count has passed 1 GiB", async () => {
    await renderHarness();
    await connectPhone();
    await clickSync();

    transfer(8 * KiB); // the first completed file
    expect(readout()).toBe("0.0 MB");
    transfer(800 * MiB);
    expect(readout()).toBe("800.0 MB");

    fireEvent.click(screen.getByTitle(/Minimize/i));
    expect(screen.queryByTitle(/Minimize/i)).toBeNull(); // really unmounted

    transfer(1.5 * GiB); // the sync carries on while the modal is closed

    fireEvent.click(screen.getByRole("button", { name: "Open iPhone sync" }));
    expect(readout()).toBe("1536.0 MB");

    transfer(3 * GiB);
    expect(readout()).toBe("3072.0 MB");
  });

  it("a new sync after Cancel picks its own unit", async () => {
    await renderHarness();
    await connectPhone();
    await clickSync();

    transfer(8 * KiB);
    transfer(800 * MiB);
    expect(readout()).toBe("800.0 MB");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    await flush();
    expect(readout()).toBeNull();

    await clickSync();
    transfer(2 * GiB); // this sync's first completed file is large
    expect(readout()).toBe("2.0 GB");
  });

  it("a new sync after Continue picks its own unit", async () => {
    await renderHarness();
    await connectPhone();
    await clickSync();

    transfer(8 * KiB);
    expect(readout()).toBe("0.0 MB");

    act(() => {
      onStorageComplete?.({ messagesStored: 10, contactsStored: 2, duration: 1000 });
    });
    // Continue dismisses the sync and closes the modal.
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.queryByTitle(/Minimize/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open iPhone sync" }));
    await clickSync();
    transfer(2 * GiB);
    expect(readout()).toBe("2.0 GB");
  });
});
