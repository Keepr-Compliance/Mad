/**
 * BACKLOG-4243 — every restore path ends with the Keepr Cloud reset
 * (prepareRestoredFile): after the user restore's re-initialise, after the
 * recovery to the safety copy, and after the automatic restore of a failed
 * migration. Harness and mocks transcribed from sqliteBackupService.poolDrain-2553.
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

const mockEnsureDb = jest.fn(() => ({ marker: "restored-db" }));
jest.mock("../db/core/dbConnection", () => ({ ensureDb: mockEnsureDb }));

const mockPrepareRestored = jest.fn((db: unknown) => {
  calls.push(`prepareRestored(${(db as { marker?: string })?.marker})`);
  return true;
});
jest.mock("../db/cloudSyncTriggers", () => ({ prepareRestoredFile: mockPrepareRestored }));

import fs from "fs";
import path from "path";
import { restoreDatabase } from "../sqliteBackupService";

const BACKUP = "/tmp/valid.db";

describe("BACKLOG-4243 — Keepr Cloud reset after a restore", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    calls.length = 0;
    mockGetPath.mockReturnValue("/mock/userData");
    mockGetEncryptionKey.mockResolvedValue("deadbeef");
    mockIsInitialized.mockReturnValue(true);
    mockDbServiceClose.mockImplementation(async () => { calls.push("close"); });
    mockDbServiceInitialize.mockImplementation(async () => { calls.push("initialize"); return true; });
    mockDrain.mockImplementation(async () => { calls.push("drain"); return { drained: true, via: "graceful-exit" }; });
    mockExistsSync.mockReturnValue(true);
    mockTestDbPrepare.mockReturnValue({ get: () => ({ count: 12 }) });
  });

  it("user restore: the reset runs on the re-opened database right after initialize", async () => {
    const result = await restoreDatabase(BACKUP);
    expect(result.success).toBe(true);
    expect(calls).toEqual(["drain", "close", "initialize", "prepareRestored(restored-db)", "restart(spawn=true)"]);
  });

  it("failed restore: the recovery to the safety copy also ends with the reset", async () => {
    let n = 0;
    mockDbServiceInitialize.mockImplementation(async () => {
      calls.push("initialize");
      if (++n === 1) throw new Error("first open failed");
      return true;
    });
    const result = await restoreDatabase(BACKUP);
    expect(result.success).toBe(false);
    expect(calls).toEqual(["drain", "close", "initialize", "initialize", "prepareRestored(restored-db)", "restart(spawn=true)"]);
  });

  it("automatic restore after a failed migration: databaseService prepares the restored handle", () => {
    // databaseService cannot be driven here; its call site is pinned by source.
    const src = (jest.requireActual("fs") as typeof fs).readFileSync(
      (jest.requireActual("path") as typeof path).join(__dirname, "..", "databaseService.ts"),
      "utf8",
    );
    const call = src.indexOf("const restoreResult = await this._attemptAutoRestore(");
    expect(call).toBeGreaterThan(0);
    const next = src.slice(call, call + 400);
    expect(next).toMatch(/if \(restoreResult\.handle\) prepareRestoredFile\(restoreResult\.handle, /);
  });
});
