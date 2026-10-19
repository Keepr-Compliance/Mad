/**
 * BACKLOG-3996: the sync when a pre-flight iPhone query does not answer, and Cancel
 * while one is running.
 *
 *  C3   Cancel during the storage query aborts the signal handed to that query (the
 *       query's own kill on abort is proven in deviceDetectionService.toolTimeout-3996).
 *  C4   Cancel during the backup-encryption check returns at once ("Sync cancelled by
 *       user") and aborts the signal handed to that check. Before this it was a plain
 *       await that Cancel could not end.
 *  C13  a timed-out storage query, a timed-out encryption check, and an
 *       IPHONE_TOOL_TIMEOUT result from startBackup each end the sync with the
 *       time-out message (structured, for the sync screen) and reason IPHONE_TOOL_TIMEOUT.
 *  R7   a watchdog stop (BACKUP_TIMEOUT) and a refused backup service
 *       (SERVICE_UNAVAILABLE) never produce the time-out message.
 *
 * Harness copied from deviceSyncOrchestrator.toolBlocked-3953.test.ts; runs as darwin
 * (no Windows driver or tool-file pre-flight).
 */
import { EventEmitter } from "events";

const UDID = "00008030-0011223344556677";
const GB = 1024 * 1024 * 1024;

const mockStartBackup = jest.fn();
const mockCheckBackupStatus = jest.fn();
const mockCancelBackup = jest.fn();
const mockStopForQuit = jest.fn();
const mockCheckEncryptionStatus = jest.fn();
const mockGetDeviceStorageInfo = jest.fn();

// BACKLOG-3816 S4-C: the kept backup's at-rest layer is not this suite's subject.
jest.mock("../atRest/backupAtRest", () => ({
  ...jest.requireActual("../atRest/backupAtRest"),
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  getBackupAtRest: () => require("./helpers/passThroughBackupAtRest").passThroughBackupAtRest,
}));
jest.mock("electron", () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  app: { isPackaged: false, getPath: jest.fn(() => require("./helpers/testUserData").testUserDataDir()) },
}));

const logLines: string[] = [];

jest.mock("electron-log", () => ({
  info: (...args: unknown[]) => {
    logLines.push(args.map(String).join(" "));
  },
  warn: (...args: unknown[]) => {
    logLines.push(args.map(String).join(" "));
  },
  error: (...args: unknown[]) => {
    logLines.push(args.map(String).join(" "));
  },
  debug: jest.fn(),
}));

jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureMessage: jest.fn(),
  captureException: jest.fn(),
}));

jest.mock("better-sqlite3-multiple-ciphers", () =>
  jest.fn().mockImplementation(() => ({
    prepare: jest.fn().mockReturnValue({ all: jest.fn(), get: jest.fn(), run: jest.fn() }),
    close: jest.fn(),
  })),
);

jest.mock("check-disk-space", () =>
  jest.fn().mockResolvedValue({ diskPath: "C:", free: 500 * GB, size: 1000 * GB }),
);

jest.mock("../diagnostics/diskSpaceDiagnostics", () => ({
  ...jest.requireActual("../diagnostics/diskSpaceDiagnostics"),
  checkDiskSpaceForOperation: jest
    .fn()
    .mockResolvedValue({ sufficient: true, availableMB: 500000, requiredMB: 1000 }),
}));

const mockCheckAppleDrivers = jest.fn();
jest.mock("../appleDriverService", () => ({
  checkAppleDrivers: (...a: unknown[]) => mockCheckAppleDrivers(...a),
}));

let mockToolsDir = "";
jest.mock("../libimobiledeviceService", () => ({
  ...jest.requireActual("../libimobiledeviceService"),
  getLibimobiledevicePath: () => mockToolsDir,
  canUseLibimobiledevice: jest.fn(() => true),
  getCommand: jest.fn(() => "/nonexistent/idevicebackup2"),
  isMockMode: jest.fn(() => false),
}));

// C12: the row the Supabase writer would send. The real row builder runs on it.
const mockOutcomeRows: unknown[] = [];
jest.mock("../syncOutcomeSupabase", () => ({
  ...jest.requireActual("../syncOutcomeSupabase"),
  recordSyncOutcome: (row: unknown) => mockOutcomeRows.push(row),
  recordSyncRunStart: jest.fn(),
  recordSyncRunProgress: jest.fn(),
  recordSyncRunProgressWhileRunning: jest.fn(),
  recordSyncRunMetrics: jest.fn(),
}));

/** Captured so a test can drive the real `progress` / `backup-mode` events. */
let backupServiceInstance: EventEmitter | null = null;

