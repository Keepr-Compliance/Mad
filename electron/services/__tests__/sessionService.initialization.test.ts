/**
 * @jest-environment node
 */

/**
 * Tests for SessionService initialization bug fix
 *
 * Bug: SessionService constructor called app.getPath('userData') before Electron app was ready,
 * causing "Cannot read properties of undefined (reading 'getPath')" error.
 *
 * Fix: Implemented lazy initialization pattern where sessionFilePath is initialized
 * only when first accessed, ensuring app.getPath() is called after app.whenReady().
 */

import path from "path";

// Mock Electron app and safeStorage modules
const mockGetPath = jest.fn(() => "/mock/user/data");

jest.mock("electron", () => ({
  app: {
    getPath: mockGetPath,
  },
  safeStorage: {
    isEncryptionAvailable: jest.fn(() => true),
    encryptString: jest.fn((str: string) => Buffer.from(`encrypted:${str}`)),
    decryptString: jest.fn((buf: Buffer) => {
      const str = buf.toString();
      if (str.startsWith("encrypted:")) return str.slice("encrypted:".length);
      throw new Error("Cannot decrypt");
    }),
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
    logService: mockFns,
  };
});

describe("SessionService - Initialization Bug Fix", () => {
  let sessionService: typeof import("../sessionService").default;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.resetModules();

    // Reset mock implementations
    mockFs.writeFile.mockResolvedValue(undefined);
    mockFs.readFile.mockResolvedValue("{}");
    mockFs.unlink.mockResolvedValue(undefined);
    mockGetPath.mockReturnValue("/mock/user/data");

    // Re-import to get fresh instance
    const module = await import("../sessionService");
    sessionService = module.default;
  });

  describe("Lazy Initialization", () => {
    it("should not call app.getPath on module import", () => {
      // When the module is imported, getPath should NOT be called
      // This prevents the "Cannot read properties of undefined" error
      // when the module loads before Electron app is ready

      // Since we already imported in beforeEach, check call count is minimal
      // The actual implementation should only call getPath when methods are invoked
      // At this point, sessionFilePath should be null, not initialized
      expect((sessionService as any).sessionFilePath).toBeNull();
    });

    it("should initialize sessionFilePath on first saveSession call", async () => {
      const sessionData = {
        user: {
          id: "user-123",
          email: "test@example.com",
          oauth_provider: "google" as const,
          oauth_id: "google-123",
          subscription_tier: "free" as const,
          subscription_status: "trial" as const,
          is_active: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        sessionToken: "session-token-abc123",
        provider: "google" as const,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        createdAt: Date.now(),
      };

      // Before calling saveSession, getPath should not have been called
      mockGetPath.mockClear();

      await sessionService.saveSession(sessionData);

      // After saveSession, getPath should have been called
      expect(mockGetPath).toHaveBeenCalledWith("userData");

      // And the file should be written to the correct path
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        path.join("/mock/user/data", "session.json"),
        expect.any(String),
        "utf8",
      );
    });

    it("should initialize sessionFilePath on first loadSession call", async () => {
      const futureExpiry = Date.now() + 24 * 60 * 60 * 1000;
      const sessionData = {
        user: {
          id: "user-123",
          email: "test@example.com",
          oauth_provider: "google",
          oauth_id: "google-123",
        },
        sessionToken: "session-token-abc123",
        provider: "google",
        expiresAt: futureExpiry,
        createdAt: Date.now(),
      };

      // Create encrypted file content matching mock safeStorage format
      const json = JSON.stringify(sessionData);
      const encrypted = Buffer.from(`encrypted:${json}`).toString("base64");
      mockFs.readFile.mockResolvedValue(JSON.stringify({ encrypted }));
      mockGetPath.mockClear();

      await sessionService.loadSession();

      // getPath should have been called during loadSession
      expect(mockGetPath).toHaveBeenCalledWith("userData");

      // And it should read from the correct path
      expect(mockFs.readFile).toHaveBeenCalledWith(
        path.join("/mock/user/data", "session.json"),
        "utf8",
      );
    });

    it("should initialize sessionFilePath on first clearSession call", async () => {
      mockGetPath.mockClear();

      await sessionService.clearSession();

      // getPath should have been called during clearSession
      expect(mockGetPath).toHaveBeenCalledWith("userData");

      // And it should delete the correct path
      expect(mockFs.unlink).toHaveBeenCalledWith(
        path.join("/mock/user/data", "session.json"),
      );
    });

    it("should cache sessionFilePath after first initialization", async () => {
      const sessionData = {
        user: {
          id: "user-123",
          email: "test@example.com",
          oauth_provider: "google" as const,
          oauth_id: "google-123",
          subscription_tier: "free" as const,
          subscription_status: "trial" as const,
          is_active: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        sessionToken: "session-token-abc123",
        provider: "google" as const,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        createdAt: Date.now(),
      };

      mockGetPath.mockClear();

      // First call should initialize
      await sessionService.saveSession(sessionData);
      const firstCallCount = mockGetPath.mock.calls.length;
      expect(firstCallCount).toBe(1);

      // Second call should use cached path
      await sessionService.saveSession(sessionData);
      const secondCallCount = mockGetPath.mock.calls.length;
      expect(secondCallCount).toBe(1); // Should still be 1, not incremented

      // Third call (different method) should also use cached path
      const json = JSON.stringify(sessionData);
      const encrypted = Buffer.from(`encrypted:${json}`).toString("base64");
      mockFs.readFile.mockResolvedValue(JSON.stringify({ encrypted }));
      await sessionService.loadSession();
      const thirdCallCount = mockGetPath.mock.calls.length;
      expect(thirdCallCount).toBe(1); // Should still be 1
    });

    it("should handle app.getPath error gracefully", async () => {
      mockGetPath.mockImplementation(() => {
        throw new Error("App not ready");
      });

      const sessionData = {
        user: {
          id: "user-123",
          email: "test@example.com",
          oauth_provider: "google" as const,
          oauth_id: "google-123",
          subscription_tier: "free" as const,
          subscription_status: "trial" as const,
          is_active: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        sessionToken: "session-token-abc123",
        provider: "google" as const,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        createdAt: Date.now(),
      };

      // The error should be caught and logged
      const result = await sessionService.saveSession(sessionData);

      // Should return false on error
      expect(result).toBe(false);
    });
  });

  describe("Integration with File Operations", () => {
    it("should work correctly when app.getPath returns different paths", async () => {
      // Test that the lazy initialization works with different userData paths
      mockGetPath.mockReturnValue("/different/user/path");

      const sessionData = {
        user: {
          id: "user-123",
          email: "test@example.com",
          oauth_provider: "google" as const,
          oauth_id: "google-123",
          subscription_tier: "free" as const,
          subscription_status: "trial" as const,
          is_active: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        sessionToken: "session-token-abc123",
        provider: "google" as const,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        createdAt: Date.now(),
      };

      await sessionService.saveSession(sessionData);

      expect(mockFs.writeFile).toHaveBeenCalledWith(
        path.join("/different/user/path", "session.json"),
        expect.any(String),
        "utf8",
      );
    });

    it("should maintain consistent path across multiple operations", async () => {
      const sessionData = {
        user: {
          id: "user-123",
          email: "test@example.com",
          oauth_provider: "google" as const,
          oauth_id: "google-123",
          subscription_tier: "free" as const,
          subscription_status: "trial" as const,
          is_active: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        sessionToken: "session-token-abc123",
        provider: "google" as const,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        createdAt: Date.now(),
      };

      const jsonStr = JSON.stringify(sessionData);
      const encryptedB64 = Buffer.from(`encrypted:${jsonStr}`).toString("base64");
      mockFs.readFile.mockResolvedValue(JSON.stringify({ encrypted: encryptedB64 }));

      // Perform multiple operations
      await sessionService.saveSession(sessionData);
      await sessionService.loadSession();
      await sessionService.clearSession();

      // All operations should use the same path
      const expectedPath = path.join("/mock/user/data", "session.json");
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        expectedPath,
        expect.any(String),
        "utf8",
      );
      expect(mockFs.readFile).toHaveBeenCalledWith(expectedPath, "utf8");
      expect(mockFs.unlink).toHaveBeenCalledWith(expectedPath);
    });
  });
});
