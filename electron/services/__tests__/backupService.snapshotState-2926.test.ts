/**
 * BACKLOG-2926 — the third snapshot state must survive the trip to the caller.
 *
 * ## The collapse
 *
 * `readSnapshotState` has been a correct three-state design since BACKLOG-2911:
 * `finished` / `unfinished` / `absent`, failing closed on unreadable and unparseable
 * input. One line later `checkBackupStatus` reduced it to
 *
 *     const isInterrupted = snapshotState === "unfinished";
 *
 * and never returned the value. So `"absent"` became `isInterrupted: false`, which is
 * the same value a FINISHED snapshot produces. The orchestrator had exactly two
 * branches — interrupted, and complete — and a directory that is neither fired
 * NEITHER. The user was told nothing at all.
 *
 * ## Reachability: MEASURED, not inferred
 *
 * The item filed this as "plausible and unverified" and asked for reachability to be
 * established before sizing the work. It is established, on the founder's PRODUCTION
 * install (not the dev one), read 2026-08-26:
 *
 *     <userData>/Backups/<udid>/
 *       Info.plist    6,343,173 bytes    mtime 2026-07-28
 *       - and nothing else. No Status.plist. No Manifest.db. No blob directories.
 *
 * Verified with `ls -1a` and `du -sh` (6.1M, i.e. the Info.plist IS the directory).
 * The exact path and device identifier are recorded in the BACKLOG-2926 comments in
 * Supabase and deliberately kept out of this public repo, per the BACKLOG-2911
 * precedent.
 *
 * Corroborating write-order evidence from the dev install's real backup directory for
 * the same device: `Info.plist` mtime is ELEVEN MINUTES LATER than `Status.plist`
 * mtime, so `Info.plist` is (re)written after the snapshot state — which is the
 * ordering that makes an Info.plist-only directory reachable rather than imaginable.
 *
 * ## What is transcribed here, and what is not
 *
 * The FIXTURE IS THE DIRECTORY SHAPE — which files exist and which do not — taken from
 * that real listing. The `Info.plist` BYTES are not transcribed: that file carries the
 * device name, serial number, phone number and installed-application list, and nothing
 * under test reads its content. `checkBackupStatus` only ever asks whether it exists,
 * via `fs.stat`. Substituting a placeholder body therefore cannot make the test pass
 * for a reason the real file would not.
 */

import fsSync from "fs";
import os from "os";
import path from "path";

const UDID = "00008030-0011223344556677";

// The SQLite magic header ends in a NUL byte, written as an escape. A raw NUL makes
// the whole FILE grep as binary, silently excluding it from every repo-wide sweep
// including the pre-push PII guard.
const SQLITE_MAGIC = "SQLite format 3\u0000";

// Real, untouched bytes from a genuinely torn backup — see the 2911 suite for full
// provenance. `SnapshotState: "uploading"`, `BackupState: "empty"`, 192 bytes.
const REAL_TORN_STATUS_PLIST_B64 =
  "YnBsaXN0MDDWAQIDBAUGBwgJCgsMXElzRnVsbEJhY2t1cFdWZXJzaW9uVFVVSURURGF0ZVtCYWNrdXBTdGF0ZV1TbmFwc2hvdFN0YXRlCVMzLjNfECQ2MUFDNDYzMi1DNDZFLTRCRjgtODg4QS0wQjFDODlGQUEzOUQzQcgf5+ZAILxVZW1wdHlZdXBsb2FkaW5nCBUiKi80QE5PU3qDiQAAAAAAAAEBAAAAAAAAAA0AAAAAAAAAAAAAAAAAAACT";

// Same real file, SnapshotState -> "finished" and BackupState -> "new" via plutil.
const DERIVED_FINISHED_STATUS_PLIST_B64 =
  "YnBsaXN0MDDWAQIDBAUGBwgJCgsMXVNuYXBzaG90U3RhdGVXVmVyc2lvbltCYWNrdXBTdGF0ZVxJc0Z1bGxCYWNrdXBURGF0ZVRVVUlEWGZpbmlzaGVkUzMuM1NuZXcJM0HIH+fmQCC8XxAkNjFBQzQ2MzItQzQ2RS00QkY4LTg4OEEtMEIxQzg5RkFBMzlECBUjKzdESU5XW19gaQAAAAAAAAEBAAAAAAAAAA0AAAAAAAAAAAAAAAAAAACQ";

const TORN_BYTES = Buffer.from(REAL_TORN_STATUS_PLIST_B64, "base64");
const FINISHED_BYTES = Buffer.from(DERIVED_FINISHED_STATUS_PLIST_B64, "base64");

/**
 * Stand-in for the founder's real 6,343,173-byte `Info.plist`. Only its EXISTENCE is
 * read (`fs.stat`), never its content — see the header note on why the real bytes are
 * not transcribed.
 */
const INFO_PLIST_PLACEHOLDER = Buffer.from("<plist></plist>");

jest.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: jest.fn(() => process.env.KEEPR_2926_USERDATA as string),
  },
}));

jest.mock("electron-log", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const mockAddBreadcrumb = jest.fn();
jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: (...args: unknown[]) => mockAddBreadcrumb(...args),
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

let userDataDir: string;
let deviceBackupDir: string;
let service: BackupService;

async function statusFor(files: Record<string, Buffer | "DIRECTORY">) {
  fsSync.rmSync(deviceBackupDir, { recursive: true, force: true });
  fsSync.mkdirSync(deviceBackupDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(deviceBackupDir, name);
    if (content === "DIRECTORY") fsSync.mkdirSync(target);
    else fsSync.writeFileSync(target, content);
  }
  const status = await service.checkBackupStatus(UDID);
  if (status.state !== "present") {
    throw new Error(`expected a present backup, got state="${status.state}"`);
  }
  return status;
}

beforeAll(() => {
  userDataDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "keepr-2926-"));
  process.env.KEEPR_2926_USERDATA = userDataDir;
  deviceBackupDir = path.join(userDataDir, "Backups", UDID);
});

