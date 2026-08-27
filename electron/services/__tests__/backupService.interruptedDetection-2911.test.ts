/**
 * BACKLOG-2911 — interrupted-backup detection in `checkBackupStatus`.
 *
 * ## What this file proves
 *
 * The shipped predicate (`backupService.ts`, pre-fix) was:
 *
 *   statusContent.includes("BackupState") && statusContent.includes("InProgress")
 *
 * **iOS never writes the string `InProgress`.** The values BackupAgent2 actually
 * writes are `SnapshotState: "uploading" | "finished"` and
 * `BackupState: "empty" | "new"`. So the predicate was dead: `isCorrupted` could
 * never become true for any readable `Status.plist`, and the orchestrator's
 * "Found interrupted backup … Resuming…" branch was unreachable on real hardware.
 *
 * ## Fixture provenance — transcribed, not invented
 *
 * `REAL_TORN_STATUS_PLIST_B64` is the byte-for-byte content (192 bytes) of a real
 * interrupted Keepr backup found on the development Mac on 2026-08-26:
 *
 *   ~/Library/Application Support/keepr-dev/Backups/<udid>/Status.plist
 *
 * The directory name is a physical device identifier and is redacted here — this repo
 * is public. It is recorded in the BACKLOG-2911 comments in Supabase. The plist bytes
 * themselves carry no device or personal identifier: the `UUID` field below is a
 * per-backup snapshot id, which is why the fixture is kept byte-exact.
 *
 * That directory held `Info.plist`, this `Status.plist`, and 41,097 already-transferred
 * blob files, with **no `Manifest.db`** — i.e. a backup torn mid-upload. Decoded:
 *
 *   BackupState   = "empty"
 *   Date          = 2026-08-27T01:52:12Z
 *   IsFullBackup  = 1
 *   SnapshotState = "uploading"
 *   UUID          = <v4 uuid: a per-backup snapshot id minted by BackupAgent2>
 *   Version       = "3.3"
 *
 * The `UUID` value is redacted above and nowhere else in this file: it is a v4 UUID,
 * and `scripts/ci/check-fixture-pii.mjs` correctly refuses to guess whether any given
 * UUID is a live record id (BACKLOG-2871). Describing the shape rather than the value
 * is the remedy that guard asks for, and nothing here depends on the literal — the
 * decode is verified by assertion below, not by this comment. The encoded bytes in
 * the fixture are untouched, so `plist.parse` still yields the real value at runtime.
 *
 * `DERIVED_FINISHED_STATUS_PLIST_B64` is derived from those same real bytes by
 * changing exactly two fields on a copy, then letting Apple's own serialiser
 * rewrite the file (which is why it is 189 bytes, not 192 — `plutil` reorders the
 * object table):
 *
 *   plutil -replace SnapshotState -string finished  <copy>
 *   plutil -replace BackupState   -string new       <copy>
 *
 * No completed-backup `Status.plist` existed on this machine to transcribe, so the
 * completed state is derived from the real producer's output rather than hand-written.
 *
 * ## Why the states are swept as ON-DISK states, not causal histories
 *
 * A clean cancel, a transport drop (the founder's 2026-08-26 failure) and a crash
 * mid-write all leave the *same* artifact behind: `SnapshotState: "uploading"`.
 * The host cannot distinguish them and must not pretend to. What it can and must
 * distinguish is "the device said this snapshot finished" from everything else.
 *
 * ## Why there is no resume test here
 *
 * There is no host-side resume to test. `idevicebackup2` never reads `Status.plist`
 * on the backup path — `mb2_status_check_snapshot_state` is called only from
 * `CMD_RESTORE` — and the only option the protocol accepts on a backup request is
 * `ForceFullBackup`. Continuation is device-driven and file-granular. The two host
 * actions that *would* destroy it are deleting the partial directory and injecting
 * `--full`; both are asserted against below.
 */

import fsSync from "fs";
import os from "os";
import path from "path";

