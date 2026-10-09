/**
 * @jest-environment node
 */
/**
 * BACKLOG-3816 S4-C at the orchestrator: the kept iPhone backup is sealed on EVERY end
 * of a sync, with the REAL at-rest layer (real fileCrypto, real files).
 *
 *  C2  one test per end path AFTER the unseal: device error, watchdog, disconnect, disk
 *      guard, user cancel during the backup, password required, parser exception,
 *      cancel during parsing — each leaves zero plaintext and marker `encrypted`.
 *      Success: plaintext through persistence (the copier reads the chain), sealed by
 *      completeBackupAtRest(); with no persistence listener, sealed at once.
 *      Pre-unseal exits (disk precheck, drivers, size unknown, password unavailable)
 *      have nothing to seal and are NOT listed as controls.
 *  Q   a quit does not seal: marker stays `syncing` (next launch seals — C3 in
 *      atRest/__tests__/backupAtRest.test.ts).
 *  K   data key unavailable → refused, idevicebackup2 never spawned, nothing unsealed.
 *  B   a backup being secured → refused with the founder sentence, never spawned.
 *  D   C-DELTA: parsers get the at-rest-tmp parse copy, not the chain.
 */
import crypto from "crypto";
import fsSync from "fs";
import os from "os";
import path from "path";

const UDID = "00008030-0011223344556677";

jest.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: jest.fn(() => process.env.KEEPR_S4C_USERDATA as string),
  },
}));
jest.mock("electron-log", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
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
  checkDiskSpaceForOperation: jest.fn().mockResolvedValue({ sufficient: true, availableMB: 500000, requiredMB: 1000 }),
}));
jest.mock("../appleDriverService", () => ({
  checkAppleDrivers: jest.fn().mockResolvedValue({ isInstalled: true, serviceRunning: true, version: "12.0.0", error: null }),
}));
jest.mock("../libimobiledeviceService", () => ({
  canUseLibimobiledevice: jest.fn(() => true),
  getCommand: jest.fn(() => "/nonexistent/idevicebackup2"),
  isMockMode: jest.fn(() => false),
}));
jest.mock("../deviceDetectionService", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: Emitter } = require("events");
  const svc = new Emitter();
  Object.assign(svc, {
    start: jest.fn(),
    stop: jest.fn(),
    getConnectedDevices: jest.fn().mockReturnValue([]),
    probeConnectedUdids: jest.fn().mockResolvedValue([]),
    getDeviceStorageInfo: jest.fn().mockResolvedValue({
      totalCapacity: 256 * 1024 * 1024 * 1024,
      usedSpace: 128 * 1024 * 1024 * 1024,
      availableSpace: 128 * 1024 * 1024 * 1024,
      estimatedBackupSize: 1024 * 1024,
    }),
  });
  return { DeviceDetectionService: jest.fn().mockImplementation(() => svc), deviceDetectionService: svc };
});

/** What each parser saw: was the chain's sms.db plaintext when it was opened? */
const parserSaw: Array<{ path: string; smsPlain: boolean | null }> = [];
let parserBehaviour: "ok" | "throw" | "cancel" = "ok";
let currentOrchestrator: { cancel(): void } | null = null;
jest.mock("../iosMessagesParser", () => ({
  iOSMessagesParser: jest.fn().mockImplementation(() => ({
    open: jest.fn(),
    close: jest.fn(),
    getConversationsAsync: jest.fn(async () => {
      if (parserBehaviour === "cancel") currentOrchestrator?.cancel();
      return [];
    }),
    getMessagesAsync: jest.fn().mockResolvedValue([]),
  })),
}));
jest.mock("../iosContactsParser", () => ({
  iOSContactsParser: jest.fn().mockImplementation(() => ({
    open: jest.fn(async (p: string) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("fs");
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pth = require("path");
      const sms = pth.join(p, "3d", "3d0d7e5fb2ce288813306e4d4636395e047a3d28");
      let smsPlain: boolean | null = null;
      if (fs.existsSync(sms)) smsPlain = !fs.readFileSync(sms).subarray(0, 7).equals(Buffer.from("KEPRENC"));
      parserSaw.push({ path: p, smsPlain });
      if (parserBehaviour === "throw") throw new Error("parser exploded");
    }),
    close: jest.fn(),
    getAllContacts: jest.fn().mockReturnValue([]),
    lookupByHandle: jest.fn().mockReturnValue({ contact: null, matchType: null }),
  })),
}));

import plist from "simple-plist";

