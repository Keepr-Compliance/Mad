/**
 * @jest-environment node
 */

/**
 * Conflict Resolution Tests for SupabaseService
 * Tests for:
 * - Concurrent update handling
 * - Last-write-wins strategy
 * - Sync conflict detection
 * - Offline queue behavior
 * - Retry logic for transient failures
 */


// Mock Supabase client
const mockSupabaseClient = {
  from: jest.fn(),
  rpc: jest.fn(),
  auth: {
    getSession: jest.fn().mockResolvedValue({
      data: { session: { user: { id: "auth-user-123" } } },
      error: null,
    }),
    onAuthStateChange: jest.fn(() => ({
      data: { subscription: { unsubscribe: jest.fn() } },
    })),
    signOut: jest.fn().mockResolvedValue({ error: null }),
  },
  functions: {
    invoke: jest.fn(),
  },
};

// Mock Supabase module
jest.mock("@supabase/supabase-js", () => ({
  createClient: jest.fn(() => mockSupabaseClient),
}));

// Mock dotenv
jest.mock("dotenv", () => ({
  config: jest.fn(),
}));

// Set environment variables before importing
process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_ANON_KEY = "test-anon-key";

describe("SupabaseService - Conflict Resolution", () => {
  let supabaseService: typeof import("../supabaseService").default;

  // Fluent query builder mock
  const createQueryMock = (
    returnData: unknown = null,
    error: { code?: string; message?: string } | null = null,
  ) => ({
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    upsert: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    gte: jest.fn().mockReturnThis(),
    lte: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    range: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: returnData, error }),
    then: jest.fn((resolve) =>
      resolve({
        data: returnData,
        error,
        count: Array.isArray(returnData) ? returnData.length : 0,
      }),
    ),
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.resetModules();

    // Re-import to get fresh instance
    const module = await import("../supabaseService");
    supabaseService = module.default;

    // Reset initialization state
    (supabaseService as any).initialized = false;
    (supabaseService as any).client = null;
    supabaseService.initialize();
  });

  describe("Concurrent User Updates", () => {
    it("should handle simultaneous user updates with last-write-wins", async () => {
      const userData = {
        email: "test@example.com",
        first_name: "Test",
        last_name: "User",
        oauth_provider: "google",
        oauth_id: "google-123",
      };

      const existingUser = {
        id: "user-uuid-123",
        email: "test@example.com",
        oauth_provider: "google",
        oauth_id: "google-123",
        updated_at: "2024-01-01T10:00:00Z", // Original timestamp
      };

      // First update succeeds (from device A)
      const updatedUserA = {
        ...existingUser,
        first_name: "Updated A",
        updated_at: "2024-01-01T10:01:00Z", // Device A timestamp
      };

      // Second update also succeeds (from device B) - last write wins
      const updatedUserB = {
        ...existingUser,
        first_name: "Updated B",
        updated_at: "2024-01-01T10:02:00Z", // Device B timestamp (later)
      };

      // First sync
      const findQuery1 = createQueryMock(existingUser);
      const updateQuery1 = createQueryMock(updatedUserA);
      mockSupabaseClient.from
        .mockReturnValueOnce(findQuery1)
        .mockReturnValueOnce(updateQuery1);
      mockSupabaseClient.rpc.mockResolvedValue({ data: null, error: null });

      const result1 = await supabaseService.syncUser(userData);
      expect(result1.first_name).toBe("Updated A");

      // Second sync from different "device" - should succeed with last write
      const findQuery2 = createQueryMock(updatedUserA);
      const updateQuery2 = createQueryMock(updatedUserB);
      mockSupabaseClient.from
        .mockReturnValueOnce(findQuery2)
        .mockReturnValueOnce(updateQuery2);

      const result2 = await supabaseService.syncUser({
        ...userData,
        first_name: "Updated B",
      });
      expect(result2.first_name).toBe("Updated B");
    });

    it("should handle update during concurrent read", async () => {
      const userId = "user-123";

      // Simulate: Device A reading while Device B updates
      const userBeforeUpdate = {
        id: userId,
        email: "test@example.com",
        first_name: "Original",
        subscription_tier: "free",
      };

      const userAfterUpdate = {
        id: userId,
        email: "test@example.com",
        first_name: "Updated",
        subscription_tier: "pro", // Device B upgraded subscription
      };

      // Device A reads original
      const readQuery = createQueryMock(userBeforeUpdate);
      mockSupabaseClient.from.mockReturnValue(readQuery);

      const result1 = await supabaseService.getUserById(userId);
      expect(result1.first_name).toBe("Original");
      expect(result1.subscription_tier).toBe("free");

      // Device B updates (simulated by changing mock)
      const updatedReadQuery = createQueryMock(userAfterUpdate);
      mockSupabaseClient.from.mockReturnValue(updatedReadQuery);

      // Device A reads again - should see Device B's update
      const result2 = await supabaseService.getUserById(userId);
      expect(result2.first_name).toBe("Updated");
      expect(result2.subscription_tier).toBe("pro");
    });
  });

  describe("Preferences Sync Conflicts", () => {
    it("should use upsert for preference sync (conflict resolution via upsert)", async () => {
      const upsertQuery = {
        upsert: jest.fn().mockResolvedValue({ data: null, error: null }),
      };
      mockSupabaseClient.from.mockReturnValue(upsertQuery);

      const preferencesA = { theme: "dark", language: "en" };
      await supabaseService.syncPreferences("user-123", preferencesA);

      // Verify upsert was called (which handles conflicts)
      expect(upsertQuery.upsert).toHaveBeenCalledWith({
        user_id: "user-123",
        preferences: preferencesA,
        updated_at: expect.any(String),
      });
    });

    it("should handle concurrent preference updates", async () => {
      // Device A sets theme to dark
      const upsertQueryA = {
        upsert: jest.fn().mockResolvedValue({ data: null, error: null }),
      };
      mockSupabaseClient.from.mockReturnValue(upsertQueryA);
      await supabaseService.syncPreferences("user-123", { theme: "dark" });

      // Device B sets language to 'es' - this overwrites entirely
      const upsertQueryB = {
        upsert: jest.fn().mockResolvedValue({ data: null, error: null }),
      };
      mockSupabaseClient.from.mockReturnValue(upsertQueryB);
      await supabaseService.syncPreferences("user-123", {
        theme: "light",
        language: "es",
      });

      // Last write wins - only language:es and theme:light should exist
      expect(upsertQueryB.upsert).toHaveBeenCalledWith({
        user_id: "user-123",
        preferences: { theme: "light", language: "es" },
        updated_at: expect.any(String),
      });
    });
  });

  describe("Audit Log Conflict Resolution", () => {
    it("should use ignoreDuplicates for audit log sync", async () => {
      const entries = [
        {
          id: "audit-1",
          timestamp: new Date("2024-01-15T10:00:00Z"),
          userId: "user-123",
          action: "LOGIN" as const,
          resourceType: "SESSION" as const,
          success: true,
        },
      ];

      const upsertQuery = {
        upsert: jest.fn().mockResolvedValue({ data: null, error: null }),
      };
      mockSupabaseClient.from.mockReturnValue(upsertQuery);

      await supabaseService.batchInsertAuditLogs(entries);

      // Verify ignoreDuplicates is set to true
      expect(upsertQuery.upsert).toHaveBeenCalledWith(expect.any(Array), {
        onConflict: "id",
        ignoreDuplicates: true,
      });
    });

    it("should handle duplicate audit log entries gracefully", async () => {
      const duplicateEntries = [
        {
          id: "audit-same-id",
          timestamp: new Date("2024-01-15T10:00:00Z"),
          userId: "user-123",
          action: "LOGIN" as const,
          resourceType: "SESSION" as const,
          success: true,
        },
        {
          id: "audit-same-id", // Duplicate ID
          timestamp: new Date("2024-01-15T10:00:01Z"),
          userId: "user-123",
          action: "LOGIN" as const,
          resourceType: "SESSION" as const,
          success: true,
        },
      ];

      const upsertQuery = {
        upsert: jest.fn().mockResolvedValue({ data: null, error: null }),
      };
      mockSupabaseClient.from.mockReturnValue(upsertQuery);

      // Should not throw even with duplicates
      await expect(
        supabaseService.batchInsertAuditLogs(duplicateEntries),
      ).resolves.not.toThrow();
    });

    it("should handle conflict when syncing from multiple devices", async () => {
      // Device A logs an event
      const deviceAEntry = {
        id: "audit-device-a",
        timestamp: new Date("2024-01-15T10:00:00Z"),
        userId: "user-123",
        // "EXPORT_STARTED" is not a member of the AuditAction union (the real
        // export action is "DATA_EXPORT"). Kept verbatim so the fixture data is
        // unchanged; this test only asserts upsert() was called, not the action.
        action: "EXPORT_STARTED" as unknown as import("../auditService").AuditAction,
        resourceType: "EXPORT" as const,
        success: true,
        metadata: { device: "MacBook" },
      };

      // Device B logs the same event with same ID (edge case)
      const deviceBEntry = {
        id: "audit-device-a", // Same ID
        timestamp: new Date("2024-01-15T10:00:00Z"),
        userId: "user-123",
        // See deviceAEntry: "EXPORT_STARTED" is outside the AuditAction union.
        action: "EXPORT_STARTED" as unknown as import("../auditService").AuditAction,
        resourceType: "EXPORT" as const,
        success: true,
        metadata: { device: "iMac" },
      };

      const upsertQuery = {
        upsert: jest.fn().mockResolvedValue({ data: null, error: null }),
      };
      mockSupabaseClient.from.mockReturnValue(upsertQuery);

      // First device syncs
      await supabaseService.batchInsertAuditLogs([deviceAEntry]);

      // Second device syncs - duplicate should be ignored
      await supabaseService.batchInsertAuditLogs([deviceBEntry]);

      // Both calls should succeed without error
      expect(upsertQuery.upsert).toHaveBeenCalledTimes(2);
    });
  });

  describe("Device Registration Conflicts", () => {
    it("should handle device already registered scenario", async () => {
      const deviceInfo = {
        device_id: "device-123",
        device_name: "MacBook Pro",
        os: "darwin",
        app_version: "1.0.0",
      };

      const existingDevice = {
        id: "device-uuid-123",
        user_id: "user-123",
        device_id: "device-123",
        device_name: "Old MacBook",
        os: "darwin",
        app_version: "0.9.0",
        last_seen_at: "2024-01-01T00:00:00Z",
      };

      const updatedDevice = {
        ...existingDevice,
        device_name: "MacBook Pro",
        app_version: "1.0.0",
        last_seen_at: expect.any(String),
      };

      // Find existing device
      const findQuery = createQueryMock(existingDevice);
      // Update it
      const updateQuery = createQueryMock(updatedDevice);

      mockSupabaseClient.from
        .mockReturnValueOnce(findQuery)
        .mockReturnValueOnce(updateQuery);

      const result = await supabaseService.registerDevice(
        "user-123",
        deviceInfo,
      );

      expect(result.device_name).toBe("MacBook Pro");
      expect(result.app_version).toBe("1.0.0");
    });

    it("should handle race condition in device registration", async () => {
      const deviceInfo = {
        device_id: "new-device",
        device_name: "New MacBook",
        os: "darwin",
        app_version: "1.0.0",
      };

      // First attempt: device not found
      const notFoundQuery = createQueryMock(null, { code: "PGRST116" });

      // Insert succeeds
      const newDevice = {
        id: "device-uuid-new",
        user_id: "user-123",
        ...deviceInfo,
      };
      const insertQuery = createQueryMock(newDevice);

      mockSupabaseClient.from
        .mockReturnValueOnce(notFoundQuery)
        .mockReturnValueOnce(insertQuery);

      const result = await supabaseService.registerDevice(
        "user-123",
        deviceInfo,
      );
      expect(result.device_name).toBe("New MacBook");
    });
  });

  describe("Transient Error Handling", () => {
    it("should handle temporary network failures for critical operations", async () => {
      const userData = {
        email: "test@example.com",
        oauth_provider: "google",
        oauth_id: "google-123",
      };

      // First call fails with network error
      const networkErrorQuery = createQueryMock(null, {
        code: "NETWORK_ERROR",
        message: "Network timeout",
      });
      mockSupabaseClient.from.mockReturnValue(networkErrorQuery);

      // Critical operations should propagate errors
      await expect(supabaseService.syncUser(userData)).rejects.toBeDefined();
    });

    it("should fail open for non-critical operations on network error", async () => {
      // API limit check should fail open
      const errorQuery = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        gte: jest.fn().mockRejectedValue(new Error("Network error")),
      };
      mockSupabaseClient.from.mockReturnValue(errorQuery);

      const result = await supabaseService.checkApiLimit(
        "user-123",
        "google_maps",
      );

      // Should allow access even on error
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(100); // Default fallback
    });

    it("should not throw for analytics tracking failures", async () => {
      const errorQuery = {
        insert: jest.fn().mockRejectedValue(new Error("Database unavailable")),
      };
      mockSupabaseClient.from.mockReturnValue(errorQuery);

      // Analytics should silently fail
      await expect(
        supabaseService.trackEvent("user-123", "test_event", { data: "test" }),
      ).resolves.not.toThrow();

      // API usage tracking should also silently fail
      await expect(
        supabaseService.trackApiUsage("user-123", "api", "/endpoint", 0.01),
      ).resolves.not.toThrow();
    });
  });

  describe("Data Consistency During Sync", () => {
    it("should maintain consistency when updating user with login count increment", async () => {
      const userData = {
        email: "test@example.com",
        first_name: "Test",
        oauth_provider: "google",
        oauth_id: "google-123",
      };

      const existingUser = {
        id: "user-123",
        email: "test@example.com",
        oauth_provider: "google",
        oauth_id: "google-123",
        login_count: 5,
      };

      const updatedUser = {
        ...existingUser,
        first_name: "Test",
        login_count: 6,
      };

      const findQuery = createQueryMock(existingUser);
      const updateQuery = createQueryMock(updatedUser);

      mockSupabaseClient.from
        .mockReturnValueOnce(findQuery)
        .mockReturnValueOnce(updateQuery);

      // RPC for incrementing login count
      mockSupabaseClient.rpc.mockResolvedValue({ data: null, error: null });

      await supabaseService.syncUser(userData);

      // Verify login count increment was called atomically via RPC
      expect(mockSupabaseClient.rpc).toHaveBeenCalledWith("increment", {
        row_id: "user-123",
        x: 1,
        table_name: "users",
        column_name: "login_count",
      });
    });

    it("should handle subscription status update atomically", async () => {
      const userId = "user-123";
      const expiredTrialUser = {
        id: userId,
        subscription_tier: "free",
        subscription_status: "trial",
        trial_ends_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), // Expired
      };

      const findQuery = createQueryMock(expiredTrialUser);
      const updateQuery = createQueryMock(null);

      mockSupabaseClient.from
        .mockReturnValueOnce(findQuery)
        .mockReturnValueOnce(updateQuery);

      const subscription = await supabaseService.validateSubscription(userId);

      // Status should be updated to expired
      expect(subscription.status).toBe("expired");
      expect(subscription.trialEnded).toBe(true);
    });
  });

  describe("Concurrent Device Limit Checks", () => {
    it("should handle concurrent device registrations near limit", async () => {
      const license = { max_devices: 2 };

      // Initially at 1 device
      const devices = [{ device_id: "device-1" }];

      const licenseQuery = createQueryMock(license);
      const devicesQuery = {
        ...createQueryMock(devices),
        then: jest.fn((resolve) => resolve({ data: devices, error: null })),
      };

      mockSupabaseClient.from
        .mockReturnValueOnce(licenseQuery)
        .mockReturnValueOnce(devicesQuery);

      // First check: should allow
      const result1 = await supabaseService.checkDeviceLimit(
        "user-123",
        "device-2",
      );
      expect(result1.allowed).toBe(true);
      expect(result1.current).toBe(1);
      expect(result1.max).toBe(2);

      // Simulate: another device registered concurrently (now at limit)
      const devicesAtLimit = [
        { device_id: "device-1" },
        { device_id: "device-2" },
      ];

      const licenseQuery2 = createQueryMock(license);
      const devicesQuery2 = {
        ...createQueryMock(devicesAtLimit),
        then: jest.fn((resolve) =>
          resolve({ data: devicesAtLimit, error: null }),
        ),
      };

      mockSupabaseClient.from
        .mockReturnValueOnce(licenseQuery2)
        .mockReturnValueOnce(devicesQuery2);

      // Third device should be blocked
      const result2 = await supabaseService.checkDeviceLimit(
        "user-123",
        "device-3",
      );
      expect(result2.allowed).toBe(false);
      expect(result2.current).toBe(2);
    });
  });
});

// BACKLOG-2414: this file has no top-level import/export, so TypeScript treats it as a
// script and its top-level `const mockSupabaseClient` lands in the GLOBAL scope — colliding
// with the identically-named const in the sibling suite (TS2451). Jest already isolates
// these at runtime (one module registry per test file), so this marker only makes the file a
// module for the type-checker; it changes no test behaviour.
export {};