// Real, untouched bytes — see "Fixture provenance" above.
const REAL_TORN_STATUS_PLIST_B64 =
  "YnBsaXN0MDDWAQIDBAUGBwgJCgsMXElzRnVsbEJhY2t1cFdWZXJzaW9uVFVVSURURGF0ZVtCYWNrdXBTdGF0ZV1TbmFwc2hvdFN0YXRlCVMzLjNfECQ2MUFDNDYzMi1DNDZFLTRCRjgtODg4QS0wQjFDODlGQUEzOUQzQcgf5+ZAILxVZW1wdHlZdXBsb2FkaW5nCBUiKi80QE5PU3qDiQAAAAAAAAEBAAAAAAAAAA0AAAAAAAAAAAAAAAAAAACT";

// Same real file, `SnapshotState` -> "finished" and `BackupState` -> "new" via plutil.
const DERIVED_FINISHED_STATUS_PLIST_B64 =
  "YnBsaXN0MDDWAQIDBAUGBwgJCgsMXVNuYXBzaG90U3RhdGVXVmVyc2lvbltCYWNrdXBTdGF0ZVxJc0Z1bGxCYWNrdXBURGF0ZVRVVUlEWGZpbmlzaGVkUzMuM1NuZXcJM0HIH+fmQCC8XxAkNjFBQzQ2MzItQzQ2RS00QkY4LTg4OEEtMEIxQzg5RkFBMzlECBUjKzdESU5XW19gaQAAAAAAAAEBAAAAAAAAAA0AAAAAAAAAAAAAAAAAAACQ";

const TORN_BYTES = Buffer.from(REAL_TORN_STATUS_PLIST_B64, "base64");
const FINISHED_BYTES = Buffer.from(DERIVED_FINISHED_STATUS_PLIST_B64, "base64");

// Synthetic UDID in the modern 25-char format (8 hex, dash, 16 hex). The real device
// this fixture came from is not named in a public repo; `validateDeviceUdid` checks
// format only, and nothing here depends on the value matching a real device.
const UDID = "00008030-0011223344556677";

// The SQLite magic header ends in a NUL byte, written here as an escape. Typing the
// raw byte into the source makes the whole FILE grep as binary, which silently
// excludes it from every repo-wide sweep — including the pre-push PII guard. Only
// the file's existence matters to `checkBackupStatus`; the bytes are for realism.
const SQLITE_MAGIC = "SQLite format 3\u0000";

// `app.getPath` is read lazily inside `getDefaultBackupPath()`, so an env var set in
// beforeAll is sufficient and avoids the TDZ problem with hoisted jest.mock factories.
jest.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: jest.fn(() => process.env.KEEPR_2911_USERDATA as string),
  },
}));

jest.mock("electron-log", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

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

// NOTE: `fs` is deliberately NOT mocked. These tests write the real fixture bytes to a
// real temp directory so the code under test reads a real binary plist, not a string a
// test author decided a binary plist looks like.
import { BackupService } from "../backupService";

let userDataDir: string;
let deviceBackupDir: string;
let service: BackupService;

/** Lay down one on-disk backup state and return the status the service reports for it. */
async function statusFor(files: Record<string, Buffer | "DIRECTORY">) {
  fsSync.rmSync(deviceBackupDir, { recursive: true, force: true });
  fsSync.mkdirSync(deviceBackupDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(deviceBackupDir, name);
    if (content === "DIRECTORY") {
      fsSync.mkdirSync(target);
    } else {
      fsSync.writeFileSync(target, content);
    }
  }
  return service.checkBackupStatus(UDID);
}

beforeAll(() => {
  userDataDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "keepr-2911-"));
  process.env.KEEPR_2911_USERDATA = userDataDir;
  deviceBackupDir = path.join(userDataDir, "Backups", UDID);
});

beforeEach(() => {
  service = new BackupService();
});

afterAll(() => {
  fsSync.rmSync(userDataDir, { recursive: true, force: true });
  delete process.env.KEEPR_2911_USERDATA;
});