import { BackupService } from "../backupService";
import { DeviceSyncOrchestrator } from "../deviceSyncOrchestrator";
import { BackupAtRest, BACKUP_SECURING_SENTENCE, readMarkerAt } from "../atRest/backupAtRest";
import { createFileCrypto, MAGIC, type KeyResolver } from "../atRest/fileCrypto";
import { createMarkerStore } from "../atRest/markers";
import { syncTimeline } from "../syncTimeline";
import type { BackupResult } from "../../types/backup";

const KEY = crypto.randomBytes(32);
const resolver: KeyResolver = {
  currentKey: async () => ({ keyId: crypto.createHash("sha256").update(KEY).digest("hex").slice(0, 32), key: KEY }),
  keyFor: async () => KEY,
};
const files = createFileCrypto(resolver, { chunkSize: 64 });
const SMS_ID = "3d0d7e5fb2ce288813306e4d4636395e047a3d28";

let userData: string;
let backups: string;
let chain: string;
let keyAvailable: boolean;
let atRest: BackupAtRest;
let startBackup: jest.SpyInstance;

function write(rel: string, data: Buffer | string): void {
  const p = path.join(chain, rel);
  fsSync.mkdirSync(path.dirname(p), { recursive: true });
  fsSync.writeFileSync(p, data);
}

function makeChain(): void {
  fsSync.mkdirSync(chain, { recursive: true });
  write("Info.plist", plist.stringify({ "Device Name": "Test" }));
  write("Status.plist", plist.stringify({ SnapshotState: "finished" }));
  write("Manifest.plist", plist.stringify({ IsEncrypted: false }));
  write("Manifest.db", "manifest index bytes ".repeat(10));
  write(`3d/${SMS_ID}`, "sms database ".repeat(20));
  write("ab/" + "a".repeat(40), crypto.randomBytes(200));
}

function plaintextLeft(): string[] {
  const out: string[] = [];
  const walk = (d: string, root: boolean) => {
    for (const e of fsSync.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f, false);
      else if (!(root && e.name.endsWith(".plist"))) {
        const b = fsSync.readFileSync(f);
        if (b.length > 0 && !b.subarray(0, 7).equals(MAGIC)) out.push(f);
      }
    }
  };
  if (fsSync.existsSync(chain)) walk(chain, true);
  return out;
}

function ok(over: Partial<BackupResult> = {}): BackupResult {
  return {
    success: true,
    backupPath: chain,
    error: null,
    duration: 1000,
    deviceUdid: UDID,
    backupSize: 4096,
    isIncremental: true,
    isEncrypted: false,
    deviceReportedBackupMode: null,
    ...over,
  } as BackupResult;
}

function fail(over: Partial<BackupResult> = {}): BackupResult {
  return ok({ success: false, backupPath: null, error: "The connection to your iPhone was lost.", errorCode: "CONNECTION_LOST", ...over } as Partial<BackupResult>);
}

function newOrchestrator(listen = true): DeviceSyncOrchestrator {
  const o = new DeviceSyncOrchestrator();
  o.on("error", () => {});
  if (listen) o.on("complete", () => {});
  o.backupAtRest = atRest;
  o.backupPasswordStore = {
    get: async () => ({ kind: "absent" as const }),
    put: async () => undefined,
    replaceVerified: async () => undefined,
    storePath: () => "",
  } as never;
  currentOrchestrator = o;
  return o;
}

/** idevicebackup2 stand-in: asserts what it sees, writes a new file, returns `result`. */
function backupReturns(result: BackupResult | ((o: DeviceSyncOrchestrator) => BackupResult), o?: DeviceSyncOrchestrator) {
  startBackup.mockImplementation(async () => {
    // C-FULL: the chain the tool reads is fully plaintext (Manifest.db included).
    write("cd/" + "c".repeat(40), "a file the phone sent this time");
    return typeof result === "function" ? result(o!) : result;
  });
}

async function sealedAfter(o: DeviceSyncOrchestrator): Promise<void> {
  expect(o.lastAtRestSeal).not.toBeNull();
  await o.lastAtRestSeal;
  expect(plaintextLeft()).toEqual([]);
  expect(await readMarkerAt(backups, UDID)).toBe("encrypted");
  expect(atRest.busyReason(UDID)).toBeNull();
}

