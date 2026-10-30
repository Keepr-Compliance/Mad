/**
 * BACKLOG-4002 — the orchestrator's half: BACKUP_TIMEOUT gets its own message (variant
 * picked by toolSuspendedAtTimeout, SR R7), and the backup service's tool-suspended /
 * tool-resumed events are forwarded as one "tool-suspended" event with a flag.
 *
 * Harness copied from deviceSyncOrchestrator.toolTimeout-3996.test.ts; runs as darwin
 * unless a test sets win32.
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
import { formatIphoneToolTimeoutError, formatBackupWatchdogError } from "../diagnostics/userFacingErrors";

const STORAGE = {
  totalCapacity: 256 * GB,
  usedSpace: 128 * GB,
  availableSpace: 128 * GB,
  estimatedBackupSize: 11_547 * 1024 * 1024,
};
const OFF = { isEncrypted: false, needsPassword: false, status: "off" };

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

const backupResult = (errorCode: string, extra: Record<string, unknown> = {}) => ({
  success: false, backupPath: null, error: "Backup process became unresponsive and was terminated", errorCode,
  duration: 1, deviceUdid: UDID, isIncremental: false, backupSize: null, isEncrypted: false, ...extra,
});

describe("BACKUP_TIMEOUT: its own message", () => {
  it("b2 (the notice was not showing): 'The backup stopped making progress', never the time-out message", async () => {
    mockStartBackup.mockResolvedValue(backupResult("BACKUP_TIMEOUT"));
    const { errors, result } = start();
    const r = await result;
    expect(r.errorCode).toBe("BACKUP_TIMEOUT");
    const expected = formatBackupWatchdogError({ toolSuspendedAtTimeout: false, keeprFolder: null, platform: "darwin" });
    expect(errors.map((e) => e.userError)).toEqual([expected]);
    expect(expected.title).toBe("The backup stopped making progress");
    expect(errors.map((e) => e.userError?.code)).not.toContain("IPHONE_TOOL_TIMEOUT");
    expect(rowOf().ended_by).toBe("watchdog");
  });

  it("b1 (the notice was showing when the watchdog fired): the antivirus variant", async () => {
    mockStartBackup.mockResolvedValue(backupResult("BACKUP_TIMEOUT", { toolSuspendedAtTimeout: true }));
    const { errors, result } = start();
    await result;
    expect(errors.map((e) => e.userError)).toEqual([
      formatBackupWatchdogError({ toolSuspendedAtTimeout: true, keeprFolder: null, platform: "darwin" }),
    ]);
    expect(errors[0].userError?.title).toBe("Your antivirus may have paused the backup");
  });

  it("other failures get no BACKUP_TIMEOUT message", async () => {
    mockStartBackup.mockResolvedValue(backupResult("SERVICE_UNAVAILABLE"));
    const { errors, result } = start();
    await result;
    expect(errors.map((e) => e.userError?.code)).not.toContain("BACKUP_TIMEOUT");
  });

  it("the IPHONE_TOOL_TIMEOUT message is unchanged by this (3996 R7 still holds)", async () => {
    mockStartBackup.mockResolvedValue(backupResult("IPHONE_TOOL_TIMEOUT"));
    const { errors, result } = start();
    await result;
    expect(errors.map((e) => e.userError)).toEqual([formatIphoneToolTimeoutError()]);
  });
});

describe("tool-suspended forwarding", () => {
  it("tool-suspended -> { suspended: true, userError }; tool-resumed -> { suspended: false }", async () => {
    const reached = hold(mockStartBackup);
    const { orchestrator, result } = start();
    const forwarded: unknown[] = [];
    orchestrator.on("tool-suspended", (p) => forwarded.push(p));
    await reached;
    const userError = { code: "IPHONE_TOOL_SUSPENDED", title: "t", description: "d", actionSuggestion: "a" };
    backupServiceInstance!.emit("tool-suspended", { userError });
    backupServiceInstance!.emit("tool-resumed");
    expect(forwarded).toEqual([{ suspended: true, userError }, { suspended: false }]);
    void result;
  });
});
