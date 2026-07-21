/**
 * @jest-environment node
 */

/**
 * Tests for InitializationBroadcaster integration with DatabaseService
 *
 * Verifies that databaseService.initialize() broadcasts the correct
 * stage events (db-opening, migrating, db-ready, error) through
 * the InitializationBroadcaster singleton.
 *
 * BACKLOG-1381: Wire InitializationBroadcaster into main process init flow
 */

import { jest } from "@jest/globals";

// Mock Electron modules
jest.mock("electron", () => ({
  app: {
    getPath: jest.fn(() => "/mock/user/data"),
    isReady: jest.fn(() => true),
    whenReady: jest.fn().mockResolvedValue(undefined),
  },
  dialog: {
    showMessageBox: jest.fn().mockResolvedValue({ response: 0 }),
  },
  BrowserWindow: {
    getAllWindows: jest.fn(() => []),
  },
}));

// Mock Sentry
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
}));

// Mock better-sqlite3-multiple-ciphers
// Return a schema_version that says we're at the latest version,
// so no versioned migrations are attempted.
const mockPrepareGet = jest.fn().mockReturnValue({ version: 9999 });
const mockPrepareRun = jest.fn();
const mockDb = {
  pragma: jest.fn(),
  exec: jest.fn(),
  prepare: jest.fn(() => ({
    get: mockPrepareGet,
    all: jest.fn().mockReturnValue([]),
    run: mockPrepareRun,
  })),
  close: jest.fn(),
  transaction: jest.fn((callback: () => void) => {
    return () => callback();
  }),
};

jest.mock("better-sqlite3-multiple-ciphers", () => {
  return jest.fn(() => mockDb);
});

// Mock fs
jest.mock("fs", () => ({
  existsSync: jest.fn().mockReturnValue(false),
  mkdirSync: jest.fn(),
  readFileSync: jest.fn().mockReturnValue("-- schema SQL"),
  readdirSync: jest.fn(() => []),
  copyFileSync: jest.fn(),
  unlinkSync: jest.fn(),
  statSync: jest.fn(() => ({ size: 1024 })),
}));

// Mock crypto
jest.mock("crypto", () => ({
  randomUUID: jest.fn(() => "test-uuid-1234"),
  randomBytes: jest.fn(() => Buffer.from("random-bytes-for-testing")),
}));

// Mock databaseEncryptionService
jest.mock("../databaseEncryptionService", () => ({
  databaseEncryptionService: {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("test-encryption-key-hex"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false),
  },
}));

// Mock logService
jest.mock("../logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  },
}));

