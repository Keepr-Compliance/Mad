/**
 * BACKLOG-2909 + BACKLOG-2939 — unplugging the iPhone after the backup finished.
 *
 * Once the backup tool has returned, every remaining step reads files already on this
 * computer. Unplugging then must not fail the sync, and the late completion event must
 * still be applied. The hook decides "is the phone still needed?" from the phase it
 * mapped from the last `sync:progress` tick; the mapper compared against
 * "parsing_messages" / "parsing_contacts" while the main process sends
 * "parsing-messages" / "parsing-contacts", so every parsing tick read as the backup.
 *
 * The REAL useIPhoneSync hook drives the REAL IPhoneSyncFlow (harness of
 * IPhoneSyncFlow.failureUx-3816.test.tsx). The progress ticks are typed as the
 * orchestrator's own `SyncProgress`, so a misspelt phase name here fails type-check
 * instead of reproducing the bug; values are transcribed from the orchestrator's emits
 * (deviceSyncOrchestrator.ts `phase: "backup"` backup ticks, "parsing-contacts",
 * "parsing-messages", "resolving" — Step 3/4/5 of `sync`).
 */
import React from "react";
import { render, screen, act, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import type { SyncProgress } from "../../../../electron/services/deviceSyncOrchestrator";
import type { WindowApiSync } from "../../../../electron/types/ipc/window-api-platform";
import { useIPhoneSync, syncStateRef } from "../../../hooks/useIPhoneSync";
import { syncOrchestrator } from "../../../services/SyncOrchestratorService";
import { IPhoneSyncFlow } from "../IPhoneSyncFlow";
import type { UseIPhoneSyncReturn } from "../../../types/iphone";

jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../../../contexts/PlatformContext", () => ({
  usePlatform: () => ({ isWindows: true, isMacOS: false, isLinux: false, isWindowsArm64: false, platform: "win32" }),
}));
jest.mock("../../../utils/platform", () => ({
  ...jest.requireActual("../../../utils/platform"),
  isWindowsArm64: () => false,
}));

let currentHook: UseIPhoneSyncReturn | null = null;
jest.mock("../../../contexts/IPhoneSyncContext", () => ({
  useIPhoneSyncContext: () => currentHook,
}));

// ---------------------------------------------------------------------------
// Producer ticks (see header). Typed as the orchestrator's payload.
// ---------------------------------------------------------------------------

const BACKUP_TICK: SyncProgress = { phase: "backup", phaseProgress: 40, overallProgress: 20, message: "Backing up..." };
const PARSING_CONTACTS_TICK: SyncProgress = {
  phase: "parsing-contacts",
  phaseProgress: 0,
  overallProgress: 50,
  message: "Reading contacts...",
};
const PARSING_MESSAGES_TICK: SyncProgress = {
  phase: "parsing-messages",
  phaseProgress: 0,
  overallProgress: 55,
  message: "Reading messages...",
};
const RESOLVING_TICK: SyncProgress = {
  phase: "resolving",
  phaseProgress: 0,
  overallProgress: 90,
  message: "Resolving contact names...",
};

/** The sync:complete payload shape the hook reads (SyncResultType). */
const COMPLETE = { success: true, messageCount: 12, contactCount: 3, conversationCount: 2, duration: 1 };

const SAFE_TITLE = "Reading messages - Safe to disconnect";
const SAVING_TITLE = "Saving to database - Safe to disconnect";

// ---------------------------------------------------------------------------
// window.api double
// ---------------------------------------------------------------------------

const DEVICE = {
  udid: "00008110-000A2909000B2909",
  name: "Test iPhone",
  productType: "iPhone15,2",
  productVersion: "18.0",
  serialNumber: "SERIAL2909",
  isConnected: true,
};

type Cb = (arg?: unknown) => void;
const cbs: Record<string, Cb> = {};
const on = (name: string) => jest.fn((cb: Cb) => { cbs[name] = cb; return jest.fn(); });

let syncApi: Record<string, jest.Mock>;

function installSyncApi() {
  syncApi = {
    startDetection: jest.fn(),
    stopDetection: jest.fn(),
    // Never settles: the run is driven by events only, as in production.
    start: jest.fn(() => new Promise(() => undefined)),
    cancel: jest.fn().mockResolvedValue({ success: true }),
    getUnifiedStatus: jest.fn().mockResolvedValue({ isAnyOperationRunning: false, currentOperation: null }),
    getIPhoneLastSyncTime: jest.fn().mockResolvedValue({ lastSyncTime: null }),
    onDeviceConnected: on("connected"),
    onDeviceDisconnected: on("disconnected"),
    onProgress: on("progress"),
    onPasswordRequired: on("password"),
    onError: on("error"),
    onComplete: on("complete"),
    onWaitingForPasscode: on("waiting"),
    onPasscodeEntered: on("passcode"),
    onStorageComplete: on("storageComplete"),
    onStorageError: on("storageError"),
  };
  (window as unknown as { api: unknown }).api = { sync: syncApi };
}

function Harness() {
  currentHook = useIPhoneSync(true);
  return <IPhoneSyncFlow />;
}

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