beforeEach(async () => {
  userData = fsSync.mkdtempSync(path.join(os.tmpdir(), "keepr-s4c-orch-"));
  process.env.KEEPR_S4C_USERDATA = userData;
  backups = path.join(userData, "Backups");
  chain = path.join(backups, UDID);
  keyAvailable = true;
  parserSaw.length = 0;
  parserBehaviour = "ok";
  syncTimeline.reset();
  atRest = new BackupAtRest({
    backupsRoot: () => backups,
    files: () => files,
    markers: () => createMarkerStore({ userData: () => userData }),
    ensureKey: async () => {
      if (!keyAvailable) throw new Error("DataKeyUnavailableError");
    },
    freeBytes: async () => Number.MAX_SAFE_INTEGER,
    sleep: async () => undefined,
    log: (_l, m, d) => process.env.S4C_DEBUG && process.stderr.write(`${m} ${JSON.stringify(d)}\n`),
    strategy: () => "full",
  });
  makeChain();
  expect(await atRest.migrate(UDID)).toBe("encrypted");

  jest.restoreAllMocks();
  const P = BackupService.prototype;
  startBackup = jest.spyOn(P, "startBackup");
  jest.spyOn(P, "checkEncryptionStatus").mockResolvedValue({ isEncrypted: false, needsPassword: false, status: "off" });
  jest.spyOn(P, "sweepLeftoverBackups").mockResolvedValue({ removed: 0, bytesFreed: 0, failures: [] });
  jest.spyOn(P, "getStatus").mockReturnValue({ isRunning: false, currentDeviceUdid: null, progress: null });
  jest.spyOn(P, "cancelBackup").mockImplementation(() => undefined);
});
afterEach(() => {
  fsSync.rmSync(userData, { recursive: true, force: true });
  delete process.env.KEEPR_S4C_USERDATA;
});

describe("C2 — the chain is sealed on every end path after the unseal", () => {
  it("success: plaintext for the parsers and persistence, sealed by completeBackupAtRest()", async () => {
    const o = newOrchestrator();
    backupReturns(ok());
    const result = await o.sync({ udid: UDID });
    expect(result.success).toBe(true);
    expect(result.backupPath).toBe(chain);
    expect(parserSaw[0]).toEqual({ path: chain, smsPlain: true });
    // Handed off: still plaintext (the attachment copier reads it), lock held.
    expect(plaintextLeft().length).toBeGreaterThan(0);
    expect(await readMarkerAt(backups, UDID)).toBe("syncing");
    expect(atRest.busyReason(UDID)).toBe("syncing");
    await o.completeBackupAtRest();
    await sealedAfter(o);
  });

  it("success with no persistence listener: sealed at once", async () => {
    const o = newOrchestrator(false);
    backupReturns(ok());
    expect((await o.sync({ udid: UDID })).success).toBe(true);
    await sealedAfter(o);
  });

  it("device error", async () => {
    const o = newOrchestrator();
    backupReturns(fail({ errorCode: "DEVICE_LOCKED", error: "locked" } as Partial<BackupResult>));
    expect((await o.sync({ udid: UDID })).success).toBe(false);
    await sealedAfter(o);
  });

  it("watchdog (BACKUP_TIMEOUT)", async () => {
    const o = newOrchestrator();
    backupReturns(fail({ errorCode: "BACKUP_TIMEOUT", error: "stalled" } as Partial<BackupResult>));
    expect((await o.sync({ udid: UDID })).success).toBe(false);
    await sealedAfter(o);
  });

  it("phone disconnected mid-backup", async () => {
    const o = newOrchestrator();
    backupReturns((orc) => {
      (orc as unknown as { backupInFlight: { disconnected: boolean } }).backupInFlight.disconnected = true;
      return fail();
    }, o);
    const result = await o.sync({ udid: UDID });
    expect(result.success).toBe(false);
    await sealedAfter(o);
  });

  it("disk guard stopped the backup", async () => {
    const o = newOrchestrator();
    backupReturns((orc) => {
      Object.assign(orc, { diskSpaceAborted: true, diskSpaceAtAbort: 1024 });
      return fail({ errorCode: "DISK_FULL" } as Partial<BackupResult>);
    }, o);
    const result = await o.sync({ udid: UDID });
    expect(result.error).toMatch(/protect your computer/);
    await sealedAfter(o);
  });

  it("user cancelled during the backup", async () => {
    const o = newOrchestrator();
    backupReturns((orc) => {
      orc.cancel();
      return fail();
    }, o);
    expect((await o.sync({ udid: UDID })).error).toMatch(/cancel/i);
    await sealedAfter(o);
  });

  it("password required (the phone started encrypting, no password)", async () => {
    const o = newOrchestrator();
    backupReturns(ok({ isEncrypted: true }));
    expect((await o.sync({ udid: UDID })).error).toMatch(/Password required/);
    await sealedAfter(o);
  });

  it("a parser throws", async () => {
    const o = newOrchestrator();
    parserBehaviour = "throw";
    backupReturns(ok());
    expect((await o.sync({ udid: UDID })).error).toMatch(/parser exploded/);
    await sealedAfter(o);
  });

  it("user cancelled during parsing", async () => {
    const o = newOrchestrator();
    parserBehaviour = "cancel";
    backupReturns(ok());
    expect((await o.sync({ udid: UDID })).error).toMatch(/cancel/i);
    await sealedAfter(o);
  });
});

