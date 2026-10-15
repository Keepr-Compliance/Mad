/**
 * BACKLOG-3816: processExistingBackup (re-process a kept backup) honours a cancel during
 * its pre-flight, like sync(): the size walk is not waited for, no later step runs, and
 * a decrypted copy made before the cancel is removed. Mocks transcribed from
 * deviceSyncOrchestrator.interruptedIsUsable-2911.test.ts.
 */
import { EventEmitter } from "events";

const UDID = "00008030-0011223344556677";

const mockStartBackup = jest.fn();
const mockCheckBackupStatus = jest.fn();

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
  jest.fn().mockResolvedValue({
    diskPath: "C:",
    free: 500 * 1024 * 1024 * 1024,
    size: 1000 * 1024 * 1024 * 1024,
  }),
);

jest.mock("../diagnostics/diskSpaceDiagnostics", () => ({
  ...jest.requireActual("../diagnostics/diskSpaceDiagnostics"),
  checkDiskSpaceForOperation: jest
    .fn()
    .mockResolvedValue({ sufficient: true, availableMB: 500000, requiredMB: 1000 }),
}));

jest.mock("../appleDriverService", () => ({
  checkAppleDrivers: jest
    .fn()
    .mockResolvedValue({ isInstalled: true, serviceRunning: true, version: "12.0.0", error: null }),
}));

jest.mock("../libimobiledeviceService", () => ({
  canUseLibimobiledevice: jest.fn(() => true),
  getCommand: jest.fn(() => "/nonexistent/idevicebackup2"),
  isMockMode: jest.fn(() => false),
}));

jest.mock("../backupService", () => ({
  BackupService: jest.fn().mockImplementation(() => {
    const svc = new EventEmitter();
    return Object.assign(svc, {
      checkBackupStatus: mockCheckBackupStatus,
      startBackup: mockStartBackup,
      cancelBackup: jest.fn(),
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
    getConnectedDevices: jest.fn().mockReturnValue([]),
    getDeviceStorageInfo: jest.fn().mockResolvedValue({
      totalSpace: 256 * 1024 * 1024 * 1024,
      usedSpace: 128 * 1024 * 1024 * 1024,
      freeSpace: 128 * 1024 * 1024 * 1024,
      // 11,547 MB — the exact wrong number from the 2026-08-28 run.
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

const COMPLETE = {
  state: "present" as const,
  isComplete: true,
  isInterrupted: false,
  snapshotState: "finished" as const,
  size: { measured: true as const, bytes: 1024 },
  lastModified: new Date("2026-10-09T00:00:00Z"),
};

interface Internals {
  decryptionService: { isBackupEncrypted: jest.Mock; decryptBackup: jest.Mock };
  contactsParser: { open: jest.Mock };
  discardParseCopy: (p: string | null) => Promise<void>;
}

function setup() {
  const o = new DeviceSyncOrchestrator();
  o.on("error", () => {});
  const internals = o as unknown as Internals;
  return { o, internals };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("BACKLOG-3816: processExistingBackup honours a cancel during pre-flight", () => {
  beforeEach(() => {
    mockCheckBackupStatus.mockReset().mockResolvedValue(COMPLETE);
  });

  it("cancel during the backup-status walk: ends within 1 s, nothing after it runs", async () => {
    const reached = deferred<void>();
    mockCheckBackupStatus.mockReset().mockImplementation(() => {
      reached.resolve();
      return new Promise(() => undefined); // the 576k-file walk
    });
    const { o, internals } = setup();
    const running = o.processExistingBackup({ udid: UDID, forceResync: true });
    await reached.promise;
    const at = Date.now();
    o.cancel("progress-cancel");
    const result = await running;
    expect(Date.now() - at).toBeLessThan(1000);
    expect(result.error).toBe("Processing cancelled by user");
    expect(mockCheckBackupStatus.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(internals.decryptionService.isBackupEncrypted).not.toHaveBeenCalled();
    expect(internals.contactsParser.open).not.toHaveBeenCalled();
  });

  it("cancel during the encryption check: stops when it returns, nothing is parsed", async () => {
    const { o, internals } = setup();
    const check = deferred<boolean>();
    internals.decryptionService.isBackupEncrypted.mockImplementation(() => check.promise);
    const running = o.processExistingBackup({ udid: UDID, forceResync: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(internals.decryptionService.isBackupEncrypted).toHaveBeenCalled();
    o.cancel("progress-cancel");
    check.resolve(false);
    const result = await running;
    expect(result.error).toBe("Processing cancelled by user");
    expect(internals.contactsParser.open).not.toHaveBeenCalled();
  });

});
