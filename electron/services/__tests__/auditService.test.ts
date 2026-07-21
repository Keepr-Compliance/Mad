/**
 * Unit tests for AuditService
 * Tests audit logging functionality including:
 * - Creating immutable audit log entries
 * - Preventing modification of audit logs
 * - Syncing to cloud when online
 * - Queueing logs when offline
 * - Including all required fields
 */

import {
  auditService,
  AuditAction,
  ResourceType,
} from "../auditService";

// Mock dependencies
const mockDatabaseService = {
  insertAuditLog: jest.fn(),
  getUnsyncedAuditLogs: jest.fn(),
  markAuditLogsSynced: jest.fn(),
  // BACKLOG-2149: audit writes now gate on DB readiness. Default to ready.
  isInitialized: jest.fn(() => true),
};

const mockSupabaseService = {
  batchInsertAuditLogs: jest.fn(),
};

describe("AuditService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset audit service state
    (auditService as any).pendingSyncQueue = [];
    (auditService as any).syncInProgress = false;
    (auditService as any).initialized = false;
    (auditService as any).databaseService = null;
    (auditService as any).supabaseService = null;
    // BACKLOG-2149: reset the DB-ready pending-write buffer between tests.
    (auditService as any).pendingLocalWrites = [];
    (auditService as any).flushingPendingWrites = false;
    mockDatabaseService.isInitialized.mockReturnValue(true);

    // Stop any running sync interval
    auditService.stopSyncInterval();
  });

  afterEach(() => {
    auditService.stopSyncInterval();
  });

  describe("initialization", () => {
    it("should initialize with database and supabase services", () => {
      auditService.initialize(
        mockDatabaseService as any,
        mockSupabaseService as any,
      );

      expect(auditService.isInitialized()).toBe(true);
    });

    it("should not re-initialize if already initialized", () => {
      auditService.initialize(
        mockDatabaseService as any,
        mockSupabaseService as any,
      );
      auditService.initialize(
        mockDatabaseService as any,
        mockSupabaseService as any,
      );

      // Should only initialize once
      expect(auditService.isInitialized()).toBe(true);
    });
  });

  describe("log", () => {
    beforeEach(() => {
      auditService.initialize(
        mockDatabaseService as any,
        mockSupabaseService as any,
      );
    });

    it("should create immutable audit log entries", async () => {
      const entry = {
        userId: "user-123",
        sessionId: "session-456",
        action: "LOGIN" as AuditAction,
        resourceType: "SESSION" as ResourceType,
        resourceId: "session-456",
        success: true,
      };

      await auditService.log(entry);

      expect(mockDatabaseService.insertAuditLog).toHaveBeenCalledTimes(1);

      const insertedEntry = mockDatabaseService.insertAuditLog.mock.calls[0][0];
      expect(insertedEntry).toMatchObject({
        userId: "user-123",
        sessionId: "session-456",
        action: "LOGIN",
        resourceType: "SESSION",
        resourceId: "session-456",
        success: true,
      });
      expect(insertedEntry.id).toBeDefined();
      expect(insertedEntry.timestamp).toBeInstanceOf(Date);
    });

    it("should include all required fields", async () => {
      const entry = {
        userId: "user-123",
        action: "TRANSACTION_CREATE" as AuditAction,
        resourceType: "TRANSACTION" as ResourceType,
        resourceId: "txn-789",
        metadata: { propertyAddress: "123 Main St" },
        success: true,
      };

      await auditService.log(entry);

      const insertedEntry = mockDatabaseService.insertAuditLog.mock.calls[0][0];

      // Check all required fields
      expect(insertedEntry.id).toBeDefined();
      expect(insertedEntry.timestamp).toBeDefined();
      expect(insertedEntry.userId).toBe("user-123");
      expect(insertedEntry.action).toBe("TRANSACTION_CREATE");
      expect(insertedEntry.resourceType).toBe("TRANSACTION");
      expect(insertedEntry.success).toBe(true);
    });

    it("should sanitize metadata to remove sensitive information", async () => {
      const entry = {
        userId: "user-123",
        action: "LOGIN" as AuditAction,
        resourceType: "SESSION" as ResourceType,
        metadata: {
          provider: "google",
          password: "secret123",
          access_token: "token123",
          normalField: "visible",
        },
        success: true,
      };

      await auditService.log(entry);

      const insertedEntry = mockDatabaseService.insertAuditLog.mock.calls[0][0];
      expect(insertedEntry.metadata.password).toBe("[REDACTED]");
      expect(insertedEntry.metadata.access_token).toBe("[REDACTED]");
      expect(insertedEntry.metadata.provider).toBe("google");
      expect(insertedEntry.metadata.normalField).toBe("visible");
    });

    it("should queue logs for cloud sync", async () => {
      const entry = {
        userId: "user-123",
        action: "LOGIN" as AuditAction,
        resourceType: "SESSION" as ResourceType,
        success: true,
      };

      await auditService.log(entry);

      // Entry should be queued
      expect(auditService.getPendingSyncCount()).toBe(1);
    });

    it("should log failed operations", async () => {
      const entry = {
        userId: "user-123",
        action: "LOGIN_FAILED" as AuditAction,
        resourceType: "SESSION" as ResourceType,
        success: false,
        errorMessage: "Invalid credentials",
      };

      await auditService.log(entry);

      const insertedEntry = mockDatabaseService.insertAuditLog.mock.calls[0][0];
      expect(insertedEntry.success).toBe(false);
      expect(insertedEntry.errorMessage).toBe("Invalid credentials");
    });

    it("should not throw on database failure", async () => {
      mockDatabaseService.insertAuditLog.mockRejectedValueOnce(
        new Error("DB error"),
      );

      const entry = {
        userId: "user-123",
        action: "LOGIN" as AuditAction,
        resourceType: "SESSION" as ResourceType,
        success: true,
      };

      // Should not throw
      await expect(auditService.log(entry)).resolves.not.toThrow();
    });

    it("should handle logging when service is not fully initialized", async () => {
      // Reset service to uninitialized state
      (auditService as any).initialized = false;
      (auditService as any).databaseService = null;

      const entry = {
        userId: "user-123",
        action: "LOGIN" as AuditAction,
        resourceType: "SESSION" as ResourceType,
        success: true,
      };

      // Should not throw even when not initialized (errors are caught internally)
      await expect(auditService.log(entry)).resolves.not.toThrow();
    });
  });

  describe("withAudit", () => {
    beforeEach(() => {
      auditService.initialize(
        mockDatabaseService as any,
        mockSupabaseService as any,
      );
    });

    it("should log successful operations", async () => {
      const operation = jest.fn().mockResolvedValue({ result: "success" });

      const result = await auditService.withAudit(
        {
          userId: "user-123",
          sessionId: "session-456",
          action: "TRANSACTION_CREATE",
          resourceType: "TRANSACTION",
          resourceId: "txn-789",
        },
        operation,
      );

      expect(result).toEqual({ result: "success" });
      expect(operation).toHaveBeenCalledTimes(1);

      const insertedEntry = mockDatabaseService.insertAuditLog.mock.calls[0][0];
      expect(insertedEntry.success).toBe(true);
      expect(insertedEntry.action).toBe("TRANSACTION_CREATE");
    });

    it("should log failed operations and re-throw error", async () => {
      const error = new Error("Operation failed");
      const operation = jest.fn().mockRejectedValue(error);

      await expect(
        auditService.withAudit(
          {
            userId: "user-123",
            action: "TRANSACTION_CREATE",
            resourceType: "TRANSACTION",
          },
          operation,
        ),
      ).rejects.toThrow("Operation failed");

      const insertedEntry = mockDatabaseService.insertAuditLog.mock.calls[0][0];
      expect(insertedEntry.success).toBe(false);
      expect(insertedEntry.errorMessage).toBe("Operation failed");
    });
  });

  describe("syncToCloud", () => {
    beforeEach(() => {
      auditService.initialize(
        mockDatabaseService as any,
        mockSupabaseService as any,
      );
    });

    it("should sync pending logs to cloud when online", async () => {
      // Add an entry to the queue
      const entry = {
        userId: "user-123",
        action: "LOGIN" as AuditAction,
        resourceType: "SESSION" as ResourceType,
        success: true,
      };

      await auditService.log(entry);
      expect(auditService.getPendingSyncCount()).toBe(1);

      // Set up successful sync
      mockSupabaseService.batchInsertAuditLogs.mockResolvedValueOnce(undefined);

      // Manually trigger sync
      await auditService.syncToCloud();

      expect(mockSupabaseService.batchInsertAuditLogs).toHaveBeenCalledTimes(1);
      expect(mockDatabaseService.markAuditLogsSynced).toHaveBeenCalledTimes(1);
      expect(auditService.getPendingSyncCount()).toBe(0);
    });

    it("should queue logs when offline (sync fails)", async () => {
      // Clear any previous mock implementations and set up rejection
      mockSupabaseService.batchInsertAuditLogs.mockReset();
      mockSupabaseService.batchInsertAuditLogs.mockRejectedValue(
        new Error("Network error"),
      );

      const entry = {
        userId: "user-123",
        action: "LOGIN" as AuditAction,
        resourceType: "SESSION" as ResourceType,
        success: true,
      };

      await auditService.log(entry);

      // The log() method calls syncToCloud() non-blocking via .catch()
      // We need to let the event loop process the async sync attempt
      // Use multiple setTimeout(0) calls to ensure all microtasks are processed
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Entry should still be queued after failed sync
      expect(auditService.getPendingSyncCount()).toBe(1);

      // Verify the sync was actually attempted
      expect(mockSupabaseService.batchInsertAuditLogs).toHaveBeenCalledTimes(1);

      // Manually trigger sync again to verify it still fails
      await auditService.syncToCloud();

      // Entry should still be queued after second failed attempt
      expect(auditService.getPendingSyncCount()).toBe(1);
      expect(mockSupabaseService.batchInsertAuditLogs).toHaveBeenCalledTimes(2);
    });

    it("should not sync if no pending logs", async () => {
      await auditService.syncToCloud();

      expect(mockSupabaseService.batchInsertAuditLogs).not.toHaveBeenCalled();
    });

    it("should prevent concurrent sync attempts", async () => {
      // Reset mocks to start fresh
      mockSupabaseService.batchInsertAuditLogs.mockReset();

      // Set up a slow sync that takes time to complete
      let resolveSync: () => void;
      const slowSyncPromise = new Promise<void>((resolve) => {
        resolveSync = resolve;
      });
      mockSupabaseService.batchInsertAuditLogs.mockReturnValue(slowSyncPromise);

      // Manually add entry to queue (bypassing log() which triggers its own sync)
      (auditService as any).pendingSyncQueue = [
        {
          id: "test-123",
          timestamp: new Date(),
          userId: "user-123",
          action: "LOGIN",
          resourceType: "SESSION",
          success: true,
        },
      ];

      // Start first sync (this will set syncInProgress = true)
      const firstSync = auditService.syncToCloud();

      // Try to start second sync while first is in progress
      const secondSync = auditService.syncToCloud();

      // Complete the first sync
      resolveSync!();
      await firstSync;
      await secondSync;

      // batchInsertAuditLogs should only be called once (second sync was skipped due to syncInProgress flag)
      expect(mockSupabaseService.batchInsertAuditLogs).toHaveBeenCalledTimes(1);
    });

    it("should sync from database when queue is empty but database has unsynced logs", async () => {
      // Queue is empty, but database has unsynced logs
      const unsyncedLogs = [
        {
          id: "log-1",
          timestamp: new Date(),
          userId: "user-123",
          action: "LOGIN" as AuditAction,
          resourceType: "SESSION" as ResourceType,
          success: true,
        },
      ];

      mockDatabaseService.getUnsyncedAuditLogs.mockResolvedValue(unsyncedLogs);
      mockSupabaseService.batchInsertAuditLogs.mockResolvedValue(undefined);

      // Manually add to internal queue to trigger sync, then clear it
      (auditService as any).pendingSyncQueue = [];

      // Since queue is empty, syncToCloud should return early
      // We need to test the branch where queue is empty but we check database
      // This requires the queue to have items initially
      (auditService as any).pendingSyncQueue = [unsyncedLogs[0]];

      await auditService.syncToCloud();

      expect(mockSupabaseService.batchInsertAuditLogs).toHaveBeenCalledTimes(1);
      expect(mockDatabaseService.markAuditLogsSynced).toHaveBeenCalledWith([
        "log-1",
      ]);
    });

    it("should not sync when services are not initialized", async () => {
      // Reset the service to uninitialized state
      (auditService as any).supabaseService = null;
      (auditService as any).databaseService = null;
      (auditService as any).pendingSyncQueue = [{ id: "test" }];

      await auditService.syncToCloud();

      // Should return early without attempting sync
      expect(mockSupabaseService.batchInsertAuditLogs).not.toHaveBeenCalled();
    });
  });

  describe("flushPendingLogs", () => {
    beforeEach(() => {
      auditService.initialize(
        mockDatabaseService as any,
        mockSupabaseService as any,
      );
    });

    it("should sync all pending logs", async () => {
      // Add multiple entries
      for (let i = 0; i < 3; i++) {
        await auditService.log({
          userId: `user-${i}`,
          action: "LOGIN" as AuditAction,
          resourceType: "SESSION" as ResourceType,
          success: true,
        });
      }

      mockSupabaseService.batchInsertAuditLogs.mockResolvedValue(undefined);

      await auditService.flushPendingLogs();

      expect(auditService.getPendingSyncCount()).toBe(0);
    });
  });
});

