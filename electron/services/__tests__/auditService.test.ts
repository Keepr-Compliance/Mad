/**
 * Unit tests for AuditService
 * Tests audit logging functionality including:
 * - Creating immutable audit log entries
 * - Preventing modification of audit logs
 * - Syncing to cloud when online
 * - Queueing logs when offline
 * - Including all required fields
 */

import * as Sentry from "@sentry/electron/main";
import {
  auditService,
  AuditAction,
  AuditLogEntry,
  ResourceType,
} from "../auditService";

// Mock dependencies
const mockDatabaseService = {
  insertAuditLog: jest.fn(),
  // BACKLOG-3339
  isInTransaction: jest.fn(() => false),
  getUnsyncedAuditLogs: jest.fn(),
  markAuditLogsSynced: jest.fn(),
  // BACKLOG-2149: audit writes now gate on DB readiness. Default to ready.
  isInitialized: jest.fn(() => true),
};

const mockSupabaseService = {
  batchInsertAuditLogs: jest.fn(),
  // BACKLOG-3987: only the signed-in user's entries are sent.
  getAuthSession: jest.fn(async () => ({ userId: "user-123" })),
};

describe("AuditService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset audit service state
    (auditService as any).pendingSyncQueue = [];
    (auditService as any).syncInProgress = false;
    (auditService as any).currentSync = null;
    (auditService as any).initialized = false;
    (auditService as any).databaseService = null;
    (auditService as any).supabaseService = null;
    // BACKLOG-2149: reset the DB-ready pending-write buffer between tests.
    (auditService as any).pendingLocalWrites = [];
    (auditService as any).flushingPendingWrites = false;
    (auditService as any).cloudSyncFailing = false;
    mockDatabaseService.isInitialized.mockReturnValue(true);
    mockSupabaseService.getAuthSession.mockImplementation(async () => ({
      userId: "user-123",
    }));
    // BACKLOG-3987: the table fallback is live; default it to empty.
    mockDatabaseService.getUnsyncedAuditLogs.mockReset();
    mockDatabaseService.getUnsyncedAuditLogs.mockResolvedValue([]);

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

  // BACKLOG-3339: withAudit (0 product callers) was deleted; recordFailure
  // (after a rollback) replaces its failure half.
  describe("recordFailure (BACKLOG-3339)", () => {
    beforeEach(() => {
      mockDatabaseService.isInTransaction.mockReset();
      auditService.initialize(
        mockDatabaseService as any,
        mockSupabaseService as any,
      );
    });

    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    it("recordFailure writes a success:false entry and queues it", async () => {
      mockDatabaseService.isInTransaction.mockReturnValue(false);
      mockSupabaseService.getAuthSession.mockImplementation(async () => null as never);
      auditService.recordFailure({
        userId: "user-123",
        action: "TRANSACTION_CREATE",
        resourceType: "TRANSACTION",
        errorMessage: "Operation failed",
      });
      await settle();
      const written = mockDatabaseService.insertAuditLog.mock.calls[0][0];
      expect(written.success).toBe(false);
      expect(written.errorMessage).toBe("Operation failed");
      expect(auditService.getPendingSyncCount()).toBe(1);
    });

    it("recordFailure never throws when its own write fails, and reports once to Sentry", async () => {
      mockDatabaseService.isInTransaction.mockReturnValue(false);
      mockDatabaseService.insertAuditLog.mockRejectedValueOnce(new Error("disk I/O error"));
      const original = new Error("the user's real error");
      const run = () => {
        try {
          throw original;
        } catch (err) {
          auditService.recordFailure({
            userId: "user-123",
            action: "TRANSACTION_CREATE",
            resourceType: "TRANSACTION",
            errorMessage: (err as Error).message,
          });
          throw err;
        }
      };
      expect(run).toThrow(original);
      await settle();
      expect(mockDatabaseService.insertAuditLog).toHaveBeenCalledTimes(1);
      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
      expect((Sentry.captureException as jest.Mock).mock.calls[0][0].message).toBe("disk I/O error");
    });

    it("recordFailure refuses to write inside a transaction", async () => {
      mockDatabaseService.isInTransaction.mockReturnValue(true);
      auditService.recordFailure({
        userId: "user-123",
        action: "TRANSACTION_CREATE",
        resourceType: "TRANSACTION",
      });
      await settle();
      expect(mockDatabaseService.insertAuditLog).not.toHaveBeenCalled();
      expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
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

    it("sends rows left unsynced by a previous run when the queue is empty (BACKLOG-3987)", async () => {
      // A restart: the in-memory queue is gone, the rows are still in the
      // local table with synced_at NULL.
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
      expect(auditService.getPendingSyncCount()).toBe(0);

      await auditService.syncToCloud();

      expect(mockDatabaseService.getUnsyncedAuditLogs).toHaveBeenCalledWith(
        100,
        "user-123",
      );
      expect(mockSupabaseService.batchInsertAuditLogs).toHaveBeenCalledTimes(1);
      expect(
        mockSupabaseService.batchInsertAuditLogs.mock.calls[0][0].map(
          (e: AuditLogEntry) => e.id,
        ),
      ).toEqual(["log-1"]);
      expect(mockDatabaseService.markAuditLogsSynced).toHaveBeenCalledWith([
        "log-1",
      ]);
    });

    it("asks the table only for the signed-in user's rows (BACKLOG-3987)", async () => {
      // The mock honours the userId argument the way the SQL does, so a
      // query that drops it returns the other account's row first.
      const rows: AuditLogEntry[] = [
        {
          id: "other-1",
          timestamp: new Date("2026-01-01T00:00:00Z"),
          userId: "user-other",
          action: "LOGIN" as AuditAction,
          resourceType: "SESSION" as ResourceType,
          success: true,
        },
        {
          id: "mine-1",
          timestamp: new Date("2026-01-02T00:00:00Z"),
          userId: "user-123",
          action: "LOGIN" as AuditAction,
          resourceType: "SESSION" as ResourceType,
          success: true,
        },
      ];
      mockDatabaseService.getUnsyncedAuditLogs.mockImplementation(
        async (limit: number, userId?: string) =>
          rows.filter((r) => userId === undefined || r.userId === userId).slice(0, limit),
      );
      mockSupabaseService.batchInsertAuditLogs.mockResolvedValue(undefined);

      await auditService.syncToCloud();

      const sent = mockSupabaseService.batchInsertAuditLogs.mock.calls.flatMap(
        (c: AuditLogEntry[][]) => c[0].map((e) => e.id),
      );
      expect(sent).toEqual(["mine-1"]);
      expect(mockDatabaseService.markAuditLogsSynced).toHaveBeenCalledWith([
        "mine-1",
      ]);
    });

    it("never sends another account's queued entry, and it does not hold the queue (BACKLOG-3987)", async () => {
      const base = {
        action: "LOGIN" as AuditAction,
        resourceType: "SESSION" as ResourceType,
        success: true,
      };
      // An account switch: the queue still holds the previous user's entry,
      // ahead of the signed-in user's.
      (auditService as any).pendingSyncQueue = [
        { ...base, id: "other-q", timestamp: new Date(), userId: "user-other" },
        { ...base, id: "mine-q", timestamp: new Date(), userId: "user-123" },
      ];
      mockSupabaseService.batchInsertAuditLogs.mockResolvedValue(undefined);

      await auditService.syncToCloud();

      const sent = mockSupabaseService.batchInsertAuditLogs.mock.calls.flatMap(
        (c: AuditLogEntry[][]) => c[0].map((e) => e.id),
      );
      expect(sent).toEqual(["mine-q"]);
      expect(mockDatabaseService.markAuditLogsSynced).not.toHaveBeenCalledWith(
        expect.arrayContaining(["other-q"]),
      );
      expect(auditService.getPendingSyncCount()).toBe(0);
    });

    it("sends nothing when nobody is signed in (BACKLOG-3987)", async () => {
      mockSupabaseService.getAuthSession.mockResolvedValue(null as never);
      (auditService as any).pendingSyncQueue = [
        {
          id: "q-1",
          timestamp: new Date(),
          userId: "user-123",
          action: "LOGIN",
          resourceType: "SESSION",
          success: true,
        },
      ];

      await auditService.syncToCloud();

      expect(mockSupabaseService.batchInsertAuditLogs).not.toHaveBeenCalled();
      expect(mockDatabaseService.getUnsyncedAuditLogs).not.toHaveBeenCalled();
      expect(auditService.getPendingSyncCount()).toBe(1);
    });

    it("reports a run of failed sends to Sentry once, not once per attempt (BACKLOG-3987)", async () => {
      (Sentry.captureException as jest.Mock).mockClear();
      mockSupabaseService.batchInsertAuditLogs.mockReset();
      mockSupabaseService.batchInsertAuditLogs.mockRejectedValue(
        new Error("fetch failed"),
      );
      (auditService as any).pendingSyncQueue = [
        {
          id: "q-1",
          timestamp: new Date(),
          userId: "user-123",
          action: "LOGIN",
          resourceType: "SESSION",
          success: true,
        },
      ];

      await auditService.syncToCloud();
      await auditService.syncToCloud();
      await auditService.syncToCloud();

      expect(mockSupabaseService.batchInsertAuditLogs).toHaveBeenCalledTimes(3);
      expect(Sentry.captureException).toHaveBeenCalledTimes(1);

      // A success ends the run; the next failure is a new run and is reported.
      mockSupabaseService.batchInsertAuditLogs.mockResolvedValueOnce(undefined);
      await auditService.syncToCloud();
      (auditService as any).pendingSyncQueue = [
        {
          id: "q-2",
          timestamp: new Date(),
          userId: "user-123",
          action: "LOGIN",
          resourceType: "SESSION",
          success: true,
        },
      ];
      await auditService.syncToCloud();
      expect(Sentry.captureException).toHaveBeenCalledTimes(2);
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
          userId: "user-123",
          action: "LOGIN" as AuditAction,
          resourceType: "SESSION" as ResourceType,
          success: true,
        });
      }

      mockSupabaseService.batchInsertAuditLogs.mockResolvedValue(undefined);
      mockDatabaseService.getUnsyncedAuditLogs.mockResolvedValue([]);

      await auditService.flushPendingLogs();

      expect(auditService.getPendingSyncCount()).toBe(0);
    });

    it("also drains rows left in the table by a previous run (BACKLOG-3987)", async () => {
      const row = {
        id: "old-1",
        timestamp: new Date(),
        userId: "user-123",
        action: "LOGIN" as AuditAction,
        resourceType: "SESSION" as ResourceType,
        success: true,
      };
      mockDatabaseService.getUnsyncedAuditLogs
        .mockResolvedValueOnce([row])
        .mockResolvedValue([]);
      mockSupabaseService.batchInsertAuditLogs.mockResolvedValue(undefined);

      await auditService.flushPendingLogs();

      expect(mockDatabaseService.markAuditLogsSynced).toHaveBeenCalledWith([
        "old-1",
      ]);
    });

    it("returns when offline instead of retrying forever (BACKLOG-3987)", async () => {
      (auditService as any).pendingSyncQueue = [
        {
          id: "q-1",
          timestamp: new Date(),
          userId: "user-123",
          action: "LOGIN",
          resourceType: "SESSION",
          success: true,
        },
      ];
      mockSupabaseService.batchInsertAuditLogs.mockReset();
      mockSupabaseService.batchInsertAuditLogs.mockRejectedValue(
        new Error("fetch failed"),
      );

      await auditService.flushPendingLogs();

      expect(mockSupabaseService.batchInsertAuditLogs).toHaveBeenCalledTimes(1);
      expect(auditService.getPendingSyncCount()).toBe(1);
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

/**
 * BACKLOG-3008 — audit events raised BEFORE `AuditService.initialize()`.
 *
 * WHY THIS IS A SEPARATE TOP-LEVEL BLOCK, NOT AN EXTENSION OF THE 2149 ONE
 * ----------------------------------------------------------------------
 * `describe("DB-not-ready deferral (BACKLOG-2149)")` is nested inside
 * `describe("AuditService - Contact Handler Integration")`, whose `beforeEach`
 * calls `auditService.initialize(...)`. Every test in it therefore runs with
 * `databaseService` ALREADY SET, which is precisely the state these controls
 * must not have. 2149 covers "databaseService injected but not initialised";
 * this block covers "initialize() never called", which took a different branch
 * — a throw — and lost the entry.
 *
 * Observed in production once per phone-type selection during onboarding:
 * `user:set-phone-type-cloud` writes to Supabase before the local DB exists,
 * and its SETTINGS_CHANGE audit record was dropped. Not a race — deterministic.
 *
 * The `whenDbReady` spy is pinned to `{ready:false}` throughout ON PURPOSE.
 * `bufferPendingWrite` arms its flush via `whenDbReady()`, and at init stage
 * `idle` that fast-resolves not-ready by design (BACKLOG-2171), so the armed
 * flush fires immediately, does nothing, and never re-arms. Pinning it false
 * reproduces that and keeps `initialize()` the ONLY thing that can drain the
 * buffer — without it these tests would pass on a fix that buffers and then
 * still loses the record.
 */
describe("AuditService - pre-initialization buffering (BACKLOG-3008)", () => {
  let whenDbReadySpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();

    // Fully uninitialized service: initialize() has never been called.
    (auditService as any).initialized = false;
    (auditService as any).databaseService = null;
    (auditService as any).supabaseService = null;
    (auditService as any).pendingSyncQueue = [];
    (auditService as any).syncInProgress = false;
    (auditService as any).currentSync = null;
    (auditService as any).pendingLocalWrites = [];
    (auditService as any).flushingPendingWrites = false;

    mockDatabaseService.isInitialized.mockReturnValue(true);
    auditService.stopSyncInterval();

    // Same singleton instance the service's dynamic import resolves.
    const broadcaster = require("../initializationBroadcaster").initializationBroadcaster;
    whenDbReadySpy = jest
      .spyOn(broadcaster, "whenDbReady")
      .mockResolvedValue({ ready: false, timedOut: false });
  });

  afterEach(() => {
    whenDbReadySpy.mockRestore();
    // initialize() starts the 60s periodic sync; don't leak it into other suites.
    auditService.stopSyncInterval();
  });

  /** Let the flush that `initialize()` floats off settle. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  const phoneTypeEvent = {
    userId: "test-user-id",
    action: "SETTINGS_CHANGE" as AuditAction,
    resourceType: "SETTINGS" as ResourceType,
    resourceId: "test-user-id",
    success: true,
    metadata: { setting: "mobile_phone_type_cloud", value: "iphone" },
  };

  it("preserves an event raised before initialize() and writes it once the service comes up", async () => {
    await expect(auditService.log(phoneTypeEvent)).resolves.toBeUndefined();

    // Nothing written yet — but the entry must still exist somewhere.
    expect(mockDatabaseService.insertAuditLog).not.toHaveBeenCalled();
    expect((auditService as any).pendingLocalWrites).toHaveLength(1);

    auditService.initialize(
      mockDatabaseService as any,
      mockSupabaseService as any,
    );
    await settle();

    expect(mockDatabaseService.insertAuditLog).toHaveBeenCalledTimes(1);
    expect((auditService as any).pendingLocalWrites).toHaveLength(0);
  });

  it("flushes the record with its identity and its ORIGINAL timestamp, not the flush time", async () => {
    await auditService.log(phoneTypeEvent);

    const buffered = (auditService as any).pendingLocalWrites[0];
    const originalId: string = buffered.id;
    const originalTime: number = buffered.timestamp.getTime();
    const loggedAtOrBefore = Date.now();

    auditService.initialize(
      mockDatabaseService as any,
      mockSupabaseService as any,
    );
    await settle();

    const written = mockDatabaseService.insertAuditLog.mock.calls[0][0];
    // Identity, not a count: the right record, not merely one record.
    expect(written.id).toBe(originalId);
    expect(written.action).toBe("SETTINGS_CHANGE");
    expect(written.resourceType).toBe("SETTINGS");
    expect(written.resourceId).toBe("test-user-id");
    expect(written.success).toBe(true);
    expect(written.metadata).toEqual({
      setting: "mobile_phone_type_cloud",
      value: "iphone",
    });
    // Audit truth: the moment it happened, not the moment it was drained.
    expect(written.timestamp.getTime()).toBe(originalTime);
    expect(written.timestamp.getTime()).toBeLessThanOrEqual(loggedAtOrBefore);
  });

  it("drains the buffer from initialize() itself — not from a later successful write", async () => {
    // VACUITY GUARD. `whenDbReady` stays not-ready, and NOTHING is logged after
    // initialize(), so the only mechanism that can drain the buffer is
    // initialize() calling flushPendingLocalWrites(). Delete that call and this
    // test — and only this one — goes red.
    await auditService.log(phoneTypeEvent);
    expect((auditService as any).pendingLocalWrites).toHaveLength(1);

    auditService.initialize(
      mockDatabaseService as any,
      mockSupabaseService as any,
    );
    await settle();

    expect(mockDatabaseService.insertAuditLog).toHaveBeenCalledTimes(1);
    expect(mockDatabaseService.insertAuditLog.mock.calls[0][0].action).toBe(
      "SETTINGS_CHANGE",
    );
    expect((auditService as any).pendingLocalWrites).toHaveLength(0);
  });

  it("covers the LOGIN_FAILED site too — the fix is in writeToLocal, so it is call-site independent", async () => {
    // microsoftAuthHandlers' catch writes LOGIN_FAILED exactly when the DB path
    // failed, so on a deferred-init machine a failed login left no audit trail.
    await auditService.log({
      userId: "unknown",
      action: "LOGIN_FAILED" as AuditAction,
      resourceType: "SESSION" as ResourceType,
      success: false,
      errorMessage: "background processing failed",
      metadata: { provider: "microsoft" },
    });

    auditService.initialize(
      mockDatabaseService as any,
      mockSupabaseService as any,
    );
    await settle();

    const written = mockDatabaseService.insertAuditLog.mock.calls[0][0];
    expect(written.action).toBe("LOGIN_FAILED");
    expect(written.resourceType).toBe("SESSION");
    expect(written.success).toBe(false);
  });

  it("writes straight through for an event logged AFTER initialize() (normal path unchanged)", async () => {
    auditService.initialize(
      mockDatabaseService as any,
      mockSupabaseService as any,
    );
    await settle();

    await auditService.log(phoneTypeEvent);

    expect(mockDatabaseService.insertAuditLog).toHaveBeenCalledTimes(1);
    expect(mockDatabaseService.insertAuditLog.mock.calls[0][0].action).toBe(
      "SETTINGS_CHANGE",
    );
    expect((auditService as any).pendingLocalWrites).toHaveLength(0);
  });

  it("keeps the pre-init buffer bounded, dropping oldest and retaining the newest", async () => {
    const max = (auditService as any).MAX_PENDING_LOCAL_WRITES as number;

    for (let i = 0; i < max + 5; i++) {
      await auditService.log({
        ...phoneTypeEvent,
        metadata: { setting: "mobile_phone_type_cloud", value: `n-${i}` },
      });
    }

    const buffer = (auditService as any).pendingLocalWrites;
    expect(buffer).toHaveLength(max);
    // Oldest dropped, newest retained — identity, not just length.
    expect(buffer[0].metadata.value).toBe("n-5");
    expect(buffer[max - 1].metadata.value).toBe(`n-${max + 4}`);
  });
});