describe("BACKLOG-2911: the fixture is the real producer's output", () => {
  it("the real torn Status.plist decodes to SnapshotState=uploading and never contains 'InProgress'", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const plist = require("simple-plist") as { parse: (b: Buffer) => unknown };
    const parsed = plist.parse(TORN_BYTES) as Record<string, unknown>;

    expect(TORN_BYTES.length).toBe(192);
    expect(parsed.SnapshotState).toBe("uploading");
    expect(parsed.BackupState).toBe("empty");

    // The string the shipped predicate hunted for is absent from a genuinely torn
    // backup, under every decoding. This is why the predicate was dead.
    expect(TORN_BYTES.includes("InProgress")).toBe(false);
    expect(TORN_BYTES.toString("latin1").includes("InProgress")).toBe(false);
    expect(TORN_BYTES.toString("utf8").includes("InProgress")).toBe(false);
  });

  it("the derived finished Status.plist differs from the real one only in the two replaced fields", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const plist = require("simple-plist") as { parse: (b: Buffer) => unknown };
    const torn = plist.parse(TORN_BYTES) as Record<string, unknown>;
    const finished = plist.parse(FINISHED_BYTES) as Record<string, unknown>;

    expect(finished.SnapshotState).toBe("finished");
    expect(finished.BackupState).toBe("new");
    // Everything else is carried over from the real device output untouched.
    expect(finished.UUID).toBe(torn.UUID);
    expect(finished.Version).toBe(torn.Version);
    expect(finished.IsFullBackup).toBe(torn.IsFullBackup);
    expect(String(finished.Date)).toBe(String(torn.Date));
  });
});

