/**
 * @jest-environment node
 */
/**
 * BACKLOG-3816 S4-C at the backup service.
 *
 *  C1  the 3598 leftover cleanup never removes a folder whose at-rest marker says
 *      migrating / encrypted / syncing / apple-encrypted — even with no Manifest.db
 *      (idevicebackup2 rewrites the index during a backup; a failed incremental over an
 *      unsealed chain must not cost the user the whole chain). Unreadable marker → kept.
 *      Control: the same folder with NO marker is removed.
 *  C5  checkBackupStatus on a SEALED chain reports the same completeness and the same
 *      snapshotState as before sealing. Status.plist / Info.plist are sealed too (founder
 *      QA 2026-10-09) and read through the in-memory decrypt; the backup list still gets
 *      the device name.
 *
 * Status.plist bytes: the `finished` plist from backupService.leftoverCleanup-3598.test.ts
 * (derived there from a real device-written plist).
 */
import crypto from "crypto";
import fsSync from "fs";
import os from "os";
import path from "path";

const FINISHED_BYTES = Buffer.from(
  "YnBsaXN0MDDWAQIDBAUGBwgJCgsMXVNuYXBzaG90U3RhdGVXVmVyc2lvbltCYWNrdXBTdGF0ZVxJc0Z1bGxCYWNrdXBURGF0ZVRVVUlEWGZpbmlzaGVkUzMuM1NuZXcJM0HIH+fmQCC8XxAkNjFBQzQ2MzItQzQ2RS00QkY4LTg4OEEtMEIxQzg5RkFBMzlECBUjKzdESU5XW19gaQAAAAAAAAEBAAAAAAAAAA0AAAAAAAAAAAAAAAAAAACQ",
  "base64",
);
const UDID = "00008030-0011223344556677";