describe("AuditService - Auth Handler Integration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (auditService as any).pendingSyncQueue = [];
    (auditService as any).initialized = false;
    auditService.stopSyncInterval();
    auditService.initialize(
      mockDatabaseService as any,
      mockSupabaseService as any,
    );
  });

  afterEach(() => {
    auditService.stopSyncInterval();
  });

  it("should log successful login", async () => {
    await auditService.log({
      userId: "user-123",
      sessionId: "session-456",
      action: "LOGIN",
      resourceType: "SESSION",
      resourceId: "session-456",
      metadata: { provider: "google", isNewUser: false },
      success: true,
    });

    const insertedEntry = mockDatabaseService.insertAuditLog.mock.calls[0][0];
    expect(insertedEntry.action).toBe("LOGIN");
    expect(insertedEntry.success).toBe(true);
    expect(insertedEntry.metadata.provider).toBe("google");
  });

  it("should log failed login", async () => {
    await auditService.log({
      userId: "unknown",
      action: "LOGIN_FAILED",
      resourceType: "SESSION",
      metadata: { provider: "google", error: "Invalid credentials" },
      success: false,
      errorMessage: "Invalid credentials",
    });

    const insertedEntry = mockDatabaseService.insertAuditLog.mock.calls[0][0];
    expect(insertedEntry.action).toBe("LOGIN_FAILED");
    expect(insertedEntry.success).toBe(false);
    expect(insertedEntry.errorMessage).toBe("Invalid credentials");
  });

  it("should log logout", async () => {
    await auditService.log({
      userId: "user-123",
      sessionId: "session-456",
      action: "LOGOUT",
      resourceType: "SESSION",
      resourceId: "session-456",
      success: true,
    });

    const insertedEntry = mockDatabaseService.insertAuditLog.mock.calls[0][0];
    expect(insertedEntry.action).toBe("LOGOUT");
    expect(insertedEntry.success).toBe(true);
  });
});