describe("BACKLOG-2911: on-disk state sweep", () => {
  it("no directory at all -> null (no backup)", async () => {
    fsSync.rmSync(deviceBackupDir, { recursive: true, force: true });
    await expect(service.checkBackupStatus(UDID)).resolves.toBeNull();
  });

  it("STATE A — finished snapshot with a manifest is complete and not interrupted", async () => {
    const status = await statusFor({
      "Status.plist": FINISHED_BYTES,
      "Info.plist": Buffer.from("<plist></plist>"),
      "Manifest.db": Buffer.from(SQLITE_MAGIC),
    });

    expect(status).not.toBeNull();
    expect(status!.exists).toBe(true);
    expect(status!.isComplete).toBe(true);
    expect(status!.isInterrupted).toBe(false);
  });

  it("STATE B — the REAL torn backup (uploading, no manifest) is reported interrupted", async () => {
    // The exact on-disk shape of the interrupted backup found on this machine.
    const status = await statusFor({
      "Status.plist": TORN_BYTES,
      "Info.plist": Buffer.from("<plist></plist>"),
    });

    expect(status!.isComplete).toBe(false);
    // The shipped predicate returned false here. That is the defect: a directory with
    // 41,097 orphaned blobs and no manifest was not flagged as interrupted, so neither
    // orchestrator branch fired and the user was told nothing at all.
    expect(status!.isInterrupted).toBe(true);
  });

  it("STATE C — torn incremental: an old manifest survives, so `isComplete` alone would lie", async () => {
    // On an incremental, `Manifest.db` from the previous successful run is still on disk
    // when the next run is torn — the device only replaces it at the end. `isComplete`
    // is therefore true while the snapshot is mid-upload. Only `isInterrupted` separates
    // these, which is exactly why `isComplete` cannot carry this signal.
    const status = await statusFor({
      "Status.plist": TORN_BYTES,
      "Info.plist": Buffer.from("<plist></plist>"),
      "Manifest.db": Buffer.from(SQLITE_MAGIC),
    });

    expect(status!.isComplete).toBe(true);
    expect(status!.isInterrupted).toBe(true);
  });

  it("STATE D — no Status.plist at all: nothing claims the snapshot finished, nothing claims it tore", async () => {
    const status = await statusFor({
      "Info.plist": Buffer.from("<plist></plist>"),
      "Manifest.db": Buffer.from(SQLITE_MAGIC),
    });

    expect(status!.isComplete).toBe(true);
    // ENOENT is the one state carrying no evidence either way, and it is also the
    // pre-first-backup state. It is not asserted to be interrupted.
    expect(status!.isInterrupted).toBe(false);
  });

  it("STATE E — unreadable Status.plist fails CLOSED: unprovable finish counts as interrupted", async () => {
    // A directory where the file should be produces EISDIR, not ENOENT.
    const status = await statusFor({
      "Status.plist": "DIRECTORY",
      "Info.plist": Buffer.from("<plist></plist>"),
      "Manifest.db": Buffer.from(SQLITE_MAGIC),
    });

    expect(status!.isComplete).toBe(true);
    expect(status!.isInterrupted).toBe(true);
  });

  it("STATE F — Status.plist present but unparseable fails CLOSED", async () => {
    const status = await statusFor({
      "Status.plist": Buffer.from("not a plist at all"),
      "Info.plist": Buffer.from("<plist></plist>"),
      "Manifest.db": Buffer.from(SQLITE_MAGIC),
    });

    expect(status!.isInterrupted).toBe(true);
  });

  it("STATE G — Status.plist parses but carries no SnapshotState: fails CLOSED", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const plist = require("simple-plist") as {
      bplistCreator: (o: unknown) => Buffer;
    };
    const noSnapshotState = plist.bplistCreator({ BackupState: "new", Version: "3.3" });

    const status = await statusFor({
      "Status.plist": Buffer.isBuffer(noSnapshotState)
        ? noSnapshotState
        : Buffer.from(noSnapshotState as unknown as Uint8Array),
      "Info.plist": Buffer.from("<plist></plist>"),
      "Manifest.db": Buffer.from(SQLITE_MAGIC),
    });

    expect(status!.isInterrupted).toBe(true);
  });

  it("an XML Status.plist is read too — the format is not guaranteed to be binary", async () => {
    const xml = Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>BackupState</key><string>new</string>
  <key>SnapshotState</key><string>finished</string>
</dict></plist>`,
    );

    const status = await statusFor({
      "Status.plist": xml,
      "Info.plist": Buffer.from("<plist></plist>"),
      "Manifest.db": Buffer.from(SQLITE_MAGIC),
    });

    expect(status!.isInterrupted).toBe(false);
  });
});

describe("BACKLOG-2911: checking status must never destroy device-side continuation", () => {
  it("reports an interrupted backup without deleting the partial directory or its blobs", async () => {
    // Deleting the partial directory is one of only two host actions that would destroy
    // the device-driven continuation (the other is injecting `--full`, covered in
    // deviceSyncOrchestrator.resumeClaim-2911.test.ts). Detecting the torn state must
    // not trigger it.
    fsSync.rmSync(deviceBackupDir, { recursive: true, force: true });
    fsSync.mkdirSync(path.join(deviceBackupDir, "a1"), { recursive: true });
    fsSync.writeFileSync(path.join(deviceBackupDir, "Status.plist"), TORN_BYTES);
    fsSync.writeFileSync(path.join(deviceBackupDir, "Info.plist"), Buffer.from("<plist></plist>"));
    fsSync.writeFileSync(path.join(deviceBackupDir, "a1", "a1b2c3"), Buffer.alloc(4096, 7));

    const status = await service.checkBackupStatus(UDID);

    expect(status!.isInterrupted).toBe(true);
    expect(fsSync.existsSync(path.join(deviceBackupDir, "a1", "a1b2c3"))).toBe(true);
    expect(fsSync.readFileSync(path.join(deviceBackupDir, "Status.plist"))).toEqual(TORN_BYTES);
    // The already-transferred bytes are counted, so the caller can report them.
    expect(status!.sizeBytes).toBeGreaterThanOrEqual(4096);
  });
});
