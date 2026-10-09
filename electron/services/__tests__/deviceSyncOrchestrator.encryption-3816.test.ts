/**
 * BACKLOG-3816 S4 (option A) + BACKLOG-3817 at the orchestrator.
 *
 *  E1  a phone that does not encrypt: Keepr generates a password, SAVES IT FIRST, then
 *      asks the phone; the backup runs with that password.
 *  E2  the phone does not confirm: no backup runs (never a plaintext fallback), and the
 *      run records reasonCode=ENCRYPTION_NOT_CONFIRMED.
 *  E3  a saved password that will not unlock: nothing generated, nothing turned on or
 *      off, no backup — reasonCode=BACKUP_PASSWORD_UNAVAILABLE.
 *  E4  a plaintext chain is moved aside before the first encrypted backup and deleted
 *      ONLY after the encrypted backup completed and its index opened with the password.
 *  E5  every encryption failure maps to its own reasonCode with endedBy=backup-encryption.
 *  E6  a decrypted parse copy is removed when parsing fails.
 */
import fsSync from "fs";
import os from "os";
import path from "path";

const UDID = "00008030-0011223344556677";

jest.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: jest.fn(() => process.env.KEEPR_3816_USERDATA as string),
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
  BACKUP_ENCRYPTION_NOT_CONFIRMED_MESSAGE,
  BACKUP_PASSWORD_UNAVAILABLE_MESSAGE,
  DeviceSyncOrchestrator,
} from "../deviceSyncOrchestrator";
import { syncTimeline } from "../syncTimeline";
import { BackupPasswordUnavailableError, type BackupPasswordStore } from "../atRest/backupPassword";
import type { BackupResult } from "../../types/backup";

const events: string[] = [];
const saved = new Map<string, string>();
let unreadable = false;
const store: BackupPasswordStore = {
  get: jest.fn(async (udid: string) => {
    if (unreadable) throw new BackupPasswordUnavailableError("will not unwrap");
    return saved.has(udid) ? { kind: "found" as const, password: saved.get(udid)!, origin: "generated" as const } : { kind: "absent" as const };
  }),
  put: jest.fn(async (udid: string, password: string) => {
    if (unreadable || saved.has(udid)) throw new BackupPasswordUnavailableError("exists");
    events.push("put");
    saved.set(udid, password);
  }),
  replaceVerified: jest.fn(async (udid: string, password: string) => {
    saved.set(udid, password);
  }),
  storePath: () => "",
};

let userDataDir: string;
let spies: Record<string, jest.SpyInstance>;

function success(over: Partial<BackupResult> = {}): BackupResult {
  return {
    success: true,
    backupPath: path.join(userDataDir, "Backups", UDID),
    error: null,
    duration: 1000,
    deviceUdid: UDID,
    backupSize: 4096,
    isIncremental: false,
    isEncrypted: true,
    deviceReportedBackupMode: null,
    ...over,
  } as BackupResult;
}

function newOrchestrator(): DeviceSyncOrchestrator {
  const o = new DeviceSyncOrchestrator();
  o.on("error", () => {});
  o.backupPasswordStore = store;
  return o;
}

/** The ended run's outcome row, or — for a run still open (success ends in the handler) — its context. */
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
  userDataDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "keepr-3816-"));
  process.env.KEEPR_3816_USERDATA = userDataDir;
  fsSync.mkdirSync(path.join(userDataDir, "Backups"), { recursive: true });
});
afterAll(() => {
  fsSync.rmSync(userDataDir, { recursive: true, force: true });
  delete process.env.KEEPR_3816_USERDATA;
});

