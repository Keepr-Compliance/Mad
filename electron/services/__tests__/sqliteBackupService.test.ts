/**
 * SQLite Backup Service Tests
 * TASK-2052: Unit tests for database backup and restore functionality
 */

// Mock fs
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

// Mock path
jest.mock("path", () => ({
  join: (...args: string[]) => args.join("/"),
  resolve: (p: string) => p,
}));

// Mock electron
const mockGetPath = jest.fn();
jest.mock("electron", () => ({
  app: {
    getPath: mockGetPath,
  },
}));

// Mock Sentry
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
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

// Mock databaseService
const mockIsInitialized = jest.fn();
const mockGetRawDatabase = jest.fn();
const mockDbServiceClose = jest.fn();
const mockDbServiceInitialize = jest.fn();
jest.mock("../databaseService", () => ({
  __esModule: true,
  default: {
    isInitialized: mockIsInitialized,
    getRawDatabase: mockGetRawDatabase,
    close: mockDbServiceClose,
    initialize: mockDbServiceInitialize,
  },
}));

// Mock databaseEncryptionService
const mockGetEncryptionKey = jest.fn();
jest.mock("../databaseEncryptionService", () => ({
  databaseEncryptionService: {
    getEncryptionKey: mockGetEncryptionKey,
  },
}));

// Mock better-sqlite3-multiple-ciphers
// Use a factory that creates fresh mocks for each Database instance
const mockTestDbClose = jest.fn();
const mockTestDbPragma = jest.fn();
const mockTestDbPrepare = jest.fn();
const MockDatabase = jest.fn().mockImplementation(() => ({
  close: mockTestDbClose,
  pragma: mockTestDbPragma,
  prepare: mockTestDbPrepare,
}));
jest.mock("better-sqlite3-multiple-ciphers", () => MockDatabase);

// Mock db/core/dbConnection to control ensureDb() used by WAL checkpoint
const mockEnsureDb = jest.fn();
jest.mock("../db/core/dbConnection", () => ({
  ensureDb: mockEnsureDb,
}));

import {
  backupDatabase,
  verifyBackup,
  restoreDatabase,
  getDatabaseInfo,
  generateBackupFilename,
} from "../sqliteBackupService";

/**
 * Helper to set up mocks for a valid verifyBackup scenario
 */
function setupValidBackupMocks(): void {
  mockExistsSync.mockReturnValue(true);
  mockGetEncryptionKey.mockResolvedValue("abcdef1234567890");
  mockTestDbPrepare.mockReturnValue({
    get: jest.fn().mockReturnValue({ count: 5 }),
  });
}

