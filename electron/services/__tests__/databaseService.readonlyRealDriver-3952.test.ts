/**
 * @jest-environment node
 *
 * BACKLOG-3952 — the two driver facts the startup retry rests on, on the REAL
 * better-sqlite3-multiple-ciphers driver (SR R6):
 *
 *   C4  `BEGIN IMMEDIATE` succeeds on a read-only file, so it is not a probe;
 *       probeWritable() must write a page and throws SQLITE_READONLY.
 *   C3  A handle that opened read-only stays read-only after the file is
 *       writable again. initialize() must open a NEW handle per attempt.
 *
 * Read-only is simulated with chmod 0444 on mad.db and its -wal/-shm. That is
 * not the field mechanism (MECHANISM UNTRACED on Windows), but it produces the
 * same SQLite state: a connection silently opened read-only. Skipped on
 * Windows, where chmod only toggles the read-only attribute and the sidecar
 * behaviour has not been measured.
 *
 * Run locally without touching the shared native module:
 *   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron node_modules/jest/bin/jest.js \
 *     electron/services/__tests__/databaseService.readonlyRealDriver-3952.test.ts
 */
import fs from "fs";
import os from "os";
import path from "path";

const mockUserData = { dir: "" };
jest.mock("electron", () => ({
  app: {
    getPath: jest.fn(() => mockUserData.dir),
    isReady: jest.fn(() => true),
    whenReady: jest.fn().mockResolvedValue(undefined),
    quit: jest.fn(),
  },
  dialog: { showMessageBox: jest.fn().mockResolvedValue({ response: 1 }) },
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
jest.mock("../databaseEncryptionService", () => {
  const m = {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("a".repeat(64)),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(true),
  };
  return { __esModule: true, default: m, databaseEncryptionService: m };
});
// Bypass the moduleNameMapper auto-mock: the real driver is the fixture.
jest.mock("better-sqlite3-multiple-ciphers", () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  jest.requireActual(
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("path").join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
  ),
);

import type { Database as DatabaseType } from "better-sqlite3";
import * as dbWriteRetry from "../db/dbWriteRetry";
import { closeDb } from "../db/core/dbConnection";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as new (file: string, opts?: object) => DatabaseType;

const SUFFIXES = ["", "-wal", "-shm"];
function chmodAll(file: string, mode: number): void {
  for (const s of SUFFIXES) {
    if (fs.existsSync(file + s)) fs.chmodSync(file + s, mode);
  }
}

const describeUnlessWindows = process.platform === "win32" ? describe.skip : describe;

describeUnlessWindows("BACKLOG-3952 real driver — read-only database", () => {
  jest.setTimeout(120_000);
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-3952-"));
    mockUserData.dir = tmpDir;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    chmodAll(path.join(tmpDir, "mad.db"), 0o644);
    chmodAll(path.join(tmpDir, "plain.db"), 0o644);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("C4: BEGIN IMMEDIATE passes on a read-only file; probeWritable throws the driver's SQLITE_READONLY", () => {
    const file = path.join(tmpDir, "plain.db");
    const seed = new RealDatabase(file);
    seed.pragma("journal_mode = WAL");
    seed.exec("CREATE TABLE t (x INTEGER)");
    seed.close();
    chmodAll(file, 0o444);

    const db = new RealDatabase(file);
    try {
      // Why a bare transaction is not a probe:
      expect(() => {
        db.prepare("BEGIN IMMEDIATE").run();
        db.prepare("ROLLBACK").run();
      }).not.toThrow();

      let caught: unknown;
      try {
        dbWriteRetry.probeWritable(db);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeDefined();
      // The fixture the mocked suites transcribe.
      expect((caught as Error).name).toBe("SqliteError");
      expect((caught as { code: string }).code).toBe("SQLITE_READONLY");
      expect((caught as Error).message).toBe("attempt to write a readonly database");
      expect(dbWriteRetry.isRetryableDbWriteError(caught)).toBe(true);
      // The probe left no transaction open.
      expect(db.inTransaction).toBe(false);
    } finally {
      db.close();
    }

    chmodAll(file, 0o644);
    const writable = new RealDatabase(file);
    try {
      expect(() => dbWriteRetry.probeWritable(writable)).not.toThrow();
      expect(writable.inTransaction).toBe(false);
    } finally {
      writable.close();
    }
  });

  it("C3: initialize() recovers when the file becomes writable — only possible with a new handle per attempt", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const service = require("../databaseService").default;
    const reset = async (): Promise<void> => {
      await closeDb();
      service.db = null;
      service.dbPath = null;
      service.encryptionKey = null;
    };

    // 1. Create a real, fully migrated, encrypted database.
    await reset();
    await expect(service.initialize()).resolves.toBe(true);
    await reset();
    const dbFile = path.join(tmpDir, "mad.db");
    expect(fs.existsSync(dbFile)).toBe(true);

    // 2. Make it read-only. The first attempt opens read-only and fails; the
    //    file is released when the loop starts waiting.
    chmodAll(dbFile, 0o444);
    let waits = 0;
    jest.spyOn(dbWriteRetry, "retryDelayMs").mockImplementation(() => {
      waits++;
      chmodAll(dbFile, 0o644);
      return 10;
    });

    await expect(service.initialize()).resolves.toBe(true);
    expect(waits).toBe(1);

    // 3. The handle that won can really write.
    const db = service.getRawDatabase() as DatabaseType;
    expect(() => db.exec("CREATE TABLE IF NOT EXISTS probe_3952 (x INTEGER)")).not.toThrow();
    await reset();
  });
});
