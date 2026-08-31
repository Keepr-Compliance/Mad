/**
 * DatabaseService Migration Auto-Restore Tests
 * TASK-2057: Tests for auto-restore behavior when database migrations fail
 *
 * Tests cover:
 * 1. Auto-restore triggered when runMigrations() throws
 * 2. Backup integrity check with encryption params
 * 3. Dialog shown after restore (success and failure)
 * 4. Sentry capture includes correct tags
 * 5. No-backup scenario (first run)
 * 6. Normal migration path unchanged (happy path)
 * 7. Corrupt backup scenario
 *
 * BACKLOG-2999: the unrecoverable branch (auto-restore recovered NOTHING) is
 * now TERMINAL -- initialize() rejects with MigrationRecoveryFailedError after
 * an AWAITED dialog, and quits only when the caller opted in. Eight tests below
 * drove that branch with a bare `await service.initialize()` and would have
 * gone red on the rejection alone. Every one of them KEEPS ALL OF ITS ORIGINAL
 * ASSERTIONS and gains only `expectTerminalRejection()`; nothing was deleted,
 * loosened or skipped. The single exception is documented in place: the old
 * `"should not crash the app (returns true)"` asserted the defect itself and is
 * INVERTED IN PLACE, keeping its surviving intent ("must not fail in an
 * UNCONTROLLED way") as a TYPED rejection assertion.
 */

// ---- Mock setup (must be before imports) ----

// Mock fs
const mockExistsSync = jest.fn();
const mockCopyFileSync = jest.fn();
const mockMkdirSync = jest.fn();
const mockReaddirSync = jest.fn();
const mockReadFileSync = jest.fn();
const mockStatSync = jest.fn();
const mockOpenSync = jest.fn();
const mockWriteSync = jest.fn();
const mockFsyncSync = jest.fn();
const mockCloseSync = jest.fn();
const mockUnlinkSync = jest.fn();
jest.mock("fs", () => ({
  existsSync: mockExistsSync,
  copyFileSync: mockCopyFileSync,
  mkdirSync: mockMkdirSync,
  readdirSync: mockReaddirSync,
  readFileSync: mockReadFileSync,
  statSync: mockStatSync,
  openSync: mockOpenSync,
  writeSync: mockWriteSync,
  fsyncSync: mockFsyncSync,
  closeSync: mockCloseSync,
  unlinkSync: mockUnlinkSync,
}));

// Mock path
jest.mock("path", () => ({
  join: (...args: string[]) => args.join("/"),
  dirname: (p: string) => {
    const parts = p.split("/");
    parts.pop();
    return parts.join("/");
  },
  basename: (p: string, ext?: string) => {
    const base = p.split("/").pop() || p;
    if (ext && base.endsWith(ext)) {
      return base.slice(0, -ext.length);
    }
    return base;
  },
  resolve: (p: string) => p,
}));

// Mock electron (app and dialog)
const mockGetPath = jest.fn();
const mockIsReady = jest.fn();
const mockWhenReady = jest.fn();
const mockShowMessageBox = jest.fn();
const mockQuit = jest.fn();
jest.mock("electron", () => ({
  app: {
    getPath: mockGetPath,
    isReady: mockIsReady,
    whenReady: mockWhenReady,
    quit: mockQuit,
  },
  dialog: {
    showMessageBox: mockShowMessageBox,
  },
}));

// Mock Sentry
const mockCaptureException = jest.fn();
jest.mock("@sentry/electron/main", () => ({
  captureException: mockCaptureException,
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
}));

