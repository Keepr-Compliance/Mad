/**
 * @jest-environment node
 *
 * BACKLOG-2834 + BACKLOG-2836 — what startup does when a migration fails, on
 * the REAL better-sqlite3-multiple-ciphers driver and the REAL migration
 * runner (`DatabaseService.initialize()` -> `runMigrations()` ->
 * `_runVersionedMigrations()`), against a real encrypted file in a temp dir.
 *
 * The failing migration is a v79 entry pushed onto the real MIGRATIONS chain;
 * the errors it throws are the driver's own (SQLITE_ERROR from bad SQL,
 * SQLITE_FULL from `max_page_count`), never hand-written objects.
 *
 *   C1  deterministic failure: restored, NOT retried, no silent continue,
 *       failure recorded in the restored file, Quit leaves data intact.
 *   C2  transient failure that clears: migrations re-run once on the restored
 *       file, the app starts at the new version, no dialog.
 *   C3  transient failure that does not clear: exactly one retry, then the
 *       two-button dialog.
 *   C4  Start fresh moves the file aside as mad-unmigratable-*.db; it still
 *       opens with the same key and still holds the seeded row.
 *   C5  (2836) neither isInitialized() predicate is true while migrations run.
 *   C6  classifier on real errors, raw and as wrapped by the runner.
 *   C7  a non-startup caller never gets the Start fresh choice.
 *   C8  a real SQLITE_BUSY inside a migration body takes the BACKLOG-3952
 *       wait path, not a restore.
 *   C9  (SR-A) a retry that clears never broadcasts "error", so a
 *       whenDbReady() waiter started during attempt 1 resolves ready:true.
 *   C10 (SR-B) two restores in one launch keep two distinct pre-restore
 *       copies (no same-second rename overwrite).
 *   C11 (SR-C) Start fresh: no mad.db / -wal / -shm left, and the failure
 *       record travels inside the moved file.
 *
 * Run without touching the shared native module:
 *   ELECTRON_RUN_AS_NODE=1 npx electron node_modules/.bin/jest \
 *     electron/services/__tests__/databaseService.restoreRerun-2834.test.ts
 */
import fs from "fs";
import os from "os";
import path from "path";