beforeEach(() => {
  service = new BackupService();
  mockAddBreadcrumb.mockClear();
});

afterAll(() => {
  fsSync.rmSync(userDataDir, { recursive: true, force: true });
  delete process.env.KEEPR_2926_USERDATA;
});

describe("BACKLOG-2926: all three snapshot states reach the caller", () => {
  it("THE FOUNDER'S LIVE STATE — Info.plist only: absent, and NOT complete", async () => {
    // Transcribed shape: exactly one file, no Status.plist, no Manifest.db, no blobs.
    const status = await statusFor({ "Info.plist": INFO_PLIST_PLACEHOLDER });

    expect(status.snapshotState).toBe("absent");
    expect(status.isComplete).toBe(false);
    // The collapse: `absent` produced `isInterrupted: false`, identical to a finished
    // snapshot, so neither orchestrator branch fired and the user was told nothing.
    expect(status.isInterrupted).toBe(false);
  });

  it("a finished snapshot reports finished", async () => {
    const status = await statusFor({
      "Status.plist": FINISHED_BYTES,
      "Info.plist": INFO_PLIST_PLACEHOLDER,
      "Manifest.db": Buffer.from(SQLITE_MAGIC),
    });

    expect(status.snapshotState).toBe("finished");
    expect(status.isInterrupted).toBe(false);
    expect(status.isComplete).toBe(true);
  });

  it("the real torn snapshot reports unfinished", async () => {
    const status = await statusFor({
      "Status.plist": TORN_BYTES,
      "Info.plist": INFO_PLIST_PLACEHOLDER,
    });

    expect(status.snapshotState).toBe("unfinished");
    expect(status.isInterrupted).toBe(true);
  });

  it("the three states are mutually distinguishable at the caller", async () => {
    const absent = await statusFor({ "Info.plist": INFO_PLIST_PLACEHOLDER });
    const finished = await statusFor({
      "Status.plist": FINISHED_BYTES,
      "Info.plist": INFO_PLIST_PLACEHOLDER,
      "Manifest.db": Buffer.from(SQLITE_MAGIC),
    });
    const unfinished = await statusFor({
      "Status.plist": TORN_BYTES,
      "Info.plist": INFO_PLIST_PLACEHOLDER,
    });

    expect(
      new Set([absent.snapshotState, finished.snapshotState, unfinished.snapshotState]).size,
    ).toBe(3);

    // And the boolean the caller USED to have cannot separate two of them. This is the
    // assertion that states the defect rather than merely avoiding it.
    expect(absent.isInterrupted).toBe(finished.isInterrupted);
  });

  it("STATE D is preserved — absent + a manifest is still a usable prior backup", async () => {
    // A real backup from before this device wrote a Status.plist. The 2911 suite pins
    // this as complete-and-not-interrupted, and BACKLOG-2925's gate depends on it
    // staying that way, so exposing `snapshotState` must not reclassify it.
    const status = await statusFor({
      "Info.plist": INFO_PLIST_PLACEHOLDER,
      "Manifest.db": Buffer.from(SQLITE_MAGIC),
    });

    expect(status.snapshotState).toBe("absent");
    expect(status.isComplete).toBe(true);
    expect(status.isInterrupted).toBe(false);
  });
});

describe("BACKLOG-2926 §6.4: an infrastructure break is separable from a torn backup", () => {
  it("leaves a breadcrumb when Status.plist is present but unreadable", async () => {
    // A directory where the file should be produces EISDIR, not ENOENT.
    const status = await statusFor({
      "Status.plist": "DIRECTORY",
      "Info.plist": INFO_PLIST_PLACEHOLDER,
      "Manifest.db": Buffer.from(SQLITE_MAGIC),
    });

    // Failing CLOSED is correct and unchanged — this refuses under uncertainty rather
    // than substituting a different answer.
    expect(status.snapshotState).toBe("unfinished");
    // But a broken reader would otherwise report EVERY user's healthy backup as torn
    // with only a log.warn to show for it.
    expect(mockAddBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ category: "backup.snapshot" }),
    );
  });

  it("leaves a breadcrumb when Status.plist is present but unparseable", async () => {
    const status = await statusFor({
      "Status.plist": Buffer.from("not a plist at all"),
      "Info.plist": INFO_PLIST_PLACEHOLDER,
      "Manifest.db": Buffer.from(SQLITE_MAGIC),
    });

    expect(status.snapshotState).toBe("unfinished");
    expect(mockAddBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ category: "backup.snapshot" }),
    );
  });

  it("does NOT leave a breadcrumb on the ordinary paths — the signal must stay rare", async () => {
    // Counter-control. A breadcrumb on every healthy sync would be noise, and noise is
    // how a real infrastructure break gets missed.
    await statusFor({
      "Status.plist": FINISHED_BYTES,
      "Info.plist": INFO_PLIST_PLACEHOLDER,
      "Manifest.db": Buffer.from(SQLITE_MAGIC),
    });
    expect(mockAddBreadcrumb).not.toHaveBeenCalled();

    mockAddBreadcrumb.mockClear();
    await statusFor({ "Info.plist": INFO_PLIST_PLACEHOLDER });
    expect(mockAddBreadcrumb).not.toHaveBeenCalled();
  });
});
