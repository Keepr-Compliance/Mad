/**
 * BACKLOG-2917 — `checkBackupStatus` must be able to report its own failure.
 *
 * ## What this file proves
 *
 * Before this item `checkBackupStatus` returned `{...} | null`, and `null` carried
 * two opposite facts:
 *
 *   - `fs.stat` returned ENOENT  -> there is genuinely no backup for this device
 *   - the check itself threw     -> we established NOTHING
 *
 * `deviceSyncOrchestrator` read the collapsed value as a first sync. So a failing
 * check produced a confident first-sync estimate, the 1.5x headroom branch, and —
 * after BACKLOG-2898 — a `backup-estimate` mark asserting `reusedPreviousBackup:
 * false` as a measured fact. The epic behind this work calls a `checkBackupStatus`
 * that cannot find a backup which demonstrably exists "a far larger bug than a bad
 * estimate", and the instrument built to settle that question printed the reassuring
 * answer in exactly the case where the true answer would be alarming.
 *
 * The same collapse existed in the size walk. `calculateBackupSize` caught everything
 * and returned `0`, so a real backup could report `{ exists: true, sizeBytes: 0 }`.
 * It runs twice per sync over 496k blobs (7.2 s warm), so a throw is a realistic
 * event rather than a corner case.
 *
 * ## Fixture provenance — transcribed, not invented
 *
 * The failures below are driven by real `fs` errors, produced once on this machine by
 * `chmod 000` on a real directory and then transcribed:
 *
 *   $ node -e '... fs.chmodSync(dir, 0o000); await fs.promises.stat(dir + "/child")'
 *     { code: "EACCES", errno: -13, syscall: "stat" }
 *   $ node -e '... fs.chmodSync(dir, 0o000); await fs.promises.readdir(dir)'
 *     { code: "EACCES", errno: -13, syscall: "scandir" }   <- scandir, not readdir
 *
 * They are REPLAYED with `jest.spyOn` rather than reproduced with `chmod` inside the
 * test, because `chmod 000` is a no-op for Administrator on Windows CI and
 * `fs.stat("file/child")` returns ENOENT there rather than EACCES. Either difference
 * would silently route the test into the *absent* branch — it would pass, on Windows,
 * while proving the opposite of what it claims. A green check that cannot fail is the
 * thing this whole item is about.
 *
 * Everything else is a real directory on a real temp filesystem, as in
 * `backupService.interruptedDetection-2911.test.ts`.
 */

import fsSync from "fs";
import os from "os";
import path from "path";
import { promises as fsPromises } from "fs";

const UDID = "00008030-0011223344556677";

// The SQLite magic header ends in a NUL byte, written here as an escape. Typing the
// raw byte into the source makes the whole FILE grep as binary, which silently
// excludes it from every repo-wide sweep. Same reasoning as the 2911 suite.
const SQLITE_MAGIC = "SQLite format 3\u0000";

jest.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: jest.fn(() => process.env.KEEPR_2917_USERDATA as string),
  },
}));

jest.mock("electron-log", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const mockCaptureException = jest.fn();
jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureMessage: jest.fn(),
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

jest.mock("../libimobiledeviceService", () => ({
  getCommand: jest.fn(() => "/nonexistent/idevicebackup2"),
  isMockMode: jest.fn(() => false),
  canUseLibimobiledevice: jest.fn(() => true),
}));

jest.mock("../backupDecryptionService", () => ({
  BackupDecryptionService: jest.fn().mockImplementation(() => ({})),
  backupDecryptionService: {
    isBackupEncrypted: jest.fn().mockResolvedValue(false),
    decryptBackup: jest.fn(),
  },
}));

jest.mock("better-sqlite3-multiple-ciphers", () =>
  jest.fn().mockImplementation(() => ({
    prepare: jest.fn().mockReturnValue({ all: jest.fn(), get: jest.fn(), run: jest.fn() }),
    close: jest.fn(),
  })),
);

import { BackupService } from "../backupService";

/** A transcribed EACCES, exactly as node produced it. See "Fixture provenance". */
function eacces(syscall: "stat" | "scandir", target: string): NodeJS.ErrnoException {
  const message =
    syscall === "stat"
      ? `EACCES: permission denied, stat '${target}'`
      : `EACCES: permission denied, scandir '${target}'`;
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = "EACCES";
  err.errno = -13;
  err.syscall = syscall;
  return err;
}

let userDataDir: string;
let deviceBackupDir: string;
let service: BackupService;

beforeAll(() => {
  userDataDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "keepr-2917-"));
  process.env.KEEPR_2917_USERDATA = userDataDir;
  deviceBackupDir = path.join(userDataDir, "Backups", UDID);
});