beforeEach(() => {
  jest.restoreAllMocks();
  logLines.length = 0;
  events.length = 0;
  saved.clear();
  unreadable = false;
  syncTimeline.reset();
  const P = BackupService.prototype;
  spies = {
    startBackup: jest.spyOn(P, "startBackup").mockImplementation(async (opts) => {
      events.push(`backup:${opts.password ? "with-password" : "no-password"}`);
      return success();
    }),
    checkEncryptionStatus: jest.spyOn(P, "checkEncryptionStatus"),
    enableEncryption: jest.spyOn(P, "enableEncryption").mockImplementation(async () => {
      events.push("enable");
      return { enabled: true };
    }),
    readChainEncryption: jest.spyOn(P, "readChainEncryption").mockResolvedValue("absent"),
    moveChainAside: jest.spyOn(P, "moveChainAside").mockImplementation(async () => {
      events.push("aside");
      return "aside";
    }),
    hasReplacedChain: jest.spyOn(P, "hasReplacedChain").mockResolvedValue(false),
    removeReplacedChains: jest.spyOn(P, "removeReplacedChains").mockImplementation(async () => {
      events.push("remove-aside");
      return 1;
    }),
    sweep: jest.spyOn(P, "sweepLeftoverBackups").mockResolvedValue({ removed: 0, bytesFreed: 0, failures: [] }),
    classify: jest.spyOn(P, "classifyBackupFolder").mockResolvedValue("absent"),
  };
  jest.spyOn(P, "getStatus").mockReturnValue({ isRunning: false, currentDeviceUdid: null, progress: null });
  mockDecryption.decryptBackup.mockReset().mockImplementation(async () => {
    events.push("decrypt");
    return { success: true, error: null, decryptedPath: path.join(userDataDir, "at-rest-tmp", "ios-run") };
  });
  mockDecryption.cleanup.mockReset().mockResolvedValue(true);
  mockDecryption.sweepParseCopies.mockReset().mockResolvedValue(0);
  mockDecryption.verifyManifestRoundTrip.mockReset().mockImplementation(async () => {
    events.push("verify");
    return true;
  });
  (store.put as jest.Mock).mockClear();
  (store.replaceVerified as jest.Mock).mockClear();
  phone("off");
});

describe("E1 option A — a phone that does not encrypt", () => {
  it("generates a 32+ char password, saves it BEFORE asking the phone, and backs up with it", async () => {
    const result = await newOrchestrator().sync({ udid: UDID });
    expect(result.success).toBe(true);
    expect(events.slice(0, 3)).toEqual(["put", "enable", "backup:with-password"]);
    const generated = saved.get(UDID)!;
    expect(generated.length).toBeGreaterThanOrEqual(32);
    expect(spies.enableEncryption.mock.calls[0][1]).toBe(generated);
    expect(spies.startBackup.mock.calls[0][0].password).toBe(generated);
    expect(outcomeRow()).toContain("backupPassword=generated");
    expect(outcomeRow()).toContain("encryptionEnable=enabled");
    expect(outcomeRow()).toContain("phoneBackupEncryption=off");
    expect(logLines.join("\n")).not.toContain(generated);
  });

  it("E2 the phone does not confirm: no backup runs, reasonCode ENCRYPTION_NOT_CONFIRMED", async () => {
    spies.enableEncryption.mockResolvedValue({ enabled: false, reason: "not-confirmed" });
    const result = await newOrchestrator().sync({ udid: UDID });
    expect(result.success).toBe(false);
    expect(result.error).toBe(BACKUP_ENCRYPTION_NOT_CONFIRMED_MESSAGE);
    expect(spies.startBackup).not.toHaveBeenCalled();
    expect(outcomeRow()).toContain("reasonCode=ENCRYPTION_NOT_CONFIRMED");
    expect(outcomeRow()).toContain("endedBy=backup-encryption");
  });

  it("E1b a password saved by an earlier, unconfirmed attempt is reused, never regenerated", async () => {
    saved.set(UDID, "earlier-saved-password-aaaaaaaaaaaaaaa");
    await newOrchestrator().sync({ udid: UDID });
    expect(store.put).not.toHaveBeenCalled();
    expect(spies.enableEncryption.mock.calls[0][1]).toBe("earlier-saved-password-aaaaaaaaaaaaaaa");
  });

  it("an unknown phone setting changes nothing: no enable, the backup runs as configured", async () => {
    phone("unknown");
    mockDecryption.decryptBackup.mockClear();
    spies.startBackup.mockResolvedValue(success({ isEncrypted: false }));
    await newOrchestrator().sync({ udid: UDID });
    expect(spies.enableEncryption).not.toHaveBeenCalled();
    expect(store.put).not.toHaveBeenCalled();
  });
});

describe("E3 a saved password that will not unlock", () => {
  it.each(["on", "off"] as const)("phone %s: nothing generated, nothing turned on, no backup", async (status) => {
    phone(status);
    unreadable = true;
    const result = await newOrchestrator().sync({ udid: UDID });
    if (status === "on") {
      expect(result.error).toBe(BACKUP_PASSWORD_UNAVAILABLE_MESSAGE);
      expect(outcomeRow()).toContain("reasonCode=BACKUP_PASSWORD_UNAVAILABLE");
    } else {
      // Phone off: the saved password protects nothing on the phone, but a new one cannot
      // be saved over it, so encryption is not turned on and the run fails closed.
      expect(result.error).toBe(BACKUP_PASSWORD_UNAVAILABLE_MESSAGE);
      expect(outcomeRow()).toContain("reasonCode=BACKUP_PASSWORD_UNAVAILABLE");
    }
    expect(result.success).toBe(false);
    expect(spies.enableEncryption).not.toHaveBeenCalled();
    expect(spies.startBackup).not.toHaveBeenCalled();
    expect(events).not.toContain("put");
  });
});

