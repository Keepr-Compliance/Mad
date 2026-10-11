/**
 * BACKLOG-3816 — the sync error screen after a failure (PC, signed 2.40.0-rc.1, 2026-10-11).
 *
 * (A) After a cable wiggle the screen read "Sync Failed" with no reason.
 * (B) Try Again did nothing visible for ~30 s.
 * (C) A retry straight after a dropped connection failed with SERVICE_UNAVAILABLE.
 * (D) After a failed reply the dashboard indicator kept its "syncing" look.
 *
 * The REAL useIPhoneSync hook drives the REAL IPhoneSyncFlow (only the context lookup is
 * redirected to the hook instance rendered by the harness), and (D) reads the REAL
 * SyncOrchestratorService singleton the dashboard indicator renders from.
 *
 * FIXTURES. Every failure message and error code comes from the producer: the main
 * process's own `classifyBackupFailure` run on idevicebackup2 output TRANSCRIBED in
 * electron/services/__tests__/backupService.failureCause-2913.test.ts and
 * backupService.connectionCopy-2913.test.ts (cited per constant below), and the
 * orchestrator's exported disconnect message. Nothing is retyped.
 * Not transcribed: the MBErrorDomain/4 description text. The classifier keys on the
 * number (MB_ERROR_FILE_MISSING), so the description does not reach the message.
 */
