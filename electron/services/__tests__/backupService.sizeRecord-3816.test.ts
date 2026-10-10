/**
 * @jest-environment node
 */
/**
 * BACKLOG-3816: the sync pre-flight uses the backup size recorded by the last
 * measurement instead of stat-ing every file in the backup again (576k files, ~135 s
 * on the founder's PC). It walks only when there is no usable record: none yet, a
 * missing or corrupt file, or a malformed entry. Real files, real BackupService.
 */
import fsSync from "fs";
import os from "os";
import path from "path";

let mockUserData = "";
jest.mock("electron", () => ({
  app: { isPackaged: false, getPath: jest.fn(() => mockUserData) },
}));
jest.mock("electron-log", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
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

import { BackupService } from "../backupService";
import {
  BACKUP_SIZE_RECORD_FILE,
  backupSizeRecordKey,
  forgetBackupSize,
  readRecordedBackupSize,
  recordBackupSize,
} from "../backupSizeRecord";

const UDID = "00008030-0011223344556677";

let chain: string;
let recordFile: string;

function write(rel: string, data: Buffer | string): void {
  const p = path.join(chain, rel);
  fsSync.mkdirSync(path.dirname(p), { recursive: true });
  fsSync.writeFileSync(p, data);
}

function walkSpy(svc: BackupService): jest.SpyInstance {
  return jest.spyOn(svc as unknown as { measureBackupSize: () => Promise<unknown> }, "measureBackupSize");
}

const CHAIN_BYTES = 100 + 200 + 300 + 400;

beforeEach(() => {
  mockUserData = fsSync.mkdtempSync(path.join(os.tmpdir(), "keepr-3816-size-"));
  chain = path.join(mockUserData, "Backups", UDID);
  recordFile = path.join(mockUserData, BACKUP_SIZE_RECORD_FILE);
  write("Info.plist", Buffer.alloc(100, 1));
  write("Manifest.db", Buffer.alloc(200, 2));
  write("3d/" + "a".repeat(40), Buffer.alloc(300, 3));
  write("ab/" + "b".repeat(40), Buffer.alloc(400, 4));
});
afterEach(() => {
  fsSync.rmSync(mockUserData, { recursive: true, force: true });
});

describe("BACKLOG-3816: pre-flight backup size from the recorded measurement", () => {
  it("first pre-flight (no record): walks once and records the total, keyed without the UDID", async () => {
    const svc = new BackupService();
    const walk = walkSpy(svc);
    const status = await svc.checkBackupStatus(UDID, { useRecordedSize: true });
    expect(walk).toHaveBeenCalled();
    expect(status).toMatchObject({ state: "present", size: { measured: true, bytes: CHAIN_BYTES } });
    const raw = fsSync.readFileSync(recordFile, "utf8");
    expect(raw).not.toContain(UDID);
    expect(JSON.parse(raw)[backupSizeRecordKey(UDID)].bytes).toBe(CHAIN_BYTES);
  });

  it("second pre-flight: uses the recorded total, no walk", async () => {
    const svc = new BackupService();
    await svc.checkBackupStatus(UDID, { useRecordedSize: true });
    // The chain grows after the record; the pre-flight must not see it (no walk).
    write("cd/" + "c".repeat(40), Buffer.alloc(5000, 5));
    const walk = walkSpy(svc);
    const status = await svc.checkBackupStatus(UDID, { useRecordedSize: true });
    expect(walk).not.toHaveBeenCalled();
    expect(status).toMatchObject({ state: "present", size: { measured: true, bytes: CHAIN_BYTES } });
  });

  it.each([
    ["missing", null],
    ["not JSON", "{not json"],
    ["an array", "[]"],
    ["a malformed entry", (key: string) => JSON.stringify({ [key]: { bytes: -1, recordedAt: 1 } })],
    ["another phone only", JSON.stringify({ ffff: { bytes: 5, recordedAt: 1 } })],
  ] as const)("record %s: walks, and writes a good record", async (_label, content) => {
    if (content !== null) {
      fsSync.writeFileSync(recordFile, typeof content === "function" ? content(backupSizeRecordKey(UDID)) : content);
    }
    const svc = new BackupService();
    const walk = walkSpy(svc);
    const status = await svc.checkBackupStatus(UDID, { useRecordedSize: true });
    expect(walk).toHaveBeenCalled();
    expect(status).toMatchObject({ size: { measured: true, bytes: CHAIN_BYTES } });
    expect(JSON.parse(fsSync.readFileSync(recordFile, "utf8"))[backupSizeRecordKey(UDID)].bytes).toBe(CHAIN_BYTES);
  });

  it("without useRecordedSize (the backup:check-status IPC) it always walks", async () => {
    const svc = new BackupService();
    await svc.checkBackupStatus(UDID, { useRecordedSize: true });
    const walk = walkSpy(svc);
    await svc.checkBackupStatus(UDID);
    expect(walk).toHaveBeenCalled();
  });

  it("a cancelled pre-flight walk keeps the existing record", async () => {
    const svc = new BackupService();
    await svc.checkBackupStatus(UDID, { useRecordedSize: true });
    fsSync.writeFileSync(recordFile, JSON.stringify({}));
    const c = new AbortController();
    c.abort();
    await svc.checkBackupStatus(UDID, { useRecordedSize: true, signal: c.signal });
    expect(JSON.parse(fsSync.readFileSync(recordFile, "utf8"))).toEqual({});
  });
});

describe("BACKLOG-3816: backupSizeRecord", () => {
  it("record -> read; forget -> null", async () => {
    await recordBackupSize(recordFile, UDID, 1234);
    expect(await readRecordedBackupSize(recordFile, UDID)).toBe(1234);
    await forgetBackupSize(recordFile, UDID);
    expect(await readRecordedBackupSize(recordFile, UDID)).toBeNull();
  });

  it("a zero or negative total removes the entry instead of recording it", async () => {
    await recordBackupSize(recordFile, UDID, 1234);
    await recordBackupSize(recordFile, UDID, 0);
    expect(await readRecordedBackupSize(recordFile, UDID)).toBeNull();
  });

  it("two phones recorded concurrently: neither entry is lost", async () => {
    await Promise.all([recordBackupSize(recordFile, "PHONE-A", 10), recordBackupSize(recordFile, "PHONE-B", 20)]);
    expect(await readRecordedBackupSize(recordFile, "PHONE-A")).toBe(10);
    expect(await readRecordedBackupSize(recordFile, "PHONE-B")).toBe(20);
  });

  it("a walk that could not measure (not a cancel) clears the record", async () => {
    await recordBackupSize(recordFile, UDID, 1234);
    const svc = new BackupService();
    jest
      .spyOn(svc as unknown as { measureBackupSize: () => Promise<unknown> }, "measureBackupSize")
      .mockResolvedValue({ measured: false, reason: "EACCES" });
    await (svc as unknown as { measureAndRecord: (u: string, p: string) => Promise<unknown> }).measureAndRecord(UDID, chain);
    expect(await readRecordedBackupSize(recordFile, UDID)).toBeNull();
  });
});