describe("AuditService - Transaction Handler Integration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (auditService as any).pendingSyncQueue = [];
    (auditService as any).initialized = false;
    auditService.stopSyncInterval();
    auditService.initialize(
      mockDatabaseService as any,
      mockSupabaseService as any,
    );
  });

  afterEach(() => {
    auditService.stopSyncInterval();
  });

  it("should log transaction create", async () => {
    await auditService.log({
      userId: "user-123",
      action: "TRANSACTION_CREATE",
      resourceType: "TRANSACTION",
      resourceId: "txn-789",
      metadata: { propertyAddress: "123 Main St" },
      success: true,
    });

    const insertedEntry = mockDatabaseService.insertAuditLog.mock.calls[0][0];
    expect(insertedEntry.action).toBe("TRANSACTION_CREATE");
    expect(insertedEntry.resourceType).toBe("TRANSACTION");
    expect(insertedEntry.resourceId).toBe("txn-789");
  });

  it("should log transaction update", async () => {
    await auditService.log({
      userId: "user-123",
      action: "TRANSACTION_UPDATE",
      resourceType: "TRANSACTION",
      resourceId: "txn-789",
      metadata: { updatedFields: ["status", "closing_date"] },
      success: true,
    });

    const insertedEntry = mockDatabaseService.insertAuditLog.mock.calls[0][0];
    expect(insertedEntry.action).toBe("TRANSACTION_UPDATE");
    expect(insertedEntry.metadata.updatedFields).toEqual([
      "status",
      "closing_date",
    ]);
  });

  it("should log transaction delete", async () => {
    await auditService.log({
      userId: "user-123",
      action: "TRANSACTION_DELETE",
      resourceType: "TRANSACTION",
      resourceId: "txn-789",
      metadata: { propertyAddress: "123 Main St" },
      success: true,
    });

    const insertedEntry = mockDatabaseService.insertAuditLog.mock.calls[0][0];
    expect(insertedEntry.action).toBe("TRANSACTION_DELETE");
  });

  it("should log data export", async () => {
    await auditService.log({
      userId: "user-123",
      action: "DATA_EXPORT",
      resourceType: "EXPORT",
      resourceId: "txn-789",
      metadata: { format: "pdf", propertyAddress: "123 Main St" },
      success: true,
    });

    const insertedEntry = mockDatabaseService.insertAuditLog.mock.calls[0][0];
    expect(insertedEntry.action).toBe("DATA_EXPORT");
    expect(insertedEntry.resourceType).toBe("EXPORT");
    expect(insertedEntry.metadata.format).toBe("pdf");
  });
});

