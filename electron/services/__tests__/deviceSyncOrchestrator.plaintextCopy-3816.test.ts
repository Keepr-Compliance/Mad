/**
 * BACKLOG-3816: the decrypted (plaintext) copy processExistingBackup makes is removed on
 * EVERY exit - a parser throw after decryption, a cancel, success - not left for the next
 * sweep. The real decryptionService.cleanup is the observable; discardParseCopy is NOT
 * stubbed. Mocks transcribed from deviceSyncOrchestrator.processCancel-3816.test.ts.
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
// BACKLOG-3816 S4-C (B1): no saved-password file I/O; this suite's subject is not the password.
jest.mock("../atRest/backupPassword", () => ({
  ...jest.requireActual("../atRest/backupPassword"),
  getBackupPasswordStore: () =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("./helpers/passThroughBackupAtRest").passThroughBackupPasswordStore,
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
  decryptionService: { isBackupEncrypted: jest.Mock; decryptBackup: jest.Mock; cleanup: jest.Mock; sweepParseCopiesSync?: jest.Mock };
  contactsParser: { open: jest.Mock };
  messagesParser: { open: jest.Mock; getConversationsAsync: jest.Mock };
  resolveBackupPassword: (...a: unknown[]) => Promise<unknown>;
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


const COPY = "/tmp/keepr-decrypted-3816-copy";

function encryptedRun() {
  const { o, internals } = setup();
  internals.decryptionService.isBackupEncrypted.mockResolvedValue(true);
  jest.spyOn(internals, "resolveBackupPassword").mockResolvedValue({ kind: "stored", password: "pw" });
  internals.decryptionService.decryptBackup.mockResolvedValue({
    success: true,
    decryptedPath: COPY,
    stats: { skipped: 0 },
  });
  internals.decryptionService.cleanup.mockReset().mockResolvedValue(true);
  return { o, internals };
}

describe("BACKLOG-3816: processExistingBackup removes the plaintext copy on every exit", () => {
  beforeEach(() => {
    mockCheckBackupStatus.mockReset().mockResolvedValue(COMPLETE);
  });

  it("a throw AFTER decryption (contacts parser): the copy is removed", async () => {
    const { o, internals } = encryptedRun();
    internals.contactsParser.open.mockRejectedValueOnce(new Error("parser blew up"));
    const result = await o.processExistingBackup({ udid: UDID, forceResync: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain("parser blew up");
    expect(internals.decryptionService.cleanup).toHaveBeenCalledWith(COPY);
  });

  it("a throw AFTER decryption (messages parser): the copy is removed", async () => {
    const { o, internals } = encryptedRun();
    internals.messagesParser.getConversationsAsync.mockRejectedValueOnce(new Error("sms.db unreadable"));
    const result = await o.processExistingBackup({ udid: UDID, forceResync: true });
    expect(result.success).toBe(false);
    expect(internals.decryptionService.cleanup).toHaveBeenCalledWith(COPY);
  });

  it("cancel right after decryption: the copy is removed, nothing is parsed", async () => {
    const { o, internals } = encryptedRun();
    internals.decryptionService.decryptBackup.mockImplementationOnce(async () => {
      o.cancel("progress-cancel");
      return { success: true, decryptedPath: COPY, stats: { skipped: 0 } };
    });
    const result = await o.processExistingBackup({ udid: UDID, forceResync: true });
    expect(result.error).toBe("Processing cancelled by user");
    expect(internals.decryptionService.cleanup).toHaveBeenCalledWith(COPY);
    expect(internals.contactsParser.open).not.toHaveBeenCalled();
  });

  it("success: the copy is removed", async () => {
    const { o, internals } = encryptedRun();
    const result = await o.processExistingBackup({ udid: UDID, forceResync: true });
    expect(result.success).toBe(true);
    expect(internals.decryptionService.cleanup).toHaveBeenCalledWith(COPY);
  });

  it("a removal that throws is logged, never silently ignored", async () => {
    const { o, internals } = encryptedRun();
    internals.decryptionService.cleanup.mockRejectedValue(new Error("EPERM: file in use"));
    internals.contactsParser.open.mockRejectedValueOnce(new Error("parser blew up"));
    logLines.length = 0;
    await o.processExistingBackup({ udid: UDID, forceResync: true });
    expect(logLines.some((l) => l.includes("Removing a decrypted parse copy failed") && l.includes("EPERM"))).toBe(true);
  });
});

describe("BACKLOG-3816: app quit removes parse copies synchronously", () => {
  it("discardParseCopiesForQuit asks the service for a synchronous sweep", () => {
    const { o, internals } = setup();
    internals.decryptionService.sweepParseCopiesSync = jest.fn().mockReturnValue({ removed: 1, failed: 0 });
    o.discardParseCopiesForQuit();
    expect(internals.decryptionService.sweepParseCopiesSync).toHaveBeenCalledTimes(1);
  });

  it("never throws, even when the sweep does", () => {
    const { o, internals } = setup();
    internals.decryptionService.sweepParseCopiesSync = jest.fn(() => {
      throw new Error("boom");
    });
    expect(() => o.discardParseCopiesForQuit()).not.toThrow();
  });
});
