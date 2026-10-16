/**
 * BACKLOG-3953: the sync when an iPhone tool never started (Windows).
 *
 *  C3  pre-flight: idevicebackup2.exe gone -> the sync ends TOOL_BLOCKED before the
 *      driver check and before any backup starts.
 *  C12 both producers write reason_code "TOOL_BLOCKED" and ended_by "tool-blocked" into
 *      the sync_outcomes row (the real buildSyncOutcomeRow runs on the reported row):
 *      the pre-flight exit (SR R3: the other pre-flight exits record no reason) and a
 *      TOOL_BLOCKED result from backupService.
 *  Both emit the structured message, which is what puts the steps on the sync screen.
 *
 * Mocks copied from deviceSyncOrchestrator.runEvidence-3440.test.ts; the tools folder is
 * real (helpers/iphoneToolsFolder-3953).
 */
import { EventEmitter } from "events";

const UDID = "00008030-0011223344556677";
const GB = 1024 * 1024 * 1024;

const mockStartBackup = jest.fn();
const mockCheckBackupStatus = jest.fn();
const mockCancelBackup = jest.fn();
const mockStopForQuit = jest.fn();

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
    getDeviceStorageInfo: jest.fn().mockResolvedValue({
      totalCapacity: 256 * GB,
      usedSpace: 128 * GB,
      availableSpace: 128 * GB,
      estimatedBackupSize: 11_547 * 1024 * 1024,
    }),
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
import { __resetToolBlockReportForTests } from "../iphoneToolBlock";
import { REQUIRED_IPHONE_TOOL_FILES } from "../libimobiledeviceService";
import { formatToolBlockedError } from "../diagnostics/userFacingErrors";
import { makeToolsFolder, type ToolsFolder } from "./helpers/iphoneToolsFolder-3953";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
let folder: ToolsFolder;

beforeEach(() => {
  jest.clearAllMocks();
  syncTimeline.reset();
  mockOutcomeRows.length = 0;
  __resetToolBlockReportForTests();
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  folder = makeToolsFolder(REQUIRED_IPHONE_TOOL_FILES);
  mockToolsDir = folder.dir;
  mockCheckAppleDrivers.mockResolvedValue({ isInstalled: true, serviceRunning: true, version: "12.0.0", error: null });
  mockCheckBackupStatus.mockResolvedValue({ state: "absent" });
});
afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  folder.cleanup();
});

async function runSync() {
  const orchestrator = new DeviceSyncOrchestrator();
  const errors: Array<{ message: string; userError?: { code: string } }> = [];
  orchestrator.on("error", (e) => errors.push(e));
  const result = await orchestrator.sync({ udid: UDID });
  expect(mockOutcomeRows).toHaveLength(1);
  const row = buildSyncOutcomeRow(mockOutcomeRows[0] as SyncOutcomeRow, "user-1");
  return { result, errors, row };
}

describe("C3 + C12: pre-flight finds a required file missing", () => {
  it("ends TOOL_BLOCKED before the driver check and the backup, and the row says why", async () => {
    folder.remove("idevicebackup2.exe");
    const { result, errors, row } = await runSync();

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("TOOL_BLOCKED");
    expect(mockStartBackup).not.toHaveBeenCalled();
    expect(mockCheckAppleDrivers).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
    expect(errors[0].userError).toEqual(formatToolBlockedError(null));

    expect(row.reason_code).toBe("TOOL_BLOCKED");
    expect(row.ended_by).toBe("tool-blocked");
    expect(row.outcome).toBe("error");
  });

  it("every file present: the pre-flight passes and the driver check runs", async () => {
    mockStartBackup.mockResolvedValue({
      success: false, backupPath: null, error: "x", errorCode: "DEVICE_LOCKED",
      duration: 1, deviceUdid: UDID, isIncremental: false, backupSize: null, isEncrypted: false,
    });
    const { row } = await runSync();
    expect(mockCheckAppleDrivers).toHaveBeenCalled();
    expect(mockStartBackup).toHaveBeenCalled();
    expect(row.reason_code).toBe("DEVICE_LOCKED");
  });
});

describe("C12: a TOOL_BLOCKED result from the backup tool", () => {
  it("writes reason_code TOOL_BLOCKED, ended_by tool-blocked, and sends the steps", async () => {
    mockStartBackup.mockResolvedValue({
      success: false,
      backupPath: null,
      error: formatToolBlockedError().description,
      errorCode: "TOOL_BLOCKED",
      toolBlock: { kind: "spawn-eperm", tool: "idevicebackup2", missingFiles: [], spawnCode: "EPERM" },
      duration: 3,
      deviceUdid: UDID,
      isIncremental: false,
      backupSize: 0,
      isEncrypted: false,
    });
    const { result, errors, row } = await runSync();
    expect(result.errorCode).toBe("TOOL_BLOCKED");
    expect(row.reason_code).toBe("TOOL_BLOCKED");
    expect(row.ended_by).toBe("tool-blocked");
    expect(errors.map((e) => e.userError?.code)).toEqual(["SECURITY_SOFTWARE_BLOCKED"]);
  });
});
