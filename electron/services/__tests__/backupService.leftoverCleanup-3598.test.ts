/**
 * BACKLOG-3598 — which backup folders the leftover cleanup may delete, against a REAL
 * temp directory (`fs` is not mocked; same approach as
 * `backupService.interruptedDetection-2911.test.ts`).
 *
 * Leftover := the folder exists AND `Manifest.db` is ENOENT. Everything else is kept:
 * absent, any folder with a `Manifest.db`, anything a read failed on, anything whose
 * name is not exactly a udid.
 *
 * ## Fixture provenance
 *
 * STATE A-D are the BACKLOG-2911 on-disk shapes; the Status.plist bytes are copied from
 * that file unchanged (see it for where they came from).
 *
 * "Manifest present, Info.plist absent" is NOT invented: idevicebackup2 deletes and
 * rewrites Info.plist at the start of every backup run —
 * libimobiledevice `tools/idevicebackup2.c` @ fa0f79190142bc309307967c058f89c1b36eb6b8,
 * lines 2242-2243: `remove_file(info_path);` then
 * `plist_write_to_file(info_plist, info_path, PLIST_FORMAT_XML, 0);`. A run killed
 * between the two (or whose Info.plist factory failed, which still reaches the remove)
 * leaves a real, indexed backup with no Info.plist. It must not be deleted.
 */

import fsSync from "fs";
import os from "os";
import path from "path";

const REAL_TORN_STATUS_PLIST_B64 =
  "YnBsaXN0MDDWAQIDBAUGBwgJCgsMXElzRnVsbEJhY2t1cFdWZXJzaW9uVFVVSURURGF0ZVtCYWNrdXBTdGF0ZV1TbmFwc2hvdFN0YXRlCVMzLjNfECQ2MUFDNDYzMi1DNDZFLTRCRjgtODg4QS0wQjFDODlGQUEzOUQzQcgf5+ZAILxVZW1wdHlZdXBsb2FkaW5nCBUiKi80QE5PU3qDiQAAAAAAAAEBAAAAAAAAAA0AAAAAAAAAAAAAAAAAAACT";
const DERIVED_FINISHED_STATUS_PLIST_B64 =
  "YnBsaXN0MDDWAQIDBAUGBwgJCgsMXVNuYXBzaG90U3RhdGVXVmVyc2lvbltCYWNrdXBTdGF0ZVxJc0Z1bGxCYWNrdXBURGF0ZVRVVUlEWGZpbmlzaGVkUzMuM1NuZXcJM0HIH+fmQCC8XxAkNjFBQzQ2MzItQzQ2RS00QkY4LTg4OEEtMEIxQzg5RkFBMzlECBUjKzdESU5XW19gaQAAAAAAAAEBAAAAAAAAAA0AAAAAAAAAAAAAAAAAAACQ";
const TORN_BYTES = Buffer.from(REAL_TORN_STATUS_PLIST_B64, "base64");
const FINISHED_BYTES = Buffer.from(DERIVED_FINISHED_STATUS_PLIST_B64, "base64");
const SQLITE_MAGIC = "SQLite format 3\u0000";
const INFO = Buffer.from("<plist></plist>");
const MANIFEST = Buffer.from(SQLITE_MAGIC);

const UDID = "00008030-0011223344556677";

jest.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: jest.fn(() => process.env.KEEPR_3598B_USERDATA as string),
  },
}));

jest.mock("electron-log", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureMessage: jest.fn(),
  captureException: jest.fn(),
}));

jest.mock("../libimobiledeviceService", () => ({
  getCommand: jest.fn(() => "/nonexistent/idevicebackup2"),
  isMockMode: jest.fn(() => false),
  canUseLibimobiledevice: jest.fn(() => true),
}));

jest.mock("../backupDecryptionService", () => ({
  BackupDecryptionService: jest.fn().mockImplementation(() => ({})),
  backupDecryptionService: { isBackupEncrypted: jest.fn().mockResolvedValue(false), decryptBackup: jest.fn() },
}));

jest.mock("better-sqlite3-multiple-ciphers", () =>
  jest.fn().mockImplementation(() => ({
    prepare: jest.fn().mockReturnValue({ all: jest.fn(), get: jest.fn(), run: jest.fn() }),
    close: jest.fn(),
  })),
);

import { BackupService } from "../backupService";

type Files = Record<string, Buffer>;

