/**
 * BACKLOG-3881 at the orchestrator: Keepr does not read Apple-encrypted iPhone backups.
 *
 *  A1  the phone reports "Encrypt local backup" ON: the run stops before anything is
 *      transferred, with the turn-it-off message, flagged appleEncryptedBackup. No
 *      password is asked for (no "password-required" event), nothing retries.
 *  A2  the phone's setting could not be read ("unknown") and the backup lands encrypted
 *      (backupService PASSWORD_REQUIRED, or a successful encrypted result): same stop,
 *      and nothing is decrypted.
 *  A3  the phone reports encryption OFF: the normal sync, with no password anywhere.
 *  A4  a stale renderer that still sends a password: it never reaches the backup.
 */
import fsSync from "fs";
import os from "os";
import path from "path";

const UDID = "00008030-0011223344556677";

// BACKLOG-3816 S4-C: the kept backup's at-rest layer is not this suite's subject.
jest.mock("../atRest/backupAtRest", () => ({
  ...jest.requireActual("../atRest/backupAtRest"),
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  getBackupAtRest: () => require("./helpers/passThroughBackupAtRest").passThroughBackupAtRest,
}));
jest.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: jest.fn(() => process.env.KEEPR_3881_USERDATA as string),
  },
}));

const logLines: string[] = [];
jest.mock("electron-log", () => ({
  info: (...args: unknown[]) => {
    logLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  },
  warn: (...args: unknown[]) => {
    logLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  },
  error: (...args: unknown[]) => {
    logLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
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
  jest.fn().mockResolvedValue({ diskPath: "C:", free: 500 * 1024 * 1024 * 1024, size: 1000 * 1024 * 1024 * 1024 }),
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

const mockDecryption = {
  isBackupEncrypted: jest.fn(),
  decryptBackup: jest.fn(),
  cleanup: jest.fn(),
  sweepParseCopies: jest.fn(),
  verifyManifestRoundTrip: jest.fn(),
};
jest.mock("../backupDecryptionService", () => ({
  BackupDecryptionService: jest.fn().mockImplementation(() => mockDecryption),
  backupDecryptionService: mockDecryption,
}));

jest.mock("../deviceDetectionService", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: Emitter } = require("events");
  const svc = new Emitter();
  Object.assign(svc, {
    start: jest.fn(),
    stop: jest.fn(),
    getConnectedDevices: jest.fn().mockReturnValue([]),
    // BACKLOG-3598 (B2): the second listing that confirms an unplug. Default: the phone
    // is absent on a successful listing. `null` = idevice_id could not answer.
    probeConnectedUdids: jest.fn().mockResolvedValue([]),
    getDeviceStorageInfo: jest.fn().mockResolvedValue({
      totalCapacity: 256 * 1024 * 1024 * 1024,
      usedSpace: 128 * 1024 * 1024 * 1024,
      availableSpace: 128 * 1024 * 1024 * 1024,
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

import { BackupService } from "../backupService";
import {
  APPLE_ENCRYPTED_BACKUP_MESSAGE,
  DeviceSyncOrchestrator,
} from "../deviceSyncOrchestrator";
import { syncTimeline } from "../syncTimeline";
import type { BackupResult } from "../../types/backup";

let userDataDir: string;
let spies: Record<string, jest.SpyInstance>;

function result(over: Partial<BackupResult> = {}): BackupResult {
  return {
    success: true,
    backupPath: path.join(userDataDir, "Backups", UDID),
    error: null,
    duration: 1000,
    deviceUdid: UDID,
    backupSize: 4096,
    isIncremental: false,
    isEncrypted: false,
    deviceReportedBackupMode: null,
    ...over,
  } as BackupResult;
}

function newOrchestrator(): DeviceSyncOrchestrator {
  const o = new DeviceSyncOrchestrator();
  o.on("error", () => {});
  return o;
}

/** The ended run's outcome row plus the live context. */
function outcomeRow(): string {
  const rows = logLines.filter((l) => l.includes("sync-outcome"));
  const live = Object.entries(syncTimeline.contextSnapshot())
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ");
  return `${rows[rows.length - 1] ?? ""} ${live}`;
}

function phone(status: "on" | "off" | "unknown") {
  spies.checkEncryptionStatus.mockResolvedValue({ isEncrypted: status === "on", needsPassword: status === "on", status });
}

beforeAll(() => {
  userDataDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "keepr-3881-"));
  process.env.KEEPR_3881_USERDATA = userDataDir;
  fsSync.mkdirSync(path.join(userDataDir, "Backups"), { recursive: true });
});
afterAll(() => {
  fsSync.rmSync(userDataDir, { recursive: true, force: true });
  delete process.env.KEEPR_3881_USERDATA;
});

beforeEach(() => {
  jest.restoreAllMocks();
  logLines.length = 0;
  syncTimeline.reset();
  const P = BackupService.prototype;
  spies = {
    startBackup: jest.spyOn(P, "startBackup").mockResolvedValue(result()),
    checkEncryptionStatus: jest.spyOn(P, "checkEncryptionStatus"),
    sweep: jest.spyOn(P, "sweepLeftoverBackups").mockResolvedValue({ removed: 0, bytesFreed: 0, failures: [] }),
    classify: jest.spyOn(P, "classifyBackupFolder").mockResolvedValue("absent"),
  };
  jest.spyOn(P, "getStatus").mockReturnValue({ isRunning: false, currentDeviceUdid: null, progress: null });
  mockDecryption.decryptBackup.mockReset();
  mockDecryption.cleanup.mockReset().mockResolvedValue(true);
  mockDecryption.sweepParseCopies.mockReset().mockResolvedValue(0);
  mockDecryption.isBackupEncrypted.mockReset().mockResolvedValue(false);
  phone("off");
});

function expectAppleEncryptedStop(r: Awaited<ReturnType<DeviceSyncOrchestrator["sync"]>>) {
  expect(r.success).toBe(false);
  expect(r.appleEncryptedBackup).toBe(true);
  expect(r.error).toBe(APPLE_ENCRYPTED_BACKUP_MESSAGE);
  expect(outcomeRow()).toContain("reasonCode=APPLE_ENCRYPTED_BACKUP");
  expect(outcomeRow()).toContain("endedBy=backup-encryption");
}

describe("A1 the phone has Encrypt local backup on", () => {
  it("stops before the backup with the turn-it-off message; no password asked for; not running", async () => {
    phone("on");
    const o = newOrchestrator();
    const asked = jest.fn();
    o.on("password-required", asked);
    const r = await o.sync({ udid: UDID });
    expectAppleEncryptedStop(r);
    expect(spies.startBackup).not.toHaveBeenCalled();
    expect(asked).not.toHaveBeenCalled();
    expect(mockDecryption.decryptBackup).not.toHaveBeenCalled();
    expect(o.getStatus().isRunning).toBe(false);
  });

  it("the message names the setting, both apps, and pressing Sync again — and never asks for a password", () => {
    expect(APPLE_ENCRYPTED_BACKUP_MESSAGE).toMatch(/Encrypt local backup/);
    expect(APPLE_ENCRYPTED_BACKUP_MESSAGE).toMatch(/Finder \(Mac\)/);
    expect(APPLE_ENCRYPTED_BACKUP_MESSAGE).toMatch(/Apple Devices \(Windows\)/);
    expect(APPLE_ENCRYPTED_BACKUP_MESSAGE).toMatch(/press Sync again/);
    expect(APPLE_ENCRYPTED_BACKUP_MESSAGE).not.toMatch(/enter your backup password/i);
  });

  it("a second Sync on the same phone stops the same way (one backup attempt per press, never a loop)", async () => {
    phone("on");
    const o = newOrchestrator();
    expectAppleEncryptedStop(await o.sync({ udid: UDID }));
    expectAppleEncryptedStop(await o.sync({ udid: UDID }));
    expect(spies.startBackup).not.toHaveBeenCalled();
    expect(spies.checkEncryptionStatus).toHaveBeenCalledTimes(2);
  });
});

describe("A2 the setting could not be read and the backup lands encrypted", () => {
  beforeEach(() => phone("unknown"));

  it("backupService reports PASSWORD_REQUIRED: the same stop, nothing decrypted", async () => {
    spies.startBackup.mockResolvedValue(
      result({ success: false, error: "This iPhone's backups are encrypted by Apple", errorCode: "PASSWORD_REQUIRED", isEncrypted: true }),
    );
    const r = await newOrchestrator().sync({ udid: UDID });
    expectAppleEncryptedStop(r);
    expect(mockDecryption.decryptBackup).not.toHaveBeenCalled();
  });

  it("a backup that comes back successful but encrypted: the same stop, nothing decrypted", async () => {
    spies.startBackup.mockResolvedValue(result({ isEncrypted: true }));
    const r = await newOrchestrator().sync({ udid: UDID });
    expectAppleEncryptedStop(r);
    expect(mockDecryption.decryptBackup).not.toHaveBeenCalled();
  });

  it("a device fault is NOT reported as an encrypted backup", async () => {
    spies.startBackup.mockResolvedValue(result({ success: false, backupPath: null, error: "lost", errorCode: "CONNECTION_LOST" }));
    const r = await newOrchestrator().sync({ udid: UDID });
    expect(r.success).toBe(false);
    expect(r.appleEncryptedBackup).toBeUndefined();
    expect(r.error).toBe("lost");
  });
});

describe("A3 the phone does not encrypt", () => {
  it("runs the normal sync with no password", async () => {
    phone("off");
    const r = await newOrchestrator().sync({ udid: UDID });
    expect(spies.startBackup).toHaveBeenCalledTimes(1);
    expect((spies.startBackup.mock.calls[0][0] as Record<string, unknown>).password).toBeUndefined();
    expect(r.appleEncryptedBackup).toBeUndefined();
    expect(r.success).toBe(true);
  });

  it("sweeps stale parse copies before a sync", async () => {
    await newOrchestrator().sync({ udid: UDID });
    expect(mockDecryption.sweepParseCopies).toHaveBeenCalled();
  });
});

describe("A4 a password sent by an old renderer", () => {
  it("never reaches the backup tool", async () => {
    phone("off");
    await newOrchestrator().sync({ udid: UDID, password: "left-over" } as unknown as { udid: string });
    expect((spies.startBackup.mock.calls[0][0] as Record<string, unknown>).password).toBeUndefined();
  });
});

describe("processExistingBackup", () => {
  it("an Apple-encrypted backup on disk: the same stop, nothing decrypted", async () => {
    const backupDir = path.join(userDataDir, "Backups", UDID);
    fsSync.mkdirSync(backupDir, { recursive: true });
    mockDecryption.isBackupEncrypted.mockResolvedValue(true);
    jest.spyOn(BackupService.prototype, "checkBackupStatus").mockResolvedValue({
      state: "present",
      isComplete: true,
      isInterrupted: false,
      snapshotState: "finished",
      size: { measured: true, bytes: 4096 },
      lastModified: new Date(),
    } as never);
    const r = await newOrchestrator().processExistingBackup({ udid: UDID, forceResync: true });
    expect(r.success).toBe(false);
    expect(r.appleEncryptedBackup).toBe(true);
    expect(r.error).toBe(APPLE_ENCRYPTED_BACKUP_MESSAGE);
    expect(mockDecryption.decryptBackup).not.toHaveBeenCalled();
  });
});