describe("SqliteBackupService", () => {
  beforeEach(() => {
    // Reset call data only (preserves implementations set by individual tests)
    mockExistsSync.mockReset();
    mockCopyFileSync.mockReset();
    mockStatSync.mockReset();
    mockUnlinkSync.mockReset();
    mockGetPath.mockReset();
    mockIsInitialized.mockReset();
    mockGetRawDatabase.mockReset();
    mockDbServiceClose.mockReset();
    mockDbServiceInitialize.mockReset();
    mockGetEncryptionKey.mockReset();
    mockTestDbClose.mockReset();
    mockTestDbPragma.mockReset();
    mockTestDbPrepare.mockReset();
    MockDatabase.mockClear();
    mockEnsureDb.mockReset();

    // Set common defaults
    mockGetPath.mockReturnValue("/mock/userData");
    mockIsInitialized.mockReturnValue(true);
    mockGetEncryptionKey.mockResolvedValue("abcdef1234567890");

    // Default: ensureDb returns a mock db where WAL checkpoint succeeds (busy=0)
    mockEnsureDb.mockReturnValue({
      pragma: jest.fn().mockReturnValue([{ busy: 0, checkpointed: 1, log: 1 }]),
    });
  });

  describe("generateBackupFilename", () => {
    it("should include current date in YYYY-MM-DD format", () => {
      const filename = generateBackupFilename();
      expect(filename).toMatch(/^keepr-backup-\d{4}-\d{2}-\d{2}\.db$/);
    });

    it("should use today's date", () => {
      const today = new Date().toISOString().slice(0, 10);
      const filename = generateBackupFilename();
      expect(filename).toBe(`keepr-backup-${today}.db`);
    });
  });

  describe("backupDatabase", () => {
    it("should copy database file to the destination path", async () => {
      mockStatSync.mockReturnValue({ size: 1024 });

      const result = await backupDatabase("/tmp/backup.db");

      expect(result.success).toBe(true);
      expect(result.filePath).toBe("/tmp/backup.db");
      expect(result.fileSize).toBe(1024);
      expect(mockCopyFileSync).toHaveBeenCalledWith(
        "/mock/userData/mad.db",
        "/tmp/backup.db"
      );
    });

    it("should return error when database is not initialized", async () => {
      mockIsInitialized.mockReturnValue(false);

      const result = await backupDatabase("/tmp/backup.db");

      expect(result.success).toBe(false);
      expect(result.error).toContain("not initialized");
    });

    it("should prevent backup to same file as active database", async () => {
      const result = await backupDatabase("/mock/userData/mad.db");

      expect(result.success).toBe(false);
      expect(result.error).toContain("same file");
    });

    it("should handle file copy errors gracefully", async () => {
      mockCopyFileSync.mockImplementation(() => {
        throw new Error("Disk full");
      });

      const result = await backupDatabase("/tmp/backup.db");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Disk full");
    });
  });

  describe("verifyBackup", () => {
    it("should return false for non-existent file", async () => {
      mockExistsSync.mockReturnValue(false);

      const result = await verifyBackup("/tmp/nonexistent.db");

      expect(result).toBe(false);
    });

    it("should return true for valid backup with tables", async () => {
      setupValidBackupMocks();

      const result = await verifyBackup("/tmp/valid-backup.db");

      expect(result).toBe(true);
    });

    it("should return false for backup with no tables", async () => {
      mockExistsSync.mockReturnValue(true);
      mockTestDbPrepare.mockReturnValue({
        get: jest.fn().mockReturnValue({ count: 0 }),
      });

      const result = await verifyBackup("/tmp/empty-backup.db");

      expect(result).toBe(false);
    });

    it("should return false when decryption fails", async () => {
      mockExistsSync.mockReturnValue(true);
      mockTestDbPragma.mockImplementation((pragma: string) => {
        if (pragma.includes("cipher_integrity_check")) {
          throw new Error("Decryption failed");
        }
      });

      const result = await verifyBackup("/tmp/wrong-key.db");

      expect(result).toBe(false);
    });

    it("should close test database after verification", async () => {
      setupValidBackupMocks();

      await verifyBackup("/tmp/valid-backup.db");

      expect(mockTestDbClose).toHaveBeenCalled();
    });
  });

  describe("restoreDatabase", () => {
    beforeEach(() => {
      // Set up for valid backup verification
      setupValidBackupMocks();
      mockDbServiceClose.mockResolvedValue(undefined);
      mockDbServiceInitialize.mockResolvedValue(true);
    });

    it("should fail for invalid backup file", async () => {
      // Override: make file not exist so verify fails
      mockExistsSync.mockReturnValue(false);

      const result = await restoreDatabase("/tmp/invalid.db");

      expect(result.success).toBe(false);
      expect(result.error).toContain("not a valid backup");
    });

    it("should close current database before restoring", async () => {
      await restoreDatabase("/tmp/valid.db");

      expect(mockDbServiceClose).toHaveBeenCalled();
    });

    it("should create safety copy before restore", async () => {
      await restoreDatabase("/tmp/valid.db");

      // Safety copy is created via copyFileSync
      expect(mockCopyFileSync).toHaveBeenCalled();
    });

    it("should copy backup file to database location", async () => {
      await restoreDatabase("/tmp/valid.db");

      const calls = mockCopyFileSync.mock.calls;
      const backupCopyCall = calls.find(
        (c: string[]) =>
          c[0] === "/tmp/valid.db" && c[1] === "/mock/userData/mad.db"
      );
      expect(backupCopyCall).toBeDefined();
    });

    it("should reinitialize database after restore", async () => {
      await restoreDatabase("/tmp/valid.db");

      expect(mockDbServiceInitialize).toHaveBeenCalled();
    });

    it("BACKLOG-3298: does not delete the safety copy on success (it is kept; see keepOne-3298)", async () => {
      await restoreDatabase("/tmp/valid.db");

      expect(mockUnlinkSync).not.toHaveBeenCalledWith(
        "/mock/userData/mad.db.safety-restore-copy"
      );
    });

    it("should return success on successful restore", async () => {
      const result = await restoreDatabase("/tmp/valid.db");

      expect(result.success).toBe(true);
    });

    it("should attempt recovery from safety copy if reinitialize fails", async () => {
      mockDbServiceInitialize
        .mockRejectedValueOnce(new Error("Init failed"))
        .mockResolvedValueOnce(true);

      const result = await restoreDatabase("/tmp/valid.db");

      expect(result.success).toBe(false);
      expect(result.error).toContain("Init failed");
    });

    it("should remove WAL and SHM files during restore", async () => {
      await restoreDatabase("/tmp/valid.db");

      expect(mockUnlinkSync).toHaveBeenCalledWith(
        "/mock/userData/mad.db-wal"
      );
      expect(mockUnlinkSync).toHaveBeenCalledWith(
        "/mock/userData/mad.db-shm"
      );
    });
  });

  describe("getDatabaseInfo", () => {
    it("should return null when database file does not exist", async () => {
      mockExistsSync.mockReturnValue(false);

      const result = await getDatabaseInfo();

      expect(result).toBeNull();
    });

    it("should return file info when database exists", async () => {
      mockExistsSync.mockReturnValue(true);
      const mockDate = new Date("2026-02-22T15:30:00Z");
      mockStatSync.mockReturnValue({
        size: 42000000,
        mtime: mockDate,
      });

      const result = await getDatabaseInfo();

      expect(result).not.toBeNull();
      expect(result!.fileSize).toBe(42000000);
      expect(result!.lastModified).toBe(mockDate.toISOString());
      expect(result!.filePath).toBe("/mock/userData/mad.db");
    });

    it("should handle stat errors gracefully", async () => {
      mockExistsSync.mockReturnValue(true);
      mockStatSync.mockImplementation(() => {
        throw new Error("Permission denied");
      });

      const result = await getDatabaseInfo();

      expect(result).toBeNull();
    });
  });
});