/** The named on-disk states. */
const STATES: Record<string, Files> = {
  "STATE A (finished, indexed)": { "Status.plist": FINISHED_BYTES, "Info.plist": INFO, "Manifest.db": MANIFEST },
  "STATE B (torn first backup, no manifest)": { "Status.plist": TORN_BYTES, "Info.plist": INFO },
  "STATE C (torn incremental, old manifest)": { "Status.plist": TORN_BYTES, "Info.plist": INFO, "Manifest.db": MANIFEST },
  "STATE D (no Status.plist, indexed)": { "Info.plist": INFO, "Manifest.db": MANIFEST },
  "manifest present, Info.plist absent": { "Status.plist": TORN_BYTES, "Manifest.db": MANIFEST },
  "empty folder (process killed before first write)": {},
};
const LEFTOVER_STATES = new Set([
  "STATE B (torn first backup, no manifest)",
  "empty folder (process killed before first write)",
]);

let userDataDir: string;
let backupsDir: string;
let service: BackupService;

function lay(name: string, files: Files): string {
  const dir = path.join(backupsDir, name);
  fsSync.rmSync(dir, { recursive: true, force: true });
  fsSync.mkdirSync(path.join(dir, "0a"), { recursive: true });
  fsSync.writeFileSync(path.join(dir, "0a", "blob"), Buffer.alloc(2048, 7));
  for (const [f, content] of Object.entries(files)) fsSync.writeFileSync(path.join(dir, f), content);
  return dir;
}

beforeAll(() => {
  userDataDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "keepr-3598b-"));
  process.env.KEEPR_3598B_USERDATA = userDataDir;
  backupsDir = path.join(userDataDir, "Backups");
});

afterAll(() => {
  fsSync.rmSync(userDataDir, { recursive: true, force: true });
  delete process.env.KEEPR_3598B_USERDATA;
});

beforeEach(() => {
  jest.restoreAllMocks();
  fsSync.rmSync(backupsDir, { recursive: true, force: true });
  fsSync.mkdirSync(backupsDir, { recursive: true });
  service = new BackupService();
});

describe("BACKLOG-3598: classifying a backup folder", () => {
  it("no folder -> absent", async () => {
    await expect(service.classifyBackupFolder(UDID)).resolves.toBe("absent");
  });

  for (const [name, files] of Object.entries(STATES)) {
    const expected = LEFTOVER_STATES.has(name) ? "leftover" : "indexed";
    it(`${name} -> ${expected}`, async () => {
      lay(UDID, files);
      await expect(service.classifyBackupFolder(UDID)).resolves.toBe(expected);
    });
  }

  it("PARITY (control 9) — every leftover is also refused as a prior backup by checkBackupStatus", async () => {
    // `isUsablePriorBackup` (deviceSyncOrchestrator) is `state === "present" && isComplete`.
    // Deleting something the sync would have reused is the failure this pins.
    for (const [name, files] of Object.entries(STATES)) {
      lay(UDID, files);
      const folder = await service.classifyBackupFolder(UDID);
      const status = await service.checkBackupStatus(UDID);
      const usable = status.state === "present" && status.isComplete;
      if (folder === "leftover") {
        expect({ name, usable }).toEqual({ name, usable: false });
      }
    }
  });
});

describe("BACKLOG-3598: the sweep at sync start (control 4)", () => {
  it("removes every leftover and keeps everything else", async () => {
    const udids = [
      "00008030-0000000000000001",
      "00008030-0000000000000002",
      "00008030-0000000000000003",
      "00008030-0000000000000004",
      "00008030-0000000000000005",
      "00008030-0000000000000006",
    ];
    const names = Object.keys(STATES);
    names.forEach((n, i) => lay(udids[i], STATES[n]));
    // Not a udid at all, and the two names `validateDeviceUdid` would TRIM into one (R3).
    lay("not-a-device", STATES["STATE B (torn first backup, no manifest)"]);
    lay(` ${UDID}`, STATES["STATE B (torn first backup, no manifest)"]);
    lay(`${UDID} `, STATES["STATE B (torn first backup, no manifest)"]);

    const announced: number[] = [];
    const sweep = await service.sweepLeftoverBackups(() => announced.push(1));

    const survivors = fsSync.readdirSync(backupsDir).sort();
    const expectedSurvivors = [
      ...names.map((n, i) => (LEFTOVER_STATES.has(n) ? null : udids[i])).filter((x): x is string => x !== null),
      "not-a-device",
      ` ${UDID}`,
      `${UDID} `,
    ].sort();
    expect(survivors).toEqual(expectedSurvivors);
    expect(sweep.removed).toBe(LEFTOVER_STATES.size);
    expect(sweep.failures).toEqual([]);
    expect(sweep.bytesFreed).toBeGreaterThanOrEqual(2 * 2048);
    expect(announced.length).toBe(LEFTOVER_STATES.size);
  });

  it("no Backups folder at all -> nothing to do, no throw", async () => {
    fsSync.rmSync(backupsDir, { recursive: true, force: true });
    await expect(service.sweepLeftoverBackups()).resolves.toEqual({ removed: 0, bytesFreed: 0, failures: [] });
  });
});