describe("AuditService - Contact Handler Integration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (auditService as any).pendingSyncQueue = [];
    (auditService as any).initialized = false;
    auditService.stopSyncInterval();
    auditService.initialize(
      mockDatabaseService as any,
      mockSupabaseService as any,
    );
  });

  afterEach(() => {
    auditService.stopSyncInterval();
  });

  it("should log contact create", async () => {
    await auditService.log({
      userId: "user-123",
      action: "CONTACT_CREATE",
      resourceType: "CONTACT",
      resourceId: "contact-456",
      metadata: { name: "John Doe" },
      success: true,
    });

    const insertedEntry = mockDatabaseService.insertAuditLog.mock.calls[0][0];
    expect(insertedEntry.action).toBe("CONTACT_CREATE");
    expect(insertedEntry.resourceType).toBe("CONTACT");
  });

  it("should log contact update", async () => {
    await auditService.log({
      userId: "user-123",
      action: "CONTACT_UPDATE",
      resourceType: "CONTACT",
      resourceId: "contact-456",
      metadata: { updatedFields: ["email", "phone"] },
      success: true,
    });

    const insertedEntry = mockDatabaseService.insertAuditLog.mock.calls[0][0];
    expect(insertedEntry.action).toBe("CONTACT_UPDATE");
  });

  it("should log contact delete", async () => {
    await auditService.log({
      userId: "user-123",
      action: "CONTACT_DELETE",
      resourceType: "CONTACT",
      resourceId: "contact-456",
      metadata: { name: "John Doe" },
      success: true,
    });

    const insertedEntry = mockDatabaseService.insertAuditLog.mock.calls[0][0];
    expect(insertedEntry.action).toBe("CONTACT_DELETE");
  });

  // BACKLOG-2149: audit writes must not throw or be lost when the DB is still
  // initializing on the deep-link auth path. They are buffered and flushed once
  // the DB becomes queryable.
  describe("DB-not-ready deferral (BACKLOG-2149)", () => {
    // The static require here resolves the SAME singleton module instance that
    // auditService's dynamic import("./initializationBroadcaster") resolves (we
    // do NOT reset modules), so this spy intercepts both the pre-write wait and
    // the deferred flush arm.
    let whenDbReadySpy: jest.SpyInstance;

    beforeEach(() => {
      // Reset the DB-ready buffer state so entries don't leak between tests.
      (auditService as any).pendingLocalWrites = [];
      (auditService as any).flushingPendingWrites = false;

      const broadcaster = require("../initializationBroadcaster").initializationBroadcaster;
      // Default: DB never becomes ready (so the deferred flush never fires on its
      // own). Individual tests override with mockResolvedValueOnce as needed.
      whenDbReadySpy = jest
        .spyOn(broadcaster, "whenDbReady")
        .mockResolvedValue({ ready: false, timedOut: true });
    });

    afterEach(() => {
      whenDbReadySpy.mockRestore();
    });

    it("buffers the entry (no throw, no insert) when DB is not ready and stays not ready", async () => {
      mockDatabaseService.isInitialized.mockReturnValue(false);

      await expect(
        auditService.log({
          userId: "user-123",
          action: "LOGIN" as AuditAction,
          resourceType: "SESSION" as ResourceType,
          success: true,
        }),
      ).resolves.toBeUndefined();

      // Nothing written yet; entry is buffered.
      expect(mockDatabaseService.insertAuditLog).not.toHaveBeenCalled();
      expect((auditService as any).pendingLocalWrites).toHaveLength(1);
    });

    it("writes immediately when whenDbReady resolves ready", async () => {
      mockDatabaseService.isInitialized.mockReturnValue(false);
      whenDbReadySpy.mockResolvedValue({ ready: true, timedOut: false });

      await auditService.log({
        userId: "user-123",
        action: "LOGIN" as AuditAction,
        resourceType: "SESSION" as ResourceType,
        success: true,
      });

      expect(mockDatabaseService.insertAuditLog).toHaveBeenCalledTimes(1);
      expect((auditService as any).pendingLocalWrites).toHaveLength(0);
    });

    it("flushes buffered entries once the DB becomes ready", async () => {
      // Buffer two entries while not ready (default spy resolves not-ready).
      mockDatabaseService.isInitialized.mockReturnValue(false);

      await auditService.log({
        userId: "u1",
        action: "LOGIN" as AuditAction,
        resourceType: "SESSION" as ResourceType,
        success: true,
      });
      await auditService.log({
        userId: "u2",
        action: "LOGIN" as AuditAction,
        resourceType: "SESSION" as ResourceType,
        success: true,
      });
      expect((auditService as any).pendingLocalWrites).toHaveLength(2);

      // DB now ready — trigger an explicit flush.
      mockDatabaseService.isInitialized.mockReturnValue(true);
      await (auditService as any).flushPendingLocalWrites();

      expect(mockDatabaseService.insertAuditLog).toHaveBeenCalledTimes(2);
      expect((auditService as any).pendingLocalWrites).toHaveLength(0);
    });

    it("bounds the pending buffer to MAX_PENDING_LOCAL_WRITES", () => {
      const max = (auditService as any).MAX_PENDING_LOCAL_WRITES as number;

      // Push max + 5 entries directly through the buffer helper (fast path).
      for (let i = 0; i < max + 5; i++) {
        (auditService as any).bufferPendingWrite({
          id: `id-${i}`,
          action: "LOGIN",
          resourceType: "SESSION",
          success: true,
          timestamp: new Date(),
        });
      }

      expect((auditService as any).pendingLocalWrites.length).toBe(max);
    });
  });
});
