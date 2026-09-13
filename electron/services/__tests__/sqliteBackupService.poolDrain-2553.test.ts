/**
 * BACKLOG-2553 — THE ORDERING AND THE RESTART, THE PARTS A REAL THREAD CANNOT SHOW
 *
 * The real-thread suite (`electron/workers/__tests__/contactWorkerPool.drain-2553.test.ts`)
 * proves the operating-system fact: no second thread holds the database file when
 * `fs.copyFileSync` runs. It cannot cheaply produce the two paths below —
 * a database file that does not exist, and an `initialize()` that fails twice —
 * so those live here, against mocked `fs`, where they cost milliseconds.
 *
 * WHAT IS MOCKED AND WHY THAT IS HONEST HERE: this file asserts CONTROL FLOW —
 * which function ran, in what order, on which exit path. Every claim about a real
 * file handle is made in the other suite. Neither file is asked to prove the
 * other's point.
 *
 * The threat model, corrected: the contact worker's connection is
 * `readonly: true` (`contactQueryWorker.ts:74`, BACKLOG-2536), so no write can be
 * lost. A live worker across a restore costs a failed copy on Windows and a stale
 * contacts list on macOS. Not corruption.
 */

const mockExistsSync = jest.fn();
const mockCopyFileSync = jest.fn();
const mockStatSync = jest.fn();
const mockUnlinkSync = jest.fn();
jest.mock("fs", () => ({
  existsSync: mockExistsSync,
  copyFileSync: mockCopyFileSync,
  statSync: mockStatSync,
  unlinkSync: mockUnlinkSync,
}));

jest.mock("path", () => ({
  join: (...args: string[]) => args.join("/"),
  resolve: (p: string) => p,
}));

const mockGetPath = jest.fn();
jest.mock("electron", () => ({ app: { getPath: mockGetPath } }));

jest.mock("@sentry/electron/main", () => ({ captureException: jest.fn() }));

jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

/**
 * ONE ordered log for every lifecycle call the restore makes.
 *
 * The point of this item is that the drain happens BEFORE anything is closed or
 * copied. Asserting each function was called individually would pass on an
 * implementation that drained last, so the order is recorded and asserted.
 */
const calls: string[] = [];

const mockDbServiceClose = jest.fn(async () => { calls.push("close"); });
const mockDbServiceInitialize = jest.fn(async () => { calls.push("initialize"); return true; });
const mockIsInitialized = jest.fn(() => true);
jest.mock("../databaseService", () => ({
  __esModule: true,
  default: {
    isInitialized: mockIsInitialized,
    getRawDatabase: jest.fn(),
    close: mockDbServiceClose,
    initialize: mockDbServiceInitialize,
  },
}));

const mockGetEncryptionKey = jest.fn();
jest.mock("../databaseEncryptionService", () => ({
  databaseEncryptionService: { getEncryptionKey: mockGetEncryptionKey },
}));

/** Mirrors `DrainResult` from the pool module, which is mocked away below. */
type DrainShape = { drained: boolean; via?: string; reason?: string };
const mockDrain = jest.fn(async (): Promise<DrainShape> => {
  calls.push("drain");
  return { drained: true, via: "graceful-exit" };
});
const mockRestart = jest.fn(async (_p: string | null, _k: string | null, spawn: boolean) => {
  calls.push(`restart(spawn=${spawn})`);
});
jest.mock("../../workers/contactWorkerPool", () => ({
  drainPoolForExclusiveAccess: mockDrain,
  restartPoolAfterExclusiveAccess: mockRestart,
}));

const mockTestDbClose = jest.fn();
const mockTestDbPragma = jest.fn();
const mockTestDbPrepare = jest.fn();
const MockDatabase = jest.fn().mockImplementation(() => ({
  close: mockTestDbClose,
  pragma: mockTestDbPragma,
  prepare: mockTestDbPrepare,
}));
jest.mock("better-sqlite3-multiple-ciphers", () => MockDatabase);

jest.mock("../db/core/dbConnection", () => ({ ensureDb: jest.fn() }));

import { restoreDatabase, RESTORE_POOL_DRAIN_REFUSAL } from "../sqliteBackupService";

const DB_PATH = "/mock/userData/mad.db";
const BACKUP = "/tmp/valid.db";