// Mock logService
jest.mock("../logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock databaseEncryptionService
const mockGetEncryptionKey = jest.fn();
const mockInitializeEncryption = jest.fn();
const mockIsDatabaseEncrypted = jest.fn();
jest.mock("../databaseEncryptionService", () => ({
  databaseEncryptionService: {
    getEncryptionKey: mockGetEncryptionKey,
    initialize: mockInitializeEncryption,
    isDatabaseEncrypted: mockIsDatabaseEncrypted,
  },
}));

// Mock dbConnection module
const mockSetDb = jest.fn();
const mockSetDbPath = jest.fn();
const mockSetEncryptionKey = jest.fn();
const mockCloseDb = jest.fn();
const mockVacuumDb = jest.fn();
jest.mock("../db/core/dbConnection", () => ({
  setDb: mockSetDb,
  setDbPath: mockSetDbPath,
  setEncryptionKey: mockSetEncryptionKey,
  closeDb: mockCloseDb,
  vacuumDb: mockVacuumDb,
}));

// Mock better-sqlite3-multiple-ciphers
const mockDbClose = jest.fn();
const mockDbPragma = jest.fn();
const mockDbExec = jest.fn();
const mockDbPrepare = jest.fn();
const mockDbTransaction = jest.fn();

function createMockDbInstance() {
  return {
    close: mockDbClose,
    pragma: mockDbPragma,
    exec: mockDbExec,
    prepare: mockDbPrepare,
    transaction: mockDbTransaction,
  };
}

const MockDatabase = jest.fn().mockImplementation(() => createMockDbInstance());
jest.mock("better-sqlite3-multiple-ciphers", () => MockDatabase);

// ---- Import after mocks ----
import databaseService from "../databaseService";
// Imported from the module that DEFINES it (not the ../types barrel) so the
// class identity `instanceof` compares against is unambiguously the same one
// databaseService throws.
import { MigrationRecoveryFailedError } from "../../types/database";

describe("DatabaseService Migration Auto-Restore (TASK-2057)", () => {
  // Store original state so we can reset between tests
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let service: any;

  beforeEach(() => {
    jest.clearAllMocks();

    // Get the singleton and reset its internal state
    service = databaseService;
    // Reset private fields using bracket notation
    service["db"] = null;
    service["dbPath"] = null;
    service["encryptionKey"] = null;

    // Default mock setups
    mockGetPath.mockReturnValue("/mock/userData");
    mockIsReady.mockReturnValue(true);
    mockWhenReady.mockResolvedValue(undefined);
    mockGetEncryptionKey.mockResolvedValue("abcdef1234567890");
    mockInitializeEncryption.mockResolvedValue(undefined);
    mockIsDatabaseEncrypted.mockResolvedValue(true); // Already encrypted, no migration needed
    mockExistsSync.mockReturnValue(true);
    mockCloseDb.mockResolvedValue(undefined);
    mockShowMessageBox.mockResolvedValue({ response: 0 });

    // Schema file read
    mockReadFileSync.mockReturnValue("CREATE TABLE IF NOT EXISTS test (id INTEGER);");

    // Default: one backup file so that _runVersionedMigrations() satisfies its
    // pre-migration-backup guard (added for v42).  Tests that need the no-backup
    // path (e.g. "first run", "app readiness") override this in their own beforeEach.
    mockReaddirSync.mockReturnValue(["mad-backup-20260222T100000.db"]);

    // Reset mockDbExec implementation so stale "throw on call #2" closures from
    // the migration-failure describe blocks do not bleed into snapshot tests.
    // Inner beforeEach blocks that need a throwing exec re-apply it themselves.
    mockDbExec.mockReset();

    // BACKLOG-2999: same hazard, same fix, for the copy. jest.clearAllMocks()
    // clears calls but NOT implementations, so ROUTE 3's throwing copy leaked
    // into ROUTE 4 and made it silently exercise route 3 instead -- it passed
    // its status assertions for the wrong reason. Caught by the setDb count.
    mockCopyFileSync.mockReset();

    // Database pragma mocking -- handle cipher_integrity_check
    mockDbPragma.mockImplementation((pragma: string) => {
      if (pragma.includes("integrity_check")) {
        return [{ integrity_check: "ok" }];
      }
      if (pragma.includes("wal_checkpoint")) {
        return undefined;
      }
      return undefined;
    });

    // schema_version table handling
    mockDbPrepare.mockImplementation((sql: string) => {
      if (sql.includes("sqlite_master") && sql.includes("schema_version")) {
        return { get: jest.fn().mockReturnValue({ name: "schema_version" }) };
      }
      if (sql.includes("PRAGMA table_info")) {
        return {
          all: jest.fn().mockReturnValue([
            { name: "id" },
            { name: "version" },
            { name: "updated_at" },
            { name: "migrated_at" },
          ]),
        };
      }
      if (sql.includes("SELECT version FROM schema_version")) {
        // BACKLOG-2993: the baseline. The schema-baseline fence refuses any
        // version below it before runMigrations is reached, so this suite's
        // auto-restore machinery is exercised on a post-baseline database —
        // the only kind that can still reach a migration failure.
        return {
          get: jest.fn().mockReturnValue({
            version: (service.constructor as { BASELINE_VERSION: number })
              .BASELINE_VERSION,
          }),
        };
      }
      if (sql.includes("SELECT 1")) {
        return { get: jest.fn().mockReturnValue({ ok: 1 }) };
      }
      return { get: jest.fn(), all: jest.fn().mockReturnValue([]), run: jest.fn() };
    });

    // Transaction mock that executes the callback
    mockDbTransaction.mockImplementation((fn: () => void) => {
      return () => fn();
    });
  });

  /**
   * BACKLOG-2999 -- drive initialize() to its terminal branch and pin the
   * rejection by TYPE, not merely that "something threw".
   *
   * A bare `rejects.toThrow()` here would be a control whose inputs cannot
   * separate the fix from a crash: a leaked TypeError out of the restore path
   * would satisfy it. Asserting the class AND the code preserves the surviving
   * intent of the test this replaces -- a migration failure must not take the
   * app down in an UNCONTROLLED way.
   */
  async function expectTerminalRejection(options?: {
    quitOnUnrecoverableFailure?: boolean;
  }): Promise<MigrationRecoveryFailedError> {
    let caught: unknown;
    try {
      await service.initialize(options);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MigrationRecoveryFailedError);
    expect((caught as MigrationRecoveryFailedError).code).toBe(
      "MIGRATION_RECOVERY_FAILED",
    );
    return caught as MigrationRecoveryFailedError;
  }

  describe("Happy path (no migration failure)", () => {
    it("should complete initialization without showing dialog when migrations succeed", async () => {
      const result = await service.initialize();

      expect(result).toBe(true);
      expect(mockShowMessageBox).not.toHaveBeenCalled();
      expect(mockCaptureException).not.toHaveBeenCalled();
    });

    it("should set shared references after successful initialization", async () => {
      await service.initialize();

      expect(mockSetDb).toHaveBeenCalled();
      expect(mockSetDbPath).toHaveBeenCalledWith("/mock/userData/mad.db");
      expect(mockSetEncryptionKey).toHaveBeenCalledWith("abcdef1234567890");
    });
  });

  describe("Pre-migration backup keyed to migration events (S5, BACKLOG-1772)", () => {
    // Re-point the schema_version query at an arbitrary on-disk version while
    // preserving every other prepare() branch from the outer beforeEach.
    function seedOnDiskVersion(version: number): void {
      mockDbPrepare.mockImplementation((sql: string) => {
        if (sql.includes("sqlite_master") && sql.includes("schema_version")) {
          return { get: jest.fn().mockReturnValue({ name: "schema_version" }) };
        }
        if (sql.includes("PRAGMA table_info")) {
          return {
            all: jest.fn().mockReturnValue([
              { name: "id" },
              { name: "version" },
              { name: "updated_at" },
              { name: "migrated_at" },
            ]),
          };
        }
        if (sql.includes("SELECT version FROM schema_version")) {
          return { get: jest.fn().mockReturnValue({ version }) };
        }
        if (sql.includes("SELECT 1")) {
          return { get: jest.fn().mockReturnValue({ ok: 1 }) };
        }
        return { get: jest.fn(), all: jest.fn().mockReturnValue([]), run: jest.fn() };
      });
    }

    /** Count copyFileSync calls whose destination is a rolling `-backup-` file. */
    function rollingBackupCopies(): number {
      return mockCopyFileSync.mock.calls.filter((c) =>
        String(c[1]).includes("-backup-"),
      ).length;
    }

    it("creates a rolling pre-migration backup when a migration WILL run (on-disk version behind latest)", async () => {
      // BACKLOG-2993: nothing below the baseline can pass the fence, so
      // "behind latest" now means a FUTURE migration above the baseline.
      // Inject one; the runner and the S5 backup gate treat it exactly as
      // they treated the old chain.
      const klass = service.constructor as {
        MIGRATIONS: Array<{ version: number; description: string; migrate: (d: unknown) => void }>;
        BASELINE_VERSION: number;
      };
      const baseline = klass.BASELINE_VERSION;
      const original = klass.MIGRATIONS;
      klass.MIGRATIONS = [
        ...original,
        { version: baseline + 1, description: "future test migration", migrate: () => undefined },
      ];
      try {
        seedOnDiskVersion(baseline); // behind the injected future head → willRunMigration = true

        const result = await service.initialize();

        expect(result).toBe(true);
        expect(rollingBackupCopies()).toBeGreaterThan(0);
      } finally {
        klass.MIGRATIONS = original;
      }
    });

    it("SKIPS the rolling pre-migration backup when the DB is already at the latest version", async () => {
      // Latest migration version, so no migration runs and no backup is needed
      // (previously every launch copied the DB and churned the 3-file window).
      // BACKLOG-2993: "latest" is the baseline — the chain is gone.
      const latest = (service.constructor as { BASELINE_VERSION: number })
        .BASELINE_VERSION;
      seedOnDiskVersion(latest);

      const result = await service.initialize();

      expect(result).toBe(true);
      expect(rollingBackupCopies()).toBe(0);
    });
  });

  describe("Migration failure with successful auto-restore", () => {
    beforeEach(() => {
      // Make runMigrations throw by having schema.sql execution fail
      // We need a more targeted approach: make the migration throw
      // during the try block inside initialize()

      // Backup files exist
      mockReaddirSync.mockReturnValue([
        "mad-backup-20260222T100000.db",
        "mad-backup-20260221T100000.db",
      ]);

      // Track call count for mockDbExec to fail on schema.sql exec.
      // Call 1 = _ensureFailureLogTable() safety check (caught internally),
      // Call 2 = schema.sql in runMigrations() -- this is the migration we want to fail.
      let execCallCount = 0;
      mockDbExec.mockImplementation(() => {
        execCallCount++;
        if (execCallCount === 2) {
          // Second exec is schema.sql -- make it throw to simulate migration failure
          throw new Error("Migration SQL syntax error");
        }
      });
    });

    it("should restore from backup when migration fails", async () => {
      const result = await service.initialize();

      expect(result).toBe(true);
      // Backup was copied over the main db
      expect(mockCopyFileSync).toHaveBeenCalled();
    });

    it("should show warning dialog on successful restore", async () => {
      await service.initialize();

      expect(mockShowMessageBox).toHaveBeenCalledTimes(1);
      expect(mockShowMessageBox).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "warning",
          title: "Database Update Notice",
          message: expect.stringContaining("restored"),
        })
      );
    });

    it("should report to Sentry with correct tags on successful restore", async () => {
      await service.initialize();

      expect(mockCaptureException).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: expect.objectContaining({
            migration_failure: "true",
            auto_restore: "succeeded",
            backup_integrity: "valid",
          }),
        })
      );
    });

    it("should update shared references after restore", async () => {
      await service.initialize();

      // setDb should be called at least twice: once during initial init, once after restore
      expect(mockSetDb.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(mockSetDbPath).toHaveBeenCalledWith("/mock/userData/mad.db");
      expect(mockSetEncryptionKey).toHaveBeenCalledWith("abcdef1234567890");
    });

    it("should verify backup integrity with encryption params before restore", async () => {
      await service.initialize();

      // Database constructor should be called with readonly for integrity check
      const readonlyCalls = MockDatabase.mock.calls.filter(
        (call: unknown[]) => call.length > 1 && (call[1] as { readonly?: boolean })?.readonly === true
      );
      expect(readonlyCalls.length).toBeGreaterThanOrEqual(1);

      // Pragma should include key and cipher_compatibility
      expect(mockDbPragma).toHaveBeenCalledWith(
        expect.stringContaining("key")
      );
    });

    /**
     * BACKLOG-2999 / BACKLOG-2834 BOUNDARY -- green today BY DESIGN. The
     * discriminator is `mockQuit` NOT being called even though quitting is
     * ENABLED here: that is what stops a later change silently widening the
     * terminal path to cover a branch that did recover the user's data.
     * Re-running migrations against the restored file is BACKLOG-2834's
     * subject and is deliberately NOT fixed here.
     */
    it("BOUNDARY (BACKLOG-2834): a SUCCESSFUL restore is not terminal -- resolves true, stays initialized, never quits", async () => {
      const result = await service.initialize({ quitOnUnrecoverableFailure: true });

      expect(result).toBe(true);
      expect(mockQuit).not.toHaveBeenCalled();
      expect(service.isInitialized()).toBe(true);
      expect(mockShowMessageBox).toHaveBeenCalledWith(
        expect.objectContaining({ type: "warning", title: "Database Update Notice" }),
      );
    });
  });

  describe("Migration failure with no backup (first run)", () => {
    beforeEach(() => {
      // No backup files
      mockReaddirSync.mockReturnValue([]);

      // Make migration fail
      mockDbExec.mockImplementation(() => {
        throw new Error("Migration failed on first run");
      });
    });

    it("should show error dialog when no backup exists", async () => {
      await expectTerminalRejection();

      expect(mockShowMessageBox).toHaveBeenCalledTimes(1);
      expect(mockShowMessageBox).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          title: "Database Update Failed",
          message: expect.stringContaining("could not be automatically fixed"),
        })
      );
      // BACKLOG-2999 (Amendment 8): the copy still says "contact support /
      // manual recovery" -- deliberately NOT the cleanup scripts the
      // BACKLOG-2993 refusal points at, which would destroy data that may
      // still be recoverable -- and now names the file support will ask for.
      const dialogArg = mockShowMessageBox.mock.calls[0][0] as { detail: string };
      expect(dialogArg.detail).toContain("manual recovery");
      expect(dialogArg.detail).toContain("/mock/userData/mad.db");
    });

    it("should report to Sentry with no_backup tag", async () => {
      await expectTerminalRejection();

      // BACKLOG-2999: MEASURED, not guessed. runMigrations captures at
      // databaseService.ts:1065 before re-throwing, then initialize()'s inner
      // catch captures again -- so this path was already 2 BEFORE the fix, and
      // is still 2 after it. Measured both ways with a deliberately-failing
      // toHaveBeenCalledTimes(0) on 2026-08-30: "Received number of calls: 2"
      // at 02722a293 and on this branch. This assertion exists to prove the
      // terminal throw does NOT add a third via the outer catch.
      expect(mockCaptureException).toHaveBeenCalledTimes(2);

      expect(mockCaptureException).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: expect.objectContaining({
            migration_failure: "true",
            auto_restore: "no_backup",
            backup_integrity: "missing",
          }),
        })
      );
    });

    // BACKLOG-2999 -- INVERTED IN PLACE (was: "should not crash the app
    // (returns true)"). The old title showed its author equating "does not
    // crash" with "returns true"; this item reverses the second half of that
    // product decision on the unrecoverable branch only. The first half
    // survives, as the TYPED rejection inside expectTerminalRejection().
    it("refuses to report success when nothing was recovered -- rejects, does not initialize, quits", async () => {
      const error = await expectTerminalRejection({
        quitOnUnrecoverableFailure: true,
      });

      // The error carries WHY, for the caller and for Sentry.
      expect(error.autoRestoreStatus).toBe("no_backup");
      expect(error.backupIntegrity).toBe("missing");

      // Nothing is left readable through EITHER predicate the app gates on.
      expect(service.isInitialized()).toBe(false);
      expect(mockCloseDb).toHaveBeenCalled();

      // And the app stops, rather than opening on the broken database.
      expect(mockQuit).toHaveBeenCalledTimes(1);
    });
  });

  describe("Migration failure with corrupt backup", () => {
    beforeEach(() => {
      // Backup files exist
      mockReaddirSync.mockReturnValue([
        "mad-backup-20260222T100000.db",
      ]);

      // Make migration fail.
      // Call 1 = _ensureFailureLogTable() safety check (caught internally),
      // Call 2 = schema.sql in runMigrations() -- this is the migration we want to fail.
      let execCallCount = 0;
      mockDbExec.mockImplementation(() => {
        execCallCount++;
        if (execCallCount === 2) {
          throw new Error("Migration failed");
        }
      });

      // Make integrity check fail for backup (corrupt file)
      mockDbPragma.mockImplementation((pragma: string) => {
        if (pragma.includes("integrity_check")) {
          return [{ integrity_check: "page 1: btree cell count mismatch" }];
        }
        return undefined;
      });
    });

    it("should show error dialog when backup is corrupt", async () => {
      await expectTerminalRejection();

      expect(mockShowMessageBox).toHaveBeenCalledTimes(1);
      expect(mockShowMessageBox).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          title: "Database Update Failed",
        })
      );
    });

    it("should report to Sentry with corrupt backup tag", async () => {
      await expectTerminalRejection();

      expect(mockCaptureException).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: expect.objectContaining({
            migration_failure: "true",
            auto_restore: "failed",
            backup_integrity: "corrupt",
          }),
        })
      );
    });

    it("should not attempt to copy corrupt backup over database", async () => {
      await expectTerminalRejection();

      // copyFileSync should only be called for the pre-migration backup, not for restore
      const restoreCalls = mockCopyFileSync.mock.calls.filter(
        (call: string[]) => call[0]?.includes("backup") && call[1]?.includes("mad.db")
      );
      expect(restoreCalls.length).toBe(0);
    });
  });

  describe("App readiness check", () => {
    beforeEach(() => {
      // Make migration fail
      mockDbExec.mockImplementation(() => {
        throw new Error("Migration failed");
      });
      mockReaddirSync.mockReturnValue([]);
    });

    it("should wait for app.whenReady() if app is not ready", async () => {
      mockIsReady.mockReturnValue(false);

      await expectTerminalRejection();

      expect(mockWhenReady).toHaveBeenCalled();
      expect(mockShowMessageBox).toHaveBeenCalled();
    });

    it("should not call whenReady if app is already ready", async () => {
      mockIsReady.mockReturnValue(true);

      await expectTerminalRejection();

      expect(mockWhenReady).not.toHaveBeenCalled();
      expect(mockShowMessageBox).toHaveBeenCalled();
    });
  });

  /**
   * BACKLOG-2999 -- the terminal branch, swept rather than sampled.
   *
   * `restored === false` is reached by FOUR routes. Two were already covered
   * in THIS file (no backup, corrupt backup) and both leave the ORIGINAL
   * handle open. The two below leave materially different wreckage and were
   * the reason the old `return true` was worse than it looked; one input per
   * branch cannot catch this.
   *
   * CORRECTION, recorded because I first wrote the opposite: these two routes
   * are NOT untested repo-wide. databaseService.test.ts's
   * "Migration Failure Auto-Restore (TASK-2057/2075)" describe drives both
   * ("restore file copy failure" and "should report failure when post-restore
   * SELECT 1 fails") -- it asserted the DIALOG on each, never the outcome.
   * They were unswept in this file only. The rows below add the outcome.
   */
  describe("Terminal branch -- the two routes this file never drove", () => {
    /** Migration fails on the schema.sql exec (call 2), with a valid backup present. */
    function failMigrationWithGoodBackup(): void {
      mockReaddirSync.mockReturnValue(["mad-backup-20260222T100000.db"]);
      let execCallCount = 0;
      mockDbExec.mockImplementation(() => {
        execCallCount++;
        if (execCallCount === 2) throw new Error("Migration SQL syntax error");
      });
    }

    it("ROUTE 3 -- the restore COPY throws: rejects instead of reporting success over a database that is not open at all", async () => {
      failMigrationWithGoodBackup();
      // Only the restore copy fails; its destination is the live database.
      // _attemptAutoRestore has ALREADY closed and nulled this.db by then and
      // never reassigns it, so before BACKLOG-2999 initialize() returned true
      // with this.db === null and dbConnection still holding a closed handle.
      mockCopyFileSync.mockImplementation((_src: string, dest: string) => {
        if (String(dest).endsWith("mad.db")) {
          throw new Error("ENOSPC: no space left on device");
        }
      });

      const error = await expectTerminalRejection({ quitOnUnrecoverableFailure: true });

      expect(error.autoRestoreStatus).toBe("failed");
      expect(error.backupIntegrity).toBe("valid");
      expect(service.isInitialized()).toBe(false);
      expect(mockQuit).toHaveBeenCalledTimes(1);
    });

    it("ROUTE 4 -- the post-restore PROBE fails: tears down the handle the restore already published to every consumer", async () => {
      failMigrationWithGoodBackup();
      // The copy succeeds and _attemptAutoRestore assigns this.db AND calls
      // setDb(newDb) BEFORE probing. On a probe failure it returns
      // restored:false with both already published -- so pre-fix this was the
      // worst of the four routes: initialize() returned true and all 46
      // isInitialized() call sites saw a perfectly initialized database.
      mockDbPrepare.mockImplementation((sql: string) => {
        if (sql.includes("sqlite_master") && sql.includes("schema_version")) {
          return { get: jest.fn().mockReturnValue({ name: "schema_version" }) };
        }
        if (sql.includes("SELECT version FROM schema_version")) {
          return {
            get: jest.fn().mockReturnValue({
              version: (service.constructor as { BASELINE_VERSION: number }).BASELINE_VERSION,
            }),
          };
        }
        // THE MUTATION THAT MATTERS: the connectivity probe comes back empty.
        if (sql.includes("SELECT 1")) {
          return { get: jest.fn().mockReturnValue(undefined) };
        }
        return { get: jest.fn(), all: jest.fn().mockReturnValue([]), run: jest.fn() };
      });

      const error = await expectTerminalRejection({ quitOnUnrecoverableFailure: true });

      expect(error.autoRestoreStatus).toBe("failed");
      expect(error.backupIntegrity).toBe("valid");
      // The restored handle really was published to consumers first...
      expect(mockSetDb.mock.calls.length).toBeGreaterThanOrEqual(2);
      // ...and the terminal branch takes it back through BOTH predicates.
      expect(mockCloseDb).toHaveBeenCalled();
      expect(service.isInitialized()).toBe(false);
      expect(mockQuit).toHaveBeenCalledTimes(1);
    });

    /**
     * THE AWAITED-DIALOG CONTROL. A deferred promise is the ONLY thing that
     * discriminates here: `mock.invocationCallOrder` is identical with and
     * without the `await` (showMessageBox is invoked first either way, quit
     * second), so an ordering assertion could not separate pass from fail. Do
     * not "simplify" this back to call order.
     */
    it("AWAITS the dialog before quitting -- the user is told BEFORE the app exits", async () => {
      mockReaddirSync.mockReturnValue([]);
      mockDbExec.mockImplementation(() => {
        throw new Error("Migration failed on first run");
      });

      let openTheDialog!: (value: unknown) => void;
      mockShowMessageBox.mockReturnValue(
        new Promise((resolve) => {
          openTheDialog = resolve;
        }),
      );

      // Settle-tracking rather than a bare await, so a dropped `await` in the
      // implementation surfaces as an assertion failure here instead of an
      // unhandled rejection somewhere else in the run.
      const settled: unknown[] = [];
      const initPromise = service
        .initialize({ quitOnUnrecoverableFailure: true })
        .then(
          (v: unknown) => { settled.push(v); return v; },
          (e: unknown) => { settled.push(e); return e; },
        );

      // setTimeout(0), not setImmediate -- the latter is not defined in this
      // test environment. No fake timers are installed in this suite.
      await new Promise((r) => setTimeout(r, 0));

      // Dialog still open: nothing may have happened yet.
      expect(mockShowMessageBox).toHaveBeenCalledTimes(1);
      expect(mockQuit).not.toHaveBeenCalled();
      expect(settled).toHaveLength(0);

      openTheDialog({ response: 0 });
      const outcome = await initPromise;

      expect(outcome).toBeInstanceOf(MigrationRecoveryFailedError);
      expect(mockQuit).toHaveBeenCalledTimes(1);
    });

    /**
     * THE FLAG IS NOT THE FIX -- THE THROW IS. The default is the
     * non-destructive one: a caller that forgets the argument (notably
     * sqliteBackupService, which calls initialize() from inside its own
     * safety-copy recovery) still gets the rejection, and must NOT get a quit
     * that would tear the process down mid-recovery.
     */
    it("does NOT quit by default -- the rejection still happens, the exit does not", async () => {
      mockReaddirSync.mockReturnValue([]);
      mockDbExec.mockImplementation(() => {
        throw new Error("Migration failed on first run");
      });

      await expectTerminalRejection(); // no options at all

      expect(mockQuit).not.toHaveBeenCalled();
      expect(mockShowMessageBox).toHaveBeenCalledTimes(1);
      expect(service.isInitialized()).toBe(false);
    });
  });

  describe("Backup integrity verification", () => {
    it("should return false for non-existent backup file", () => {
      mockExistsSync.mockReturnValue(false);

      const result = service["_verifyBackupIntegrity"]("/nonexistent.db", "key123");

      expect(result).toBe(false);
    });

    it("should return true for valid backup with ok integrity check", () => {
      mockExistsSync.mockReturnValue(true);
      mockDbPragma.mockImplementation((pragma: string) => {
        if (pragma.includes("integrity_check")) {
          return [{ integrity_check: "ok" }];
        }
        return undefined;
      });

      const result = service["_verifyBackupIntegrity"]("/valid-backup.db", "key123");

      expect(result).toBe(true);
    });

    it("should return false when Database constructor throws", () => {
      mockExistsSync.mockReturnValue(true);
      MockDatabase.mockImplementationOnce(() => {
        throw new Error("Cannot open file");
      });

      const result = service["_verifyBackupIntegrity"]("/bad-file.db", "key123");

      expect(result).toBe(false);
    });

    it("should return false when integrity check returns non-ok", () => {
      mockExistsSync.mockReturnValue(true);
      mockDbPragma.mockImplementation((pragma: string) => {
        if (pragma.includes("integrity_check")) {
          return [{ integrity_check: "page 1 error" }];
        }
        return undefined;
      });

      const result = service["_verifyBackupIntegrity"]("/corrupt.db", "key123");

      expect(result).toBe(false);
    });

    it("should close test database even on failure", () => {
      mockExistsSync.mockReturnValue(true);
      mockDbPragma.mockImplementation((pragma: string) => {
        if (pragma.includes("integrity_check")) {
          return [{ integrity_check: "ok" }];
        }
        return undefined;
      });

      service["_verifyBackupIntegrity"]("/test.db", "key123");

      expect(mockDbClose).toHaveBeenCalled();
    });

    it("should open backup with encryption key and cipher_compatibility", () => {
      mockExistsSync.mockReturnValue(true);
      mockDbPragma.mockImplementation((pragma: string) => {
        if (pragma.includes("integrity_check")) {
          return [{ integrity_check: "ok" }];
        }
        return undefined;
      });

      service["_verifyBackupIntegrity"]("/test.db", "testkey123");

      // Verify constructor called with readonly
      expect(MockDatabase).toHaveBeenCalledWith("/test.db", { readonly: true });

      // Verify encryption pragmas were called
      expect(mockDbPragma).toHaveBeenCalledWith(
        expect.stringContaining("testkey123")
      );
      expect(mockDbPragma).toHaveBeenCalledWith("cipher_compatibility = 4");
    });
  });

  describe("_attemptAutoRestore edge cases", () => {
    beforeEach(() => {
      // Set up internal state as if initialize() had progressed past key retrieval
      service["dbPath"] = "/mock/userData/mad.db";
      service["encryptionKey"] = "abcdef1234567890";
      service["db"] = createMockDbInstance();
    });

    it("should return no_backup when dbPath is null", async () => {
      service["dbPath"] = null;

      const result = await service["_attemptAutoRestore"](new Error("test"));

      expect(result).toEqual({
        restored: false,
        autoRestoreStatus: "no_backup",
        backupIntegrity: "missing",
      });
    });

    it("should return no_backup when encryptionKey is null", async () => {
      service["encryptionKey"] = null;

      const result = await service["_attemptAutoRestore"](new Error("test"));

      expect(result).toEqual({
        restored: false,
        autoRestoreStatus: "no_backup",
        backupIntegrity: "missing",
      });
    });

    it("should pick the most recent backup when multiple exist", async () => {
      mockReaddirSync.mockReturnValue([
        "mad-backup-20260220T100000.db",
        "mad-backup-20260222T100000.db",
        "mad-backup-20260221T100000.db",
      ]);
      mockExistsSync.mockReturnValue(true);
      mockDbPragma.mockImplementation((pragma: string) => {
        if (pragma.includes("integrity_check")) {
          return [{ integrity_check: "ok" }];
        }
        return undefined;
      });

      await service["_attemptAutoRestore"](new Error("test"));

      // Should have tried to copy the newest backup (20260222)
      const copyCall = mockCopyFileSync.mock.calls.find(
        (call: string[]) => call[0]?.includes("20260222")
      );
      expect(copyCall).toBeDefined();
    });

    it("should handle readdirSync failure gracefully", async () => {
      mockReaddirSync.mockImplementation(() => {
        throw new Error("Permission denied");
      });

      const result = await service["_attemptAutoRestore"](new Error("test"));

      expect(result).toEqual({
        restored: false,
        autoRestoreStatus: "no_backup",
        backupIntegrity: "missing",
      });
    });

    it("should handle db.close() failure gracefully during restore", async () => {
      mockDbClose.mockImplementation(() => {
        throw new Error("Already closed");
      });

      // Backup available and valid
      mockReaddirSync.mockReturnValue(["mad-backup-20260222T100000.db"]);
      mockExistsSync.mockReturnValue(true);
      mockDbPragma.mockImplementation((pragma: string) => {
        if (pragma.includes("integrity_check")) {
          return [{ integrity_check: "ok" }];
        }
        return undefined;
      });

      // Should not throw despite close error
      const result = await service["_attemptAutoRestore"](new Error("test"));

      // Should still succeed (close error is ignored)
      expect(result.autoRestoreStatus).not.toBe("no_backup");
    });
  });

  describe("Pre-junction backfill snapshot (R1, BACKLOG-1722)", () => {
    // BACKLOG-2993: the CREATION branch (version < 41) is unreachable — the
    // baseline fence refuses every pre-baseline database before runMigrations.
    // What must keep working: no snapshot is ever created for a baseline
    // database, and the 30-day CLEANUP of a legacy snapshot still runs.
    it("does NOT create snapshot for a baseline database", async () => {
      // Default mock has version = the baseline
      mockExistsSync.mockReturnValue(true);
      mockCopyFileSync.mockClear();

      await service.initialize();

      const snapshotCall = mockCopyFileSync.mock.calls.find(
        (call: unknown[]) => typeof call[1] === "string" && (call[1] as string).includes("pre-junction-backfill")
      );
      expect(snapshotCall).toBeUndefined();
    });

    it("deletes snapshot older than 30 days", async () => {
      // Call runMigrations() directly to isolate the cleanup path.
      // Set up service internal state (db + dbPath) that runMigrations() requires.
      // Reset mockDbExec so the "throw on call #2" impl from migration-failure
      // beforeEach doesn't bleed in (clearAllMocks does not reset implementations).
      mockDbExec.mockReset();
      const mockDbInst = {
        close: mockDbClose,
        pragma: mockDbPragma,
        exec: mockDbExec,
        prepare: mockDbPrepare,
        transaction: mockDbTransaction,
      };
      service["db"] = mockDbInst;
      service["dbPath"] = "/mock/userData/mad.db";

      // version = 41 (no snapshot creation), but snapshot exists and is old
      const THIRTY_ONE_DAYS_MS = 31 * 24 * 60 * 60 * 1000;
      mockStatSync.mockReturnValue({ mtimeMs: Date.now() - THIRTY_ONE_DAYS_MS, size: 1024 });
      mockExistsSync.mockReturnValue(true);
      // Provide a backup so _runVersionedMigrations() can satisfy its backup guard for v42.
      mockReaddirSync.mockReturnValue(["mad-backup-20260222T100000.db"]);
      mockReadFileSync.mockReturnValue("-- schema SQL");
      mockUnlinkSync.mockClear();

      await service.runMigrations();

      const snapshotUnlink = mockUnlinkSync.mock.calls.find(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("pre-junction-backfill")
      );
      expect(snapshotUnlink).toBeDefined();
    });

    it("does NOT delete snapshot younger than 30 days", async () => {
      // Call runMigrations() directly to isolate the cleanup path.
      // Reset mockDbExec so the "throw on call #2" impl from migration-failure
      // beforeEach doesn't bleed in (clearAllMocks does not reset implementations).
      mockDbExec.mockReset();
      const mockDbInst = {
        close: mockDbClose,
        pragma: mockDbPragma,
        exec: mockDbExec,
        prepare: mockDbPrepare,
        transaction: mockDbTransaction,
      };
      service["db"] = mockDbInst;
      service["dbPath"] = "/mock/userData/mad.db";

      // version = 41, snapshot exists but is only 1 day old
      const ONE_DAY_MS = 24 * 60 * 60 * 1000;
      mockStatSync.mockReturnValue({ mtimeMs: Date.now() - ONE_DAY_MS, size: 1024 });
      mockExistsSync.mockReturnValue(true);
      // Provide a backup so _runVersionedMigrations() can satisfy its backup guard for v42.
      mockReaddirSync.mockReturnValue(["mad-backup-20260222T100000.db"]);
      mockReadFileSync.mockReturnValue("-- schema SQL");
      mockUnlinkSync.mockClear();

      await service.runMigrations();

      const snapshotUnlink = mockUnlinkSync.mock.calls.find(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("pre-junction-backfill")
      );
      expect(snapshotUnlink).toBeUndefined();
    });
  });
});