jest.mock("../backupService", () => ({
  BackupService: jest.fn().mockImplementation(() => {
    const svc = new EventEmitter();
    backupServiceInstance = svc;
    return Object.assign(svc, {
      checkBackupStatus: mockCheckBackupStatus,
      startBackup: mockStartBackup,
      cancelBackup: mockCancelBackup,
      stopForQuit: mockStopForQuit,
      checkEncryptionStatus: (...a: unknown[]) => mockCheckEncryptionStatus(...a),
      // BACKLOG-3598: leftover cleanup. Inert here; the cleanup itself is proven in
      // deviceSyncOrchestrator.failedSyncCleanup-3598.test.ts against a real folder.
      sweepLeftoverBackups: jest.fn().mockResolvedValue({ removed: 0, bytesFreed: 0, failures: [] }),
      classifyBackupFolder: jest.fn().mockResolvedValue("absent"),
      removeLeftoverBackup: jest.fn().mockResolvedValue({ outcome: "kept", folder: "absent" }),
    });
  }),
}));

jest.mock("../backupDecryptionService", () => ({
  BackupDecryptionService: jest.fn().mockImplementation(() => ({
    isBackupEncrypted: jest.fn().mockResolvedValue(false),
    decryptBackup: jest.fn(),
    cleanup: jest.fn(),
  })),
  backupDecryptionService: { isBackupEncrypted: jest.fn().mockResolvedValue(false) },
}));

jest.mock("../deviceDetectionService", () => {
  const svc = new EventEmitter();
  Object.assign(svc, {
    start: jest.fn(),
    stop: jest.fn(),
    getConnectedDevices: jest.fn().mockReturnValue([
      {
        udid: UDID,
        // A NAME is present deliberately, so the PII control has something to leak.
        // A placeholder: the founder's real device name is a personal nickname.
        name: "Daniel's iPhone",
        productType: "iPhone18,2",
        productVersion: "26.6.1",
        serialNumber: "F2LX00000000",
        isConnected: true,
      },
    ]),
    getDeviceStorageInfo: (...a: unknown[]) => mockGetDeviceStorageInfo(...a),
  });
  return {
    DeviceDetectionService: jest.fn().mockImplementation(() => svc),
    deviceDetectionService: svc,
  };
});

jest.mock("../iosMessagesParser", () => ({
  iOSMessagesParser: jest.fn().mockImplementation(() => ({
    open: jest.fn(),
    close: jest.fn(),
    getConversationsAsync: jest.fn().mockResolvedValue([]),
    getMessagesAsync: jest.fn().mockResolvedValue([]),
  })),
}));

jest.mock("../iosContactsParser", () => ({
  iOSContactsParser: jest.fn().mockImplementation(() => ({
    open: jest.fn(),
    close: jest.fn(),
    getAllContacts: jest.fn().mockReturnValue([]),
    lookupByHandle: jest.fn().mockReturnValue({ contact: null, matchType: null }),
  })),
}));

import { DeviceSyncOrchestrator } from "../deviceSyncOrchestrator";
import { syncTimeline } from "../syncTimeline";
import { buildSyncOutcomeRow } from "../syncOutcomeSupabase";
import type { SyncOutcomeRow } from "../syncTimeline";
import { formatIphoneToolTimeoutError } from "../diagnostics/userFacingErrors";

const STORAGE = {
  totalCapacity: 256 * GB,
  usedSpace: 128 * GB,
  availableSpace: 128 * GB,
  estimatedBackupSize: 11_547 * 1024 * 1024,
};
const OFF = { isEncrypted: false, needsPassword: false, status: "off" };
const TIMEOUT_MESSAGE = formatIphoneToolTimeoutError();

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

beforeEach(() => {
  jest.clearAllMocks();
  syncTimeline.reset();
  mockOutcomeRows.length = 0;
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  mockToolsDir = "/nonexistent";
  mockCheckBackupStatus.mockResolvedValue({ state: "absent" });
  mockGetDeviceStorageInfo.mockReset().mockResolvedValue(STORAGE);
  mockCheckEncryptionStatus.mockReset().mockResolvedValue(OFF);
  mockStartBackup.mockReset();
});
afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
});

type Captured = Array<{ message: string; userError?: { code: string; title?: string } }>;

function start() {
  const orchestrator = new DeviceSyncOrchestrator();
  const errors: Captured = [];
  orchestrator.on("error", (e) => errors.push(e));
  const result = orchestrator.sync({ udid: UDID });
  return { orchestrator, errors, result };
}

function rowOf() {
  expect(mockOutcomeRows).toHaveLength(1);
  return buildSyncOutcomeRow(mockOutcomeRows[0] as SyncOutcomeRow, "user-1");
}

