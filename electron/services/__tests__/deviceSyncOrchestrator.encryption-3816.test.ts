/**
 * BACKLOG-3816 S4 + BACKLOG-3817 at the orchestrator (phones whose owner encrypts backups).
 *
 *  E3  a saved password that will not unlock: nothing replaced, no backup —
 *      reasonCode=BACKUP_PASSWORD_UNAVAILABLE (phone encrypting).
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
  BACKUP_PASSWORD_UNAVAILABLE_MESSAGE,
  BACKUP_PASSWORD_CHANGED_MESSAGE,
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
    return saved.has(udid) ? { kind: "found" as const, password: saved.get(udid)!, origin: "user" as const } : { kind: "absent" as const };
  }),
  put: jest.fn(async (udid: string, password: string) => {
    if (unreadable || saved.has(udid)) throw new BackupPasswordUnavailableError("exists");
    events.push("put");
    saved.set(udid, password);
  }),
  replaceVerified: jest.fn(async (udid: string, password: string) => {
    saved.set(udid, password);
  }),
  replaceUnreadable: jest.fn(async (udid: string, password: string) => {
    if (!unreadable) throw new BackupPasswordUnavailableError("readable");
    events.push("replace-unreadable");
    unreadable = false;
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
    readChainEncryption: jest.spyOn(P, "readChainEncryption").mockResolvedValue("absent"),
    moveChainAside: jest.spyOn(P, "moveChainAside").mockImplementation(async () => {
      events.push("aside");
      return "aside";
    }),
    hasReplacedChain: jest.spyOn(P, "hasReplacedChain").mockResolvedValue(false),
    removePlaintextChain: jest.spyOn(P, "removePlaintextChain").mockImplementation(async () => {
      events.push("delete-plaintext");
      return true;
    }),
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
  (store.replaceUnreadable as jest.Mock).mockClear();
  phone("off");
});

describe("E3 a saved password that will not unlock", () => {
  it("phone encrypts: asks for the password again, nothing replaced, no backup, reasonCode BACKUP_PASSWORD_UNAVAILABLE", async () => {
    phone("on");
    unreadable = true;
    const o = newOrchestrator();
    const asked = jest.fn();
    o.on("password-required", asked);
    const result = await o.sync({ udid: UDID });
    expect(result.success).toBe(false);
    expect(result.error).toBe(BACKUP_PASSWORD_UNAVAILABLE_MESSAGE);
    expect(result.error).toMatch(/^Enter your backup password again\./);
    expect(result.error).not.toMatch(/support/i);
    expect(asked).toHaveBeenCalled();
    expect(result.passwordRequired).toBe(true);
    expect(store.replaceUnreadable).not.toHaveBeenCalled();
    expect(outcomeRow()).toContain("reasonCode=BACKUP_PASSWORD_UNAVAILABLE");
    expect(outcomeRow()).toContain("endedBy=backup-encryption");
    expect(spies.startBackup).not.toHaveBeenCalled();
    expect(events).not.toContain("put");
  });

  it("D-A3: the password typed next replaces the unreadable entry only after it opened the backup", async () => {
    phone("on");
    unreadable = true;
    const result = await newOrchestrator().sync({ udid: UDID, password: "typed-new-password" });
    expect(result.success).toBe(true);
    expect(store.replaceUnreadable).toHaveBeenCalledWith(UDID, "typed-new-password");
    expect(saved.get(UDID)).toBe("typed-new-password");
    // Saved only after the backup verified the password (backupService) — never before it.
    expect(events.indexOf("replace-unreadable")).toBeGreaterThan(events.indexOf("backup:with-password"));
  });

  it("D-A3: a typed password that does NOT open the backup leaves the unreadable entry alone", async () => {
    phone("on");
    unreadable = true;
    spies.startBackup.mockResolvedValue({ ...success(), success: false, error: "Incorrect password", errorCode: "INCORRECT_PASSWORD" } as BackupResult);
    const result = await newOrchestrator().sync({ udid: UDID, password: "typed-wrong" });
    expect(result.success).toBe(false);
    expect(result.passwordRequired).toBe(true);
    expect(store.replaceUnreadable).not.toHaveBeenCalled();
    expect(unreadable).toBe(true);
  });

  it("phone reports encryption off: the sync runs without a password, the saved entry untouched", async () => {
    phone("off");
    unreadable = true;
    spies.startBackup.mockResolvedValue(success({ isEncrypted: false }));
    await newOrchestrator().sync({ udid: UDID });
    expect(spies.startBackup.mock.calls[0][0].password).toBeUndefined();
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
    const result = await o.sync({ udid: UDID });
    expect(asked).toHaveBeenCalled();
    expect(result.error).toBe(BACKUP_PASSWORD_CHANGED_MESSAGE);
    expect(result.passwordRequired).toBe(true);
    expect(outcomeRow()).toContain("reasonCode=INCORRECT_PASSWORD");
    expect(outcomeRow()).toContain("endedBy=backup-encryption");
  });

  it("PASSWORD_REQUIRED marks the result so the retry skips the sync cooldown", async () => {
    spies.startBackup.mockResolvedValue({ ...success(), success: false, backupPath: null, error: "Backup password required", errorCode: "PASSWORD_REQUIRED" } as BackupResult);
    const result = await newOrchestrator().sync({ udid: UDID });
    expect(result.passwordRequired).toBe(true);
  });

  it("a device fault is NOT marked password-required", async () => {
    spies.startBackup.mockResolvedValue({ ...success(), success: false, backupPath: null, error: "lost", errorCode: "CONNECTION_LOST" } as BackupResult);
    const result = await newOrchestrator().sync({ udid: UDID, password: "typed" });
    expect(result.passwordRequired).toBeUndefined();
  });

  it("disk full during the decrypt: reasonCode INSUFFICIENT_SPACE, the user is told why", async () => {
    mockDecryption.decryptBackup.mockResolvedValue({
      success: false,
      error: "Not enough free disk space to read this iPhone's encrypted backup. Free up space on this computer and sync again.",
      errorCode: "INSUFFICIENT_SPACE",
      decryptedPath: null,
    });
    const result = await newOrchestrator().sync({ udid: UDID, password: "typed" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/disk space/);
    expect(outcomeRow()).toContain("reasonCode=INSUFFICIENT_SPACE");
    expect(outcomeRow()).toContain("endedBy=backup-encryption");
  });

  it("B3: attachments that could not be decrypted are counted on the result and the outcome row", async () => {
    mockDecryption.decryptBackup.mockResolvedValue({
      success: true,
      error: null,
      decryptedPath: path.join(userDataDir, "at-rest-tmp", "ios-run"),
      stats: { decrypted: 10, skipped: 3 },
    });
    const result = await newOrchestrator().sync({ udid: UDID, password: "typed" });
    expect(result.success).toBe(true);
    expect(result.attachmentsUndecryptable).toBe(3);
    expect(outcomeRow()).toContain("attachmentsUndecryptable=3");
    expect(outcomeRow()).toContain("reasonCode=DECRYPTION_FAILED");
  });

  it("B3: a clean decrypt carries no undecryptable count", async () => {
    mockDecryption.decryptBackup.mockResolvedValue({
      success: true,
      error: null,
      decryptedPath: path.join(userDataDir, "at-rest-tmp", "ios-run"),
      stats: { decrypted: 10, skipped: 0 },
    });
    const result = await newOrchestrator().sync({ udid: UDID, password: "typed" });
    expect(result.attachmentsUndecryptable).toBeUndefined();
    expect(outcomeRow()).not.toContain("attachmentsUndecryptable");
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

describe("Keepr never changes the phone's own backup setting", () => {
  it("a phone that does not encrypt is left alone and backs up without a password", async () => {
    phone("off");
    spies.startBackup.mockResolvedValue(success({ isEncrypted: false }));
    await newOrchestrator().sync({ udid: UDID });
    expect(store.put).not.toHaveBeenCalled();
    expect(spies.startBackup.mock.calls[0][0].password).toBeUndefined();
    expect(events).not.toContain("aside");
  });

  it("a typed password on a phone that encrypts, with a plaintext chain on disk, starts a new chain", async () => {
    phone("on");
    spies.readChainEncryption.mockResolvedValue("plaintext");
    const o = newOrchestrator();
    (o as unknown as { checkAvailableDiskSpace: () => Promise<unknown> }).checkAvailableDiskSpace = async () => ({
      hasEnoughSpace: true,
      availableSpace: 900 * 1024 ** 3,
    });
    await o.sync({ udid: UDID, password: "typed" });
    expect(events.slice(0, 2)).toEqual(["aside", "backup:with-password"]);
  });
});

describe("E7 room for the new chain (measured branch)", () => {
  type Prep = { prepareNewChain(udid: string): Promise<string>; estimatedBackupSize: number; checkAvailableDiskSpace: (n: number) => Promise<unknown> };
  const GB = 1024 ** 3;
  function orchestratorWithFree(freeBytes: number): Prep {
    const o = newOrchestrator() as unknown as Prep;
    o.estimatedBackupSize = 67 * GB;
    o.checkAvailableDiskSpace = async (required: number) => ({ hasEnoughSpace: freeBytes >= required, availableSpace: freeBytes });
    return o;
  }

  it("enough space for a second full backup: the old chain is moved aside, not deleted", async () => {
    expect(await orchestratorWithFree(200 * GB).prepareNewChain(UDID)).toBe("aside");
    expect(spies.moveChainAside).toHaveBeenCalled();
    expect(spies.removePlaintextChain).not.toHaveBeenCalled();
  });

  it("not enough: the old PLAINTEXT chain is deleted first (no incremental value)", async () => {
    spies.readChainEncryption.mockResolvedValue("plaintext");
    expect(await orchestratorWithFree(80 * GB).prepareNewChain(UDID)).toBe("deleted");
    expect(spies.removePlaintextChain).toHaveBeenCalledWith(UDID);
    expect(spies.moveChainAside).not.toHaveBeenCalled();
  });

  it("not enough, but the chain is no longer plaintext: nothing is deleted", async () => {
    spies.readChainEncryption.mockResolvedValue("encrypted");
    expect(await orchestratorWithFree(80 * GB).prepareNewChain(UDID)).toBe("kept");
    expect(spies.removePlaintextChain).not.toHaveBeenCalled();
  });
});