jest.mock("electron", () => ({
  app: { isPackaged: false, getPath: jest.fn(() => process.env.KEEPR_S4C_BS_USERDATA as string) },
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
jest.mock("better-sqlite3-multiple-ciphers", () =>
  jest.fn().mockImplementation(() => ({
    prepare: jest.fn().mockReturnValue({ all: jest.fn(), get: jest.fn(), run: jest.fn() }),
    close: jest.fn(),
  })),
);

import plist from "simple-plist";

import { BackupService } from "../backupService";
import { setBackupIndexKeysForTests } from "../atRest/backupIndexFiles";
import { BackupAtRest } from "../atRest/backupAtRest";
import { createFileCrypto, type KeyResolver } from "../atRest/fileCrypto";
import { createMarkerStore, MARKER_DIR_NAME, type BackupAtRestState } from "../atRest/markers";

const KEY = crypto.randomBytes(32);
const KEY_ID = crypto.createHash("sha256").update(KEY).digest("hex").slice(0, 32);
const resolver: KeyResolver = { currentKey: async () => ({ keyId: KEY_ID, key: KEY }), keyFor: async () => KEY };

let userData: string;
let backups: string;
let chain: string;

function write(rel: string, data: Buffer | string): void {
  const p = path.join(chain, rel);
  fsSync.mkdirSync(path.dirname(p), { recursive: true });
  fsSync.writeFileSync(p, data);
}

beforeEach(() => {
  userData = fsSync.mkdtempSync(path.join(os.tmpdir(), "keepr-s4c-bs-"));
  process.env.KEEPR_S4C_BS_USERDATA = userData;
  backups = path.join(userData, "Backups");
  chain = path.join(backups, UDID);
});
afterEach(() => {
  setBackupIndexKeysForTests(null);
  fsSync.rmSync(userData, { recursive: true, force: true });
});

const markers = () => createMarkerStore({ userData: () => userData });

describe("C1 — 3598 cleanup vs the at-rest marker", () => {
  function unindexedChain(): void {
    write("Status.plist", FINISHED_BYTES);
    write("Info.plist", "<plist></plist>");
    write("ab/" + "a".repeat(40), "content the user would lose");
  }

  it.each<BackupAtRestState>(["migrating", "encrypted", "syncing", "apple-encrypted"])(
    "marker %s: never a leftover, never removed (even with no Manifest.db)",
    async (state) => {
      unindexedChain();
      await markers().writeBackupMarker(UDID, state);
      const svc = new BackupService();
      expect(await svc.classifyBackupFolder(UDID)).toBe("indexed");
      expect(await svc.removeLeftoverBackup(UDID)).toEqual({ outcome: "kept", folder: "indexed" });
      expect((await svc.sweepLeftoverBackups()).removed).toBe(0);
      expect(fsSync.existsSync(chain)).toBe(true);
    },
  );

  it("unreadable marker: unknown, kept", async () => {
    unindexedChain();
    fsSync.mkdirSync(path.join(backups, MARKER_DIR_NAME), { recursive: true });
    fsSync.writeFileSync(path.join(backups, MARKER_DIR_NAME, `${UDID}.json`), "{torn");
    const svc = new BackupService();
    expect(await svc.classifyBackupFolder(UDID)).toBe("unknown");
    expect((await svc.sweepLeftoverBackups()).removed).toBe(0);
    expect(fsSync.existsSync(chain)).toBe(true);
  });

  it("CONTROL: no marker (or plaintext) and no Manifest.db → still a leftover and removed (3598 unchanged)", async () => {
    unindexedChain();
    await markers().writeBackupMarker(UDID, "plaintext");
    const svc = new BackupService();
    expect(await svc.classifyBackupFolder(UDID)).toBe("leftover");
    expect((await svc.sweepLeftoverBackups()).removed).toBe(1);
    expect(fsSync.existsSync(chain)).toBe(false);
  });
});

describe("sealed Manifest.plist: the encrypted-chain check decrypts it", () => {
  it("a sealed Manifest.plist that says IsEncrypted reads as encrypted (not a parse failure read as 'plaintext')", async () => {
    write("Manifest.plist", plist.stringify({ IsEncrypted: true }));
    await createFileCrypto(resolver).encryptFileInPlace(path.join(backups, UDID, "Manifest.plist"));
    setBackupIndexKeysForTests(resolver);
    expect(await new BackupService().readChainEncryption(UDID)).toBe("encrypted");
  });
});

describe("C5 — checkBackupStatus on a sealed chain", () => {
  it("same isComplete and snapshotState before and after sealing", async () => {
    write("Status.plist", FINISHED_BYTES);
    write("Info.plist", plist.stringify({ "Device Name": "Test" }));
    write("Manifest.plist", plist.stringify({ IsEncrypted: false }));
    write("Manifest.db", "SQLite format 3\u0000 index");
    write("3d/" + "3".repeat(40), "sms");
    const svc = new BackupService();
    const before = await svc.checkBackupStatus(UDID);

    const atRest = new BackupAtRest({
      backupsRoot: () => backups,
      files: () => createFileCrypto(resolver),
      markers,
      ensureKey: async () => undefined,
      freeBytes: async () => Number.MAX_SAFE_INTEGER,
      log: () => undefined,
    });
    expect(await atRest.migrate(UDID)).toBe("encrypted");
    for (const name of ["Status.plist", "Info.plist", "Manifest.plist"]) {
      expect(fsSync.readFileSync(path.join(backups, UDID, name)).subarray(0, 7).toString("latin1")).toBe("KEPRENC");
    }
    setBackupIndexKeysForTests(resolver);
    const after = await svc.checkBackupStatus(UDID);
    const listed = (await svc.listBackups()).find((b) => b.path.endsWith(UDID));
    expect(listed?.deviceName).toBe("Test");
    expect(await svc.readChainEncryption(UDID)).toBe("plaintext");

    expect(before.state).toBe("present");
    expect(after.state).toBe("present");
    if (before.state !== "present" || after.state !== "present") throw new Error("unreachable");
    expect(after.isComplete).toBe(true);
    expect(after.isComplete).toBe(before.isComplete);
    expect(after.snapshotState).toBe("finished");
    expect(after.snapshotState).toBe(before.snapshotState);
    expect(after.isInterrupted).toBe(before.isInterrupted);
  });
});
