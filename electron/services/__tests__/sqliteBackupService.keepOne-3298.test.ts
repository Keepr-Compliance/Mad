/**
 * @jest-environment node
 *
 * BACKLOG-3298 — a manual restore keeps exactly ONE pre-restore copy
 * (founder decision 2026-11-09), on the REAL driver, the REAL databaseService
 * and the REAL sqliteBackupService, against encrypted files in a temp dir.
 * Only the contact worker pool (no worker thread here), dialogs, logging and
 * the key store are mocked.
 *
 *   K1 a successful restore keeps one copy, openable with the key, holding the
 *      pre-restore data (including a row that was still in the WAL)
 *   K2 a second restore still leaves exactly one copy: the newest
 *   K3 ordering: if keeping the new copy fails, the older copy survives
 *   K4 failure path: the live data comes back, no new copy, the older one stays
 *   K5 never deletes mad.db, a user backup, a migration backup, an auto-restore
 *      copy, or the kept copy the user just restored FROM (the undo)
 *   K5b the same, when the kept copy is opened through a symlink
 *   K7 a throw while keeping the copy never undoes the successful restore
 *
 *   ELECTRON_RUN_AS_NODE=1 npx electron node_modules/.bin/jest \
 *     electron/services/__tests__/sqliteBackupService.keepOne-3298.test.ts
 */
import fs from "fs";
import os from "os";
import path from "path";