const mockUserData = { dir: "" };
const mockShowMessageBox = jest.fn();
const mockQuit = jest.fn();
const mockRelaunch = jest.fn();
const mockExit = jest.fn();
jest.mock("electron", () => ({
  app: {
    getPath: jest.fn(() => mockUserData.dir),
    isReady: jest.fn(() => true),
    whenReady: jest.fn().mockResolvedValue(undefined),
    quit: mockQuit,
    relaunch: mockRelaunch,
    exit: mockExit,
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
jest.mock("../logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});
const KEY = "b".repeat(64);
jest.mock("../databaseEncryptionService", () => {
  const m = {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("b".repeat(64)),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(true),
  };
  return { __esModule: true, default: m, databaseEncryptionService: m };
});
jest.mock("better-sqlite3-multiple-ciphers", () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  jest.requireActual(
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("path").join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
  ),
);

import type { Database as DatabaseType } from "better-sqlite3";
import { closeDb, isInitialized as connIsInitialized } from "../db/core/dbConnection";
import { dbErrorCode, isTransientMigrationError } from "../db/dbWriteRetry";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as new (file: string, opts?: object) => DatabaseType;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const service = require("../databaseService").default;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const DatabaseServiceClass = require("../databaseService").DatabaseService ?? service.constructor;
const MIGRATIONS = DatabaseServiceClass.MIGRATIONS as Array<{
  version: number;
  description: string;
  migrate: (d: DatabaseType) => void;
}>;
const LATEST = MIGRATIONS[MIGRATIONS.length - 1].version;
const NEXT = LATEST + 1;

function openWithKey(file: string): DatabaseType {
  const db = new RealDatabase(file);
  db.pragma(`key = "x'${KEY}'"`);
  db.pragma("cipher_compatibility = 4");
  return db;
}

function version(db: DatabaseType): number {
  return (db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number }).version;
}

/** A real SQLITE_FULL: cap the page count at the current size, then grow. */
function throwRealFull(d: DatabaseType): never {
  d.exec("CREATE TABLE IF NOT EXISTS full_2834 (b BLOB)");
  const pages = d.pragma("page_count", { simple: true }) as number;
  d.pragma(`max_page_count = ${pages}`);
  d.prepare("INSERT INTO full_2834 VALUES (randomblob(1000000))").run();
  throw new Error("unreachable: SQLITE_FULL expected");
}

/** A real SQLITE_ERROR: a migration bug. */
function throwRealError(d: DatabaseType): never {
  d.exec("INSERT INTO no_such_table_2834 VALUES (1)");
  throw new Error("unreachable: SQLITE_ERROR expected");
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

describeUnlessWindows("BACKLOG-2834/2836 real driver — a failed migration at startup", () => {
  jest.setTimeout(120_000);
  let tmpDir: string;
  let dbFile: string;
  let calls: number;

  /** Real migrated DB at LATEST with one seeded row, closed; then v NEXT pushed. */
  async function arrange(migrate: (d: DatabaseType) => void): Promise<void> {
    await reset();
    await expect(service.initialize()).resolves.toBe(true);
    service.getRawDatabase().exec("CREATE TABLE seed_2834 (v TEXT); INSERT INTO seed_2834 VALUES ('kept');");
    await reset();
    calls = 0;
    MIGRATIONS.push({
      version: NEXT,
      description: "BACKLOG-2834 test migration",
      migrate: (d) => {
        calls++;
        migrate(d);
      },
    });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-2834-"));
    mockUserData.dir = tmpDir;
    dbFile = path.join(tmpDir, "mad.db");
    mockShowMessageBox.mockReset();
    mockQuit.mockReset();
    mockRelaunch.mockReset();
    mockExit.mockReset();
    mockCaptureException.mockReset();
  });

  afterEach(async () => {
    while (MIGRATIONS.length && MIGRATIONS[MIGRATIONS.length - 1].version > LATEST) MIGRATIONS.pop();
    await reset();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("C1 deterministic failure: restored, not retried, startup rejects, Quit leaves the data and a failure record", async () => {
    await arrange(throwRealError);
    mockShowMessageBox.mockResolvedValue({ response: 0 }); // Quit

    await expect(service.initialize({ quitOnUnrecoverableFailure: true })).rejects.toThrow();
    expect(calls).toBe(1);
    expect(mockQuit).toHaveBeenCalledTimes(1);
    expect(mockRelaunch).not.toHaveBeenCalled();
    expect(service.isInitialized()).toBe(false);
    expect(connIsInitialized()).toBe(false);

    const db = openWithKey(dbFile);
    try {
      expect(version(db)).toBe(LATEST);
      expect(db.prepare("SELECT v FROM seed_2834").get()).toEqual({ v: "kept" });
      const rec = db
        .prepare("SELECT operation, error_message, metadata FROM failure_log WHERE operation = 'migration'")
        .all() as Array<{ operation: string; error_message: string; metadata: string }>;
      expect(rec).toHaveLength(1);
      const meta = JSON.parse(rec[0].metadata);
      expect(meta).toMatchObject({ migrationVersion: NEXT, code: "SQLITE_ERROR" });
      expect(rec[0].error_message).toContain("no such table");
    } finally {
      db.close();
    }
  });

  it("C2 transient failure that clears: re-run once on the restored file, starts at the new version, no dialog", async () => {
    await arrange((d) => {
      if (calls === 1) throwRealFull(d);
      d.exec("CREATE TABLE IF NOT EXISTS migrated_2834 (x INTEGER)");
    });

    await expect(service.initialize({ quitOnUnrecoverableFailure: true })).resolves.toBe(true);
    expect(calls).toBe(2);
    expect(mockShowMessageBox).not.toHaveBeenCalled();
    expect(service.isInitialized()).toBe(true);
    expect(connIsInitialized()).toBe(true);
    const db = service.getRawDatabase() as DatabaseType;
    expect(version(db)).toBe(NEXT);
    expect(db.prepare("SELECT v FROM seed_2834").get()).toEqual({ v: "kept" });
  });

  it("C3 transient failure that does not clear: exactly one retry, then the two-button choice", async () => {
    // Fails on calls 1-3 and succeeds from call 4, so an unbounded retry
    // finishes (resolves, calls = 4) and reds here instead of hanging the run.
    await arrange((d) => {
      if (calls <= 3) throwRealFull(d);
      d.exec("CREATE TABLE IF NOT EXISTS migrated_2834 (x INTEGER)");
    });
    mockShowMessageBox.mockResolvedValue({ response: 0 }); // Quit

    await expect(service.initialize({ quitOnUnrecoverableFailure: true })).rejects.toThrow();
    expect(calls).toBe(2);
    expect(mockShowMessageBox).toHaveBeenCalledTimes(1);
    const opts = mockShowMessageBox.mock.calls[0][mockShowMessageBox.mock.calls[0].length - 1];
    expect(opts.buttons).toEqual(["Quit", "Start fresh"]);
    // Esc / closing the window means Quit, never Start fresh.
    expect(opts).toMatchObject({ defaultId: 0, cancelId: 0 });
    expect(mockQuit).toHaveBeenCalledTimes(1);
  });

  it("C4 Start fresh moves the database aside (never deletes) and it still opens with the same key", async () => {
    await arrange(throwRealError);
    mockShowMessageBox
      .mockResolvedValueOnce({ response: 1 }) // Start fresh
      .mockResolvedValueOnce({ response: 1 }); // confirm

    await expect(service.initialize({ quitOnUnrecoverableFailure: true })).rejects.toThrow();
    expect(mockShowMessageBox).toHaveBeenCalledTimes(2);
    const confirm = mockShowMessageBox.mock.calls[1][mockShowMessageBox.mock.calls[1].length - 1];
    expect(confirm).toMatchObject({ buttons: ["Go back", "Start fresh"], defaultId: 0, cancelId: 0 });
    expect(mockRelaunch).toHaveBeenCalledTimes(1);
    expect(mockQuit).not.toHaveBeenCalled();
    expect(fs.existsSync(dbFile)).toBe(false);
    expect(fs.existsSync(dbFile + "-wal")).toBe(false);

    const aside = fs.readdirSync(tmpDir).filter((f) => /^mad-unmigratable-.*\.db$/.test(f));
    expect(aside).toHaveLength(1);
    const db = openWithKey(path.join(tmpDir, aside[0]));
    try {
      expect(db.prepare("SELECT v FROM seed_2834").get()).toEqual({ v: "kept" });
      expect(version(db)).toBe(LATEST);
    } finally {
      db.close();
    }
  });

  it("C5 (2836) the database is not published while migrations run", async () => {
    const seen: Array<{ svc: boolean; conn: boolean; raw: string }> = [];
    await arrange((d) => {
      let raw = "readable";
      try {
        service.getRawDatabase();
      } catch (e) {
        raw = (e as Error).name;
      }
      seen.push({ svc: service.isInitialized(), conn: connIsInitialized(), raw });
      d.exec("CREATE TABLE IF NOT EXISTS migrated_2834 (x INTEGER)");
    });

    await expect(service.initialize({ quitOnUnrecoverableFailure: true })).resolves.toBe(true);
    expect(seen).toEqual([{ svc: false, conn: false, raw: "DatabaseError" }]);
    expect(service.isInitialized()).toBe(true);
    expect(connIsInitialized()).toBe(true);
  });

  it("C6 classifier: real errors, raw and as wrapped by the real runner", async () => {
    const caught: Record<string, unknown> = {};
    for (const [name, fn] of [
      ["full", throwRealFull],
      ["error", throwRealError],
      [
        "constraint",
        (d: DatabaseType) => {
          d.exec("CREATE TABLE u (x UNIQUE); INSERT INTO u VALUES (1); INSERT INTO u VALUES (1);");
        },
      ],
    ] as const) {
      // A fresh file per error: max_page_count stays set on a handle.
      const scratch = new RealDatabase(path.join(tmpDir, `scratch-${name}.db`));
      try {
        (fn as (d: DatabaseType) => void)(scratch);
      } catch (e) {
        caught[name] = e;
      } finally {
        scratch.close();
      }
    }
    expect(dbErrorCode(caught.full)).toBe("SQLITE_FULL");
    expect(dbErrorCode(caught.error)).toBe("SQLITE_ERROR");
    expect(dbErrorCode(caught.constraint)).toBe("SQLITE_CONSTRAINT_UNIQUE");
    expect(isTransientMigrationError(caught.full)).toBe(true);
    expect(isTransientMigrationError(caught.error)).toBe(false);
    expect(isTransientMigrationError(caught.constraint)).toBe(false);

    // As the runner wraps it (the object initialize()'s catch actually sees).
    // Bounded like C3, so an unbounded-retry build finishes instead of hanging.
    await arrange((d) => {
      if (calls <= 3) throwRealFull(d);
    });
    mockShowMessageBox.mockResolvedValue({ response: 0 });
    await service.initialize().catch(() => undefined);
    const runnerEvent = mockCaptureException.mock.calls.find(
      (c) => c[1]?.tags?.migration_failure === "true",
    );
    expect(runnerEvent).toBeDefined();
    expect(runnerEvent![1].tags.error_code).toBe("SQLITE_FULL");
    expect(isTransientMigrationError(runnerEvent![0])).toBe(true);
  });

  it("C8 a real SQLITE_BUSY inside a migration body goes to the 3952 wait path, not to restore", async () => {
    let holder: DatabaseType | null = null;
    await arrange((d) => {
      if (calls === 1) {
        // Another connection holds the write lock while the migration writes.
        holder = openWithKey(dbFile);
        holder.prepare("BEGIN IMMEDIATE").run();
      }
      d.exec("CREATE TABLE IF NOT EXISTS migrated_2834 (x INTEGER)");
    });
    // "Try again" — release the lock first, as the other program would.
    mockShowMessageBox.mockImplementation(async () => {
      if (holder) {
        holder.prepare("ROLLBACK").run();
        holder.close();
        holder = null;
      }
      return { response: 0 };
    });

    await expect(service.initialize({ quitOnUnrecoverableFailure: true })).resolves.toBe(true);
    expect(calls).toBe(2);
    expect(mockShowMessageBox).toHaveBeenCalledTimes(1);
    expect(mockShowMessageBox.mock.calls[0][mockShowMessageBox.mock.calls[0].length - 1].buttons).toEqual([
      "Try again",
      "Quit",
    ]);
    const notWritable = mockCaptureException.mock.calls.find((c) => c[1]?.tags?.db_not_writable === "true");
    expect(notWritable?.[1].tags.error_code).toMatch(/^SQLITE_BUSY/);
    expect(fs.readdirSync(tmpDir).filter((f) => f.startsWith("mad-pre-restore-"))).toHaveLength(0);
    expect(version(service.getRawDatabase() as DatabaseType)).toBe(NEXT);
  });

  it("C9 (SR-A) transient retry that clears: a db-ready waiter started during attempt 1 resolves ready:true, no error stage", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { initializationBroadcaster } = require("../initializationBroadcaster");
    let waiter: Promise<{ ready: boolean }> | null = null;
    const spy = jest.spyOn(initializationBroadcaster, "broadcast");
    await arrange((d) => {
      if (calls === 1) {
        waiter = initializationBroadcaster.whenDbReady(60_000);
        throwRealFull(d);
      }
      d.exec("CREATE TABLE IF NOT EXISTS migrated_2834 (x INTEGER)");
    });
    spy.mockClear();
    await expect(service.initialize({ quitOnUnrecoverableFailure: true })).resolves.toBe(true);
    expect(calls).toBe(2);
    const stages = spy.mock.calls.map((c) => (c[0] as { stage: string }).stage);
    spy.mockRestore();
    expect(waiter).not.toBeNull();
    await expect(waiter!).resolves.toMatchObject({ ready: true });
    expect(stages).not.toContain("error");
  });

  it("C10 (SR-B) transient that does not clear: two restores keep two distinct pre-restore copies", async () => {
    await arrange((d) => {
      if (calls <= 3) throwRealFull(d);
    });
    mockShowMessageBox.mockResolvedValue({ response: 0 });
    await expect(service.initialize({ quitOnUnrecoverableFailure: true })).rejects.toThrow();
    expect(calls).toBe(2);
    const kept = fs.readdirSync(tmpDir).filter((f) => /^mad-pre-restore-.*\.db$/.test(f));
    expect(kept).toHaveLength(2);
  });

  it("C11 (SR-C) Start fresh: the failure record travels with the moved file; no sidecar is left behind", async () => {
    await arrange(throwRealError);
    mockShowMessageBox.mockResolvedValueOnce({ response: 1 }).mockResolvedValueOnce({ response: 1 });
    await expect(service.initialize({ quitOnUnrecoverableFailure: true })).rejects.toThrow();
    for (const sfx of ["", "-wal", "-shm"]) expect(fs.existsSync(dbFile + sfx)).toBe(false);
    const aside = fs.readdirSync(tmpDir).filter((f) => /^mad-unmigratable-.*\.db$/.test(f));
    expect(aside).toHaveLength(1);
    const db = openWithKey(path.join(tmpDir, aside[0]));
    try {
      const rec = db.prepare("SELECT metadata FROM failure_log WHERE operation = 'migration'").all() as Array<{ metadata: string }>;
      expect(rec).toHaveLength(1);
      expect(JSON.parse(rec[0].metadata)).toMatchObject({ migrationVersion: NEXT, code: "SQLITE_ERROR" });
    } finally {
      db.close();
    }
  });

  it("C7 a non-startup caller (no quit flag) never gets Start fresh and never moves the file", async () => {
    await arrange(throwRealError);
    mockShowMessageBox.mockResolvedValue({ response: 1 });

    await expect(service.initialize()).rejects.toThrow();
    expect(mockRelaunch).not.toHaveBeenCalled();
    expect(mockQuit).not.toHaveBeenCalled();
    expect(fs.existsSync(dbFile)).toBe(true);
    expect(fs.readdirSync(tmpDir).filter((f) => f.startsWith("mad-unmigratable-"))).toHaveLength(0);
    for (const call of mockShowMessageBox.mock.calls) {
      const opts = call[call.length - 1];
      expect(opts.buttons ?? []).not.toContain("Start fresh");
    }
  });
});
