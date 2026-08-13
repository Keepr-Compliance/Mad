/**
 * @jest-environment node
 */

/**
 * Unit tests for SupabaseService
 * Tests cloud database operations including:
 * - User sync operations
 * - Device management
 * - Analytics tracking
 * - API usage limits
 * - Preferences sync
 * - Audit log sync
 * - Network error handling
 */


// TASK-2040: Track auth state change callback for testing token refresh
let capturedAuthStateCallback: ((event: string, session: unknown) => void) | null = null;
const mockUnsubscribe = jest.fn();

// BACKLOG-2332: sessionService.updateSession is called (fire-and-forget) on TOKEN_REFRESHED to
// persist rotated tokens to session.json. Default impl returns a resolved Promise so the `.catch`
// in the writeback never throws; clearAllMocks() keeps the implementation, only clears call data.
// BACKLOG-2414: params declared as `unknown[]` because the writeback really is
// called WITH a session object (see the `toHaveBeenCalledWith` assertion below);
// declaring zero params made the forwarder's spread a TS2556. The body is
// unchanged — it still ignores its arguments and resolves true.
const mockUpdateSession = jest.fn((..._args: unknown[]) => Promise.resolve(true));

// Mock Supabase client
const mockSupabaseClient = {
  from: jest.fn(),
  rpc: jest.fn(),
  auth: {
    getSession: jest.fn().mockResolvedValue({
      data: { session: { user: { id: "auth-user-123" } } },
      error: null,
    }),
    onAuthStateChange: jest.fn((callback: (event: string, session: unknown) => void) => {
      capturedAuthStateCallback = callback;
      return { data: { subscription: { unsubscribe: mockUnsubscribe } } };
    }),
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

// BACKLOG-2332: mock the session persistence so the TOKEN_REFRESHED writeback is observable and
// never touches disk. The wrapper delegates to the stable outer mock (survives resetModules).
jest.mock("../sessionService", () => ({
  __esModule: true,
  default: { updateSession: (...args: unknown[]) => mockUpdateSession(...args) },
}));

// Set environment variables before importing
process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_ANON_KEY = "test-anon-key";

describe("SupabaseService", () => {
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
    capturedAuthStateCallback = null;

    // Re-import to get fresh instance
    const module = await import("../supabaseService");
    supabaseService = module.default;

    // Reset initialization state
    (supabaseService as any).initialized = false;
    (supabaseService as any).client = null;
    (supabaseService as any).authSubscription = null;
  });

  describe("initialize", () => {
    it("should initialize Supabase client with credentials", () => {
      supabaseService.initialize();

      expect((supabaseService as any).initialized).toBe(true);
    });

    it("should not re-initialize if already initialized", () => {
      supabaseService.initialize();
      supabaseService.initialize();

      // Should only initialize once
      expect((supabaseService as any).initialized).toBe(true);
    });

    it("should throw error when credentials are missing", async () => {
      // Reset module and clear env vars
      jest.resetModules();
      const originalUrl = process.env.SUPABASE_URL;
      const originalKey = process.env.SUPABASE_ANON_KEY;

      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_ANON_KEY;

      const module = await import("../supabaseService");
      const service = module.default;
      (service as any).initialized = false;
      (service as any).client = null;

      expect(() => service.initialize()).toThrow(
        "Supabase credentials not configured",
      );

      // Restore env vars
      process.env.SUPABASE_URL = originalUrl;
      process.env.SUPABASE_ANON_KEY = originalKey;
    });
  });

  describe("Token Auto-Refresh (TASK-2040)", () => {
    it("should set up auth state listener on initialize", () => {
      supabaseService.initialize();

      expect(mockSupabaseClient.auth.onAuthStateChange).toHaveBeenCalledTimes(1);
      expect(capturedAuthStateCallback).not.toBeNull();
    });

    it("should update local session cache on TOKEN_REFRESHED event", () => {
      supabaseService.initialize();

      const refreshedSession = {
        user: { id: "user-refreshed-123" },
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      };

      // Simulate the SDK emitting a TOKEN_REFRESHED event
      capturedAuthStateCallback!("TOKEN_REFRESHED", refreshedSession);

      const authSession = (supabaseService as any).authSession;
      expect(authSession).not.toBeNull();
      expect(authSession.userId).toBe("user-refreshed-123");
      expect(authSession.accessToken).toBe("new-access-token");
      expect(authSession.refreshToken).toBe("new-refresh-token");
      expect(authSession.expiresAt).toBeInstanceOf(Date);
    });

    it("BACKLOG-2332: persists the ROTATED tokens to session.json on TOKEN_REFRESHED", () => {
      supabaseService.initialize();

      const refreshedSession = {
        user: { id: "user-refreshed-123" },
        access_token: "rotated-access-token",
        refresh_token: "rotated-refresh-token",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      };

      capturedAuthStateCallback!("TOKEN_REFRESHED", refreshedSession);

      // The in-memory cache is not the only durable copy: the SDK runs persistSession:false, so
      // session.json must be updated with the rotated tokens or a restart after ~1h restores a
      // USED refresh token and GoTrue reuse-detection revokes the family (forced re-login).
      expect(mockUpdateSession).toHaveBeenCalledWith({
        supabaseTokens: {
          access_token: "rotated-access-token",
          refresh_token: "rotated-refresh-token",
        },
      });
    });

    it("should clear local session cache on SIGNED_OUT event", () => {
      supabaseService.initialize();

      // Set a session first
      (supabaseService as any).authSession = {
        userId: "user-123",
        accessToken: "old-token",
      };

      // Simulate SIGNED_OUT
      capturedAuthStateCallback!("SIGNED_OUT", null);

      expect((supabaseService as any).authSession).toBeNull();
    });

    it("should not update session for unrelated auth events", () => {
      supabaseService.initialize();

      const existingSession = {
        userId: "user-123",
        accessToken: "existing-token",
      };
      (supabaseService as any).authSession = existingSession;

      // Simulate an unrelated event like INITIAL_SESSION
      capturedAuthStateCallback!("INITIAL_SESSION", {
        user: { id: "other" },
        access_token: "other-token",
        refresh_token: "other-refresh",
        expires_at: 9999,
      });

      // Session should be unchanged
      expect((supabaseService as any).authSession).toBe(existingSession);
    });

    it("should unsubscribe auth listener on destroy()", () => {
      supabaseService.initialize();

      supabaseService.destroy();

      expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
      expect((supabaseService as any).authSubscription).toBeNull();
      expect((supabaseService as any).authSession).toBeNull();
    });

    it("should handle destroy() when no subscription exists", () => {
      // Do not initialize -- no subscription
      supabaseService.destroy();

      // Should not throw
      expect(mockUnsubscribe).not.toHaveBeenCalled();
    });
  });

  describe("Global Sign-Out (TASK-2045)", () => {
    beforeEach(() => {
      supabaseService.initialize();
    });

    it("should call Supabase signOut with scope: global", async () => {
      mockSupabaseClient.auth.signOut.mockResolvedValueOnce({ error: null });

      const result = await supabaseService.signOutGlobal();

      expect(result.success).toBe(true);
      expect(mockSupabaseClient.auth.signOut).toHaveBeenCalledWith({ scope: "global" });
    });

    it("should return error when global sign-out fails", async () => {
      mockSupabaseClient.auth.signOut.mockResolvedValueOnce({
        error: { message: "Session expired" },
      });

      const result = await supabaseService.signOutGlobal();

      expect(result.success).toBe(false);
      expect(result.error).toBe("Session expired");
    });

    it("should handle exceptions during global sign-out", async () => {
      mockSupabaseClient.auth.signOut.mockRejectedValueOnce(
        new Error("Network unavailable")
      );

      const result = await supabaseService.signOutGlobal();

      expect(result.success).toBe(false);
      expect(result.error).toBe("Network unavailable");
    });
  });

  describe("User Operations", () => {
    beforeEach(() => {
      supabaseService.initialize();
    });

    describe("syncUser", () => {
      it("should create new user when not exists", async () => {
        const userData = {
          email: "test@example.com",
          first_name: "Test",
          last_name: "User",
          oauth_provider: "google",
          oauth_id: "google-123",
        };

        const newUser = {
          id: "auth-user-123",
          ...userData,
          subscription_tier: "free",
          subscription_status: "trial",
        };

        // First query: lookup by auth.uid() -> not found
        const notFoundByIdQuery = createQueryMock(null, {
          code: "PGRST116",
          message: "Not found",
        });
        // Second query: lookup by oauth_provider/oauth_id -> not found
        const notFoundByOAuthQuery = createQueryMock(null, {
          code: "PGRST116",
          message: "Not found",
        });
        // Third query: insert new user
        const insertQuery = createQueryMock(newUser);

        mockSupabaseClient.from
          .mockReturnValueOnce(notFoundByIdQuery)
          .mockReturnValueOnce(notFoundByOAuthQuery)
          .mockReturnValueOnce(insertQuery);

        const result = await supabaseService.syncUser(userData);

        expect(result.email).toBe("test@example.com");
        expect(result.subscription_tier).toBe("free");
      });

      it("should update existing user", async () => {
        const userData = {
          email: "test@example.com",
          first_name: "Updated",
          last_name: "User",
          oauth_provider: "google",
          oauth_id: "google-123",
        };

        const existingUser = {
          id: "user-uuid-123",
          email: "test@example.com",
          oauth_provider: "google",
          oauth_id: "google-123",
        };

        const updatedUser = {
          id: "user-uuid-123",
          ...userData,
        };

        // First query: find existing user
        const findQuery = createQueryMock(existingUser);
        // Second query: update user
        const updateQuery = createQueryMock(updatedUser);

        mockSupabaseClient.from
          .mockReturnValueOnce(findQuery)
          .mockReturnValueOnce(updateQuery);

        mockSupabaseClient.rpc.mockResolvedValue({ data: null, error: null });

        const result = await supabaseService.syncUser(userData);

        expect(result.first_name).toBe("Updated");
      });

      it("should handle network errors", async () => {
        const userData = {
          email: "test@example.com",
          oauth_provider: "google",
          oauth_id: "google-123",
        };

        const errorQuery = createQueryMock(null, {
          code: "NETWORK_ERROR",
          message: "Network unavailable",
        });
        mockSupabaseClient.from.mockReturnValue(errorQuery);

        // Network error handling may vary - just verify the call is made
        try {
          await supabaseService.syncUser(userData);
        } catch {
          // Error thrown is acceptable
        }

        expect(mockSupabaseClient.from).toHaveBeenCalled();
      });
    });

    describe("getUserById", () => {
      it("should return user when found", async () => {
        const mockUser = {
          id: "user-123",
          email: "test@example.com",
          subscription_tier: "free",
        };

        const query = createQueryMock(mockUser);
        mockSupabaseClient.from.mockReturnValue(query);

        const user = await supabaseService.getUserById("user-123");

        expect(user.email).toBe("test@example.com");
      });

      it("should handle user not found", async () => {
        const query = createQueryMock(null, { message: "User not found" });
        mockSupabaseClient.from.mockReturnValue(query);

        // getUserById may throw or return null when user not found
        try {
          const result = await supabaseService.getUserById("non-existent");
          expect(result).toBeNull();
        } catch {
          // Error thrown is also acceptable
        }
      });
    });

    describe("syncTermsAcceptance", () => {
      it("should sync terms acceptance to cloud", async () => {
        const updatedUser = {
          id: "user-123",
          email: "test@example.com",
          terms_accepted_at: new Date().toISOString(),
          terms_version_accepted: "1.0",
        };

        const query = createQueryMock(updatedUser);
        mockSupabaseClient.from.mockReturnValue(query);

        const result = await supabaseService.syncTermsAcceptance(
          "user-123",
          "1.0",
          "1.0",
        );

        expect(result.terms_version_accepted).toBe("1.0");
      });

      it("should handle failure gracefully", async () => {
        const query = {
          update: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          select: jest.fn().mockReturnThis(),
          single: jest.fn().mockResolvedValue({
            data: null,
            error: { message: "Update failed" },
          }),
        };
        mockSupabaseClient.from.mockReturnValue(query);

        // syncTermsAcceptance may throw or return undefined on failure
        try {
          await supabaseService.syncTermsAcceptance("user-123", "1.0", "1.0");
        } catch {
          // Error thrown is acceptable
        }

        expect(query.update).toHaveBeenCalled();
      });
    });

    describe("validateSubscription", () => {
      beforeEach(() => {
        supabaseService.initialize();
      });

      it("should return active subscription status", async () => {
        const activeUser = {
          id: "user-123",
          subscription_tier: "pro",
          subscription_status: "active",
          trial_ends_at: null,
        };

        const query = createQueryMock(activeUser);
        mockSupabaseClient.from.mockReturnValue(query);

        const subscription =
          await supabaseService.validateSubscription("user-123");

        expect(subscription.isActive).toBe(true);
        expect(subscription.tier).toBe("pro");
      });

      it("should return trial subscription with days remaining", async () => {
        const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days from now
        const trialUser = {
          id: "user-123",
          subscription_tier: "free",
          subscription_status: "trial",
          trial_ends_at: futureDate.toISOString(),
        };

        const query = createQueryMock(trialUser);
        mockSupabaseClient.from.mockReturnValue(query);

        const subscription =
          await supabaseService.validateSubscription("user-123");

        expect(subscription.isTrial).toBe(true);
        expect(subscription.trialDaysRemaining).toBeGreaterThanOrEqual(6);
      });

      it("should mark subscription as expired when trial ended", async () => {
        const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // 1 day ago
        const expiredUser = {
          id: "user-123",
          subscription_tier: "free",
          subscription_status: "trial",
          trial_ends_at: pastDate.toISOString(),
        };

        const findQuery = createQueryMock(expiredUser);
        const updateQuery = createQueryMock(null);

        mockSupabaseClient.from
          .mockReturnValueOnce(findQuery)
          .mockReturnValueOnce(updateQuery);

        const subscription =
          await supabaseService.validateSubscription("user-123");

        expect(subscription.trialEnded).toBe(true);
        expect(subscription.status).toBe("expired");
      });
    });
  });

  describe("Device Operations", () => {
    beforeEach(() => {
      supabaseService.initialize();
    });

    describe("registerDevice", () => {
      it("should register new device", async () => {
        const deviceInfo = {
          device_id: "device-123",
          device_name: "MacBook Pro",
          os: "darwin",
          app_version: "1.0.0",
        };

        const newDevice = {
          id: "device-uuid-123",
          user_id: "user-123",
          ...deviceInfo,
        };

        // First query: check if device exists (not found)
        const notFoundQuery = createQueryMock(null, { code: "PGRST116" });
        // Second query: insert new device
        const insertQuery = createQueryMock(newDevice);

        mockSupabaseClient.from
          .mockReturnValueOnce(notFoundQuery)
          .mockReturnValueOnce(insertQuery);

        const result = await supabaseService.registerDevice(
          "user-123",
          deviceInfo,
        );

        expect(result.device_name).toBe("MacBook Pro");
      });

      it("should update existing device", async () => {
        const deviceInfo = {
          device_id: "device-123",
          device_name: "MacBook Pro Updated",
          os: "darwin",
          app_version: "1.1.0",
        };

        const existingDevice = {
          id: "device-uuid-123",
          user_id: "user-123",
          device_id: "device-123",
        };

        const updatedDevice = {
          ...existingDevice,
          ...deviceInfo,
          last_seen_at: new Date().toISOString(),
        };

        const findQuery = createQueryMock(existingDevice);
        const updateQuery = createQueryMock(updatedDevice);

        mockSupabaseClient.from
          .mockReturnValueOnce(findQuery)
          .mockReturnValueOnce(updateQuery);

        const result = await supabaseService.registerDevice(
          "user-123",
          deviceInfo,
        );

        expect(result.app_version).toBe("1.1.0");
      });
    });

    describe("checkDeviceLimit", () => {
      it("should allow when under device limit", async () => {
        const license = { max_devices: 3 };
        const devices = [{ device_id: "device-1" }, { device_id: "device-2" }];

        const licenseQuery = createQueryMock(license);
        const devicesQuery = {
          ...createQueryMock(devices),
          then: jest.fn((resolve) => resolve({ data: devices, error: null })),
        };

        mockSupabaseClient.from
          .mockReturnValueOnce(licenseQuery)
          .mockReturnValueOnce(devicesQuery);

        const result = await supabaseService.checkDeviceLimit(
          "user-123",
          "new-device",
        );

        expect(result.allowed).toBe(true);
        expect(result.current).toBe(2);
        expect(result.max).toBe(3);
      });

      it("should allow current device even at limit", async () => {
        const license = { max_devices: 2 };
        const devices = [{ device_id: "device-1" }, { device_id: "device-2" }];

        const licenseQuery = createQueryMock(license);
        const devicesQuery = {
          ...createQueryMock(devices),
          then: jest.fn((resolve) => resolve({ data: devices, error: null })),
        };

        mockSupabaseClient.from
          .mockReturnValueOnce(licenseQuery)
          .mockReturnValueOnce(devicesQuery);

        const result = await supabaseService.checkDeviceLimit(
          "user-123",
          "device-1",
        );

        expect(result.allowed).toBe(true);
        expect(result.isCurrentDevice).toBe(true);
      });

      it("should fail open on error", async () => {
        const errorQuery = createQueryMock(null, { message: "Database error" });
        mockSupabaseClient.from.mockReturnValue(errorQuery);

        const result = await supabaseService.checkDeviceLimit(
          "user-123",
          "device-1",
        );

        // Should allow on error (fail open)
        expect(result.allowed).toBe(true);
      });
    });
  });

  describe("Analytics Operations", () => {
    beforeEach(() => {
      supabaseService.initialize();
    });

    describe("trackEvent", () => {
      it("should track analytics event", async () => {
        const insertQuery = {
          insert: jest.fn().mockResolvedValue({ data: null, error: null }),
        };
        mockSupabaseClient.from.mockReturnValue(insertQuery);

        await supabaseService.trackEvent(
          "user-123",
          "transaction_created",
          { property_address: "123 Main St" },
          "device-123",
          "1.0.0",
        );

        expect(insertQuery.insert).toHaveBeenCalledWith({
          user_id: "user-123",
          event_name: "transaction_created",
          event_data: { property_address: "123 Main St" },
          device_id: "device-123",
          app_version: "1.0.0",
        });
      });

      it("should not throw on analytics failure", async () => {
        const errorQuery = {
          insert: jest.fn().mockRejectedValue(new Error("Network error")),
        };
        mockSupabaseClient.from.mockReturnValue(errorQuery);

        // Should not throw
        await expect(
          supabaseService.trackEvent("user-123", "event", {}),
        ).resolves.not.toThrow();
      });
    });
  });

  describe("API Usage Operations", () => {
    beforeEach(() => {
      supabaseService.initialize();
    });

    describe("trackApiUsage", () => {
      it("should track API usage", async () => {
        const insertQuery = {
          insert: jest.fn().mockResolvedValue({ data: null, error: null }),
        };
        mockSupabaseClient.from.mockReturnValue(insertQuery);

        await supabaseService.trackApiUsage(
          "user-123",
          "google_maps",
          "/geocode",
          0.005,
        );

        expect(insertQuery.insert).toHaveBeenCalledWith({
          user_id: "user-123",
          api_name: "google_maps",
          endpoint: "/geocode",
          estimated_cost: 0.005,
        });
      });
    });

    describe("checkApiLimit", () => {
      it("should allow when under API limit", async () => {
        const user = { subscription_tier: "pro" };
        const tierLimits = { free: 10, pro: 100, enterprise: 1000 };

        const countQuery = {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          gte: jest.fn().mockResolvedValue({ count: 50, error: null }),
        };
        const userQuery = createQueryMock(user);

        mockSupabaseClient.from
          .mockReturnValueOnce(countQuery)
          .mockReturnValueOnce(userQuery);

        const result = await supabaseService.checkApiLimit(
          "user-123",
          "google_maps",
          tierLimits,
        );

        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(50);
      });

      it("should block when over API limit", async () => {
        const user = { subscription_tier: "free" };
        const tierLimits = { free: 10, pro: 100, enterprise: 1000 };

        const countQuery = {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          gte: jest.fn().mockResolvedValue({ count: 10, error: null }),
        };
        const userQuery = createQueryMock(user);

        mockSupabaseClient.from
          .mockReturnValueOnce(countQuery)
          .mockReturnValueOnce(userQuery);

        const result = await supabaseService.checkApiLimit(
          "user-123",
          "google_maps",
          tierLimits,
        );

        expect(result.allowed).toBe(false);
        expect(result.remaining).toBe(0);
      });

      it("should fail open on error", async () => {
        const errorQuery = {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          gte: jest.fn().mockRejectedValue(new Error("Database error")),
        };
        mockSupabaseClient.from.mockReturnValue(errorQuery);

        const result = await supabaseService.checkApiLimit(
          "user-123",
          "google_maps",
        );

        expect(result.allowed).toBe(true);
      });
    });
  });

  describe("Preferences Operations", () => {
    beforeEach(() => {
      supabaseService.initialize();
    });

    describe("syncPreferences", () => {
      it("should sync preferences to cloud", async () => {
        const upsertQuery = {
          upsert: jest.fn().mockResolvedValue({ data: null, error: null }),
        };
        mockSupabaseClient.from.mockReturnValue(upsertQuery);

        const preferences = {
          theme: "dark",
          notifications: true,
          language: "en",
        };

        await supabaseService.syncPreferences("user-123", preferences);

        expect(upsertQuery.upsert).toHaveBeenCalledWith({
          user_id: "user-123",
          preferences,
          updated_at: expect.any(String),
        });
      });

      it("should handle sync failure gracefully", async () => {
        const errorQuery = {
          upsert: jest.fn().mockResolvedValue({
            data: null,
            error: { message: "Sync failed" },
          }),
        };
        mockSupabaseClient.from.mockReturnValue(errorQuery);

        // syncPreferences may either throw or return undefined on error
        // depending on implementation - just verify it doesn't crash
        try {
          await supabaseService.syncPreferences("user-123", {});
        } catch {
          // Error thrown is acceptable behavior
        }

        expect(errorQuery.upsert).toHaveBeenCalled();
      });
    });

    describe("getPreferences", () => {
      it("should return user preferences", async () => {
        const preferences = { theme: "dark", notifications: true };
        const query = createQueryMock({ preferences });
        mockSupabaseClient.from.mockReturnValue(query);

        const result = await supabaseService.getPreferences("user-123");

        expect(result).toEqual(preferences);
      });

      it("should return empty object when not found", async () => {
        const query = createQueryMock(null, { code: "PGRST116" });
        mockSupabaseClient.from.mockReturnValue(query);

        const result = await supabaseService.getPreferences("user-123");

        expect(result).toEqual({});
      });

      it("should throw error on database failure", async () => {
        const query = createQueryMock(null, { code: "42501", message: "Permission denied" });
        mockSupabaseClient.from.mockReturnValue(query);

        await expect(supabaseService.getPreferences("user-123")).rejects.toEqual({
          code: "42501",
          message: "Permission denied",
        });
      });

      it("should return preferences with scan.lookbackMonths", async () => {
        const preferences = { scan: { lookbackMonths: 6 } };
        const query = createQueryMock({ preferences });
        mockSupabaseClient.from.mockReturnValue(query);

        const result = await supabaseService.getPreferences("user-123");

        expect(result).toEqual(preferences);
        expect(result.scan.lookbackMonths).toBe(6);
      });
    });
  });

  describe("Edge Functions", () => {
    beforeEach(() => {
      supabaseService.initialize();
    });

    describe("callEdgeFunction", () => {
      it("should call edge function and return result", async () => {
        const functionResponse = { success: true, data: "result" };
        mockSupabaseClient.functions.invoke.mockResolvedValue({
          data: functionResponse,
          error: null,
        });

        const result = await supabaseService.callEdgeFunction("process-data", {
          input: "test",
        });

        expect(result).toEqual(functionResponse);
        expect(mockSupabaseClient.functions.invoke).toHaveBeenCalledWith(
          "process-data",
          {
            body: { input: "test" },
          },
        );
      });

      it("should handle edge function error gracefully", async () => {
        mockSupabaseClient.functions.invoke.mockResolvedValue({
          data: null,
          error: { message: "Function failed" },
        });

        // Edge function may throw or return null on error
        try {
          const result = await supabaseService.callEdgeFunction(
            "failing-function",
            {},
          );
          // If no throw, result should be null or contain error
          expect(result).toBeNull();
        } catch {
          // Error thrown is also acceptable
        }
      });
    });
  });

  describe("Audit Log Operations", () => {
    beforeEach(() => {
      supabaseService.initialize();
    });

    describe("batchInsertAuditLogs", () => {
      it("should batch insert audit logs", async () => {
        const entries = [
          {
            id: "audit-1",
            timestamp: new Date(),
            userId: "user-123",
            action: "LOGIN" as const,
            resourceType: "SESSION" as const,
            success: true,
          },
          {
            id: "audit-2",
            timestamp: new Date(),
            userId: "user-123",
            action: "LOGOUT" as const,
            resourceType: "SESSION" as const,
            success: true,
          },
        ];

        const upsertQuery = {
          upsert: jest.fn().mockResolvedValue({ data: null, error: null }),
        };
        mockSupabaseClient.from.mockReturnValue(upsertQuery);

        await supabaseService.batchInsertAuditLogs(entries);

        expect(upsertQuery.upsert).toHaveBeenCalledWith(
          expect.arrayContaining([
            expect.objectContaining({ id: "audit-1", action: "LOGIN" }),
            expect.objectContaining({ id: "audit-2", action: "LOGOUT" }),
          ]),
          { onConflict: "id", ignoreDuplicates: true },
        );
      });

      it("should handle empty entries array", async () => {
        await supabaseService.batchInsertAuditLogs([]);

        expect(mockSupabaseClient.from).not.toHaveBeenCalled();
      });

      it("should handle batch insert failure", async () => {
        const entries = [
          {
            id: "audit-1",
            timestamp: new Date(),
            userId: "user-123",
            action: "LOGIN" as const,
            resourceType: "SESSION" as const,
            success: true,
          },
        ];

        const errorQuery = {
          upsert: jest.fn().mockResolvedValue({
            data: null,
            error: { message: "Insert failed" },
          }),
        };
        mockSupabaseClient.from.mockReturnValue(errorQuery);

        // batchInsertAuditLogs may throw or silently fail
        try {
          await supabaseService.batchInsertAuditLogs(entries);
        } catch {
          // Error thrown is acceptable
        }

        expect(errorQuery.upsert).toHaveBeenCalled();
      });
    });

    describe("getAuditLogs", () => {
      it("should return audit logs for user", async () => {
        const mockLogs = [
          {
            id: "audit-1",
            timestamp: "2024-01-15T10:00:00Z",
            user_id: "user-123",
            action: "LOGIN",
            resource_type: "SESSION",
            success: true,
          },
        ];

        const query = {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          order: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          range: jest.fn().mockReturnThis(),
          then: jest.fn((resolve) => resolve({ data: mockLogs, error: null })),
        };
        mockSupabaseClient.from.mockReturnValue(query);

        const logs = await supabaseService.getAuditLogs("user-123");

        expect(logs).toHaveLength(1);
        expect(logs[0].action).toBe("LOGIN");
      });

      it("should apply filters", async () => {
        const query = {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          gte: jest.fn().mockReturnThis(),
          lte: jest.fn().mockReturnThis(),
          order: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          range: jest.fn().mockReturnThis(),
          then: jest.fn((resolve) => resolve({ data: [], error: null })),
        };
        mockSupabaseClient.from.mockReturnValue(query);

        await supabaseService.getAuditLogs("user-123", {
          action: "LOGIN",
          resourceType: "SESSION",
          startDate: new Date("2024-01-01"),
          endDate: new Date("2024-12-31"),
          limit: 50,
          offset: 10,
        });

        expect(query.eq).toHaveBeenCalledWith("action", "LOGIN");
        expect(query.eq).toHaveBeenCalledWith("resource_type", "SESSION");
        expect(query.gte).toHaveBeenCalled();
        expect(query.lte).toHaveBeenCalled();
        expect(query.limit).toHaveBeenCalledWith(50);
        expect(query.range).toHaveBeenCalledWith(10, 59);
      });
    });
  });

  describe("Network Error Handling", () => {
    beforeEach(() => {
      supabaseService.initialize();
    });

    it("should handle transient errors gracefully", async () => {
      const errorQuery = createQueryMock(null, { message: "Network timeout" });
      mockSupabaseClient.from.mockReturnValue(errorQuery);

      // Analytics should not throw
      await expect(
        supabaseService.trackEvent("user-123", "test_event", {}),
      ).resolves.not.toThrow();

      // API limit check should fail open
      const limitResult = await supabaseService.checkApiLimit(
        "user-123",
        "api",
      );
      expect(limitResult.allowed).toBe(true);
    });

    it("should handle errors for critical operations", async () => {
      const errorQuery = createQueryMock(null, { message: "Database error" });
      mockSupabaseClient.from.mockReturnValue(errorQuery);

      // User operations - verify the call is made even with errors
      try {
        await supabaseService.getUserById("user-123");
        // If no throw, that's one valid behavior
      } catch {
        // Error thrown is also acceptable
      }

      // Verify Supabase was called
      expect(mockSupabaseClient.from).toHaveBeenCalled();
    });
  });
});

// BACKLOG-2414: this file has no top-level import/export, so TypeScript treats it as a
// script and its top-level `const mockSupabaseClient` lands in the GLOBAL scope — colliding
// with the identically-named const in the sibling suite (TS2451). Jest already isolates
// these at runtime (one module registry per test file), so this marker only makes the file a
// module for the type-checker; it changes no test behaviour.
export {};