import React from "react";
import { render, screen, act, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { classifyBackupFailure } from "../../../../electron/services/backupService";
import { BACKUP_DEVICE_DISCONNECTED_MESSAGE } from "../../../../electron/services/deviceSyncOrchestrator";
import { useIPhoneSync, syncStateRef, SYNC_STILL_FINISHING_MESSAGE } from "../../../hooks/useIPhoneSync";
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
// Producer output (see header)
// ---------------------------------------------------------------------------

/** failureCause-2913 `stdoutFailureBlock`, transcribed from main.log 22:44:38. */
const stdoutFailureBlock = (code: number, description: string) => `Backup directory is "/Users/tester/Library/Application Support/keepr/Backups"
Started "com.apple.mobilebackup2" service on port 49907.
Negotiated Protocol Version 2.1
Reading Info.plist from backup.
Starting backup...
Backup will be unencrypted.
Requesting backup from device...
Incremental backup mode.
*** Waiting for passcode to be entered on the device ***
ErrorCode ${code}: ${description}
Received 0 files from device.
Backup Failed (Error Code ${code}).`;
/** failureCause-2913 `STDOUT_NO_ERROR_LINE`. */
const STDOUT_NO_ERROR_LINE = `Backup directory is "/Users/tester/Library/Application Support/keepr/Backups"
Started "com.apple.mobilebackup2" service on port 49907.
Negotiated Protocol Version 2.1
Reading Info.plist from backup.
Starting backup...
Requesting backup from device...`;
/** failureCause-2913 `BROKEN_PIPE_TAIL`, transcribed from main.log 22:35:45. */
const BROKEN_PIPE_TAIL = `22:35:45.355 idevice.c:1017 internal_ssl_write(): pre-send length = 31 bytes
22:35:45.355 idevice.c:643 internal_connection_send(): ERROR: usbmuxd_send returned -32 (Broken pipe)
22:35:45.355 idevice.c:1019 internal_ssl_write(): ERROR: internal_connection_send returned -2
22:35:45.356 idevice.c:1550 idevice_connection_disable_bypass_ssl(): SSL mode disabled`;
/** failureCause-2913 `VERSION_EXCHANGE_TAIL`, transcribed from BACKLOG-2951's runbook. */
const VERSION_EXCHANGE_TAIL = `22:54:30.508 mobilebackup2.c:216 mobilebackup2_client_new(): version exchange failed, error -5
Could not perform backup protocol version exchange, error code -1`;

interface Failure {
  name: string;
  error: string;
  errorCode?: string;
  /** Whether this failure starts the 30 s hold. */
  holds: boolean;
}
const classified = (name: string, exit: number, stdout: string, stderr: string, transferStarted = false, holds = false): Failure => {
  const c = classifyBackupFailure(exit, stdout, stderr, transferStarted);
  return { name, error: c.message, errorCode: c.errorCode, holds };
};

const CONNECTION_LOST = classified("CONNECTION_LOST before transfer", 255, STDOUT_NO_ERROR_LINE, BROKEN_PIPE_TAIL, false, true);
const SERVICE_UNAVAILABLE = classified("SERVICE_UNAVAILABLE", 255, STDOUT_NO_ERROR_LINE, VERSION_EXCHANGE_TAIL, false, true);
const DEVICE_LOCKED = classified("DEVICE_LOCKED", 48, stdoutFailureBlock(208, "Device locked (MBErrorDomain/208)"), "");

const FAILURES: Failure[] = [
  CONNECTION_LOST,
  classified("CONNECTION_LOST mid-transfer", 255, STDOUT_NO_ERROR_LINE, BROKEN_PIPE_TAIL, true, true),
  SERVICE_UNAVAILABLE,
  DEVICE_LOCKED,
  classified(
    "INSUFFICIENT_SPACE",
    105,
    stdoutFailureBlock(105, "Insufficient free disk space on drive to back up (MBErrorDomain/105)"),
    "",
  ),
  classified("BACKUP_FILE_MISSING", 4, stdoutFailureBlock(4, "File missing (MBErrorDomain/4)"), ""),
  classified("UNKNOWN_ERROR (no reason)", 1, STDOUT_NO_ERROR_LINE, ""),
  // The orchestrator's own disconnect exit (deviceSyncOrchestrator.ts, errorResult(..., "CONNECTION_LOST")).
  { name: "device disconnected (orchestrator exit)", error: BACKUP_DEVICE_DISCONNECTED_MESSAGE, errorCode: "CONNECTION_LOST", holds: true },
];

// ---------------------------------------------------------------------------
// window.api.sync double — the IPC surface the hook subscribes to
// ---------------------------------------------------------------------------

const DEVICE = {
  udid: "00008110-000A3816000B3816",
  name: "Test iPhone",
  productType: "iPhone15,2",
  productVersion: "18.0",
  serialNumber: "SERIAL3816",
  isConnected: true,
};

type Cb = (arg?: unknown) => void;
const cbs: Record<string, Cb> = {};
const on = (name: string) => jest.fn((cb: Cb) => { cbs[name] = cb; return jest.fn(); });

let syncApi: Record<string, jest.Mock>;
let resolveStart: ((reply: unknown) => void) | null = null;

function installApi() {
  syncApi = {
    startDetection: jest.fn(),
    stopDetection: jest.fn(),
    start: jest.fn(() => new Promise((resolve) => { resolveStart = resolve; })),
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

function Harness({ showFlow }: { showFlow: boolean }) {
  currentHook = useIPhoneSync(true);
  return showFlow ? <IPhoneSyncFlow /> : null;
}

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

async function connect() {
  await act(async () => {
    cbs.connected(DEVICE);
  });
  await flush();
}

/** Click Sync, get to the backup phase, then the reply fails with `failure`. */
async function failASync(failure: Failure) {
  fireEvent.click(screen.getByRole("button", { name: /Sync Messages & Contacts/ }));
  await flush();
  expect(syncApi.start).toHaveBeenCalled();
  await act(async () => {
    cbs.progress({ phase: "backup", overallProgress: 5, message: "Backing up..." });
  });
  await act(async () => {
    resolveStart!({ success: false, error: failure.error, errorCode: failure.errorCode, messageCount: 0, contactCount: 0, conversationCount: 0, duration: 1 });
  });
  await flush();
}

const tryAgainButton = () => screen.getByRole("button", { name: /Try Again|Getting ready/ });

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-10-11T02:31:00Z"));
  syncStateRef.isActive = false;
  syncStateRef.deferredLogout = false;
  syncOrchestrator.reset();
  resolveStart = null;
  for (const k of Object.keys(cbs)) delete cbs[k];
  installApi();
});

afterEach(() => {
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// (A) every classified failure shows its message — including after a reconnect
// ---------------------------------------------------------------------------

describe("(A) the error screen always says why", () => {
  it.each(FAILURES.map((f) => [f.name, f] as const))(
    "%s: the message is shown, and a reconnect (cable wiggle) does not clear it",
    async (_name, failure) => {
      expect(failure.error.length).toBeGreaterThan(20);
      render(<Harness showFlow />);
      await connect();
      await failASync(failure);

      expect(screen.getByText("Sync Failed")).toBeInTheDocument();
      expect(screen.getByTestId("sync-error-message")).toHaveTextContent(failure.error);

      // The wiggle: the detector reports the phone gone, then back.
      await act(async () => {
        cbs.disconnected(DEVICE);
      });
      await act(async () => {
        cbs.connected(DEVICE);
      });
      await flush();

      expect(screen.getByText("Sync Failed")).toBeInTheDocument();
      expect(screen.getByTestId("sync-error-message")).toHaveTextContent(failure.error);
    },
  );

  it("renderer-detected disconnect mid-backup, then reconnect: the disconnect line stays", async () => {
    render(<Harness showFlow />);
    await connect();
    fireEvent.click(screen.getByRole("button", { name: /Sync Messages & Contacts/ }));
    await flush();
    await act(async () => {
      cbs.progress({ phase: "backup", overallProgress: 5, message: "Backing up..." });
    });
    await act(async () => {
      cbs.disconnected(DEVICE);
    });
    await act(async () => {
      cbs.connected(DEVICE);
    });
    await flush();

    expect(screen.getByText("Sync Failed")).toBeInTheDocument();
    expect(screen.getByTestId("sync-error-message")).toHaveTextContent("Device disconnected during sync");
  });

  it("a reconnect while NOT on the error screen still clears a stale message (no regression)", async () => {
    render(<Harness showFlow />);
    await act(async () => {
      await currentHook!.startSync(); // no device yet -> "No device connected"
    });
    expect(currentHook!.error).toBe("No device connected");
    await connect();
    expect(currentHook!.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (B) Try Again shows "Getting ready…" and never fails silently
// ---------------------------------------------------------------------------

describe("(B) Try Again feedback", () => {
  it("Try Again is disabled with Getting ready… while the request is prepared, then the sync starts", async () => {
    render(<Harness showFlow />);
    await connect();
    await failASync(DEVICE_LOCKED); // no hold, so Try Again is live

    let resolveStatus: (v: unknown) => void = () => undefined;
    syncApi.getUnifiedStatus.mockImplementationOnce(() => new Promise((r) => { resolveStatus = r; }));
    syncApi.start.mockClear();
    fireEvent.click(tryAgainButton());
    await flush();

    expect(tryAgainButton()).toBeDisabled();
    expect(screen.getByTestId("sync-getting-ready")).toHaveTextContent("Getting ready…");
    expect(syncApi.start).not.toHaveBeenCalled();

    await act(async () => {
      resolveStatus({ isAnyOperationRunning: false, currentOperation: null });
    });
    await flush();
    expect(syncApi.start).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Sync Failed")).not.toBeInTheDocument();
    expect(currentHook!.isStarting).toBe(false);
  });

  it("refused because the previous sync is still finishing: says so, and Try Again comes back", async () => {
    render(<Harness showFlow />);
    await connect();
    await failASync(DEVICE_LOCKED);

    syncApi.getUnifiedStatus.mockResolvedValueOnce({
      isAnyOperationRunning: true,
      currentOperation: "Cleaning up the unfinished iPhone backup",
    });
    syncApi.start.mockClear();
    fireEvent.click(tryAgainButton());
    await flush();

    expect(syncApi.start).not.toHaveBeenCalled();
    expect(screen.getByText("Sync Failed")).toBeInTheDocument();
    expect(screen.getByTestId("sync-error-message")).toHaveTextContent(SYNC_STILL_FINISHING_MESSAGE);
    expect(tryAgainButton()).toBeEnabled();
    expect(tryAgainButton()).toHaveTextContent("Try Again");
  });
});

// ---------------------------------------------------------------------------
// (C) the 30 s hold after CONNECTION_LOST / SERVICE_UNAVAILABLE
// ---------------------------------------------------------------------------

describe("(C) retry hold", () => {
  it.each(FAILURES.map((f) => [f.name, f] as const))("%s: hold matches the code", async (_n, failure) => {
    render(<Harness showFlow />);
    await connect();
    await failASync(failure);
    if (failure.holds) {
      expect(tryAgainButton()).toBeDisabled();
      expect(screen.getByTestId("sync-retry-cooldown")).toHaveTextContent(
        "Your iPhone is finishing the last session — you can try again in 30 seconds",
      );
    } else {
      expect(tryAgainButton()).toBeEnabled();
      expect(screen.queryByTestId("sync-retry-cooldown")).not.toBeInTheDocument();
    }
  });

  it("boundary: disabled at 29 999 ms ('1 second'), enabled at 30 000 ms", async () => {
    render(<Harness showFlow />);
    await connect();
    await failASync(CONNECTION_LOST);

    await act(async () => {
      jest.advanceTimersByTime(29_999);
    });
    expect(tryAgainButton()).toBeDisabled();
    expect(screen.getByTestId("sync-retry-cooldown")).toHaveTextContent("you can try again in 1 second");
    expect(screen.getByTestId("sync-retry-cooldown")).not.toHaveTextContent("1 seconds");

    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    await act(async () => {
      jest.advanceTimersByTime(250); // next countdown tick re-renders
    });
    expect(tryAgainButton()).toBeEnabled();
    expect(screen.queryByTestId("sync-retry-cooldown")).not.toBeInTheDocument();

    // And the button works again.
    syncApi.start.mockClear();
    fireEvent.click(tryAgainButton());
    await flush();
    expect(syncApi.start).toHaveBeenCalledTimes(1);
  });

  it("survives Close and reopening: Close at +10 s, reopen at +12 s shows 18 seconds on the Sync button", async () => {
    const { rerender } = render(<Harness showFlow />);
    await connect();
    await failASync(SERVICE_UNAVAILABLE);

    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await flush();
    rerender(<Harness showFlow={false} />);
    await act(async () => {
      jest.advanceTimersByTime(2_000);
    });
    rerender(<Harness showFlow />);
    await flush();

    const sync = screen.getByRole("button", { name: /Sync Messages & Contacts/ });
    expect(sync).toBeDisabled();
    expect(screen.getByTestId("sync-retry-cooldown")).toHaveTextContent("you can try again in 18 seconds");

    // startSync itself refuses during the hold (backstop for any other caller).
    syncApi.start.mockClear();
    await act(async () => {
      await currentHook!.startSync();
    });
    expect(syncApi.start).not.toHaveBeenCalled();
  });

  it("a renderer-detected disconnect starts the hold too", async () => {
    render(<Harness showFlow />);
    await connect();
    fireEvent.click(screen.getByRole("button", { name: /Sync Messages & Contacts/ }));
    await flush();
    await act(async () => {
      cbs.progress({ phase: "backup", overallProgress: 5, message: "Backing up..." });
    });
    await act(async () => {
      cbs.disconnected(DEVICE);
    });
    await act(async () => {
      cbs.connected(DEVICE);
    });
    await flush();
    expect(tryAgainButton()).toBeDisabled();
    expect(screen.getByTestId("sync-retry-cooldown")).toHaveTextContent("30 seconds");
  });
});

// ---------------------------------------------------------------------------
// (D) the dashboard indicator after a failed reply
// ---------------------------------------------------------------------------

describe("(D) dashboard indicator", () => {
  const iphoneRow = () => syncOrchestrator.getState().queue.find((i) => i.type === "iphone");

  it("Try Again pending -> SERVICE_UNAVAILABLE reply -> the iPhone row is failed and nothing is running", async () => {
    render(<Harness showFlow />);
    await connect();
    await failASync(DEVICE_LOCKED); // first failure, then Try Again
    resolveStart = null;

    fireEvent.click(tryAgainButton());
    await flush();
    expect(syncApi.start).toHaveBeenCalledTimes(2);
    expect(iphoneRow()?.status).toBe("running");
    expect(syncOrchestrator.getState().isRunning).toBe(true);

    await act(async () => {
      resolveStart!({ success: false, error: SERVICE_UNAVAILABLE.error, errorCode: "SERVICE_UNAVAILABLE", messageCount: 0, contactCount: 0, conversationCount: 0, duration: 1 });
    });
    await flush();

    expect(iphoneRow()?.status).toBe("error");
    expect(syncOrchestrator.getState().isRunning).toBe(false);
    expect(screen.getByTestId("sync-error-message")).toHaveTextContent(SERVICE_UNAVAILABLE.error);
  });
});
