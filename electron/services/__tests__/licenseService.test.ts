/**
 * @jest-environment node
 */

/**
 * Unit tests for LicenseService
 * SPRINT-062: Auth Flow + Licensing System
 *
 * Tests license validation, caching, and permission checks.
 * Note: Tests for canPerformAction are fully covered as it's pure logic.
 * Tests for Supabase-dependent functions test error handling paths.
 */

import { jest } from "@jest/globals";

// Mock Electron app module
jest.mock("electron", () => ({
  app: {
    getPath: jest.fn(() => "/mock/user/data"),
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

// Create mock chain helpers
function createMockChain(finalResult: unknown) {
  const chain: Record<string, jest.Mock> = {};
  chain.from = jest.fn().mockReturnValue(chain);
  chain.select = jest.fn().mockReturnValue(chain);
  chain.eq = jest.fn().mockReturnValue(chain);
  chain.single = jest.fn().mockResolvedValue(finalResult);
  chain.rpc = jest.fn().mockResolvedValue(finalResult);
  return chain;
}

// Mock supabaseService
let mockClient: ReturnType<typeof createMockChain>;

jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: {
    getClient: jest.fn(() => mockClient),
  },
}));

// Import types
import type { LicenseValidationResult } from "../../../shared/types/license";
import type { License } from "../../types/license";

describe("LicenseService", () => {
  let licenseService: typeof import("../licenseService");

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.resetModules();

    // Reset mock implementations
    mockFs.writeFile.mockResolvedValue(undefined);
    mockFs.readFile.mockRejectedValue({ code: "ENOENT" });
    mockFs.unlink.mockResolvedValue(undefined);

    // Create fresh mock client
    mockClient = createMockChain({ data: null, error: null });

    // Re-import to get fresh instance
    licenseService = await import("../licenseService");
  });

  describe("canPerformAction", () => {
    const baseStatus: LicenseValidationResult = {
      isValid: true,
      licenseType: "trial",
      transactionCount: 0,
      transactionLimit: 5,
      canCreateTransaction: true,
      deviceCount: 1,
      deviceLimit: 1,
      aiEnabled: false,
    };

    it("returns false when license is invalid", () => {
      const status: LicenseValidationResult = { ...baseStatus, isValid: false };
      expect(licenseService.canPerformAction(status, "create_transaction")).toBe(
        false
      );
    });

    it("allows transaction creation when under limit", () => {
      expect(
        licenseService.canPerformAction(baseStatus, "create_transaction")
      ).toBe(true);
    });

    it("blocks transaction creation when at limit", () => {
      const status: LicenseValidationResult = {
        ...baseStatus,
        canCreateTransaction: false,
      };
      expect(licenseService.canPerformAction(status, "create_transaction")).toBe(
        false
      );
    });

    it("blocks AI for trial users", () => {
      expect(licenseService.canPerformAction(baseStatus, "use_ai")).toBe(false);
    });

    it("allows AI when enabled", () => {
      const status: LicenseValidationResult = { ...baseStatus, aiEnabled: true };
      expect(licenseService.canPerformAction(status, "use_ai")).toBe(true);
    });

    it("blocks export for trial users", () => {
      expect(licenseService.canPerformAction(baseStatus, "export")).toBe(false);
    });

    it("allows export for individual license users", () => {
      const status: LicenseValidationResult = {
        ...baseStatus,
        licenseType: "individual",
      };
      expect(licenseService.canPerformAction(status, "export")).toBe(true);
    });

    it("allows export for team license users", () => {
      const status: LicenseValidationResult = {
        ...baseStatus,
        licenseType: "team",
      };
      expect(licenseService.canPerformAction(status, "export")).toBe(true);
    });

    it("returns false for invalid license regardless of action", () => {
      const invalidStatus: LicenseValidationResult = {
        ...baseStatus,
        isValid: false,
        aiEnabled: true,
        canCreateTransaction: true,
        licenseType: "team",
      };
      expect(licenseService.canPerformAction(invalidStatus, "create_transaction")).toBe(false);
      expect(licenseService.canPerformAction(invalidStatus, "use_ai")).toBe(false);
      expect(licenseService.canPerformAction(invalidStatus, "export")).toBe(false);
    });
  });

  describe("clearLicenseCache", () => {
    it("deletes the cache file", async () => {
      await licenseService.clearLicenseCache();

      expect(mockFs.unlink).toHaveBeenCalledWith(
        expect.stringContaining("license-cache.json")
      );
    });

    it("handles missing cache file gracefully", async () => {
      mockFs.unlink.mockRejectedValueOnce({ code: "ENOENT" });

      // Should not throw
      await expect(
        licenseService.clearLicenseCache()
      ).resolves.not.toThrow();
    });

    it("handles other errors gracefully", async () => {
      mockFs.unlink.mockRejectedValueOnce(new Error("Permission denied"));

      // Should not throw
      await expect(
        licenseService.clearLicenseCache()
      ).resolves.not.toThrow();
    });
  });

  describe("incrementTransactionCount", () => {
    it("calls Supabase RPC and returns new count", async () => {
      mockClient.rpc.mockResolvedValueOnce({
        data: 3,
        error: null,
      });

      const result = await licenseService.incrementTransactionCount("user-123");

      expect(mockClient.rpc).toHaveBeenCalledWith(
        "increment_transaction_count",
        { p_user_id: "user-123" }
      );
      expect(result).toBe(3);
    });

    it("throws error when RPC fails", async () => {
      mockClient.rpc.mockResolvedValueOnce({
        data: null,
        error: { message: "RPC error" },
      });

      await expect(
        licenseService.incrementTransactionCount("user-123")
      ).rejects.toThrow("Failed to increment transaction count");
    });
  });

  describe("createUserLicense", () => {
    it("throws error when RPC fails", async () => {
      mockClient.rpc.mockResolvedValueOnce({
        data: null,
        error: { message: "RPC error" },
      });

      await expect(
        licenseService.createUserLicense("user-123")
      ).rejects.toThrow("Failed to create license");
    });
  });

  describe("validateLicense - offline fallback", () => {
    it("returns invalid status when no cache and Supabase fails", async () => {
      // No cache
      mockFs.readFile.mockRejectedValueOnce({ code: "ENOENT" });

      // Supabase fails
      mockClient.single.mockRejectedValueOnce(new Error("Network error"));

      const result = await licenseService.validateLicense("user-123");

      expect(result.isValid).toBe(false);
      expect(result.blockReason).toBe("no_license");
    });

    it("uses cache when Supabase fails and cache is valid", async () => {
      const cachedStatus: LicenseValidationResult = {
        isValid: true,
        licenseType: "trial",
        transactionCount: 3,
        transactionLimit: 5,
        canCreateTransaction: true,
        deviceCount: 1,
        deviceLimit: 1,
        aiEnabled: false,
      };

      const cache = {
        status: cachedStatus,
        userId: "user-123",
        cachedAt: Date.now() - 1000, // 1 second ago (within grace period)
      };

      // Supabase fails first
      mockClient.single.mockRejectedValueOnce(new Error("Network error"));

      // Then cache is read
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify(cache));

      const result = await licenseService.validateLicense("user-123");

      expect(result.isValid).toBe(true);
      expect(result.transactionCount).toBe(3);
    });

    it("returns expired status when cache is too old", async () => {
      const cachedStatus: LicenseValidationResult = {
        isValid: true,
        licenseType: "trial",
        transactionCount: 3,
        transactionLimit: 5,
        canCreateTransaction: true,
        deviceCount: 1,
        deviceLimit: 1,
        aiEnabled: false,
      };

      // Cache from 25 hours ago (beyond 24-hour grace period)
      const cache = {
        status: cachedStatus,
        userId: "user-123",
        cachedAt: Date.now() - 25 * 60 * 60 * 1000,
      };

      // Supabase fails first
      mockClient.single.mockRejectedValueOnce(new Error("Network error"));

      // Then cache is read
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify(cache));

      const result = await licenseService.validateLicense("user-123");

      expect(result.isValid).toBe(false);
      expect(result.blockReason).toBe("expired");
    });

    it("ignores cache for different user", async () => {
      const cachedStatus: LicenseValidationResult = {
        isValid: true,
        licenseType: "trial",
        transactionCount: 3,
        transactionLimit: 5,
        canCreateTransaction: true,
        deviceCount: 1,
        deviceLimit: 1,
        aiEnabled: false,
      };

      const cache = {
        status: cachedStatus,
        userId: "different-user",
        cachedAt: Date.now() - 1000,
      };

      // Supabase fails first
      mockClient.single.mockRejectedValueOnce(new Error("Network error"));

      // Then cache is read but for different user
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify(cache));

      const result = await licenseService.validateLicense("user-123");

      // Should return no_license since cache was for different user
      expect(result.isValid).toBe(false);
      expect(result.blockReason).toBe("no_license");
    });
  });

  // BACKLOG-2077: the chargeback-suspension path depends on a suspended license
  // status mapping to blockReason='suspended' (the switch the renderer honours to
  // show the humane "License Suspended — contact support" screen). This is the
  // desktop half of the chargeback flow: the webhook flips licenses.status, and
  // calculateLicenseStatus is what turns that into the block the app renders.
  describe("calculateLicenseStatus — suspended status", () => {
    function makeLicense(overrides: Record<string, unknown> = {}): License {
      return {
        id: "lic-1",
        user_id: "user-123",
        license_key: "KEY-123",
        max_devices: 2,
        status: "active",
        expires_at: null,
        activated_at: null,
        license_type: "individual",
        trial_status: "converted",
        trial_started_at: new Date().toISOString(),
        trial_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        transaction_count: 0,
        transaction_limit: 1000,
        ai_detection_enabled: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...overrides,
      } as License;
    }

    it("maps status='suspended' to isValid=false + blockReason='suspended'", () => {
      const result = licenseService.calculateLicenseStatus(
        makeLicense({ status: "suspended" }),
        1
      );
      expect(result.isValid).toBe(false);
      expect(result.blockReason).toBe("suspended");
    });

    it("does NOT block an active license (blockReason undefined)", () => {
      const result = licenseService.calculateLicenseStatus(
        makeLicense({ status: "active" }),
        1
      );
      expect(result.isValid).toBe(true);
      expect(result.blockReason).toBeUndefined();
    });

    it("suspension outranks a paid individual license (a repaid dispute needs a manual lift)", () => {
      // Even a fully-paid individual plan is blocked while suspended — reinstatement
      // is a deliberate support action, not implicit.
      const result = licenseService.calculateLicenseStatus(
        makeLicense({ status: "suspended", license_type: "individual" }),
        2
      );
      expect(result.blockReason).toBe("suspended");
    });
  });
});