async function connectAndStart() {
  render(<Harness />);
  await act(async () => {
    cbs.connected(DEVICE);
  });
  await flush();
  fireEvent.click(screen.getByRole("button", { name: /Sync Messages & Contacts/ }));
  await flush();
  expect(syncApi.start).toHaveBeenCalled();
}

async function tick(progress: SyncProgress) {
  await act(async () => {
    cbs.progress(progress);
  });
}

async function unplug() {
  await act(async () => {
    cbs.disconnected(DEVICE);
  });
  await flush();
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ["queueMicrotask"] });
  jest.setSystemTime(new Date("2026-11-05T10:00:00Z"));
  syncStateRef.isActive = false;
  syncStateRef.deferredLogout = false;
  syncOrchestrator.reset();
  for (const k of Object.keys(cbs)) delete cbs[k];
  installSyncApi();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("BACKLOG-2909 — unplug after the backup finished does not fail the sync", () => {
  it.each([
    ["C1 parsing-contacts", PARSING_CONTACTS_TICK],
    ["C2 parsing-messages", PARSING_MESSAGES_TICK],
    ["resolving (already safe before the fix)", RESOLVING_TICK],
  ] as const)("%s: no Sync Failed, and the late completion is applied", async (_name, postBackupTick) => {
    await connectAndStart();
    await tick(BACKUP_TICK);
    await tick(postBackupTick);

    // BACKLOG-2939: the copy that tells the user the phone is free is shown.
    expect(screen.getByText(SAFE_TITLE)).toBeInTheDocument();

    await unplug();
    expect(screen.queryByText("Sync Failed")).not.toBeInTheDocument();
    expect(currentHook!.syncStatus).toBe("syncing");
    expect(syncStateRef.isActive).toBe(true);

    // The completion arrives after the unplug and must not be dropped.
    await act(async () => {
      cbs.complete(COMPLETE);
    });
    await flush();
    expect(syncStateRef.isActive).toBe(true);
    expect(screen.queryByText("Sync Failed")).not.toBeInTheDocument();
    expect(screen.getByText(SAVING_TITLE)).toBeInTheDocument();
  });

  it("C3 unplug mid-backup still fails the sync", async () => {
    await connectAndStart();
    await tick(BACKUP_TICK);
    expect(screen.getByText("Exporting - Keep connected")).toBeInTheDocument();

    await unplug();
    expect(screen.getByText("Sync Failed")).toBeInTheDocument();
    expect(screen.getByTestId("sync-error-message")).toHaveTextContent("Device disconnected during sync");
    expect(currentHook!.syncStatus).toBe("error");
  });
});

describe("C4 — the device-API disconnect handler", () => {
  // The hook subscribes to `window.api.device.onDisconnected` only when there is NO sync
  // API, and a sync can only start through `window.api.sync.start`. So that handler can
  // never see a running sync: this pins that it cannot fail one.
  it("with only the device API, a sync cannot start and an unplug shows no Sync Failed", async () => {
    const deviceApi = {
      startDetection: jest.fn(),
      stopDetection: jest.fn(),
      onConnected: on("deviceConnected"),
      onDisconnected: on("deviceDisconnected"),
    };
    (window as unknown as { api: unknown }).api = { device: deviceApi };
    render(<Harness />);
    expect(deviceApi.onDisconnected).toHaveBeenCalledTimes(1);
    await act(async () => {
      cbs.deviceConnected(DEVICE);
    });
    await flush();
    await act(async () => {
      await currentHook!.startSync();
    });
    expect(currentHook!.syncStatus).not.toBe("syncing");
    await act(async () => {
      cbs.deviceDisconnected(DEVICE);
    });
    await flush();
    expect(currentHook!.syncStatus).not.toBe("error");
    expect(screen.queryByText("Sync Failed")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// C5 — compile-time: the renderer can only compare against phases main sends.
// Checked by `npm run type-check:tests`: if the IPC type is widened back to `string`,
// every `@ts-expect-error` below becomes unused and type-check fails (TS2578).
// ---------------------------------------------------------------------------

type WirePhase = Parameters<Parameters<WindowApiSync["onProgress"]>[0]>[0]["phase"];

function wirePhaseTypeControls(p: WirePhase): boolean[] {
  return [
    // @ts-expect-error — the underscore spelling is not a phase main sends (BACKLOG-2939).
    p === "parsing_messages",
    // @ts-expect-error — the underscore spelling is not a phase main sends (BACKLOG-2939).
    p === "parsing_contacts",
    p === "parsing-messages",
    p === "parsing-contacts",
    p === "storing",
  ];
}

describe("C5 — the sync:progress phase type", () => {
  it("accepts every phase main sends", () => {
    const sent: WirePhase[] = [
      "idle",
      "backup",
      "decrypting",
      "parsing-contacts",
      "parsing-messages",
      "resolving",
      "cleanup",
      "complete",
      "error",
      "storing",
    ];
    // @ts-expect-error — a string that is not a phase does not type-check.
    const notAPhase: WirePhase = "parsing_messages";
    expect(sent).toHaveLength(10);
    expect(notAPhase).toBe("parsing_messages");
    expect(wirePhaseTypeControls("parsing-messages")).toEqual([false, false, true, false, false]);
  });
});