beforeEach(() => {
  service = new BackupService();
  mockCaptureException.mockClear();
  fsSync.rmSync(deviceBackupDir, { recursive: true, force: true });
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  fsSync.rmSync(userDataDir, { recursive: true, force: true });
  delete process.env.KEEPR_2917_USERDATA;
});

/** A complete, believable backup directory: manifest, info plist and one blob. */
function layDownCompleteBackup(): void {
  fsSync.mkdirSync(path.join(deviceBackupDir, "a1"), { recursive: true });
  fsSync.writeFileSync(path.join(deviceBackupDir, "Manifest.db"), Buffer.from(SQLITE_MAGIC));
  fsSync.writeFileSync(path.join(deviceBackupDir, "Info.plist"), Buffer.from("<plist></plist>"));
  fsSync.writeFileSync(path.join(deviceBackupDir, "a1", "a1b2c3"), Buffer.alloc(4096, 7));
}

describe("BACKLOG-2917: three states, three answers", () => {
  it("STATE 1 — ENOENT is the ONLY state that means 'there is no backup'", async () => {
    const status = await service.checkBackupStatus(UDID);
    expect(status).toEqual({ state: "absent" });
  });

  it("STATE 2 — a real backup directory reports present with a MEASURED size", async () => {
    layDownCompleteBackup();

    const status = await service.checkBackupStatus(UDID);

    expect(status.state).toBe("present");
    if (status.state !== "present") throw new Error("unreachable");
    expect(status.isComplete).toBe(true);
    expect(status.size.measured).toBe(true);
    if (!status.size.measured) throw new Error("unreachable");
    expect(status.size.bytes).toBeGreaterThanOrEqual(4096);
  });

  it("STATE 3 — a THROWN check reports 'unknown', never 'absent'", async () => {
    layDownCompleteBackup();

    // A non-ENOENT failure on the device directory itself: the check cannot complete.
    jest.spyOn(fsPromises, "stat").mockImplementation(async (target) => {
      throw eacces("stat", String(target));
    });

    const status = await service.checkBackupStatus(UDID);

    // THE defect: this returned `null` — the same value as "no backup exists".
    expect(status.state).toBe("unknown");
    expect(status.state).not.toBe("absent");
    if (status.state !== "unknown") throw new Error("unreachable");
    expect(status.reason).toBe("EACCES");
  });

  it("the three states are mutually distinguishable — no two collapse to one value", async () => {
    // Absent.
    const absent = await service.checkBackupStatus(UDID);

    // Present.
    layDownCompleteBackup();
    const present = await service.checkBackupStatus(UDID);

    // Unknown.
    jest.spyOn(fsPromises, "stat").mockImplementation(async (target) => {
      throw eacces("stat", String(target));
    });
    const unknown = await service.checkBackupStatus(UDID);

    // Three inputs, three distinct answers. Before this item the first and third
    // were byte-identical (`null`), which is the whole defect in one assertion.
    expect(new Set([absent.state, present.state, unknown.state]).size).toBe(3);
    expect(absent.state).toBe("absent");
    expect(present.state).toBe("present");
    expect(unknown.state).toBe("unknown");
  });

  it("a failed check raises a Sentry event — the alarming case must not need someone to go looking", async () => {
    layDownCompleteBackup();
    jest.spyOn(fsPromises, "stat").mockImplementation(async (target) => {
      throw eacces("stat", String(target));
    });

    await service.checkBackupStatus(UDID);

    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ operation: "checkBackupStatus" }),
      }),
    );
  });
});

