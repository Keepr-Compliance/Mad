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
jest.mock("electron", () => ({
  app: {
    getPath: mockGetPath,
    isReady: mockIsReady,
    whenReady: mockWhenReady,
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
        // BACKLOG-1722: bumped from 40 to 41 with the v41 (email_participants)
        // migration so the runner sees no pending work in the happy-path test.
        return { get: jest.fn().mockReturnValue({ version: 41 }) };
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
      seedOnDiskVersion(41); // behind latest (45) → willRunMigration = true

      const result = await service.initialize();

      expect(result).toBe(true);
      expect(rollingBackupCopies()).toBeGreaterThan(0);
    });

    it("SKIPS the rolling pre-migration backup when the DB is already at the latest version", async () => {
      // Latest migration version, so no migration runs and no backup is needed
      // (previously every launch copied the DB and churned the 3-file window).
      const migrations = service.constructor.MIGRATIONS as Array<{ version: number }>;
      const latest = migrations[migrations.length - 1].version;
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
      await service.initialize();

      expect(mockShowMessageBox).toHaveBeenCalledTimes(1);
      expect(mockShowMessageBox).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          title: "Database Update Failed",
          message: expect.stringContaining("could not be automatically fixed"),
        })
      );
    });

    it("should report to Sentry with no_backup tag", async () => {
      await service.initialize();

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

    it("should not crash the app (returns true)", async () => {
      const result = await service.initialize();

      expect(result).toBe(true);
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
      await service.initialize();

      expect(mockShowMessageBox).toHaveBeenCalledTimes(1);
      expect(mockShowMessageBox).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          title: "Database Update Failed",
        })
      );
    });

    it("should report to Sentry with corrupt backup tag", async () => {
      await service.initialize();

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
      await service.initialize();

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

      await service.initialize();

      expect(mockWhenReady).toHaveBeenCalled();
      expect(mockShowMessageBox).toHaveBeenCalled();
    });

    it("should not call whenReady if app is already ready", async () => {
      mockIsReady.mockReturnValue(true);

      await service.initialize();

      expect(mockWhenReady).not.toHaveBeenCalled();
      expect(mockShowMessageBox).toHaveBeenCalled();
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
    it("creates snapshot when DB version is below 41", async () => {
      // Override version mock to return 40
      mockDbPrepare.mockImplementation((sql: string) => {
        if (sql.includes("sqlite_master") && sql.includes("schema_version")) {
          return { get: jest.fn().mockReturnValue({ name: "schema_version" }) };
        }
        if (sql.includes("SELECT version FROM schema_version")) {
          return { get: jest.fn().mockReturnValue({ version: 40 }) };
        }
        if (sql.includes("PRAGMA table_info")) {
          return {
            all: jest.fn().mockReturnValue([
              { name: "id" }, { name: "version" }, { name: "updated_at" }, { name: "migrated_at" },
            ]),
          };
        }
        if (sql.includes("SELECT 1")) {
          return { get: jest.fn().mockReturnValue({ ok: 1 }) };
        }
        return { get: jest.fn(), all: jest.fn().mockReturnValue([]), run: jest.fn() };
      });

      // Snapshot file does NOT exist yet; DB file and backups exist
      mockExistsSync.mockImplementation((p: string) => {
        if (typeof p === "string" && p.includes("pre-junction-backfill")) return false;
        return true;
      });

      mockCopyFileSync.mockClear();

      await service.initialize();

      // copyFileSync should be called for (1) rolling backup and (2) snapshot
      const snapshotCall = mockCopyFileSync.mock.calls.find(
        (call: unknown[]) => typeof call[1] === "string" && (call[1] as string).includes("pre-junction-backfill")
      );
      expect(snapshotCall).toBeDefined();
      expect(snapshotCall![1]).toMatch(/mad-pre-junction-backfill\.db$/);
    });

    it("does NOT create snapshot when DB version is 41 or above", async () => {
      // Default mock has version = 41
      mockExistsSync.mockReturnValue(true);
      mockCopyFileSync.mockClear();

      await service.initialize();

      const snapshotCall = mockCopyFileSync.mock.calls.find(
        (call: unknown[]) => typeof call[1] === "string" && (call[1] as string).includes("pre-junction-backfill")
      );
      expect(snapshotCall).toBeUndefined();
    });

    it("does NOT overwrite an existing snapshot (idempotent)", async () => {
      // version = 40, but snapshot file already exists
      mockDbPrepare.mockImplementation((sql: string) => {
        if (sql.includes("sqlite_master") && sql.includes("schema_version")) {
          return { get: jest.fn().mockReturnValue({ name: "schema_version" }) };
        }
        if (sql.includes("SELECT version FROM schema_version")) {
          return { get: jest.fn().mockReturnValue({ version: 40 }) };
        }
        if (sql.includes("PRAGMA table_info")) {
          return {
            all: jest.fn().mockReturnValue([
              { name: "id" }, { name: "version" }, { name: "updated_at" }, { name: "migrated_at" },
            ]),
          };
        }
        return { get: jest.fn(), all: jest.fn().mockReturnValue([]), run: jest.fn() };
      });

      // ALL files exist — snapshot already there
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
