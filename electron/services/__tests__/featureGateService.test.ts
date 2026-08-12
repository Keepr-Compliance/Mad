/**
 * @jest-environment node
 */

/**
 * Unit tests for FeatureGateService
 * SPRINT-122: Plan Admin + Feature Gate Enforcement
 *
 * Tests feature gate checking, caching, persistence, and fail-open behavior.
 */

import path from "path";

// ============================================
// Mocks
// ============================================

const MOCK_USER_DATA_DIR = path.join("/mock", "user", "data");
const MOCK_CACHE_PATH = path.join(MOCK_USER_DATA_DIR, "feature-cache.json");

// Mock Electron app module
jest.mock("electron", () => ({
  app: {
    getPath: jest.fn(() => path.join("/mock", "user", "data")),
  },
}));

// Mock fs promises module
const mockFs = {
  writeFile: jest.fn(),
  readFile: jest.fn(),
  unlink: jest.fn(),
};

jest.mock("fs", () => ({
  promises: mockFs,
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
  };
});

// Mock Sentry
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
}));

// Mock supabaseService
const mockRpc = jest.fn();
const mockGetSession = jest.fn();
const mockGetAuthSession = jest.fn();
jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: {
    getClient: () => ({
      rpc: mockRpc,
      auth: {
        getSession: mockGetSession,
      },
    }),
    getAuthSession: mockGetAuthSession,
  },
}));

// ============================================
// Test Suite
// ============================================

// We need to re-import the module for each test to get a fresh singleton
// Instead, we'll use the module and manage state via clearCache
import featureGateService from "../featureGateService";

/**
 * Helper: Build a mock RPC response matching the JSONB shape
 * returned by get_org_features.
 */
function mockOrgFeaturesResponse(
  features: Record<string, { enabled: boolean; value: string; source: string }>
) {
  return {
    data: {
      org_id: "org-mock",
      plan_name: "Trial",
      plan_tier: "trial",
      features,
    },
    error: null,
  };
}

