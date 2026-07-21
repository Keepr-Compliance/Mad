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
    // BACKLOG-2148 (case a): a transient license-LOAD failure with no cache must NOT
    // gate an authenticated user. The old behavior returned isValid:false/'no_license'
    // which the deep-link gate rendered as the false "Trial Expired / Upgrade" screen
    // (ELECTRON-1Z). It now fails OPEN with the soft, non-blocking 'load_error' reason.
    it("fails open (isValid, load_error) when no cache and Supabase fails", async () => {
      // No cache
      mockFs.readFile.mockRejectedValueOnce({ code: "ENOENT" });

      // Supabase fails (transient — network / DB-init race)
      mockClient.single.mockRejectedValueOnce(new Error("Network error"));

      const result = await licenseService.validateLicense("user-123");

      expect(result.isValid).toBe(true);
      expect(result.blockReason).toBe("load_error");
      // Neutral, non-trial type so no false "trial" banner shows.
      expect(result.licenseType).toBe("individual");
      // 'load_error' (not 'no_license') so the caller retries online rather than
      // forcing trial-license creation.
      expect(result.blockReason).not.toBe("no_license");
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

    // BACKLOG-2148 (case b): an aged cache is a TRANSIENT signal, not a terminal one.
    // A previously-VALID cached license must NOT be flipped to expired (the regression).
    // It fails OPEN with 'load_error' and, per the identity-assertion directive, EVERY
    // cached field is preserved verbatim — only the soft tag is attached.
    it("does NOT flip a previously-valid license to expired when cache is too old (fails open)", async () => {
      const cachedStatus: LicenseValidationResult = {
        isValid: true,
        licenseType: "individual",
        transactionCount: 42,
        transactionLimit: 1000,
        canCreateTransaction: true,
        deviceCount: 2,
        deviceLimit: 2,
        aiEnabled: true,
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

      // Fails OPEN — not gated.
      expect(result.isValid).toBe(true);
      expect(result.blockReason).toBe("load_error");
      // Identity assertion: every prior field is preserved (only isValid/blockReason
      // are the soft overrides). A user at quota keeps their real quota — no headroom.
      expect(result.licenseType).toBe("individual");
      expect(result.transactionCount).toBe(42);
      expect(result.transactionLimit).toBe(1000);
      expect(result.canCreateTransaction).toBe(true);
      expect(result.deviceCount).toBe(2);
      expect(result.deviceLimit).toBe(2);
      expect(result.aiEnabled).toBe(true);
    });

    // BACKLOG-2148 (case c): CARVE-OUT — a cached status that was itself TERMINAL
    // (suspended, per the BACKLOG-2077 chargeback path) is honored verbatim even when
    // aged. We never fail-open a definitively-blocked account.
    it("keeps blocking an aged cache whose status was suspended (carve-out)", async () => {
      const cachedStatus: LicenseValidationResult = {
        isValid: false,
        licenseType: "individual",
        transactionCount: 10,
        transactionLimit: 1000,
        canCreateTransaction: false,
        deviceCount: 1,
        deviceLimit: 2,
        aiEnabled: false,
        blockReason: "suspended",
      };

      const cache = {
        status: cachedStatus,
        userId: "user-123",
        cachedAt: Date.now() - 25 * 60 * 60 * 1000, // aged, beyond grace
      };

      mockClient.single.mockRejectedValueOnce(new Error("Network error"));
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify(cache));

      const result = await licenseService.validateLicense("user-123");

      // Still blocked — suspension is honored, not failed-open.
      expect(result.isValid).toBe(false);
      expect(result.blockReason).toBe("suspended");
    });

    // BACKLOG-2148 (case g): CARVE-OUT hardening — the aged-cache preservation checks
    // isValid===false (not a reason list), so a cached EXPIRED/terminal state also
    // stays blocked rather than being soft-converted.
    it("keeps blocking an aged cache whose status was already invalid/expired", async () => {
      const cachedStatus: LicenseValidationResult = {
        isValid: false,
        licenseType: "trial",
        transactionCount: 5,
        transactionLimit: 5,
        canCreateTransaction: false,
        deviceCount: 1,
        deviceLimit: 1,
        aiEnabled: false,
        blockReason: "expired",
      };

      const cache = {
        status: cachedStatus,
        userId: "user-123",
        cachedAt: Date.now() - 25 * 60 * 60 * 1000, // aged, beyond grace
      };

      mockClient.single.mockRejectedValueOnce(new Error("Network error"));
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify(cache));

      const result = await licenseService.validateLicense("user-123");

      // A previously-terminal cache is NOT soft-converted to load_error.
      expect(result.isValid).toBe(false);
      expect(result.blockReason).toBe("expired");
    });

    // A cache for a DIFFERENT user is ignored (returns null), so validateLicense falls
    // through to the no-cache path. BACKLOG-2148: that path now fails OPEN (load_error),
    // not isValid:false/'no_license'.
    it("ignores cache for different user and fails open", async () => {
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

      // Then cache is read but for different user (ignored -> null)
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify(cache));

      const result = await licenseService.validateLicense("user-123");

      // No usable cache -> transient fail-open, not gated.
      expect(result.isValid).toBe(true);
      expect(result.blockReason).toBe("load_error");
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

    // BACKLOG-2148 (case d): the fail-open fix must NOT regress genuine trial expiry.
    // A real trial that has actually expired is still terminally blocked with 'expired'.
    it("still blocks a genuinely-expired real trial with blockReason='expired'", () => {
      const result = licenseService.calculateLicenseStatus(
        makeLicense({
          license_type: "trial",
          trial_status: "active",
          // Expired an hour ago.
          trial_expires_at: new Date(Date.now() - 3_600_000).toISOString(),
        }),
        1
      );
      expect(result.isValid).toBe(false);
      expect(result.blockReason).toBe("expired");
    });

    // BACKLOG-2148: the exact account type from ELECTRON-1Z — a valid active individual
    // with no trial — is NOT blocked when the license is read successfully from the
    // server. (The false gate only ever came from the transient load-failure fallbacks.)
    it("does NOT block a valid active individual (the ELECTRON-1Z account type)", () => {
      const result = licenseService.calculateLicenseStatus(
        makeLicense({ status: "active", license_type: "individual" }),
        1
      );
      expect(result.isValid).toBe(true);
      expect(result.blockReason).toBeUndefined();
    });
  });

  // BACKLOG-2148 (case f / must-fix #2): the fail-open change touches ONLY the
  // catch/aged-cache paths. The success path where Supabase returns no license row for
  // a genuinely new user must be UNCHANGED — it still yields isValid:true/'no_license'
  // so the caller auto-creates a trial. If this regressed, new users would get
  // 'load_error' and never receive a trial row.
  describe("validateLicense - new user (no license row)", () => {
    it("returns isValid:true + blockReason='no_license' when Supabase returns no row", async () => {
      // Supabase succeeds but there is no license row (PGRST116 is treated as no row).
      mockClient.single.mockResolvedValueOnce({ data: null, error: null });

      const result = await licenseService.validateLicense("new-user-456");

      expect(result.isValid).toBe(true);
      expect(result.blockReason).toBe("no_license");
      // Must NOT be soft-converted to load_error — the caller keys trial creation on
      // 'no_license'.
      expect(result.blockReason).not.toBe("load_error");
    });
  });
});
