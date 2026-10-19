/**
 * BACKLOG-3952 — a read-only database at startup is waited for, never
 * "restored".
 *
 * Same mocked harness as databaseService.migration-restore.test.ts. The
 * read-only error is TRANSCRIBED from the real driver (better-sqlite3-multiple-
 * ciphers, file chmod 0444, `PRAGMA user_version = 0` inside BEGIN IMMEDIATE,
 * run 2026-10-15 under Electron's node):
 *
 *   {"ctor":"SqliteError","name":"SqliteError","code":"SQLITE_READONLY",
 *    "message":"attempt to write a readonly database",
 *    "ownKeys":["message","stack","code"]}
 *
 * Injection is by SQL text (the probe's `user_version =` write, or the
 * schema.sql exec), never by call count: each attempt opens a new handle, so
 * call counts move.
 *
 * Real-driver facts (a read-only handle stays read-only; BEGIN IMMEDIATE is not
 * a probe) are in databaseService.readonlyRealDriver-3952.test.ts.
 */

// ---- Mock setup (must be before imports) ----
const mockExistsSync = jest.fn();
const mockCopyFileSync = jest.fn();
const mockRenameSync = jest.fn();
const mockReaddirSync = jest.fn();
const mockReadFileSync = jest.fn();
const mockUnlinkSync = jest.fn();
jest.mock("fs", () => ({
  existsSync: mockExistsSync,
  copyFileSync: mockCopyFileSync,
  renameSync: mockRenameSync,
  mkdirSync: jest.fn(),
  readdirSync: mockReaddirSync,
  readFileSync: mockReadFileSync,
  statSync: jest.fn(),
  openSync: jest.fn(),
  writeSync: jest.fn(),
  fsyncSync: jest.fn(),
  closeSync: jest.fn(),
  unlinkSync: mockUnlinkSync,
}));

jest.mock("path", () => ({
  join: (...args: string[]) => args.join("/"),
  dirname: (p: string) => {
    const parts = p.split("/");
    parts.pop();
    return parts.join("/");
  },
  basename: (p: string, ext?: string) => {
    const base = p.split("/").pop() || p;
    if (ext && base.endsWith(ext)) return base.slice(0, -ext.length);
    return base;
  },
  resolve: (p: string) => p,
}));

const mockShowMessageBox = jest.fn();
const mockQuit = jest.fn();
jest.mock("electron", () => ({
  app: {
    getPath: jest.fn(() => "/mock/userData"),
    isReady: jest.fn(() => true),
    whenReady: jest.fn().mockResolvedValue(undefined),
    quit: mockQuit,
  },
  dialog: { showMessageBox: mockShowMessageBox },
}));

const mockCaptureException = jest.fn();
jest.mock("@sentry/electron/main", () => ({
  captureException: mockCaptureException,
  captureMessage: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
}));

jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock("../databaseEncryptionService", () => ({
  databaseEncryptionService: {
    getEncryptionKey: jest.fn().mockResolvedValue("abcdef1234567890"),
    initialize: jest.fn().mockResolvedValue(undefined),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(true),
  },
}));

const mockSetDb = jest.fn();
const mockCloseDb = jest.fn();
jest.mock("../db/core/dbConnection", () => ({
  setDb: mockSetDb,
  setDbPath: jest.fn(),
  setEncryptionKey: jest.fn(),
  closeDb: mockCloseDb,
  vacuumDb: jest.fn(),
}));

const mockDbClose = jest.fn();
const mockDbPragma = jest.fn();
const mockDbExec = jest.fn();
const mockDbPrepare = jest.fn();
const MockDatabase = jest.fn().mockImplementation(() => ({
  close: mockDbClose,
  pragma: mockDbPragma,
  exec: mockDbExec,
  prepare: mockDbPrepare,
  transaction: (fn: () => void) => () => fn(),
}));
jest.mock("better-sqlite3-multiple-ciphers", () => MockDatabase);

// ---- Imports after mocks ----
import databaseService from "../databaseService";
import { initializationBroadcaster } from "../initializationBroadcaster";
import { DbNotWritableError } from "../../types/database";
import * as dbWriteRetry from "../db/dbWriteRetry";

const DB_PATH = "/mock/userData/mad.db";

/** The real driver's error, field for field (see header). */
function readonlyError(): Error {
  const e = new Error("attempt to write a readonly database") as Error & { code: string };
  e.name = "SqliteError";
  e.code = "SQLITE_READONLY";
  return e;
}