describe("FeatureGateService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset the service's internal state
    featureGateService.invalidateCache();
    // Default mock: fs.readFile throws ENOENT (no persisted cache)
    mockFs.readFile.mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    );
    mockFs.writeFile.mockResolvedValue(undefined);
    mockFs.unlink.mockResolvedValue(undefined);
    // BACKLOG-1348: Default mock for auth session check — simulate active session
    mockGetSession.mockResolvedValue({
      data: { session: { user: { id: "user-mock" }, access_token: "token-mock" } },
    });
    mockGetAuthSession.mockResolvedValue({
      userId: "user-mock",
      accessToken: "token-mock",
    });
  });

  // ==========================================
  // checkFeature
  // ==========================================

  describe("checkFeature", () => {
    it("should fetch from Supabase on first call and cache the result", async () => {
      mockRpc.mockResolvedValue(
        mockOrgFeaturesResponse({
          text_export: { enabled: true, value: "unlimited", source: "plan" },
          email_export: { enabled: false, value: "", source: "plan" },
        })
      );

      const result = await featureGateService.checkFeature(
        "org-1",
        "text_export"
      );

      expect(result).toEqual({
        allowed: true,
        value: "unlimited",
        source: "plan",
      });
      expect(mockRpc).toHaveBeenCalledWith("get_org_features", {
        p_org_id: "org-1",
      });
    });

    it("should return cached value on subsequent calls within TTL", async () => {
      mockRpc.mockResolvedValue(
        mockOrgFeaturesResponse({
          text_export: { enabled: true, value: "", source: "plan" },
        })
      );

      // First call: fetches from Supabase
      await featureGateService.checkFeature("org-1", "text_export");
      expect(mockRpc).toHaveBeenCalledTimes(1);

      // Second call: should use cache
      const result = await featureGateService.checkFeature(
        "org-1",
        "text_export"
      );
      expect(mockRpc).toHaveBeenCalledTimes(1); // Not called again
      expect(result.allowed).toBe(true);
    });

    it("should return default (allowed) for unknown features", async () => {
      mockRpc.mockResolvedValue(
        mockOrgFeaturesResponse({
          text_export: { enabled: true, value: "", source: "plan" },
        })
      );

      const result = await featureGateService.checkFeature(
        "org-1",
        "unknown_feature"
      );

      expect(result).toEqual({
        allowed: true,
        value: "",
        source: "default",
      });
    });

    it("should return feature as blocked when RPC says disabled", async () => {
      mockRpc.mockResolvedValue(
        mockOrgFeaturesResponse({
          email_export: { enabled: false, value: "", source: "plan" },
        })
      );

      const result = await featureGateService.checkFeature(
        "org-1",
        "email_export"
      );

      expect(result).toEqual({
        allowed: false,
        value: "",
        source: "plan",
      });
    });

    it("should fall back to persisted cache when Supabase fails", async () => {
      // Supabase fails
      mockRpc.mockRejectedValue(new Error("Network error"));

      // But we have a persisted cache
      const persistedCache = {
        features: {
          text_export: { allowed: true, value: "", source: "plan" as const },
        },
        fetchedAt: Date.now() - 60 * 1000, // 1 minute old
        orgId: "org-1",
      };
      mockFs.readFile.mockResolvedValue(JSON.stringify(persistedCache));

      const result = await featureGateService.checkFeature(
        "org-1",
        "text_export"
      );

      expect(result).toEqual({
        allowed: true,
        value: "",
        source: "plan",
      });
    });

    it("should fail-open when offline with no cache", async () => {
      // Supabase fails
      mockRpc.mockRejectedValue(new Error("Network error"));

      // No persisted cache (ENOENT)
      mockFs.readFile.mockRejectedValue(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" })
      );

      const result = await featureGateService.checkFeature(
        "org-1",
        "text_export"
      );

      expect(result).toEqual({
        allowed: true,
        value: "",
        source: "default",
      });
    });

    it("should refetch when cache is for a different org", async () => {
      // First call: org-1
      mockRpc.mockResolvedValue(
        mockOrgFeaturesResponse({
          text_export: { enabled: true, value: "", source: "plan" },
        })
      );
      await featureGateService.checkFeature("org-1", "text_export");
      expect(mockRpc).toHaveBeenCalledTimes(1);

      // Second call: different org
      mockRpc.mockResolvedValue(
        mockOrgFeaturesResponse({
          text_export: { enabled: false, value: "", source: "plan" },
        })
      );
      const result = await featureGateService.checkFeature(
        "org-2",
        "text_export"
      );

      expect(mockRpc).toHaveBeenCalledTimes(2); // Called again
      expect(result.allowed).toBe(false);
    });

    it("should ignore persisted cache for different org", async () => {
      mockRpc.mockRejectedValue(new Error("Network error"));

      // Persisted cache is for org-1
      const persistedCache = {
        features: {
          text_export: { allowed: true, value: "", source: "plan" as const },
        },
        fetchedAt: Date.now(),
        orgId: "org-1",
      };
      mockFs.readFile.mockResolvedValue(JSON.stringify(persistedCache));

      // Requesting for org-2 => should fail-open
      const result = await featureGateService.checkFeature(
        "org-2",
        "text_export"
      );

      expect(result).toEqual({
        allowed: true,
        value: "",
        source: "default",
      });
    });
  });

  // ==========================================
  // getAllFeatures
  // ==========================================

  describe("getAllFeatures", () => {
    it("should return all features from Supabase", async () => {
      mockRpc.mockResolvedValue(
        mockOrgFeaturesResponse({
          text_export: { enabled: true, value: "", source: "plan" },
          email_export: { enabled: false, value: "", source: "plan" },
          call_log: { enabled: true, value: "basic", source: "override" },
        })
      );

      const result = await featureGateService.getAllFeatures("org-1");

      expect(Object.keys(result)).toHaveLength(3);
      expect(result["text_export"]?.allowed).toBe(true);
      expect(result["email_export"]?.allowed).toBe(false);
      expect(result["call_log"]?.value).toBe("basic");
    });

    it("should return empty when no cache and offline (fail-open)", async () => {
      mockRpc.mockRejectedValue(new Error("Network error"));
      mockFs.readFile.mockRejectedValue(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" })
      );

      const result = await featureGateService.getAllFeatures("org-1");

      expect(result).toEqual({});
    });

    it("should use cached features on subsequent calls", async () => {
      mockRpc.mockResolvedValue(
        mockOrgFeaturesResponse({
          text_export: { enabled: true, value: "", source: "plan" },
        })
      );

      await featureGateService.getAllFeatures("org-1");
      await featureGateService.getAllFeatures("org-1");

      expect(mockRpc).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================
  // Cache behavior
  // ==========================================

  describe("cache behavior", () => {
    it("should persist cache to disk after fetch", async () => {
      mockRpc.mockResolvedValue(
        mockOrgFeaturesResponse({
          text_export: { enabled: true, value: "", source: "plan" },
        })
      );

      await featureGateService.checkFeature("org-1", "text_export");

      expect(mockFs.writeFile).toHaveBeenCalledWith(
        MOCK_CACHE_PATH,
        expect.any(String),
        "utf8"
      );

      // Verify the written content is valid JSON with expected shape
      const writtenContent = JSON.parse(
        mockFs.writeFile.mock.calls[0][1] as string
      );
      expect(writtenContent.orgId).toBe("org-1");
      expect(writtenContent.features.text_export.allowed).toBe(true);
      expect(writtenContent.fetchedAt).toBeDefined();
    });

    it("should invalidate cache on invalidateCache()", async () => {
      mockRpc.mockResolvedValue(
        mockOrgFeaturesResponse({
          text_export: { enabled: true, value: "", source: "plan" },
        })
      );

      await featureGateService.checkFeature("org-1", "text_export");
      expect(mockRpc).toHaveBeenCalledTimes(1);

      featureGateService.invalidateCache();

      await featureGateService.checkFeature("org-1", "text_export");
      expect(mockRpc).toHaveBeenCalledTimes(2);
    });

    it("should clear both memory and disk cache on clearCache()", async () => {
      mockRpc.mockResolvedValue(
        mockOrgFeaturesResponse({})
      );

      await featureGateService.checkFeature("org-1", "text_export");

      await featureGateService.clearCache();

      expect(mockFs.unlink).toHaveBeenCalledWith(
        MOCK_CACHE_PATH
      );

      // After clearing, should re-fetch
      await featureGateService.checkFeature("org-1", "text_export");
      expect(mockRpc).toHaveBeenCalledTimes(2);
    });

    it("should handle clearCache when no cache file exists", async () => {
      mockFs.unlink.mockRejectedValue(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" })
      );

      // Should not throw
      await expect(
        featureGateService.clearCache()
      ).resolves.toBeUndefined();
    });

    it("should discard persisted cache older than 7 days", async () => {
      // Supabase fails
      mockRpc.mockRejectedValue(new Error("Network error"));

      // Persisted cache is 8 days old
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      const persistedCache = {
        features: {
          text_export: { allowed: false, value: "", source: "plan" as const },
        },
        fetchedAt: eightDaysAgo,
        orgId: "org-1",
      };
      mockFs.readFile.mockResolvedValue(JSON.stringify(persistedCache));

      const result = await featureGateService.checkFeature(
        "org-1",
        "text_export"
      );

      // Stale cache discarded => fail-open
      expect(result.allowed).toBe(true);
      expect(result.source).toBe("default");
      // Should have tried to clean up the stale file
      expect(mockFs.unlink).toHaveBeenCalled();
    });

    it("should use persisted cache within 7 days", async () => {
      // Supabase fails
      mockRpc.mockRejectedValue(new Error("Network error"));

      // Persisted cache is 6 days old (within limit)
      const sixDaysAgo = Date.now() - 6 * 24 * 60 * 60 * 1000;
      const persistedCache = {
        features: {
          text_export: { allowed: false, value: "", source: "plan" as const },
        },
        fetchedAt: sixDaysAgo,
        orgId: "org-1",
      };
      mockFs.readFile.mockResolvedValue(JSON.stringify(persistedCache));

      const result = await featureGateService.checkFeature(
        "org-1",
        "text_export"
      );

      // Cache is valid, should use it (feature is blocked)
      expect(result.allowed).toBe(false);
      expect(result.source).toBe("plan");
    });

    it("should handle concurrent fetches without duplicate requests", async () => {
      // Make the RPC slow
      mockRpc.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve(
                  mockOrgFeaturesResponse({
                    text_export: { enabled: true, value: "", source: "plan" },
                  })
                ),
              50
            )
          )
      );

      // Launch multiple concurrent requests
      const [result1, result2, result3] = await Promise.all([
        featureGateService.checkFeature("org-1", "text_export"),
        featureGateService.checkFeature("org-1", "text_export"),
        featureGateService.checkFeature("org-1", "text_export"),
      ]);

      // Should only have made one RPC call
      expect(mockRpc).toHaveBeenCalledTimes(1);
      expect(result1.allowed).toBe(true);
      expect(result2.allowed).toBe(true);
      expect(result3.allowed).toBe(true);
    });
  });

  // ==========================================
  // RPC error handling
  // ==========================================

  describe("RPC error handling", () => {
    it("should handle RPC returning an error", async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: "permission denied" },
      });

      // No persisted cache either
      mockFs.readFile.mockRejectedValue(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" })
      );

      const result = await featureGateService.checkFeature(
        "org-1",
        "text_export"
      );

      // Should fail-open
      expect(result.allowed).toBe(true);
      expect(result.source).toBe("default");
    });

    it("should handle RPC returning null data", async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: null,
      });

      const result = await featureGateService.checkFeature(
        "org-1",
        "text_export"
      );

      // No features in response => unknown feature => default allowed
      expect(result.allowed).toBe(true);
      expect(result.source).toBe("default");
    });

    it("should handle features with null values gracefully", async () => {
      mockRpc.mockResolvedValue(
        mockOrgFeaturesResponse({
          text_export: { enabled: true, value: null as unknown as string, source: null as unknown as string },
        })
      );

      const result = await featureGateService.checkFeature(
        "org-1",
        "text_export"
      );

      expect(result.allowed).toBe(true);
      expect(result.value).toBe(""); // null coerced to empty string
      expect(result.source).toBe("plan"); // null falls back to "plan"
    });
  });

  // ==========================================
  // Persistence error handling
  // ==========================================

  describe("persistence error handling", () => {
    it("should not throw when cache write fails", async () => {
      mockRpc.mockResolvedValue(
        mockOrgFeaturesResponse({
          text_export: { enabled: true, value: "", source: "plan" },
        })
      );
      mockFs.writeFile.mockRejectedValue(new Error("Disk full"));

      const result = await featureGateService.checkFeature(
        "org-1",
        "text_export"
      );

      // Should still return the feature even though persist failed
      expect(result.allowed).toBe(true);
    });

    it("should handle corrupt persisted cache", async () => {
      mockRpc.mockRejectedValue(new Error("Network error"));
      mockFs.readFile.mockResolvedValue("not valid json");

      const result = await featureGateService.checkFeature(
        "org-1",
        "text_export"
      );

      // Corrupt cache => fail-open
      expect(result.allowed).toBe(true);
      expect(result.source).toBe("default");
    });
  });
});
