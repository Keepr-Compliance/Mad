/**
 * @jest-environment node
 */

/**
 * Unit tests for DatabaseService migration runner robustness
 *
 * TASK-2048: Tests version gap detection, duplicate detection,
 * partial failure rollback, backup verification, dry-run mode,
 * and timestamp tracking.
 *
 * Uses mocked better-sqlite3 matching existing test patterns.
 */

import { jest } from "@jest/globals";

// Mock Electron modules
jest.mock("electron", () => ({
  app: {
    getPath: jest.fn(() => "/mock/user/data"),
  },
}));

// Mock better-sqlite3-multiple-ciphers
const mockStatement = {
  get: jest.fn(),
  all: jest.fn(),
  run: jest.fn(),
};

const mockDb = {
  pragma: jest.fn(),
  exec: jest.fn(),
  prepare: jest.fn(() => mockStatement),
  close: jest.fn(),
  serialize: jest.fn((callback: () => void) => callback()),
  run: jest.fn(
    (
      _sql: string,
      _params: unknown[],
      callback: (err: Error | null) => void,
    ) => {
      if (callback) callback(null);
      return mockDb;
    },
  ),
  transaction: jest.fn((callback: (...args: unknown[]) => unknown) => {
    return (...args: unknown[]) => callback(...args);
  }),
};

jest.mock("better-sqlite3-multiple-ciphers", () => {
  return jest.fn(() => mockDb);
});

// Mock fs
jest.mock("fs", () => ({
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
  readFileSync: jest.fn(),
  writeSync: jest.fn(),
  fsyncSync: jest.fn(),
  closeSync: jest.fn(),
  openSync: jest.fn(),
  unlinkSync: jest.fn(),
  copyFileSync: jest.fn(),
  renameSync: jest.fn(),
  readdirSync: jest.fn(() => []),
  statSync: jest.fn(() => ({ size: 1024 })),
}));

// Mock crypto
jest.mock("crypto", () => ({
  randomUUID: jest.fn(() => "test-uuid-1234"),
  randomBytes: jest.fn(() => Buffer.from("random-bytes-for-testing")),
}));

// Mock Sentry
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
}));

// Mock databaseEncryptionService
jest.mock("../databaseEncryptionService", () => ({
  databaseEncryptionService: {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("test-encryption-key-hex"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false),
  },
  default: {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("test-encryption-key-hex"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false),
  },
}));

// Mock logService
jest.mock("../logService", () => {
  const mockFns = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return {
    __esModule: true,
    default: mockFns,
    logService: mockFns,
  };
});

// Mock db/core/dbConnection
jest.mock("../db/core/dbConnection", () => ({
  setDb: jest.fn(),
  setDbPath: jest.fn(),
  setEncryptionKey: jest.fn(),
  closeDb: jest.fn().mockResolvedValue(undefined),
  vacuumDb: jest.fn(),
}));

// Mock all domain db services to prevent import failures
jest.mock("../db/userDbService", () => ({}));
jest.mock("../db/sessionDbService", () => ({}));
jest.mock("../db/oauthTokenDbService", () => ({}));
jest.mock("../db/transactionDbService", () => ({}));
jest.mock("../db/contactDbService", () => ({}));
jest.mock("../db/transactionContactDbService", () => ({}));
jest.mock("../db/communicationDbService", () => ({}));
jest.mock("../db/feedbackDbService", () => ({}));
jest.mock("../db/auditLogDbService", () => ({}));

// We need to get the DatabaseService class itself (not just the instance)
// for testing static methods
type DatabaseServiceModule = typeof import("../databaseService");

// Helper to get the current fs mock (re-evaluated after resetModules)
const getFs = () => require("fs") as typeof import("fs");