const mockUserData = { dir: "" };
const mockShowMessageBox = jest.fn();
const mockQuit = jest.fn();
jest.mock("electron", () => ({
  app: {
    getPath: jest.fn(() => mockUserData.dir),
    isReady: jest.fn(() => true),
    whenReady: jest.fn().mockResolvedValue(undefined),
    quit: mockQuit,
  },
  dialog: { showMessageBox: mockShowMessageBox },
}));
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
}));
jest.mock("../logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});
const KEY = "c".repeat(64);
jest.mock("../databaseEncryptionService", () => {
  const m = {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("c".repeat(64)),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(true),
  };
  return { __esModule: true, default: m, databaseEncryptionService: m };
});
jest.mock("../../workers/contactWorkerPool", () => ({
  drainPoolForExclusiveAccess: jest.fn().mockResolvedValue({ drained: true, via: "test" }),
  restartPoolAfterExclusiveAccess: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("better-sqlite3-multiple-ciphers", () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  jest.requireActual(
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("path").join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
  ),
);

import type { Database as DatabaseType } from "better-sqlite3";
import { closeDb } from "../db/core/dbConnection";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as new (file: string, opts?: object) => DatabaseType;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const service = require("../databaseService").default;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const DatabaseServiceClass = require("../databaseService").DatabaseService ?? service.constructor;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { backupDatabase, restoreDatabase } = require("../sqliteBackupService");
const MIGRATIONS = DatabaseServiceClass.MIGRATIONS as Array<{
  version: number;
  description: string;
  migrate: (d: DatabaseType) => void;
}>;
const LATEST = MIGRATIONS[MIGRATIONS.length - 1].version;

const KEPT_RE = /^mad-before-restore-\d{8}T\d{9}(-\d+)?\.db$/;

function rows(file: string): string[] {
  const db = new RealDatabase(file, { readonly: true });
  try {
    db.pragma(`key = "x'${KEY}'"`);
    db.pragma("cipher_compatibility = 4");
    return (db.prepare("SELECT v FROM t_3298 ORDER BY v").all() as Array<{ v: string }>).map((r) => r.v);
  } finally {
    db.close();
  }
}

async function reset(): Promise<void> {
  try {
    await closeDb();
  } catch {
    /* already closed */
  }
  try {
    service.db?.close?.();
  } catch {
    /* already closed */
  }
  service.db = null;
  service.dbPath = null;
  service.encryptionKey = null;
}

const describeUnlessWindows = process.platform === "win32" ? describe.skip : describe;

describeUnlessWindows("BACKLOG-3298 real driver — a manual restore keeps one copy", () => {
  jest.setTimeout(120_000);
  let tmpDir: string;
  let dbFile: string;
  let userBackup: string;

  const kept = (): string[] => fs.readdirSync(tmpDir).filter((f) => KEPT_RE.test(f)).sort();
  const insert = (v: string): void => {
    service.getRawDatabase().prepare("INSERT INTO t_3298 VALUES (?)").run(v);
  };

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-3298-"));
    mockUserData.dir = tmpDir;
    dbFile = path.join(tmpDir, "mad.db");
    userBackup = path.join(tmpDir, "keepr-backup-2026-01-01.db");
    mockShowMessageBox.mockReset();
    await reset();
    await expect(service.initialize()).resolves.toBe(true);
    service.getRawDatabase().exec("CREATE TABLE t_3298 (v TEXT)");
    insert("in-backup");
    const b = await backupDatabase(userBackup);
    expect(b.success).toBe(true);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    while (MIGRATIONS.length && MIGRATIONS[MIGRATIONS.length - 1].version > LATEST) MIGRATIONS.pop();
    await reset();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("K1 a successful restore keeps one copy holding the pre-restore data, WAL row included", async () => {
    insert("after-backup");
    // Fixture check: the row is in the WAL, not yet in the main file.
    expect(fs.statSync(`${dbFile}-wal`).size).toBeGreaterThan(0);

    const r = await restoreDatabase(userBackup);
    expect(r.success).toBe(true);
    expect(kept()).toHaveLength(1);
    expect(r.keptPreviousAs).toBe(path.join(tmpDir, kept()[0]));
    expect(fs.existsSync(`${dbFile}.safety-restore-copy`)).toBe(false);
    expect(rows(path.join(tmpDir, kept()[0]))).toEqual(["after-backup", "in-backup"]);
    expect(rows(dbFile)).toEqual(["in-backup"]);
  });

  it("K2 a second restore still leaves exactly one copy: the newest", async () => {
    insert("first");
    expect((await restoreDatabase(userBackup)).success).toBe(true);
    const first = kept();
    expect(first).toHaveLength(1);
    insert("second");
    await new Promise((r) => setTimeout(r, 5));
    expect((await restoreDatabase(userBackup)).success).toBe(true);
    const after = kept();
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(first[0]);
    expect(rows(path.join(tmpDir, after[0]))).toEqual(["in-backup", "second"]);
  });

  it("K3 if keeping the new copy fails, the older copy survives (delete only after write)", async () => {
    insert("first");
    expect((await restoreDatabase(userBackup)).success).toBe(true);
    const first = kept();
    expect(first).toHaveLength(1);
    insert("second");
    const realRename = fs.renameSync;
    jest.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to).includes("before-restore")) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      return realRename(from, to);
    });
    const r = await restoreDatabase(userBackup);
    expect(r.success).toBe(true);
    expect(r.keptPreviousAs).toBeUndefined();
    expect(kept()).toEqual(first);
    expect(rows(path.join(tmpDir, first[0]))).toEqual(["first", "in-backup"]);
  });

  it("K5b restoring FROM a kept copy through a symlink still keeps that copy", async () => {
    insert("undo-me");
    expect((await restoreDatabase(userBackup)).success).toBe(true);
    const k = kept();
    expect(k).toHaveLength(1);
    const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-3298-link-"));
    try {
      const link = path.join(linkDir, "my-undo.db");
      fs.symlinkSync(path.join(tmpDir, k[0]), link);
      expect((await restoreDatabase(link)).success).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, k[0]))).toBe(true);
    } finally {
      fs.rmSync(linkDir, { recursive: true, force: true });
    }
  });

  it("K7 a throw while keeping the copy never undoes a restore that succeeded", async () => {
    insert("before");
    const realExists = fs.existsSync;
    jest.spyOn(fs, "existsSync").mockImplementation((p) => {
      if (String(p).includes("before-restore")) throw new Error("EACCES-3298");
      return realExists(p);
    });
    const r = await restoreDatabase(userBackup);
    expect(r.success).toBe(true);
    jest.restoreAllMocks();
    await reset();
    expect(rows(dbFile)).toEqual(["in-backup"]);
  });

  it("K4 failure path: live data comes back, no new copy, the older copy stays", async () => {
    insert("first");
    expect((await restoreDatabase(userBackup)).success).toBe(true);
    const first = kept();
    insert("live");
    const realInit = service.initialize.bind(service);
    jest.spyOn(service, "initialize")
      .mockImplementationOnce(async () => { throw new Error("boom-3298"); })
      .mockImplementation(realInit);
    const r = await restoreDatabase(userBackup);
    expect(r.success).toBe(false);
    expect(kept()).toEqual(first);
    expect(fs.existsSync(`${dbFile}.safety-restore-copy`)).toBe(false);
    await reset();
    // "first" lives only in the older kept copy (the earlier restore replaced it).
    expect(rows(dbFile)).toEqual(["in-backup", "live"]);
    expect(rows(path.join(tmpDir, first[0]))).toEqual(["first", "in-backup"]);
  });

  it("K5 never deletes mad.db, user/migration backups, auto copies, or the kept copy restored FROM", async () => {
    const others = [
      "mad-backup-20260101T000000.db",
      "mad-pre-restore-20260101T000000000.db",
      "mad-before-restore-notes.db",
      "keepr-backup-2026-02-02.db",
    ];
    for (const o of others) fs.copyFileSync(userBackup, path.join(tmpDir, o));
    insert("wrong-restore-undo-me");
    expect((await restoreDatabase(userBackup)).success).toBe(true); // the mistake
    const k = kept();
    expect(k).toHaveLength(1);
    // The undo: restore FROM the kept copy. It must survive its own restore.
    const r = await restoreDatabase(path.join(tmpDir, k[0]));
    expect(r.success).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, k[0]))).toBe(true);
    expect(rows(dbFile)).toEqual(["in-backup", "wrong-restore-undo-me"]);
    for (const o of others) expect(fs.existsSync(path.join(tmpDir, o))).toBe(true);
    expect(fs.existsSync(userBackup)).toBe(true);
    // A third restore: the copy restored from last time is now older and goes.
    expect((await restoreDatabase(userBackup)).success).toBe(true);
    expect(kept()).toHaveLength(1);
    for (const o of others) expect(fs.existsSync(path.join(tmpDir, o))).toBe(true);
    expect(fs.existsSync(dbFile)).toBe(true);
  });

});