describe("BACKLOG-3598: a read that fails is never a delete (control 5)", () => {
  function denyManifestStat(code: string) {
    const realStat = fsSync.promises.stat;
    let served = 0;
    jest.spyOn(fsSync.promises, "stat").mockImplementation((async (p: fsSync.PathLike, opts?: unknown) => {
      if (String(p).endsWith(`${path.sep}Manifest.db`)) {
        served += 1;
        throw Object.assign(new Error("locked"), { code });
      }
      return (realStat as (p: fsSync.PathLike, o?: unknown) => Promise<fsSync.Stats>)(p, opts);
    }) as typeof fsSync.promises.stat);
    return () => served;
  }

  it("Manifest.db stat throws EPERM -> checkBackupStatus is UNKNOWN, not 'present, incomplete'", async () => {
    lay(UDID, STATES["STATE A (finished, indexed)"]);
    const served = denyManifestStat("EPERM");

    const status = await service.checkBackupStatus(UDID);

    expect(served()).toBeGreaterThan(0);
    expect(status.state).toBe("unknown");
  });

  it("Manifest.db stat throws EBUSY -> classified unknown, and the folder is not removed", async () => {
    const dir = lay(UDID, STATES["STATE A (finished, indexed)"]);
    const served = denyManifestStat("EBUSY");

    await expect(service.classifyBackupFolder(UDID)).resolves.toBe("unknown");
    await expect(service.removeLeftoverBackup(UDID)).resolves.toEqual({ outcome: "kept", folder: "unknown" });
    const sweep = await service.sweepLeftoverBackups();

    expect(served()).toBeGreaterThan(0);
    expect(sweep.removed).toBe(0);
    expect(fsSync.existsSync(path.join(dir, "Manifest.db"))).toBe(true);
  });
});

describe("BACKLOG-3598: delete failures and concurrency", () => {
  it("rm rejects EBUSY -> returned as failed:EBUSY, never thrown, folder still there for the next sweep", async () => {
    const dir = lay(UDID, STATES["STATE B (torn first backup, no manifest)"]);
    jest
      .spyOn(fsSync.promises, "rm")
      .mockRejectedValue(Object.assign(new Error("resource busy or locked"), { code: "EBUSY" }));

    await expect(service.removeLeftoverBackup(UDID)).resolves.toEqual({ outcome: "failed", errorCode: "EBUSY" });
    expect(fsSync.existsSync(dir)).toBe(true);
  });

  it("rm is asked to retry the Windows lock errors", async () => {
    lay(UDID, STATES["STATE B (torn first backup, no manifest)"]);
    const rmSpy = jest.spyOn(fsSync.promises, "rm");

    await service.removeLeftoverBackup(UDID);

    expect(rmSpy).toHaveBeenCalledWith(
      path.join(backupsDir, UDID),
      expect.objectContaining({ recursive: true, force: true, maxRetries: 3 }),
    );
  });

  it("R2 — two services removing at once never run rm concurrently", async () => {
    lay(UDID, STATES["STATE B (torn first backup, no manifest)"]);
    lay("00008030-0000000000000009", STATES["STATE B (torn first backup, no manifest)"]);
    const realRm = fsSync.promises.rm;
    let active = 0;
    let maxActive = 0;
    jest.spyOn(fsSync.promises, "rm").mockImplementation(async (p, o) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      try {
        return await realRm(p, o);
      } finally {
        active -= 1;
      }
    });

    // Separate instances, as the orchestrator and the IPC handlers hold.
    const results = await Promise.all([
      new BackupService().removeLeftoverBackup(UDID),
      new BackupService().removeLeftoverBackup("00008030-0000000000000009"),
      new BackupService().sweepLeftoverBackups(),
    ]);

    expect(maxActive).toBe(1);
    expect(results[0]).toMatchObject({ outcome: "removed" });
    expect(results[1]).toMatchObject({ outcome: "removed" });
    expect(fsSync.readdirSync(backupsDir)).toEqual([]);
  });

  it("a udid that only validates after trimming is never acted on", async () => {
    const dir = lay(` ${UDID}`, STATES["STATE B (torn first backup, no manifest)"]);
    await expect(service.removeLeftoverBackup(` ${UDID}`)).resolves.toEqual({ outcome: "kept", folder: "unknown" });
    expect(fsSync.existsSync(dir)).toBe(true);
  });
});