describe("BACKLOG-2553 — restore ordering, refusal, and the restart on every exit", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    calls.length = 0;
    mockGetPath.mockReturnValue("/mock/userData");
    mockGetEncryptionKey.mockResolvedValue("deadbeef");
    mockIsInitialized.mockReturnValue(true);
    mockDbServiceClose.mockImplementation(async () => { calls.push("close"); });
    mockDbServiceInitialize.mockImplementation(async () => { calls.push("initialize"); return true; });
    mockDrain.mockImplementation(async () => { calls.push("drain"); return { drained: true, via: "graceful-exit" }; });

    // verifyBackup: file exists, decrypts, has tables.
    mockExistsSync.mockReturnValue(true);
    mockTestDbPrepare.mockReturnValue({ get: () => ({ count: 12 }) });
  });

  it("drains the pool before closing the database or copying any file", async () => {
    const result = await restoreDatabase(BACKUP);

    expect(result).toEqual({ success: true });
    // The drain is first, and the restart is last — the whole contract in one line.
    expect(calls).toEqual(["drain", "close", "initialize", "restart(spawn=true)"]);
    expect(mockDrain).toHaveBeenCalledTimes(1);
  });

  it("refuses the restore and touches no bytes when the pool cannot be drained", async () => {
    mockDrain.mockImplementation(async () => {
      calls.push("drain");
      return { drained: false, reason: "worker did not exit within 5000ms" };
    });

    const result = await restoreDatabase(BACKUP);

    expect(result).toEqual({ success: false, error: RESTORE_POOL_DRAIN_REFUSAL });
    // Nothing was closed, no safety copy written, no file replaced.
    expect(calls).toEqual(["drain"]);
    expect(mockDbServiceClose).not.toHaveBeenCalled();
    expect(mockCopyFileSync).not.toHaveBeenCalled();
    // And no restart: the drain never took the hold, so there is nothing to release.
    expect(mockRestart).not.toHaveBeenCalled();
  });

  /**
   * THE PATH THAT KEYING OFF `safetyCreated` WOULD MISS.
   *
   * When the database file does not exist there is no safety copy, so
   * `safetyCreated` stays false and the existing catch block's
   * `if (safetyCreated && ...)` recovery never runs. A restart placed inside
   * that block — or gated on that flag — would leave the app with no contact
   * worker on exactly the path that already went wrong.
   */
  it("restarts the pool when the restore fails and no safety copy was ever made", async () => {
    // dbPath absent → no safety copy; backup path still present for verifyBackup.
    mockExistsSync.mockImplementation((p: string) => p !== DB_PATH);
    mockDbServiceInitialize.mockImplementation(async () => {
      calls.push("initialize");
      throw new Error("migration exploded");
    });

    const result = await restoreDatabase(BACKUP);

    expect(result.success).toBe(false);
    expect(result.error).toContain("migration exploded");
    expect(calls).toEqual(["drain", "close", "initialize", "restart(spawn=true)"]);
  });

  /**
   * THE DOUBLE-FAILURE PATH — the restart releases the hold but must NOT spawn.
   *
   * Copy done, `initialize()` failed, safety-copy recovery ALSO failed. The
   * database is not open. A worker started against it never posts `ready`, and
   * `initializePool` would hold the user's error dialog behind a 10-second init
   * timeout for a restart that was never going to work.
   */
  it("releases the hold without spawning when the database could not be reopened", async () => {
    mockDbServiceInitialize.mockImplementation(async () => {
      calls.push("initialize");
      throw new Error("cannot open");
    });
    mockIsInitialized.mockReturnValue(false);

    const result = await restoreDatabase(BACKUP);

    expect(result.success).toBe(false);
    expect(result.requiresRestart).toBe(true);
    expect(mockRestart).toHaveBeenCalledWith(null, null, false);
  });

  it("does not drain when the backup file fails verification", async () => {
    mockExistsSync.mockReturnValue(false);

    const result = await restoreDatabase("/tmp/invalid.db");

    expect(result.success).toBe(false);
    expect(result.error).toContain("not a valid backup");
    // Nothing was drained, so nothing needs restarting.
    expect(calls).toEqual([]);
    expect(mockRestart).not.toHaveBeenCalled();
  });
});
