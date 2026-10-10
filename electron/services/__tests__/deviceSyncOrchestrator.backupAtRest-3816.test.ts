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
import {
  BACKUP_AT_REST_QUARANTINED_MESSAGE,
  BACKUP_AT_REST_UNREADABLE_MESSAGE,
  BackupAtRest,
  BACKUP_SECURING_SENTENCE,
  QUARANTINE_DIR_NAME,
  readMarkerAt,
} from "../atRest/backupAtRest";
import { createFileCrypto, MAGIC, type KeyResolver } from "../atRest/fileCrypto";
import { createMarkerStore } from "../atRest/markers";
import { setBackupIndexKeysForTests } from "../atRest/backupIndexFiles";
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
      else {
        // Root plists included: sealed between syncs too (founder QA 2026-10-09).
        void root;
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
    pauseWaitMs: 20,
  });
  // Sealed root plists are read (checkBackupStatus) with the test key, never the app's key store.
  setBackupIndexKeysForTests(resolver);
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
  setBackupIndexKeysForTests(null);
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

  it("BACKLOG-3816: the sync does not wait for the finished backup's size walk; the size reaches the run when it ends", async () => {
    const o = newOrchestrator();
    backupReturns(ok({ backupSize: null } as Partial<BackupResult>));
    let finishWalk!: (r: { measured: true; bytes: number }) => void;
    const walk = new Promise<{ measured: true; bytes: number }>((r) => (finishWalk = r));
    const take = jest
      .spyOn(BackupService.prototype, "takeDeferredSizeMeasurement")
      .mockImplementation((udid) => (udid === UDID ? walk : null));
    const result = await o.sync({ udid: UDID });
    // Returned while the walk is still running.
    expect(result.success).toBe(true);
    expect(startBackup).toHaveBeenCalledWith(expect.objectContaining({ deferSizeMeasurement: true }));
    expect(take).toHaveBeenCalledWith(UDID);
    expect(syncTimeline.contextSnapshot().backupBytes).toBeUndefined();
    expect(syncTimeline.contextSnapshot().backupBytesUnmeasured).toBeUndefined();
    finishWalk({ measured: true, bytes: 4242 });
    await new Promise((r) => setImmediate(r));
    expect(syncTimeline.contextSnapshot().backupBytes).toBe(4242);
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
      return fail({ errorCode: "INSUFFICIENT_SPACE" });
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

describe("D1 / G3 — two C-DELTA backup-tool failures in a row force C-FULL for the next sync; nothing else does", () => {
  const smsPath = () => path.join(chain, "3d", SMS_ID);
  const smsSealed = () => fsSync.readFileSync(smsPath()).subarray(0, 7).equals(MAGIC);

  // The outer setup pins C-FULL; these tests run the shipped default (C-DELTA).
  const freshAtRest = () =>
    new BackupAtRest({
      backupsRoot: () => backups,
      files: () => files,
      markers: () => createMarkerStore({ userData: () => userData }),
      ensureKey: async () => undefined,
      freeBytes: async () => Number.MAX_SAFE_INTEGER,
      sleep: async () => undefined,
      log: () => undefined,
    });
  beforeEach(() => {
    atRest = freshAtRest();
  });

  /** Run the next sync and report whether the content file was plaintext (C-FULL) or sealed (C-DELTA) when the tool started. */
  async function nextSyncUnsealedContent(): Promise<boolean> {
    let sealedAtStart: boolean | null = null;
    startBackup.mockImplementation(async () => {
      sealedAtStart = smsSealed();
      return ok();
    });
    // An app restart: a new at-rest service reads the flag from the marker file, and a quit
    // left no in-process lock behind.
    atRest = freshAtRest();
    const o = newOrchestrator(false);
    await o.sync({ udid: UDID });
    await o.lastAtRestSeal;
    expect(sealedAtStart).not.toBeNull();
    return sealedAtStart === false;
  }

  /** One sync whose backup tool fails the given way. */
  async function toolFails(how: "result" | "no-code" | "throw"): Promise<void> {
    const o = newOrchestrator(false);
    if (how === "throw") startBackup.mockRejectedValue(new Error("spawn failed"));
    else if (how === "no-code") backupReturns(fail({ errorCode: undefined, error: "idevicebackup2 exited with code 1" } as Partial<BackupResult>));
    else backupReturns(fail({ errorCode: "BACKUP_FILE_MISSING", error: "The iPhone could not find a file the backup needed." } as Partial<BackupResult>));
    expect((await o.sync({ udid: UDID })).success).toBe(false);
    await sealedAfter(o);
  }

  it("G3: ONE tool error (nothing damaged) -> the next sync is still C-DELTA", async () => {
    await toolFails("result");
    expect(await atRest.forcedFullReason(UDID)).toBeNull();
    expect(await nextSyncUnsealedContent()).toBe(false);
  });

  it.each(["result", "no-code", "throw"] as const)("G3: TWO tool errors in a row (%s) -> the next sync is C-FULL, reason DELTA_TOOL_FAILED", async (how) => {
    await toolFails(how);
    await toolFails(how);
    expect(await atRest.forcedFullReason(UDID)).toBe("DELTA_TOOL_FAILED");
    expect(await nextSyncUnsealedContent()).toBe(true);
  });

  it("G3: a successful sync in between resets the count (fail, succeed, fail -> still C-DELTA)", async () => {
    await toolFails("result");
    expect(await nextSyncUnsealedContent()).toBe(false); // this one succeeds (ok())
    await toolFails("result");
    expect(await atRest.forcedFullReason(UDID)).toBeNull();
    expect(await nextSyncUnsealedContent()).toBe(false);
  });

  it.each([
    ["user cancel", (orc: DeviceSyncOrchestrator) => { orc.cancel(); return fail({ errorCode: undefined, error: "stopped" } as Partial<BackupResult>); }],
    ["phone disconnected", (orc: DeviceSyncOrchestrator) => {
      (orc as unknown as { backupInFlight: { disconnected: boolean } }).backupInFlight.disconnected = true;
      return fail({ errorCode: undefined, error: "stopped" } as Partial<BackupResult>);
    }],
    ["disk guard", (orc: DeviceSyncOrchestrator) => {
      Object.assign(orc, { diskSpaceAborted: true, diskSpaceAtAbort: 1024 });
      return fail({ errorCode: undefined, error: "stopped" } as Partial<BackupResult>);
    }],
    ["app quit", (orc: DeviceSyncOrchestrator) => { Object.assign(orc, { stoppedForQuit: true }); return fail({ errorCode: undefined, error: "stopped" } as Partial<BackupResult>); }],
    ["app quit as BackupService now returns it (BACKUP_CANCELLED)", (orc: DeviceSyncOrchestrator) => { Object.assign(orc, { stoppedForQuit: true }); return fail({ errorCode: "BACKUP_CANCELLED", error: "Backup stopped because Keepr was closed." } as Partial<BackupResult>); }],
    ["password failure", () => fail({ errorCode: "INCORRECT_PASSWORD", error: "wrong password" } as Partial<BackupResult>)],
    ["disk-space error from the tool", () => fail({ errorCode: undefined, error: "No space left on device" } as Partial<BackupResult>)],
  ])("%s -> the flag is NOT set and the next sync is still C-DELTA", async (_name, ending) => {
    const o = newOrchestrator(false);
    backupReturns(ending, o);
    await o.sync({ udid: UDID });
    await o.lastAtRestSeal;
    expect(await atRest.forcedFullReason(UDID)).toBeNull();
    expect(await nextSyncUnsealedContent()).toBe(false);
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

  it("G4: the quit does not happen after all (update failed to install): the phone is not left locked; Try Again runs and its end seals everything", async () => {
    const o = newOrchestrator();
    backupReturns((orc) => {
      Object.assign(orc, { stoppedForQuit: true });
      return fail();
    }, o);
    await o.sync({ udid: UDID });
    expect(atRest.busyReason(UDID)).toBeNull();
    backupReturns(fail());
    const again = await o.sync({ udid: UDID });
    expect(again.error).not.toContain(BACKUP_SECURING_SENTENCE);
    expect(startBackup).toHaveBeenCalledTimes(2);
    await sealedAfter(o);
  });

  it("G4: a successful sync handed to persistence, then a quit that does not happen: completeBackupAtRest gives the phone back", async () => {
    const o = newOrchestrator();
    backupReturns((orc) => {
      Object.assign(orc, { stoppedForQuit: true });
      return ok();
    }, o);
    const result = await o.sync({ udid: UDID });
    expect(result.success).toBe(true);
    expect(atRest.busyReason(UDID)).toBe("syncing"); // persistence still reads the chain
    await o.completeBackupAtRest(true);
    expect(atRest.busyReason(UDID)).toBeNull();
    expect(await readMarkerAt(backups, UDID)).toBe("syncing"); // the launch / idle recovery seals
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

  it("B (founder decision 2026-10-09): a sync started during the launch migration is NOT refused — the migration pauses, the sync runs, its seal finishes the rest", async () => {
    // A pre-2.40 chain: plaintext, marker removed, so migrate really seals.
    await atRest.removeMarker(UDID);
    fsSync.rmSync(chain, { recursive: true, force: true });
    makeChain();
    const o = newOrchestrator();
    backupReturns(ok());
    const errors: unknown[] = [];
    o.on("error", (e) => errors.push(e));
    // A launch migration mid-pass (the real pass/pause mechanics are covered in
    // backupAtRest.test.ts): it holds the phone and stops when asked.
    const internals = atRest as unknown as {
      busy: Map<string, string>;
      pausable: Map<string, Int32Array>;
      release: (u: string) => void;
    };
    const flag = new Int32Array(new SharedArrayBuffer(4));
    internals.busy.set(UDID, "migrating");
    internals.pausable.set(UDID, flag);
    // It takes several of the sync's wait intervals (pauseWaitMs 20) to reach its next
    // file boundary, as a large file would: the sync keeps waiting, it never gives up.
    let askedAt: number | null = null;
    let pausedAt: number | null = null;
    const pass = setInterval(() => {
      if (Atomics.load(flag, 0) !== 1 || pausedAt !== null) return;
      askedAt ??= Date.now();
      if (Date.now() - askedAt >= 150) {
        pausedAt = Date.now();
        internals.release(UDID);
      }
    }, 5);
    const result = await o.sync({ udid: UDID });
    clearInterval(pass);
    expect(pausedAt).not.toBeNull();
    expect(result.success).toBe(true);
    expect(startBackup).toHaveBeenCalled();
    expect(errors).toEqual([]);
    await o.completeBackupAtRest(true);
    await sealedAfter(o);
  });

  it("B-cancel: Cancel while the sync waits for a background seal to pause is a cancel, not 'Sync Failed', and the seal resumes", async () => {
    const o = newOrchestrator();
    backupReturns(ok());
    const errors: unknown[] = [];
    o.on("error", (e) => errors.push(e));
    // A background pass that has not reached its next file boundary yet.
    const internals = atRest as unknown as { busy: Map<string, string>; pausable: Map<string, Int32Array> };
    internals.busy.set(UDID, "sealing");
    internals.pausable.set(UDID, new Int32Array(new SharedArrayBuffer(4)));
    const syncing = o.sync({ udid: UDID });
    await new Promise((r) => setTimeout(r, 60));
    o.cancel();
    const result = await syncing;
    expect(result.error).toBe("Sync cancelled by user");
    expect(result.error).not.toContain(BACKUP_SECURING_SENTENCE);
    expect(errors).toEqual([]);
    expect(startBackup).not.toHaveBeenCalled();
    internals.busy.delete(UDID);
    internals.pausable.delete(UDID);
  });

  // BACKLOG-3816 (phantom cancel, PC 2026-10-10 03:38:42Z-03:41:12Z): the run that ended
  // `user-cancel` was in exactly this wait — a sync paused behind the post-unplug seal
  // pass, phases []. Its terminal row may say `user-cancel` only when a named control
  // asked; a cancel that arrives without one says `cancel-unattributed`.
  describe("phantom cancel: the row names the control that ended the wait", () => {
    async function cancelDuringPauseWait(trigger?: string): Promise<{ error: string | undefined; row: { outcome: string; fields: Record<string, unknown> } }> {
      const rows: Array<{ outcome: string; fields: Record<string, unknown> }> = [];
      const tl = syncTimeline as unknown as { reporter: (row: unknown) => void };
      const original = tl.reporter;
      tl.reporter = (row) => rows.push(row as { outcome: string; fields: Record<string, unknown> });
      try {
        const o = newOrchestrator();
        backupReturns(ok());
        const internals = atRest as unknown as { busy: Map<string, string>; pausable: Map<string, Int32Array> };
        internals.busy.set(UDID, "sealing");
        internals.pausable.set(UDID, new Int32Array(new SharedArrayBuffer(4)));
        const syncing = o.sync({ udid: UDID });
        await new Promise((r) => setTimeout(r, 60));
        (o.cancel as (t?: unknown) => void)(trigger);
        const result = await syncing;
        internals.busy.delete(UDID);
        internals.pausable.delete(UDID);
        expect(startBackup).not.toHaveBeenCalled();
        expect(rows).toHaveLength(1);
        return { error: result.error ?? undefined, row: rows[0] };
      } finally {
        tl.reporter = original;
      }
    }

    it("a Cancel click (progress-cancel) records ended_by=user-cancel with the control as reason_code", async () => {
      const { error, row } = await cancelDuringPauseWait("progress-cancel");
      expect(error).toBe("Sync cancelled by user");
      expect(row.outcome).toBe("cancelled");
      expect(row.fields.endedBy).toBe("user-cancel");
      expect(row.fields.reasonCode).toBe("progress-cancel");
    });

    it("a cancel with no trigger records ended_by=cancel-unattributed, never user-cancel", async () => {
      const { row } = await cancelDuringPauseWait(undefined);
      expect(row.outcome).toBe("cancelled");
      expect(row.fields.endedBy).toBe("cancel-unattributed");
      expect(row.fields.reasonCode).toBeUndefined();
    });

    it("a cancel with an unknown trigger records ended_by=cancel-unattributed", async () => {
      const { row } = await cancelDuringPauseWait("window-close");
      expect(row.fields.endedBy).toBe("cancel-unattributed");
      expect(row.fields.reasonCode).toBeUndefined();
    });
  });

  // BACKLOG-3816 (PC 2026-10-10): the founder cancelled at 20:39:30, 48 s into
  // "Initializing sync…", while checkBackupStatus walked the 576k-file chain. The sync
  // kept going for ~100 s (backup status, disk, storage query, estimate), then asked
  // the background seal to pause, and only then ended. A cancel during pre-flight must
  // end the sync at once, run no further step and never request the at-rest pause.
  describe("pre-flight honours a cancel at once", () => {
    function hang<T>(): Promise<T> {
      return new Promise<T>(() => undefined);
    }

    async function cancelDuring(step: "backup-status" | "storage-query") {
      const rows: Array<{ outcome: string; elapsedMs: number; fields: Record<string, unknown> }> = [];
      const tl = syncTimeline as unknown as { reporter: (row: unknown) => void };
      const original = tl.reporter;
      tl.reporter = (row) => rows.push(row as { outcome: string; elapsedMs: number; fields: Record<string, unknown> });
      const internals = atRest as unknown as { busy: Map<string, string>; pausable: Map<string, Int32Array> };
      const flag = new Int32Array(new SharedArrayBuffer(4));
      try {
        const o = newOrchestrator();
        backupReturns(ok());
        // A background seal is running on the phone, as on the PC.
        internals.busy.set(UDID, "sealing");
        internals.pausable.set(UDID, flag);
        let reached!: () => void;
        const atStep = new Promise<void>((r) => (reached = r));
        const P = BackupService.prototype;
        const status = jest.spyOn(P, "checkBackupStatus");
        const deviceService = (o as unknown as { deviceService: { getDeviceStorageInfo: (u: string) => Promise<unknown> } }).deviceService;
        const storage = jest.spyOn(deviceService, "getDeviceStorageInfo");
        if (step === "backup-status") {
          status.mockImplementation(() => {
            reached();
            return hang();
          });
        } else {
          // Once: `getDeviceStorageInfo` is the module mock's own jest.fn, which
          // restoreAllMocks does not reset.
          storage.mockImplementationOnce(() => {
            reached();
            return hang();
          });
        }
        const diskCheck = jest.spyOn(o as unknown as { checkAvailableDiskSpace: (n: number) => Promise<unknown> }, "checkAvailableDiskSpace");
        const beginAtRest = jest.spyOn(atRest, "beginSync");
        const syncing = o.sync({ udid: UDID });
        await atStep;
        const callsBefore = { disk: diskCheck.mock.calls.length, storage: storage.mock.calls.length };
        const cancelledAt = Date.now();
        o.cancel("progress-cancel");
        const result = await syncing;
        const tookMs = Date.now() - cancelledAt;
        return { result, tookMs, rows, diskCheck, storage, callsBefore, beginAtRest, flag };
      } finally {
        tl.reporter = original;
        internals.busy.delete(UDID);
        internals.pausable.delete(UDID);
      }
    }

    it.each(["backup-status", "storage-query"] as const)(
      "cancel during %s: ends within 1 s, no later step runs, the seal is never asked to pause",
      async (step) => {
        const r = await cancelDuring(step);
        expect(r.result.success).toBe(false);
        expect(r.result.error).toBe("Sync cancelled by user");
        expect(r.tookMs).toBeLessThan(1000);
        // Nothing after the cancel: no further disk check, no storage query, no at-rest pause.
        expect(r.diskCheck.mock.calls.length).toBe(r.callsBefore.disk);
        expect(r.storage.mock.calls.length).toBe(r.callsBefore.storage);
        expect(r.beginAtRest).not.toHaveBeenCalled();
        expect(Atomics.load(r.flag, 0)).toBe(0);
        expect(startBackup).not.toHaveBeenCalled();
        // The run row is closed at the cancel, as the user's.
        expect(r.rows).toHaveLength(1);
        expect(r.rows[0].outcome).toBe("cancelled");
        expect(r.rows[0].fields.endedBy).toBe("user-cancel");
      },
    );

    it("cancel during a step that cannot be interrupted (password lookup): the sync stops when it returns and never asks the seal to pause", async () => {
      const internals = atRest as unknown as { busy: Map<string, string>; pausable: Map<string, Int32Array> };
      const flag = new Int32Array(new SharedArrayBuffer(4));
      internals.busy.set(UDID, "sealing");
      internals.pausable.set(UDID, flag);
      try {
        const o = newOrchestrator();
        backupReturns(ok());
        let release!: () => void;
        let reached!: () => void;
        const atStep = new Promise<void>((r) => (reached = r));
        jest
          .spyOn(o as unknown as { resolveBackupPassword: () => Promise<unknown> }, "resolveBackupPassword")
          .mockImplementation(() => {
            reached();
            return new Promise((r) => (release = () => r({ kind: "none" })));
          });
        const beginAtRest = jest.spyOn(atRest, "beginSync");
        const syncing = o.sync({ udid: UDID });
        const first = await Promise.race([atStep.then(() => "step"), syncing.then((r) => r)]);
        expect(first).toBe("step");
        o.cancel("progress-cancel");
        release();
        const result = await syncing;
        expect(result.error).toBe("Sync cancelled by user");
        expect(beginAtRest).not.toHaveBeenCalled();
        expect(Atomics.load(flag, 0)).toBe(0);
        expect(startBackup).not.toHaveBeenCalled();
      } finally {
        internals.busy.delete(UDID);
        internals.pausable.delete(UDID);
      }
    });

    it("the backup-size walk stops on a cancelled signal (no full walk behind the user's back)", async () => {
      const controller = new AbortController();
      controller.abort();
      const report = await new BackupService().checkBackupStatus(UDID, { signal: controller.signal });
      expect(report).toMatchObject({ state: "present", size: { measured: false, reason: "cancelled" } });
    });
  });

  it("B2: a phone held by something that cannot pause (another sync) is not moved aside or deleted by the new-chain step", async () => {
    const P = BackupService.prototype;
    jest.spyOn(P, "checkEncryptionStatus").mockResolvedValue({ isEncrypted: true, needsPassword: true, status: "on" });
    jest.spyOn(P, "readChainEncryption").mockResolvedValue("plaintext");
    const aside = jest.spyOn(P, "moveChainAside").mockResolvedValue("aside");
    const del = jest.spyOn(P, "removePlaintextChain").mockResolvedValue(true);
    const o = newOrchestrator();
    backupReturns(ok());
    const busy = (atRest as unknown as { busy: Map<string, string> }).busy;
    busy.set(UDID, "migrating");
    const result = await o.sync({ udid: UDID, password: "typed" });
    busy.delete(UDID);
    expect(result.error).toContain(BACKUP_SECURING_SENTENCE);
    expect(aside).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
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
      return { copied: 1, missing: 0, unreadable: 0 };
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

describe("C2-DELTA (founder must-fix 2026-10-09) — every end of a C-DELTA sync reseals at once; persistence is not waited for", () => {
  let copySpy: jest.SpyInstance;
  beforeEach(() => {
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
    copySpy = jest.spyOn(atRest, "buildParseCopy").mockImplementation(async (_udid, out) => {
      fsSync.mkdirSync(path.join(out, "3d"), { recursive: true });
      fsSync.writeFileSync(path.join(out, "3d", SMS_ID), "decrypted sms copy");
      return { copied: 1, missing: 0, unreadable: 0 };
    });
  });

  it("success: the seal starts right after the parse copy — before persistence ends; completeBackupAtRest adds nothing", async () => {
    const o = newOrchestrator();
    const finish = jest.spyOn(atRest, "finishSync");
    backupReturns(ok());
    const result = await o.sync({ udid: UDID });
    expect(result.success).toBe(true);
    expect(copySpy).toHaveBeenCalledTimes(1);
    // The seal starts AFTER the parse copy has been made (parsers read the copy, not the chain).
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish.mock.invocationCallOrder[0]).toBeGreaterThan(copySpy.mock.invocationCallOrder[0]);
    // Persistence (the 'complete' listener) has NOT run completeBackupAtRest, yet:
    await sealedAfter(o);
    const sealPromise = o.lastAtRestSeal;
    await o.completeBackupAtRest(true);
    expect(o.lastAtRestSeal).toBe(sealPromise); // no second seal was started
    await o.cleanupBackup(result.backupPath!);
  });

  it("G3: the early seal after the parse copy resets the consecutive tool-failure count", async () => {
    await createMarkerStore({ userData: () => userData }).setToolFailures(UDID, 1);
    const o = newOrchestrator();
    const finish = jest.spyOn(atRest, "finishSync");
    backupReturns(ok());
    const result = await o.sync({ udid: UDID });
    expect(result.success).toBe(true);
    expect(finish).toHaveBeenCalledTimes(1);
    await sealedAfter(o);
    const marker = JSON.parse(fsSync.readFileSync(path.join(backups, ".keepr-at-rest", `${UDID}.json`), "utf8"));
    expect(marker.toolFailures).toBeUndefined();
    await o.completeBackupAtRest(true);
    await o.cleanupBackup(result.backupPath!);
  });

  it("disconnect (the tool exits, the phone is gone)", async () => {
    const o = newOrchestrator();
    backupReturns((orc) => {
      (orc as unknown as { backupInFlight: { disconnected: boolean } }).backupInFlight.disconnected = true;
      return fail();
    }, o);
    expect((await o.sync({ udid: UDID })).success).toBe(false);
    await sealedAfter(o);
    // Keeps the force-full flag semantics: a disconnect does not force C-FULL.
    expect(await atRest.forcedFullReason(UDID)).toBeNull();
  });

  it("cancel during the backup", async () => {
    const o = newOrchestrator();
    backupReturns((orc) => {
      orc.cancel();
      return fail();
    }, o);
    expect((await o.sync({ udid: UDID })).error).toMatch(/cancel/i);
    await sealedAfter(o);
  });

  it("the backup tool errors", async () => {
    const o = newOrchestrator();
    backupReturns(fail({ errorCode: "DEVICE_LOCKED", error: "locked" } as Partial<BackupResult>));
    expect((await o.sync({ udid: UDID })).success).toBe(false);
    await sealedAfter(o);
  });

  it("a throw after the parse copy (parser explodes): sealed once, not twice", async () => {
    const o = newOrchestrator();
    parserBehaviour = "throw";
    backupReturns(ok());
    const finish = jest.spyOn(atRest, "finishSync");
    expect((await o.sync({ udid: UDID })).error).toMatch(/parser exploded/);
    await sealedAfter(o);
    expect(finish).toHaveBeenCalledTimes(1);
  });
});

describe("B2 — an unreadable kept backup no longer ends iPhone sync", () => {
  it("one flipped byte: the chain is quarantined, the user is told plainly, and a full backup runs", async () => {
    const sms = path.join(chain, "Manifest.db");
    const buf = fsSync.readFileSync(sms);
    buf[60 + 5] ^= 0x01; // inside the first chunk, not the header
    fsSync.writeFileSync(sms, buf);
    const o = newOrchestrator();
    const messages: string[] = [];
    o.on("progress", (p: { message: string }) => messages.push(p.message));
    startBackup.mockImplementation(async () => {
      // A full backup: idevicebackup2 writes a new chain from scratch.
      expect(fsSync.existsSync(chain)).toBe(false);
      makeChain();
      return ok({ isIncremental: false });
    });
    const result = await o.sync({ udid: UDID });
    expect(result.success).toBe(true);
    expect(startBackup).toHaveBeenCalledTimes(1);
    expect(messages).toContain(BACKUP_AT_REST_QUARANTINED_MESSAGE);
    const quarantined = fsSync.readdirSync(path.join(backups, QUARANTINE_DIR_NAME));
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0].startsWith(`${UDID}-`)).toBe(true);
    await o.completeBackupAtRest();
    await sealedAfter(o);
  });
});

describe("lock before the new-chain step", () => {
  it("a launch migration that arrives while the old chain is being moved aside stands aside", async () => {
    const P = BackupService.prototype;
    jest.spyOn(P, "checkEncryptionStatus").mockResolvedValue({ isEncrypted: true, needsPassword: true, status: "on" });
    jest.spyOn(P, "readChainEncryption").mockResolvedValue("plaintext");
    let migrationDuringMove: string | null = null;
    const aside = jest.spyOn(P, "moveChainAside").mockImplementation(async () => {
      migrationDuringMove = await atRest.migrate(UDID);
      return "aside";
    });
    const o = newOrchestrator();
    (o as unknown as { needsNewEncryptedChain: () => Promise<boolean> }).needsNewEncryptedChain = async () => true;
    backupReturns(ok());
    await o.sync({ udid: UDID, password: "typed" });
    expect(aside).toHaveBeenCalledTimes(1);
    expect(migrationDuringMove).toBe("busy");
    await o.completeBackupAtRest();
  });
});

describe("an error in the new-chain step is an ordinary sync error, not an at-rest refusal", () => {
  it("moveChainAside throwing under the lock surfaces its own message and releases the lock", async () => {
    const P = BackupService.prototype;
    jest.spyOn(P, "checkEncryptionStatus").mockResolvedValue({ isEncrypted: true, needsPassword: true, status: "on" });
    jest.spyOn(P, "readChainEncryption").mockResolvedValue("plaintext");
    jest.spyOn(P, "moveChainAside").mockRejectedValue(new Error("rename blew up"));
    const o = newOrchestrator();
    (o as unknown as { needsNewEncryptedChain: () => Promise<boolean> }).needsNewEncryptedChain = async () => true;
    backupReturns(ok());
    const emitted: unknown[] = [];
    o.on("error", (e: unknown) => emitted.push(e));
    const result = await o.sync({ udid: UDID, password: "typed" });
    expect(result.success).toBe(false);
    expect(result.error).toBe("rename blew up");
    // An ordinary failure emits the Error itself; an at-rest refusal emits { message }.
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toBeInstanceOf(Error);
    expect(result.error).not.toBe(BACKUP_AT_REST_UNREADABLE_MESSAGE);
    expect(startBackup).not.toHaveBeenCalled();
    expect(atRest.busyReason(UDID)).toBeNull();
  });
});

describe("progress for passes no sync is watching", () => {
  it("the seal after a sync / the launch migration reach the sync status channel", async () => {
    const o = newOrchestrator();
    o.watchBackupAtRestProgress();
    o.watchBackupAtRestProgress(); // idempotent: one subscription
    const seen: Array<{ phase: string; message: string }> = [];
    o.on("progress", (p: { phase: string; message: string }) => seen.push(p));
    // A plaintext file appears; a seal with no caller callback reports through the event.
    write("dd/" + "d".repeat(40), "new plaintext");
    await atRest.seal(UDID);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((p) => p.phase === "cleanup")).toBe(true);
    expect(seen[seen.length - 1].message).toBe("Securing your iPhone backup… 100%");
    expect(atRest.listenerCount("progress")).toBe(1);
  });
});

// SR PROBE (PR #2903): the founder's beta.3 sequence, driven through the REAL disconnect
// machinery: DeviceDetection emits device-disconnected -> orchestrator confirms with a
// second listing -> backupService.cancelBackup() -> the child exits with code null ->
// startBackup resolves a failure -> sync ends with an error. Nothing sets
// backupInFlight.disconnected by hand.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { deviceDetectionService: detector } = require("../deviceDetectionService");

describe.each(["delta", "full"] as const)("SR probe — disconnect -> cancel -> exit code null (%s)", (strategy) => {
  it("reseals at once and leaves nothing plaintext", async () => {
    atRest = new BackupAtRest({
      backupsRoot: () => backups,
      files: () => files,
      markers: () => createMarkerStore({ userData: () => userData }),
      ensureKey: async () => undefined,
      freeBytes: async () => Number.MAX_SAFE_INTEGER,
      sleep: async () => undefined,
      log: () => undefined,
      strategy: () => strategy,
    });
    const o = newOrchestrator();
    (o as unknown as { disconnectConfirmDelayMs: number }).disconnectConfirmDelayMs = 1;
    let running = false;
    let exitWithNull: (() => void) | null = null;
    (BackupService.prototype.getStatus as unknown as jest.Mock).mockImplementation(() => ({
      isRunning: running, currentDeviceUdid: running ? UDID : null, progress: null,
    }));
    (BackupService.prototype.cancelBackup as unknown as jest.Mock).mockImplementation(() => {
      exitWithNull?.();
    });
    detector.probeConnectedUdids.mockResolvedValue([]);
    const finish = jest.spyOn(atRest, "finishSync");
    startBackup.mockImplementation(async () => {
      running = true;
      // The phone wrote new files (plaintext) and the index is unsealed.
      write("cd/" + "c".repeat(40), "a file the phone sent this time");
      write("ce/" + "e".repeat(40), "another new file");
      return new Promise<BackupResult>((resolve) => {
        exitWithNull = () => {
          running = false;
          resolve(fail({ errorCode: undefined, error: "Backup failed with code null" } as Partial<BackupResult>));
        };
        // Unplug while the transfer runs.
        setTimeout(() => detector.emit("device-disconnected", { udid: UDID, name: "x" }), 5);
      });
    });
    const t0 = Date.now();
    const result = await o.sync({ udid: UDID });
    expect(result.success).toBe(false);
    expect(BackupService.prototype.cancelBackup).toHaveBeenCalled();
    // The seal STARTED before sync() returned (finally path), within seconds.
    expect(finish).toHaveBeenCalledTimes(1);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(o.lastAtRestSeal).not.toBeNull();
    await o.lastAtRestSeal;
    expect(plaintextLeft()).toEqual([]);
    expect(await readMarkerAt(backups, UDID)).toBe("encrypted");
    expect(atRest.busyReason(UDID)).toBeNull();
    expect(await atRest.forcedFullReason(UDID)).toBeNull();
  });
});

// PC unplug retest 2026-10-09 (founder's local2 log): after the unplug the seal walked all
// 576k files newest first; Try Again paused it before it reached Manifest.db, which stayed
// plaintext. Same real disconnect wiring as the SR probe above, then Try Again at once.
describe("PC unplug retest — the index is sealed first at the error end; Try Again pauses only the walk", () => {
  it("disconnect → Manifest.db + plists sealed before any content file → immediate Try Again (also unplugged) → its end leaves nothing plaintext", async () => {
    const order: string[] = [];
    atRest = new BackupAtRest({
      backupsRoot: () => backups,
      files: () => files,
      markers: () => createMarkerStore({ userData: () => userData }),
      ensureKey: async () => undefined,
      freeBytes: async () => Number.MAX_SAFE_INTEGER,
      sleep: async () => undefined,
      log: () => undefined,
      strategy: () => "delta",
      pauseWaitMs: 20,
      sealEngineOptions: { beforeSeal: (p) => order.push(p) },
    });
    let running = false;
    let exitWithNull: (() => void) | null = null;
    (BackupService.prototype.getStatus as unknown as jest.Mock).mockImplementation(() => ({
      isRunning: running, currentDeviceUdid: running ? UDID : null, progress: null,
    }));
    (BackupService.prototype.cancelBackup as unknown as jest.Mock).mockImplementation(() => exitWithNull?.());
    detector.probeConnectedUdids.mockResolvedValue([]);
    let n = 0;
    startBackup.mockImplementation(async () => {
      running = true;
      n++;
      // The index is unsealed (C-DELTA) and the phone sends files newer than it.
      expect(fsSync.readFileSync(path.join(chain, "Manifest.db")).subarray(0, 7).equals(MAGIC)).toBe(false);
      const later = new Date(Date.now() + 60_000 * n);
      for (const d of ["c", "e"]) {
        write(`${d}${n}/${d.repeat(40)}`, `sent in sync ${n}`);
        fsSync.utimesSync(path.join(chain, `${d}${n}/${d.repeat(40)}`), later, later);
      }
      return new Promise<BackupResult>((resolve) => {
        exitWithNull = () => {
          running = false;
          resolve(fail({ errorCode: undefined, error: "Backup failed with code null" } as Partial<BackupResult>));
        };
        setTimeout(() => detector.emit("device-disconnected", { udid: UDID, name: "x" }), 5);
      });
    });
    const o = newOrchestrator();
    (o as unknown as { disconnectConfirmDelayMs: number }).disconnectConfirmDelayMs = 1;
    order.length = 0;
    expect((await o.sync({ udid: UDID })).success).toBe(false);
    const firstSeal = o.lastAtRestSeal;
    // Try Again at once: the first end's walk gives way; the index was sealed already.
    expect((await o.sync({ udid: UDID })).success).toBe(false);
    await firstSeal;
    const root = (p: string) => path.dirname(p) === chain;
    const firstContent = order.findIndex((p) => !root(p));
    expect(order.slice(0, firstContent).map((p) => path.basename(p)).sort()).toEqual(
      ["Info.plist", "Manifest.db", "Manifest.plist", "Status.plist"],
    );
    await sealedAfter(o);
  });
});