/** Resolves with the call's options once the mock is reached; the call itself never settles. */
function hold(mock: jest.Mock): Promise<{ signal?: AbortSignal }> {
  return new Promise((reached) => {
    mock.mockImplementation((_udid: string, opts?: { signal?: AbortSignal }) => {
      reached(opts ?? {});
      return new Promise(() => undefined);
    });
  });
}

const backupResult = (errorCode: string, error = "x") => ({
  success: false, backupPath: null, error, errorCode,
  duration: 1, deviceUdid: UDID, isIncremental: false, backupSize: null, isEncrypted: false,
});

describe("C3: Cancel during the storage query", () => {
  it("aborts the signal the query was given, and the sync ends cancelled", async () => {
    const reached = hold(mockGetDeviceStorageInfo);
    const { orchestrator, result } = start();
    const opts = await reached;
    expect(opts.signal).toBeDefined();
    expect(opts.signal!.aborted).toBe(false);
    orchestrator.cancel();
    expect(opts.signal!.aborted).toBe(true);
    await expect(result).resolves.toMatchObject({ success: false, error: "Sync cancelled by user" });
    expect(mockStartBackup).not.toHaveBeenCalled();
  });
});

describe("C4: Cancel during the backup-encryption check", () => {
  it("returns at once, aborts the check's signal, and never starts the backup", async () => {
    const reached = hold(mockCheckEncryptionStatus);
    const { orchestrator, result } = start();
    const opts = await reached;
    expect(opts.signal).toBeDefined();
    orchestrator.cancel();
    expect(opts.signal!.aborted).toBe(true);
    await expect(result).resolves.toMatchObject({ success: false, error: "Sync cancelled by user" });
    expect(mockStartBackup).not.toHaveBeenCalled();
  });
});

describe("C13: a pre-flight query timed out", () => {
  it("storage query: the sync ends with the time-out message and reason", async () => {
    mockGetDeviceStorageInfo.mockImplementation(
      async (_u: string, opts?: { onTimeout?: () => void }) => {
        opts?.onTimeout?.();
        return null;
      },
    );
    const { errors, result } = start();
    const r = await result;
    expect(r.errorCode).toBe("IPHONE_TOOL_TIMEOUT");
    expect(r.error).toBe(TIMEOUT_MESSAGE.description);
    expect(errors.map((e) => e.userError)).toEqual([TIMEOUT_MESSAGE]);
    expect(mockStartBackup).not.toHaveBeenCalled();
    const row = rowOf();
    expect(row.reason_code).toBe("IPHONE_TOOL_TIMEOUT");
    expect(row.ended_by).toBe("tool-timeout");
  });

  it("storage query answered null WITHOUT a time-out: no time-out message (unknown size path)", async () => {
    mockGetDeviceStorageInfo.mockResolvedValue(null);
    const { errors, result } = start();
    await result;
    expect(errors.map((e) => e.userError?.code)).not.toContain("IPHONE_TOOL_TIMEOUT");
  });

  it("encryption check: the sync ends with the time-out message and the backup is not started", async () => {
    mockCheckEncryptionStatus.mockResolvedValue({ isEncrypted: false, needsPassword: false, status: "unknown", timedOut: true });
    const { errors, result } = start();
    const r = await result;
    expect(r.errorCode).toBe("IPHONE_TOOL_TIMEOUT");
    expect(errors.map((e) => e.userError)).toEqual([TIMEOUT_MESSAGE]);
    expect(mockStartBackup).not.toHaveBeenCalled();
    expect(rowOf().reason_code).toBe("IPHONE_TOOL_TIMEOUT");
  });

  it("an IPHONE_TOOL_TIMEOUT result from startBackup sends the structured message", async () => {
    mockStartBackup.mockResolvedValue(backupResult("IPHONE_TOOL_TIMEOUT", TIMEOUT_MESSAGE.description));
    const { errors, result } = start();
    const r = await result;
    expect(r.errorCode).toBe("IPHONE_TOOL_TIMEOUT");
    expect(errors.map((e) => e.userError)).toEqual([TIMEOUT_MESSAGE]);
    const row = rowOf();
    expect(row.reason_code).toBe("IPHONE_TOOL_TIMEOUT");
    expect(row.ended_by).toBe("tool-timeout");
  });
});

describe("R7: other failures never map to the time-out message", () => {
  it.each(["BACKUP_TIMEOUT", "SERVICE_UNAVAILABLE"])("%s", async (code) => {
    mockStartBackup.mockResolvedValue(backupResult(code));
    const { errors, result } = start();
    const r = await result;
    expect(r.errorCode).toBe(code);
    expect(errors.map((e) => e.userError?.code)).not.toContain("IPHONE_TOOL_TIMEOUT");
    expect(r.error).not.toBe(TIMEOUT_MESSAGE.description);
    expect(rowOf().reason_code).toBe(code);
  });
});