describe("E4 replacing a plaintext chain", () => {
  beforeEach(() => {
    phone("on");
    saved.set(UDID, "saved-password-bbbbbbbbbbbbbbbbbbbbbbbb");
    spies.readChainEncryption.mockResolvedValue("plaintext");
    spies.hasReplacedChain.mockResolvedValue(true);
  });

  it("moves it aside before the backup and deletes it only after the encrypted backup verifies", async () => {
    const result = await newOrchestrator().sync({ udid: UDID });
    expect(result.success).toBe(true);
    expect(events).toEqual(["aside", "backup:with-password", "verify", "remove-aside", "decrypt"]);
  });

  it("keeps it when the encrypted backup does not verify", async () => {
    mockDecryption.verifyManifestRoundTrip.mockResolvedValue(false);
    await newOrchestrator().sync({ udid: UDID });
    expect(spies.removeReplacedChains).not.toHaveBeenCalled();
  });

  it("keeps it when the encrypted backup fails", async () => {
    spies.startBackup.mockResolvedValue({ ...success(), success: false, backupPath: null, error: "lost", errorCode: "CONNECTION_LOST" } as BackupResult);
    await newOrchestrator().sync({ udid: UDID });
    expect(spies.removeReplacedChains).not.toHaveBeenCalled();
    expect(mockDecryption.verifyManifestRoundTrip).not.toHaveBeenCalled();
  });
});

describe("E5 each encryption failure has its own reasonCode", () => {
  beforeEach(() => phone("on"));

  it("PASSWORD_REQUIRED", async () => {
    spies.startBackup.mockResolvedValue({ ...success(), success: false, backupPath: null, error: "Backup password required", errorCode: "PASSWORD_REQUIRED" } as BackupResult);
    await newOrchestrator().sync({ udid: UDID });
    expect(outcomeRow()).toContain("reasonCode=PASSWORD_REQUIRED");
    expect(outcomeRow()).toContain("endedBy=backup-encryption");
    expect(outcomeRow()).toContain("backupPassword=none");
  });

  it("INCORRECT_PASSWORD — a saved password that no longer opens the backup asks the user", async () => {
    saved.set(UDID, "stale-saved-password-cccccccccccccccccc");
    spies.startBackup.mockResolvedValue({ ...success(), success: false, error: "Incorrect password", errorCode: "INCORRECT_PASSWORD" } as BackupResult);
    const o = newOrchestrator();
    const asked = jest.fn();
    o.on("password-required", asked);
    await o.sync({ udid: UDID });
    expect(asked).toHaveBeenCalled();
    expect(outcomeRow()).toContain("reasonCode=INCORRECT_PASSWORD");
    expect(outcomeRow()).toContain("endedBy=backup-encryption");
  });

  it("DECRYPTION_FAILED", async () => {
    mockDecryption.decryptBackup.mockResolvedValue({ success: false, error: "The backup has no messages database", decryptedPath: null });
    await newOrchestrator().sync({ udid: UDID, password: "typed" });
    expect(outcomeRow()).toContain("reasonCode=DECRYPTION_FAILED");
    expect(outcomeRow()).toContain("endedBy=backup-encryption");
  });

  it("a typed password that worked is saved for the next sync", async () => {
    await newOrchestrator().sync({ udid: UDID, password: "typed-and-correct" });
    expect(saved.get(UDID)).toBe("typed-and-correct");
    expect(outcomeRow()).toContain("backupPassword=provided");
  });
});

describe("E6 parse copies", () => {
  it("removes the parse copy when parsing throws", async () => {
    phone("on");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { iOSContactsParser } = require("../iosContactsParser");
    (iOSContactsParser as jest.Mock).mockImplementationOnce(() => ({
      open: jest.fn().mockRejectedValue(new Error("not a database")),
      close: jest.fn(),
      getAllContacts: jest.fn(),
      lookupByHandle: jest.fn(),
    }));
    const result = await newOrchestrator().sync({ udid: UDID, password: "typed" });
    expect(result.success).toBe(false);
    expect(mockDecryption.cleanup).toHaveBeenCalledWith(path.join(userDataDir, "at-rest-tmp", "ios-run"));
  });

  it("sweeps stale parse copies before a sync", async () => {
    await newOrchestrator().sync({ udid: UDID });
    expect(mockDecryption.sweepParseCopies).toHaveBeenCalled();
  });
});