// Mock electron-log
jest.mock("electron-log", () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// Mock the initializationBroadcaster
const mockBroadcast = jest.fn();
jest.mock("../initializationBroadcaster", () => ({
  initializationBroadcaster: {
    broadcast: mockBroadcast,
    getCurrentStage: jest.fn().mockReturnValue({ stage: "idle" }),
    reset: jest.fn(),
  },
}));

// Mock db/core/dbConnection
jest.mock("../db/core/dbConnection", () => ({
  setDb: jest.fn(),
  setDbPath: jest.fn(),
  setEncryptionKey: jest.fn(),
  closeDb: jest.fn(),
  vacuumDb: jest.fn(),
}));

// Mock all domain db services (required by databaseService imports)
jest.mock("../db/userDbService", () => ({}));
jest.mock("../db/sessionDbService", () => ({}));
jest.mock("../db/oauthTokenDbService", () => ({}));
jest.mock("../db/transactionDbService", () => ({}));
jest.mock("../db/contactDbService", () => ({}));
jest.mock("../db/transactionContactDbService", () => ({}));
jest.mock("../db/communicationDbService", () => ({}));
jest.mock("../db/feedbackDbService", () => ({}));
jest.mock("../db/auditLogDbService", () => ({}));
jest.mock("../db/messageDbService", () => ({}));
jest.mock("../db/diagnosticDbService", () => ({}));
jest.mock("../db/attachmentDbService", () => ({}));
jest.mock("../db/submissionDbService", () => ({}));
jest.mock("../db/syncDbService", () => ({}));
jest.mock("../db/maintenanceDbService", () => ({}));

// Import after mocks
import databaseService from "../databaseService";

describe("DatabaseService - InitializationBroadcaster Integration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset the databaseService internal state by closing
    try {
      databaseService.close();
    } catch {
      // May not be initialized
    }
  });

  describe("initialize() broadcasts", () => {
    // BACKLOG-2171: initialize() now broadcasts "starting" synchronously as
    // its very first action (before db-opening) so whenDbReady() waiters can
    // distinguish "init genuinely in flight" from bare "idle" (deferred init
    // that hasn't been kicked off) without a window where init is running
    // but the broadcaster still reads idle.
    it("should broadcast starting as the very first call", async () => {
      await databaseService.initialize();

      const firstCall = mockBroadcast.mock.calls[0];
      expect(firstCall[0].stage).toBe("starting");
    });

    it("should broadcast db-opening before opening the database", async () => {
      await databaseService.initialize();

      expect(mockBroadcast).toHaveBeenCalledWith({
        stage: "db-opening",
        message: "Opening secure database...",
      });

      // db-opening should be the second broadcast call, right after "starting"
      const stages = mockBroadcast.mock.calls.map(
        (call: unknown[]) => (call[0] as { stage: string }).stage,
      );
      expect(stages[0]).toBe("starting");
      expect(stages[1]).toBe("db-opening");
    });

    it("should broadcast migrating before running migrations", async () => {
      await databaseService.initialize();

      expect(mockBroadcast).toHaveBeenCalledWith({
        stage: "migrating",
        progress: 0,
        message: "Updating database...",
      });
    });

    it("should broadcast db-ready after successful migrations", async () => {
      await databaseService.initialize();

      expect(mockBroadcast).toHaveBeenCalledWith({
        stage: "db-ready",
        message: "Database ready",
      });
    });

    it("should broadcast stages in correct order: db-opening -> migrating -> db-ready", async () => {
      await databaseService.initialize();

      const stages = mockBroadcast.mock.calls.map(
        (call: unknown[]) => (call[0] as { stage: string }).stage,
      );

      const dbOpeningIdx = stages.indexOf("db-opening");
      const migratingIdx = stages.indexOf("migrating");
      const dbReadyIdx = stages.indexOf("db-ready");

      expect(dbOpeningIdx).toBeGreaterThanOrEqual(0);
      expect(migratingIdx).toBeGreaterThan(dbOpeningIdx);
      expect(dbReadyIdx).toBeGreaterThan(migratingIdx);
    });

    it("should broadcast error when initialization fails", async () => {
      // Make encryption service throw
      const { databaseEncryptionService } = require("../databaseEncryptionService");
      databaseEncryptionService.initialize.mockRejectedValueOnce(
        new Error("Encryption failed"),
      );

      await expect(databaseService.initialize()).rejects.toThrow(
        "Encryption failed",
      );

      expect(mockBroadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: "error",
          error: expect.objectContaining({
            message: "Encryption failed",
            retryable: true,
          }),
        }),
      );
    });

    it("should broadcast error with retryable flag on migration failure", async () => {
      // Make schema.sql exec throw (simulating migration failure)
      // _ensureFailureLogTable exec succeeds, schema exec (runMigrations) throws
      let execCallCount = 0;
      mockDb.exec.mockImplementation(() => {
        execCallCount++;
        // The first exec is _ensureFailureLogTable (CREATE TABLE IF NOT EXISTS),
        // the second exec is schema.sql in runMigrations
        if (execCallCount === 2) {
          throw new Error("Migration v35 failed: disk full");
        }
      });

      // initialize() should not throw — migration errors are caught internally
      await databaseService.initialize();

      expect(mockBroadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: "error",
          error: expect.objectContaining({
            message: "Migration v35 failed: disk full",
            retryable: true,
          }),
        }),
      );

      // Reset exec mock
      mockDb.exec.mockReset();
    });

    it("should not broadcast when already initialized", async () => {
      await databaseService.initialize();
      mockBroadcast.mockClear();

      // Second call should skip
      await databaseService.initialize();
      expect(mockBroadcast).not.toHaveBeenCalled();
    });
  });
});