describe("first backup — 3598 must still remove an unfinished one", () => {
  it("a failed FIRST backup (no Manifest.db) is removed by the 3598 cleanup, not kept by a marker", async () => {
    fsSync.rmSync(chain, { recursive: true, force: true });
    await atRest.removeMarker(UDID);
    const o = newOrchestrator();
    startBackup.mockImplementation(async () => {
      write("ab/" + "b".repeat(40), "partial first backup");
      write("Status.plist", plist.stringify({ SnapshotState: "uploading" }));
      return fail();
    });
    const result = await o.sync({ udid: UDID });
    expect(result.success).toBe(false);
    await o.lastAtRestSeal;
    expect(fsSync.existsSync(chain)).toBe(false);
    expect(await readMarkerAt(backups, UDID)).toBe("absent");
  });

  it("a successful FIRST backup is sealed and marked once persistence ends", async () => {
    fsSync.rmSync(chain, { recursive: true, force: true });
    await atRest.removeMarker(UDID);
    const o = newOrchestrator();
    startBackup.mockImplementation(async () => {
      makeChain();
      return ok({ isIncremental: false });
    });
    expect((await o.sync({ udid: UDID })).success).toBe(true);
    expect(await readMarkerAt(backups, UDID)).toBe("absent");
    await o.completeBackupAtRest();
    await sealedAfter(o);
  });
});

describe("Q — a quit does not seal; the marker says syncing for the next launch", () => {
  it("stoppedForQuit: no seal, marker syncing", async () => {
    const o = newOrchestrator();
    backupReturns((orc) => {
      Object.assign(orc, { stoppedForQuit: true });
      return fail();
    }, o);
    await o.sync({ udid: UDID });
    expect(o.lastAtRestSeal).toBeNull();
    expect(await readMarkerAt(backups, UDID)).toBe("syncing");
    expect(plaintextLeft().length).toBeGreaterThan(0);
  });
});

describe("refusals before idevicebackup2", () => {
  it("K: data key unavailable → refused, never spawned, nothing unsealed", async () => {
    keyAvailable = false;
    const o = newOrchestrator();
    backupReturns(ok());
    const result = await o.sync({ udid: UDID });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/encryption key/);
    expect(startBackup).not.toHaveBeenCalled();
    expect(plaintextLeft()).toEqual([]);
  });

  it("B: a backup being secured → refused with the founder sentence, never spawned", async () => {
    const o = newOrchestrator();
    backupReturns(ok());
    const busy = (atRest as unknown as { busy: Map<string, string> }).busy;
    busy.set(UDID, "migrating");
    const result = await o.sync({ udid: UDID });
    busy.delete(UDID);
    expect(result.error).toContain(BACKUP_SECURING_SENTENCE);
    expect(startBackup).not.toHaveBeenCalled();
  });
});

describe("D — C-DELTA reads a parse copy", () => {
  it("parsers get the at-rest-tmp copy; the chain keeps unchanged files sealed during the sync", async () => {
    atRest = new BackupAtRest({
      backupsRoot: () => backups,
      files: () => files,
      markers: () => createMarkerStore({ userData: () => userData }),
      ensureKey: async () => undefined,
      freeBytes: async () => Number.MAX_SAFE_INTEGER,
      sleep: async () => undefined,
      log: () => undefined,
      strategy: () => "delta",
    });
    const copySpy = jest.spyOn(atRest, "buildParseCopy").mockImplementation(async (_udid, out) => {
      fsSync.mkdirSync(path.join(out, "3d"), { recursive: true });
      fsSync.writeFileSync(path.join(out, "3d", SMS_ID), "decrypted sms copy");
      return { copied: 1, missing: 0 };
    });
    const o = newOrchestrator();
    backupReturns(ok());
    const result = await o.sync({ udid: UDID });
    expect(copySpy).toHaveBeenCalledTimes(1);
    expect(result.backupPath).not.toBe(chain);
    expect(result.backupPath).toContain(`${path.sep}at-rest-tmp${path.sep}ios-`);
    expect(result.needsCleanup).toBe(true);
    expect(parserSaw[0].smsPlain).toBe(true);
    // the chain's own sms.db stayed sealed (only Manifest.db was unsealed)
    expect(fsSync.readFileSync(path.join(chain, "3d", SMS_ID)).subarray(0, 7).equals(MAGIC)).toBe(true);
    await o.cleanupBackup(result.backupPath!);
    expect(fsSync.existsSync(result.backupPath!)).toBe(false); // C4: parse copy gone after close
    await o.completeBackupAtRest();
    await sealedAfter(o);
  });
});