describe("BACKLOG-2917: a failed size walk is not a size of zero", () => {
  it("a backup that EXISTS never reports as present-with-zero-bytes when its walk throws", async () => {
    layDownCompleteBackup();

    // The whole walk fails. `fs.stat` on the directory still succeeds, so the backup
    // demonstrably exists — this is precisely the "far larger bug" case.
    jest.spyOn(fsPromises, "readdir").mockImplementation(async (target) => {
      throw eacces("scandir", String(target));
    });

    const status = await service.checkBackupStatus(UDID);

    expect(status.state).toBe("present");
    if (status.state !== "present") throw new Error("unreachable");
    // The defect: `{ exists: true, sizeBytes: 0 }`. There is no longer a `bytes`
    // property to read on an unmeasured reading, so a caller cannot even spell it.
    expect(status.size.measured).toBe(false);
    expect(status.size).not.toHaveProperty("bytes");
    if (status.size.measured) throw new Error("unreachable");
    expect(status.size.reason).toBe("EACCES");
  });

  it("ONE unreadable subdirectory fails the whole measurement instead of silently shrinking it", async () => {
    // The unreported half of this defect. Every recursive call had its own catch-all,
    // so an unreadable subtree returned 0 and the PARENT added 0 and carried on —
    // returning a short total with no error anywhere. A partial sum presented as a
    // measurement is worse than a failure: nothing downstream can tell it from a
    // genuinely smaller backup.
    fsSync.mkdirSync(path.join(deviceBackupDir, "a1"), { recursive: true });
    fsSync.mkdirSync(path.join(deviceBackupDir, "b2"), { recursive: true });
    fsSync.writeFileSync(path.join(deviceBackupDir, "Manifest.db"), Buffer.from(SQLITE_MAGIC));
    fsSync.writeFileSync(path.join(deviceBackupDir, "Info.plist"), Buffer.from("<plist></plist>"));
    fsSync.writeFileSync(path.join(deviceBackupDir, "a1", "blob"), Buffer.alloc(4096, 7));
    fsSync.writeFileSync(path.join(deviceBackupDir, "b2", "blob"), Buffer.alloc(8192, 9));

    const unreadableSubtree = path.join(deviceBackupDir, "b2");
    const realReaddir = fsPromises.readdir.bind(fsPromises);
    jest
      .spyOn(fsPromises, "readdir")
      .mockImplementation((async (target: string, opts: unknown) => {
        if (String(target) === unreadableSubtree) throw eacces("scandir", unreadableSubtree);
        return realReaddir(target as string, opts as never);
      }) as unknown as typeof fsPromises.readdir);

    const status = await service.checkBackupStatus(UDID);

    expect(status.state).toBe("present");
    if (status.state !== "present") throw new Error("unreachable");
    // Old behaviour: a measured-looking 4096-ish total, missing b2's 8192 entirely,
    // with no error raised anywhere.
    expect(status.size.measured).toBe(false);
  });

  it("a file that vanishes mid-walk is a normal race, NOT an unmeasurable backup", async () => {
    // The counter-control. ENOENT paths must stay `measured` — over-reporting
    // "unknown" would make the new state useless by crying wolf on a routine race in
    // a directory the device is still writing to.
    layDownCompleteBackup();
    const vanishing = path.join(deviceBackupDir, "a1", "a1b2c3");
    const realStat = fsPromises.stat.bind(fsPromises);
    jest.spyOn(fsPromises, "stat").mockImplementation((async (target: string) => {
      if (String(target) === vanishing) {
        const err = new Error(
          `ENOENT: no such file or directory, stat '${vanishing}'`,
        ) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        err.errno = -2;
        err.syscall = "stat";
        throw err;
      }
      return realStat(target as string);
    }) as unknown as typeof fsPromises.stat);

    const status = await service.checkBackupStatus(UDID);

    expect(status.state).toBe("present");
    if (status.state !== "present") throw new Error("unreachable");
    expect(status.size.measured).toBe(true);
  });
});

describe("BACKLOG-2917: listBackups must not show a real backup at size 0", () => {
  it("reports an unmeasured size as null rather than zero bytes", async () => {
    layDownCompleteBackup();

    const realReaddir = fsPromises.readdir.bind(fsPromises);
    const backupsRoot = path.join(userDataDir, "Backups");
    jest
      .spyOn(fsPromises, "readdir")
      .mockImplementation((async (target: string, opts: unknown) => {
        // Let the service enumerate device directories, then fail the size walk.
        if (String(target) === backupsRoot) return realReaddir(target as string, opts as never);
        throw eacces("scandir", String(target));
      }) as unknown as typeof fsPromises.readdir);

    const backups = await service.listBackups();

    expect(backups).toHaveLength(1);
    // The third caller of the size walk. A real backup listed at "0 B" tells the user
    // their data is gone.
    expect(backups[0].size).toBeNull();
    expect(backups[0].size).not.toBe(0);
  });
});