/** Phase "open" changed nothing; phase "migration" may follow committed migrations. */
const NOT_WRITABLE_DIALOG = (phase: "open" | "migration") => ({
  type: "warning",
  title: "Keepr can't open your data yet",
  message: "Keepr can't write to your data yet.",
  detail:
    (phase === "open"
      ? "Nothing was changed. "
      : "Keepr did not replace or delete your data file. ") +
    "Another program may still be checking Keepr's files, " +
    "which can happen right after an update. Choose Try again to keep waiting.\n\n" +
    "If this keeps happening, contact support.",
  buttons: ["Try again", "Quit"],
});

describe("BACKLOG-3952 — read-only database at startup", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service: any = databaseService;
  let parkedMigrations: unknown[];
  let probeFailuresLeft: number;
  let broadcastSpy: jest.SpyInstance;

  /** Read-write opens of mad.db (the readonly fence passes an options object). */
  const readWriteOpens = (): number =>
    MockDatabase.mock.calls.filter((c: unknown[]) => c.length === 1).length;
  const copiesOntoLiveDb = (): unknown[][] =>
    mockCopyFileSync.mock.calls.filter((c) => c[1] === DB_PATH);
  const stagesBroadcast = (): string[] =>
    broadcastSpy.mock.calls.map((c) => (c[0] as { stage: string }).stage);

  beforeEach(() => {
    jest.clearAllMocks();
    service.db = null;
    service.dbPath = null;
    service.encryptionKey = null;
    service.sameLaunchBackupPath = null;

    mockExistsSync.mockReturnValue(true);
    mockCopyFileSync.mockReset();
    mockRenameSync.mockReset();
    mockCloseDb.mockResolvedValue(undefined);
    mockShowMessageBox.mockReset();
    mockShowMessageBox.mockResolvedValue({ response: 1 }); // Quit
    mockReadFileSync.mockReturnValue("CREATE TABLE IF NOT EXISTS test (id INTEGER);");
    mockReaddirSync.mockReturnValue(["mad-backup-20260222T100000.db"]);
    mockDbExec.mockReset();

    probeFailuresLeft = 0;
    mockDbPragma.mockImplementation((pragma: string) => {
      if (pragma.startsWith("user_version =")) {
        if (probeFailuresLeft > 0) {
          probeFailuresLeft--;
          throw readonlyError();
        }
        return undefined;
      }
      if (pragma === "user_version") return 0;
      if (pragma.includes("integrity_check")) return [{ integrity_check: "ok" }];
      return undefined;
    });

    const baseline = (service.constructor as { BASELINE_VERSION: number }).BASELINE_VERSION;
    mockDbPrepare.mockImplementation((sql: string) => {
      if (sql.includes("sqlite_master") && sql.includes("schema_version")) {
        return { get: jest.fn().mockReturnValue({ name: "schema_version" }) };
      }
      if (sql.includes("SELECT version FROM schema_version")) {
        return { get: jest.fn().mockReturnValue({ version: baseline }) };
      }
      if (sql.includes("SELECT 1")) return { get: jest.fn().mockReturnValue({ ok: 1 }) };
      return { get: jest.fn(), all: jest.fn().mockReturnValue([]), run: jest.fn() };
    });

    parkedMigrations = (service.constructor as { MIGRATIONS: unknown[] }).MIGRATIONS;
    (service.constructor as { MIGRATIONS: unknown[] }).MIGRATIONS = [];

    broadcastSpy = jest.spyOn(initializationBroadcaster, "broadcast");
  });

  afterEach(() => {
    (service.constructor as { MIGRATIONS: unknown[] }).MIGRATIONS = parkedMigrations;
    broadcastSpy.mockRestore();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  /** Inject one future migration so this launch writes its pre-migration backup. */
  function armSameLaunchBackup(): void {
    const klass = service.constructor as {
      MIGRATIONS: Array<{ version: number; description: string; migrate: () => void }>;
      BASELINE_VERSION: number;
    };
    klass.MIGRATIONS = [
      { version: klass.BASELINE_VERSION + 1, description: "future", migrate: () => undefined },
    ];
  }

  /** Run initialize() on fake timers until it settles. */
  async function runToSettle(
    options?: { quitOnUnrecoverableFailure?: boolean },
  ): Promise<{ value?: unknown; error?: unknown; advancedMs: number }> {
    jest.useFakeTimers();
    let settled = false;
    const out: { value?: unknown; error?: unknown; advancedMs: number } = { advancedMs: 0 };
    service.initialize(options).then(
      (v: unknown) => {
        settled = true;
        out.value = v;
      },
      (e: unknown) => {
        settled = true;
        out.error = e;
      },
    );
    for (let i = 0; i < 400 && !settled; i++) {
      await jest.advanceTimersByTimeAsync(500);
      out.advancedMs += 500;
    }
    expect(settled).toBe(true);
    return out;
  }

  it("C1: read-only for two attempts, writable on the third — opens normally, nothing restored, no dialog", async () => {
    probeFailuresLeft = 2;

    const out = await runToSettle({ quitOnUnrecoverableFailure: true });

    expect(out.error).toBeUndefined();
    expect(out.value).toBe(true);
    expect(service.isInitialized()).toBe(true);
    expect(readWriteOpens()).toBe(3); // a NEW handle per attempt
    expect(mockDbClose.mock.calls.length).toBeGreaterThanOrEqual(2); // failed handles closed
    expect(copiesOntoLiveDb()).toHaveLength(0);
    expect(mockRenameSync).not.toHaveBeenCalled();
    expect(mockShowMessageBox).not.toHaveBeenCalled();
    expect(mockQuit).not.toHaveBeenCalled();
    const stages = stagesBroadcast();
    expect(stages).toContain("db-waiting");
    expect(stages).not.toContain("error");
    expect(stages[stages.length - 1]).toBe("db-ready");
    // Nothing reached Sentry as an error; success after waiting is a breadcrumb.
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("C2: read-only for the whole budget, user chooses Quit — honest dialog, nothing copied, one Sentry event, quits", async () => {
    probeFailuresLeft = Number.MAX_SAFE_INTEGER;
    mockShowMessageBox.mockResolvedValue({ response: 1 });

    const out = await runToSettle({ quitOnUnrecoverableFailure: true });

    expect(out.error).toBeInstanceOf(DbNotWritableError);
    expect((out.error as DbNotWritableError).errorCode).toBe("SQLITE_READONLY");
    expect(mockShowMessageBox).toHaveBeenCalledTimes(1);
    expect(mockShowMessageBox).toHaveBeenCalledWith(NOT_WRITABLE_DIALOG("open"));
    expect(JSON.stringify(mockShowMessageBox.mock.calls)).not.toMatch(/restored/i);
    expect(copiesOntoLiveDb()).toHaveLength(0);
    expect(mockRenameSync).not.toHaveBeenCalled();
    expect(mockQuit).toHaveBeenCalledTimes(1);
    expect(service.isInitialized()).toBe(false);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockCaptureException.mock.calls[0][1]).toEqual({
      tags: expect.objectContaining({
        db_not_writable: "true",
        error_code: "SQLITE_READONLY",
        phase: "open",
      }),
    });
    // The renderer stays on "db-waiting" while asked; error only at the end.
    const stages = stagesBroadcast();
    expect(stages.filter((s) => s === "error")).toHaveLength(1);
    expect(stages[stages.length - 1]).toBe("error");
  });

  it("C2b: \"Try again\" retries in place — no relaunch, opens once the file is writable", async () => {
    probeFailuresLeft = Number.MAX_SAFE_INTEGER;
    mockShowMessageBox.mockImplementation(async () => {
      probeFailuresLeft = 0; // released while the user read the dialog
      return { response: 0 };
    });

    const out = await runToSettle({ quitOnUnrecoverableFailure: true });

    expect(out.error).toBeUndefined();
    expect(out.value).toBe(true);
    expect(mockShowMessageBox).toHaveBeenCalledTimes(1);
    expect(mockQuit).not.toHaveBeenCalled();
    expect(service.isInitialized()).toBe(true);
    expect(stagesBroadcast()).not.toContain("error");
  });

  it("C2c: without the startup flag (backup restore caller) — no dialog, no quit, typed rejection", async () => {
    probeFailuresLeft = Number.MAX_SAFE_INTEGER;

    const out = await runToSettle();

    expect(out.error).toBeInstanceOf(DbNotWritableError);
    expect(mockShowMessageBox).not.toHaveBeenCalled();
    expect(mockQuit).not.toHaveBeenCalled();
    expect(copiesOntoLiveDb()).toHaveLength(0);
  });

  it("C6: read-only inside runMigrations after a passing probe — never restores, asks the user", async () => {
    armSameLaunchBackup(); // a restorable same-launch backup EXISTS: the guard must still win
    mockDbExec.mockImplementation((sql: string) => {
      if (sql.includes("CREATE TABLE IF NOT EXISTS test")) throw readonlyError();
    });

    const out = await runToSettle({ quitOnUnrecoverableFailure: true });

    expect(out.error).toBeInstanceOf(DbNotWritableError);
    expect(copiesOntoLiveDb()).toHaveLength(0);
    expect(mockRenameSync).not.toHaveBeenCalled();
    expect(mockShowMessageBox).toHaveBeenCalledTimes(1);
    expect(mockShowMessageBox).toHaveBeenCalledWith(NOT_WRITABLE_DIALOG("migration"));
    expect(mockCloseDb).toHaveBeenCalled();
    expect(service.isInitialized()).toBe(false);
    // R4: the migration_failure event carries the code.
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tags: expect.objectContaining({
          migration_failure: "true",
          error_code: "SQLITE_READONLY",
          auto_restore: "skipped_not_writable",
        }),
      }),
    );
  });

  it("C7: a read-only error inside runMigrations never re-runs migrations automatically — one backup", async () => {
    armSameLaunchBackup();
    let schemaFailures = 1;
    mockDbExec.mockImplementation((sql: string) => {
      if (sql.includes("CREATE TABLE IF NOT EXISTS test") && schemaFailures > 0) {
        schemaFailures--;
        throw readonlyError();
      }
    });

    const out = await runToSettle(); // no startup flag: the caller gets the error

    expect(out.error).toBeInstanceOf(DbNotWritableError);
    const backups = mockCopyFileSync.mock.calls.filter((c) => String(c[1]).includes("-backup-"));
    expect(backups).toHaveLength(1);
  });

  it("C7b: open retries take no backup and run migrations once", async () => {
    armSameLaunchBackup();
    probeFailuresLeft = 3;

    const out = await runToSettle({ quitOnUnrecoverableFailure: true });

    expect(out.value).toBe(true);
    const backups = mockCopyFileSync.mock.calls.filter((c) => String(c[1]).includes("-backup-"));
    expect(backups).toHaveLength(1);
    const schemaExecs = mockDbExec.mock.calls.filter((c) =>
      String(c[0]).includes("CREATE TABLE IF NOT EXISTS test"),
    );
    expect(schemaExecs).toHaveLength(1);
  });

  it("C9: bounded — 21 attempts and 87.5 s of waiting, inside the 90 s budget", async () => {
    // Derivation from dbWriteRetry's constants: delays 0.5, 1, 2, 4, then 5 s.
    // Before attempt k (k >= 5) the loop has waited 7.5 + 5(k-5) s; it stops
    // when that plus the next 5 s would pass 90 s, i.e. after attempt 21.
    probeFailuresLeft = Number.MAX_SAFE_INTEGER;

    const out = await runToSettle();

    expect(out.error).toBeInstanceOf(DbNotWritableError);
    expect((out.error as DbNotWritableError).attempts).toBe(21);
    expect(readWriteOpens()).toBe(21);
    expect(out.advancedMs).toBeLessThanOrEqual(dbWriteRetry.DB_WRITE_RETRY_BUDGET_MS);
    expect(out.advancedMs).toBeGreaterThanOrEqual(87_500);
  });

  it("C11: every startup wait outlasts the retry budget by at least 5 s", async () => {
    const { DEFAULT_DB_READY_TIMEOUT_MS } = await import("../initializationBroadcaster");
    expect(dbWriteRetry.DB_WRITE_RETRY_BUDGET_MS).toBeGreaterThan(60_000); // observed hold ~60 s
    expect(dbWriteRetry.DB_WAIT_DEPENDENT_TIMEOUT_MS).toBeGreaterThanOrEqual(
      dbWriteRetry.DB_WRITE_RETRY_BUDGET_MS + 5_000,
    );
    expect(DEFAULT_DB_READY_TIMEOUT_MS).toBeGreaterThanOrEqual(
      dbWriteRetry.DB_WAIT_DEPENDENT_TIMEOUT_MS,
    );
  });

  it("C12: the wait is asynchronous — other timers keep running while it waits", async () => {
    // Real timers and short delays: a synchronous sleep would starve this
    // interval until initialize() returned.
    jest.spyOn(dbWriteRetry, "retryDelayMs").mockReturnValue(20);
    probeFailuresLeft = 8;
    let ticks = 0;
    const interval = setInterval(() => {
      ticks++;
    }, 5);
    let ticksAtResolve = -1;
    try {
      await service.initialize().then(() => {
        ticksAtResolve = ticks;
      });
    } finally {
      clearInterval(interval);
    }
    expect(service.isInitialized()).toBe(true);
    // A synchronous sleep yields 0 ticks. >= 2 leaves room for the coarse
    // Windows timer (~15.6 ms) on CI.
    expect(ticksAtResolve).toBeGreaterThanOrEqual(2);
  });
});