describe("DatabaseService Migration Robustness (TASK-2048)", () => {
  let databaseService: DatabaseServiceModule["default"];
  let DatabaseServiceClass: {
    validateNoDuplicateVersions: (migrations: Array<{ version: number; description: string; migrate: (d: unknown) => void }>) => void;
    validateNoVersionGaps: (migrations: Array<{ version: number; description: string; migrate: (d: unknown) => void }>) => void;
    BASELINE_VERSION: number;
    MIGRATIONS: Array<{ version: number; description: string; migrate: (d: unknown) => void }>;
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.resetModules();

    // Reset mock defaults
    mockStatement.get.mockReturnValue(undefined);
    mockStatement.all.mockReturnValue([]);
    mockStatement.run.mockReturnValue({ lastInsertRowid: 1, changes: 1 });
    (getFs().existsSync as jest.Mock).mockReturnValue(false);
    (getFs().readFileSync as jest.Mock).mockReturnValue("-- schema SQL");
    (getFs().readdirSync as jest.Mock).mockReturnValue([]);

    // Re-import for fresh instance
    const module = await import("../databaseService");
    databaseService = module.default;

    // Access the class via the constructor of the default export
    DatabaseServiceClass = (databaseService as unknown as { constructor: typeof DatabaseServiceClass }).constructor as unknown as typeof DatabaseServiceClass;
  });

  // ============================================
  // DUPLICATE VERSION DETECTION
  // ============================================

  describe("validateNoDuplicateVersions", () => {
    it("should pass when no duplicates exist", () => {
      const migrations = [
        { version: 30, description: "v30", migrate: jest.fn() },
        { version: 31, description: "v31", migrate: jest.fn() },
        { version: 32, description: "v32", migrate: jest.fn() },
      ];

      expect(() =>
        DatabaseServiceClass.validateNoDuplicateVersions(migrations)
      ).not.toThrow();
    });

    it("should throw on duplicate version numbers", () => {
      const migrations = [
        { version: 30, description: "v30a", migrate: jest.fn() },
        { version: 30, description: "v30b", migrate: jest.fn() },
      ];

      expect(() =>
        DatabaseServiceClass.validateNoDuplicateVersions(migrations)
      ).toThrow("Duplicate migration versions detected: 30");
    });

    it("should list all duplicate versions", () => {
      const migrations = [
        { version: 30, description: "a", migrate: jest.fn() },
        { version: 30, description: "b", migrate: jest.fn() },
        { version: 31, description: "c", migrate: jest.fn() },
        { version: 32, description: "d", migrate: jest.fn() },
        { version: 32, description: "e", migrate: jest.fn() },
      ];

      expect(() =>
        DatabaseServiceClass.validateNoDuplicateVersions(migrations)
      ).toThrow("Duplicate migration versions detected: 30, 32");
    });

    it("should pass with empty migrations array", () => {
      expect(() =>
        DatabaseServiceClass.validateNoDuplicateVersions([])
      ).not.toThrow();
    });
  });

  // ============================================
  // VERSION GAP DETECTION
  // ============================================

  describe("validateNoVersionGaps", () => {
    it("should pass for consecutive versions", () => {
      const migrations = [
        { version: 30, description: "v30", migrate: jest.fn() },
        { version: 31, description: "v31", migrate: jest.fn() },
        { version: 32, description: "v32", migrate: jest.fn() },
      ];

      expect(() =>
        DatabaseServiceClass.validateNoVersionGaps(migrations)
      ).not.toThrow();
    });

    it("should throw when versions have gaps", () => {
      const migrations = [
        { version: 30, description: "v30", migrate: jest.fn() },
        { version: 32, description: "v32", migrate: jest.fn() },
      ];

      expect(() =>
        DatabaseServiceClass.validateNoVersionGaps(migrations)
      ).toThrow("Migration sequence error: Missing migration version 31 (found 30 -> 32)");
    });

    it("should pass with empty migrations array", () => {
      expect(() =>
        DatabaseServiceClass.validateNoVersionGaps([])
      ).not.toThrow();
    });

    it("should pass with single migration", () => {
      const migrations = [
        { version: 30, description: "v30", migrate: jest.fn() },
      ];

      expect(() =>
        DatabaseServiceClass.validateNoVersionGaps(migrations)
      ).not.toThrow();
    });

    it("should handle out-of-order versions (sorts before checking)", () => {
      const migrations = [
        { version: 32, description: "v32", migrate: jest.fn() },
        { version: 30, description: "v30", migrate: jest.fn() },
        { version: 31, description: "v31", migrate: jest.fn() },
      ];

      expect(() =>
        DatabaseServiceClass.validateNoVersionGaps(migrations)
      ).not.toThrow();
    });
  });

  // ============================================
  // PARTIAL FAILURE ROLLBACK
  // ============================================

  describe("partial failure rollback", () => {
    it("should leave DB at previous version when migration fails", async () => {
      // Initialize DB
      (getFs().existsSync as jest.Mock).mockReturnValue(false);
      await databaseService.initialize();
      jest.clearAllMocks();

      // Setup: schema_version table exists, current version = 29
      mockStatement.get
        .mockReturnValueOnce({ name: "schema_version" }) // schema_version exists check
        .mockReturnValueOnce({ version: 29 }); // current version

      // migrated_at column present
      mockStatement.all.mockReturnValueOnce([
        { name: "id" },
        { name: "version" },
        { name: "updated_at" },
        { name: "migrated_at" },
      ]);

      // DB file exists with backup
      (getFs().existsSync as jest.Mock).mockReturnValue(true);
      (getFs().readdirSync as jest.Mock).mockReturnValue(["mad-backup-20260222T120000.db"]);

      // Simulate migration 30 failing by making the transaction throw
      mockDb.transaction.mockImplementationOnce((callback: () => void) => {
        return () => {
          callback();
          throw new Error("SQLITE_ERROR: some table issue");
        };
      });

      await expect(
        databaseService._runVersionedMigrations()
      ).rejects.toThrow(/Migration 30.*failed.*SQLITE_ERROR/);
    });

    it("should include recovery info in error message", async () => {
      (getFs().existsSync as jest.Mock).mockReturnValue(false);
      await databaseService.initialize();
      jest.clearAllMocks();

      mockStatement.get
        .mockReturnValueOnce({ name: "schema_version" })
        .mockReturnValueOnce({ version: 29 });
      mockStatement.all.mockReturnValueOnce([
        { name: "id" },
        { name: "version" },
        { name: "updated_at" },
        { name: "migrated_at" },
      ]);
      (getFs().existsSync as jest.Mock).mockReturnValue(true);
      (getFs().readdirSync as jest.Mock).mockReturnValue(["mad-backup-20260222T120000.db"]);
      mockDb.transaction.mockImplementationOnce((callback: () => void) => {
        return () => {
          callback();
          throw new Error("test failure");
        };
      });

      await expect(
        databaseService._runVersionedMigrations()
      ).rejects.toThrow("Database remains at version 29");
    });
  });

  // ============================================
  // BACKUP VERIFICATION
  // ============================================

  describe("backup verification", () => {
    it("should refuse to run migrations when no backup exists", async () => {
      // Directly set up the internal state to bypass initialize() entirely
      const svc = databaseService as unknown as { dbPath: string | null; db: unknown };
      svc.db = mockDb;
      svc.dbPath = "/mock/user/data/mad.db";

      // schema_version table exists, current version = 29
      mockStatement.get
        .mockReturnValueOnce({ name: "schema_version" })
        .mockReturnValueOnce({ version: 29 });

      // Has migrated_at column
      mockStatement.all.mockReturnValueOnce([
        { name: "id" },
        { name: "version" },
        { name: "updated_at" },
        { name: "migrated_at" },
      ]);

      // DB file + directory exist, but no backup files matching pattern
      (getFs().existsSync as jest.Mock).mockReturnValue(true);
      (getFs().readdirSync as jest.Mock).mockReturnValue([]);

      await expect(
        databaseService._runVersionedMigrations()
      ).rejects.toThrow("Pre-migration backup required but not found");
    });

    it("should proceed when no pending migrations (backup not checked)", async () => {
      (getFs().existsSync as jest.Mock).mockReturnValue(false);
      await databaseService.initialize();

      // Clear mocks consumed during initialize()
      jest.clearAllMocks();

      // DB is at version 30 (all migrations already applied)
      mockStatement.get
        .mockReturnValueOnce({ name: "schema_version" })
        .mockReturnValueOnce({ version: 30 });

      mockStatement.all.mockReturnValueOnce([
        { name: "id" },
        { name: "version" },
        { name: "updated_at" },
        { name: "migrated_at" },
      ]);

      // No pending migrations, so backup check is skipped
      await expect(
        databaseService._runVersionedMigrations()
      ).resolves.toBeUndefined();
    });
  });

  // ============================================
  // DRY-RUN MODE
  // ============================================

  describe("dry-run mode", () => {
    it("should return migration plan without executing", async () => {
      (getFs().existsSync as jest.Mock).mockReturnValue(false);
      await databaseService.initialize();
      jest.clearAllMocks();

      // Setup: current version = 29, so migration 30 is pending
      mockStatement.get
        .mockReturnValueOnce({ name: "schema_version" })
        .mockReturnValueOnce({ version: 29 });

      mockStatement.all.mockReturnValueOnce([
        { name: "id" },
        { name: "version" },
        { name: "updated_at" },
        { name: "migrated_at" },
      ]);

      const plan = await databaseService._runVersionedMigrations(true);

      expect(plan).toBeDefined();
      expect(plan).toEqual({
        currentVersion: 29,
        targetVersion: 46,
        pendingMigrations: [
          {
            version: 30,
            description: expect.stringContaining("transaction_summary"),
          },
          {
            version: 31,
            description: expect.stringContaining("failure_log"),
          },
          {
            version: 32,
            description: expect.stringContaining("sync_session_id"),
          },
          {
            version: 33,
            description: expect.stringContaining("audit_logs CHECK"),
          },
          {
            version: 34,
            description: expect.stringContaining("skip_address_filter"),
          },
          {
            version: 35,
            description: expect.stringContaining("default_role"),
          },
          {
            version: 36,
            description: expect.stringContaining("android_sync"),
          },
          {
            version: 37,
            description: expect.stringContaining("BACKLOG-1560"),
          },
          {
            version: 38,
            description: expect.stringContaining("BACKLOG-1576"),
          },
          {
            version: 39,
            description: expect.stringContaining("BACKLOG-1579"),
          },
          {
            version: 40,
            description: expect.stringContaining("BACKLOG-1727"),
          },
          {
            version: 41,
            description: expect.stringContaining("BACKLOG-1722"),
          },
          {
            version: 42,
            description: expect.stringContaining("BACKLOG-1718"),
          },
          {
            version: 43,
            description: expect.stringContaining("BACKLOG-1768"),
          },
          {
            version: 44,
            description: expect.stringContaining("BACKLOG-1769"),
          },
          {
            version: 45,
            description: expect.stringContaining("BACKLOG-1771"),
          },
          {
            version: 46,
            description: expect.stringContaining("BACKLOG-1801"),
          },
        ],
        wouldRunCount: 17,
      });

      // Verify no transaction was started (migration wasn't executed)
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it("should report zero pending when all applied", async () => {
      (getFs().existsSync as jest.Mock).mockReturnValue(false);
      await databaseService.initialize();
      jest.clearAllMocks();

      // Setup: version = 46 (all applied, including BACKLOG-1801 v46)
      mockStatement.get
        .mockReturnValueOnce({ name: "schema_version" })
        .mockReturnValueOnce({ version: 46 });

      mockStatement.all.mockReturnValueOnce([
        { name: "id" },
        { name: "version" },
        { name: "updated_at" },
        { name: "migrated_at" },
      ]);

      const plan = await databaseService._runVersionedMigrations(true);

      expect(plan).toEqual({
        currentVersion: 46,
        targetVersion: 46,
        pendingMigrations: [],
        wouldRunCount: 0,
      });
    });
  });

  // ============================================
  // SCHEMA VERSION TABLE SETUP
  // ============================================

  describe("schema version table", () => {
    it("should create schema_version table with migrated_at column on fresh DB", async () => {
      (getFs().existsSync as jest.Mock).mockReturnValue(false);
      await databaseService.initialize();
      jest.clearAllMocks();

      // No schema_version table exists
      mockStatement.get
        .mockReturnValueOnce(undefined) // table does not exist -> CREATE TABLE path
        .mockReturnValueOnce({ version: 30 }); // version after creation (all applied)

      await databaseService._runVersionedMigrations();

      // Verify CREATE TABLE was called with migrated_at column
      expect(mockDb.exec).toHaveBeenCalledWith(
        expect.stringContaining("migrated_at")
      );
    });

    it("should add migrated_at column to existing schema_version table", async () => {
      (getFs().existsSync as jest.Mock).mockReturnValue(false);
      await databaseService.initialize();
      jest.clearAllMocks();

      // schema_version exists but without migrated_at
      mockStatement.get
        .mockReturnValueOnce({ name: "schema_version" }) // table exists
        .mockReturnValueOnce({ version: 30 }); // current version

      // PRAGMA table_info returns columns WITHOUT migrated_at
      mockStatement.all.mockReturnValueOnce([
        { name: "id" },
        { name: "version" },
        { name: "updated_at" },
      ]);

      await databaseService._runVersionedMigrations();

      // Verify ALTER TABLE was called
      expect(mockDb.exec).toHaveBeenCalledWith(
        "ALTER TABLE schema_version ADD COLUMN migrated_at TEXT"
      );
    });

    it("should not alter table when migrated_at already exists", async () => {
      (getFs().existsSync as jest.Mock).mockReturnValue(false);
      await databaseService.initialize();
      jest.clearAllMocks();

      mockStatement.get
        .mockReturnValueOnce({ name: "schema_version" })
        .mockReturnValueOnce({ version: 30 });

      // PRAGMA table_info WITH migrated_at already present
      mockStatement.all.mockReturnValueOnce([
        { name: "id" },
        { name: "version" },
        { name: "updated_at" },
        { name: "migrated_at" },
      ]);

      await databaseService._runVersionedMigrations();

      // ALTER TABLE should NOT be called
      expect(mockDb.exec).not.toHaveBeenCalledWith(
        "ALTER TABLE schema_version ADD COLUMN migrated_at TEXT"
      );
    });
  });

  // ============================================
  // HAPPY PATH
  // ============================================

  describe("happy path", () => {
    it("should run all pending migrations in sequence", async () => {
      (getFs().existsSync as jest.Mock).mockReturnValue(false);
      await databaseService.initialize();
      jest.clearAllMocks();

      // version = 29, migration 30 is pending
      mockStatement.get
        .mockReturnValueOnce({ name: "schema_version" })
        .mockReturnValueOnce({ version: 29 });

      mockStatement.all.mockReturnValueOnce([
        { name: "id" },
        { name: "version" },
        { name: "updated_at" },
        { name: "migrated_at" },
      ]);

      // DB file exists with backup present
      (getFs().existsSync as jest.Mock).mockReturnValue(true);
      (getFs().readdirSync as jest.Mock).mockReturnValue(["mad-backup-20260222T120000.db"]);

      await databaseService._runVersionedMigrations();

      // Transaction should have been called seventeen times (for migrations 30-46;
      // BACKLOG-1722 adds v41, BACKLOG-1718 R3 adds v42, BACKLOG-1768 adds v43,
      // BACKLOG-1769 adds v44, BACKLOG-1771 adds v45, BACKLOG-1801 adds v46).
      expect(mockDb.transaction).toHaveBeenCalledTimes(17);
    });

    it("should skip already-applied migrations", async () => {
      (getFs().existsSync as jest.Mock).mockReturnValue(false);
      await databaseService.initialize();
      jest.clearAllMocks();

      // version = 46, all migrations applied (including BACKLOG-1801 v46)
      mockStatement.get
        .mockReturnValueOnce({ name: "schema_version" })
        .mockReturnValueOnce({ version: 46 });

      mockStatement.all.mockReturnValueOnce([
        { name: "id" },
        { name: "version" },
        { name: "updated_at" },
        { name: "migrated_at" },
      ]);

      await databaseService._runVersionedMigrations();

      // No transaction should have been called (nothing to run)
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });
  });

  // ============================================
  // TIMESTAMP TRACKING
  // ============================================

  describe("timestamp tracking", () => {
    it("should use parameterized UPDATE with migrated_at for version bump", async () => {
      (getFs().existsSync as jest.Mock).mockReturnValue(false);
      await databaseService.initialize();
      jest.clearAllMocks();

      mockStatement.get
        .mockReturnValueOnce({ name: "schema_version" })
        .mockReturnValueOnce({ version: 29 });

      mockStatement.all.mockReturnValueOnce([
        { name: "id" },
        { name: "version" },
        { name: "updated_at" },
        { name: "migrated_at" },
      ]);

      (getFs().existsSync as jest.Mock).mockReturnValue(true);
      (getFs().readdirSync as jest.Mock).mockReturnValue(["mad-backup-20260222T120000.db"]);

      await databaseService._runVersionedMigrations();

      // Verify the UPDATE statement includes migrated_at
      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining("migrated_at = datetime('now')")
      );
    });
  });

  // ============================================
  // PRODUCTION MIGRATIONS VALIDATION
  // ============================================

  describe("production migration list integrity", () => {
    it("BASELINE_VERSION should be 29", () => {
      expect(DatabaseServiceClass.BASELINE_VERSION).toBe(29);
    });

    it("should have no duplicate versions in MIGRATIONS", () => {
      expect(() =>
        DatabaseServiceClass.validateNoDuplicateVersions(
          DatabaseServiceClass.MIGRATIONS
        )
      ).not.toThrow();
    });

    it("should have no version gaps in MIGRATIONS", () => {
      expect(() =>
        DatabaseServiceClass.validateNoVersionGaps(
          DatabaseServiceClass.MIGRATIONS
        )
      ).not.toThrow();
    });

    it("all migration versions should be above BASELINE_VERSION", () => {
      for (const m of DatabaseServiceClass.MIGRATIONS) {
        expect(m.version).toBeGreaterThan(DatabaseServiceClass.BASELINE_VERSION);
      }
    });
  });

  // ============================================
  // BELOW-BASELINE WARNING
  // ============================================

  describe("below-baseline version warning", () => {
    it("should warn when DB version is below baseline", async () => {
      (getFs().existsSync as jest.Mock).mockReturnValue(false);
      await databaseService.initialize();
      jest.clearAllMocks();

      const logService = (await import("../logService")).default;

      // version = 10, below baseline of 29
      mockStatement.get
        .mockReturnValueOnce({ name: "schema_version" })
        .mockReturnValueOnce({ version: 10 });

      mockStatement.all.mockReturnValueOnce([
        { name: "id" },
        { name: "version" },
        { name: "updated_at" },
        { name: "migrated_at" },
      ]);

      // Need backup for pending migrations
      (getFs().existsSync as jest.Mock).mockReturnValue(true);
      (getFs().readdirSync as jest.Mock).mockReturnValue(["mad-backup-20260222T120000.db"]);

      await databaseService._runVersionedMigrations();

      expect(logService.warn).toHaveBeenCalledWith(
        expect.stringContaining("below baseline"),
        "DatabaseService"
      );
    });
  });

  // ============================================
  // ERROR MESSAGE QUALITY
  // ============================================

  describe("error message quality", () => {
    it("should include failed version number in error", async () => {
      (getFs().existsSync as jest.Mock).mockReturnValue(false);
      await databaseService.initialize();
      jest.clearAllMocks();

      mockStatement.get
        .mockReturnValueOnce({ name: "schema_version" })
        .mockReturnValueOnce({ version: 29 });

      mockStatement.all.mockReturnValueOnce([
        { name: "id" },
        { name: "version" },
        { name: "updated_at" },
        { name: "migrated_at" },
      ]);

      (getFs().existsSync as jest.Mock).mockReturnValue(true);
      (getFs().readdirSync as jest.Mock).mockReturnValue(["mad-backup-20260222T120000.db"]);

      // Make migration throw
      mockDb.transaction.mockImplementationOnce((callback: () => void) => {
        return () => {
          callback();
          throw new Error("column already exists");
        };
      });

      await expect(
        databaseService._runVersionedMigrations()
      ).rejects.toThrow(/Migration 30/);
    });

    it("should include previous version in error for recovery guidance", async () => {
      (getFs().existsSync as jest.Mock).mockReturnValue(false);
      await databaseService.initialize();
      jest.clearAllMocks();

      mockStatement.get
        .mockReturnValueOnce({ name: "schema_version" })
        .mockReturnValueOnce({ version: 29 });

      mockStatement.all.mockReturnValueOnce([
        { name: "id" },
        { name: "version" },
        { name: "updated_at" },
        { name: "migrated_at" },
      ]);

      (getFs().existsSync as jest.Mock).mockReturnValue(true);
      (getFs().readdirSync as jest.Mock).mockReturnValue(["mad-backup-20260222T120000.db"]);

      mockDb.transaction.mockImplementationOnce((callback: () => void) => {
        return () => {
          callback();
          throw new Error("test error");
        };
      });

      await expect(
        databaseService._runVersionedMigrations()
      ).rejects.toThrow("Database remains at version 29");
    });

    it("should mention pre-migration backup in error", async () => {
      (getFs().existsSync as jest.Mock).mockReturnValue(false);
      await databaseService.initialize();
      jest.clearAllMocks();

      mockStatement.get
        .mockReturnValueOnce({ name: "schema_version" })
        .mockReturnValueOnce({ version: 29 });

      mockStatement.all.mockReturnValueOnce([
        { name: "id" },
        { name: "version" },
        { name: "updated_at" },
        { name: "migrated_at" },
      ]);

      (getFs().existsSync as jest.Mock).mockReturnValue(true);
      (getFs().readdirSync as jest.Mock).mockReturnValue(["mad-backup-20260222T120000.db"]);

      mockDb.transaction.mockImplementationOnce((callback: () => void) => {
        return () => {
          callback();
          throw new Error("test error");
        };
      });

      await expect(
        databaseService._runVersionedMigrations()
      ).rejects.toThrow("Pre-migration backup available");
    });
  });

  // ============================================
  // FAILURE_LOG SAFETY CHECK (TASK-2279)
  // ============================================

  describe("_ensureFailureLogTable (TASK-2279)", () => {
    it("should create failure_log table when it does not exist", () => {
      // Call the safety check method directly
      (databaseService as unknown as { _ensureFailureLogTable: (db: typeof mockDb) => void })
        ._ensureFailureLogTable(mockDb as unknown as import("better-sqlite3").Database);

      // Verify exec was called with CREATE TABLE IF NOT EXISTS
      expect(mockDb.exec).toHaveBeenCalledWith(
        expect.stringContaining("CREATE TABLE IF NOT EXISTS failure_log")
      );
      // Verify indexes are also created
      expect(mockDb.exec).toHaveBeenCalledWith(
        expect.stringContaining("CREATE INDEX IF NOT EXISTS idx_failure_log_timestamp")
      );
      expect(mockDb.exec).toHaveBeenCalledWith(
        expect.stringContaining("CREATE INDEX IF NOT EXISTS idx_failure_log_acknowledged")
      );
    });

    it("should be idempotent -- no error when table already exists", () => {
      // First call creates the table
      (databaseService as unknown as { _ensureFailureLogTable: (db: typeof mockDb) => void })
        ._ensureFailureLogTable(mockDb as unknown as import("better-sqlite3").Database);

      // Second call should also succeed (IF NOT EXISTS handles this)
      expect(() => {
        (databaseService as unknown as { _ensureFailureLogTable: (db: typeof mockDb) => void })
          ._ensureFailureLogTable(mockDb as unknown as import("better-sqlite3").Database);
      }).not.toThrow();
    });

    it("should not throw when exec fails -- logs warning instead", () => {
      mockDb.exec.mockImplementationOnce(() => {
        throw new Error("disk I/O error");
      });

      // Should not throw -- the method catches errors internally
      expect(() => {
        (databaseService as unknown as { _ensureFailureLogTable: (db: typeof mockDb) => void })
          ._ensureFailureLogTable(mockDb as unknown as import("better-sqlite3").Database);
      }).not.toThrow();
    });
  });
});
