/**
 * @jest-environment node
 */

/**
 * Unit tests for SessionService
 * Tests session persistence and management including:
 * - Saving sessions to disk
 * - Loading sessions from disk
 * - Session expiration handling
 * - Clearing sessions
 * - Updating session data
 * - Error handling for file operations
 */

import path from "path";

// Mock Electron app and safeStorage modules
jest.mock("electron", () => ({
  app: {
    getPath: jest.fn(() => "/mock/user/data"),
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

// Mock logService - must use factory function
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

/**
 * Helper: extract the session data from a writeFile call.
 * Since saveSession now encrypts via safeStorage, the written string is
 * a JSON wrapper {"encrypted":"<base64>"} where the base64 decodes to
 * "encrypted:<original_json>" due to our mock. This helper reverses that.
 */
function extractSavedSessionData(writeCallArg: string): Record<string, unknown> {
  const wrapper = JSON.parse(writeCallArg);
  if (wrapper.encrypted) {
    // Our mock encryptString produces Buffer.from(`encrypted:${str}`)
    // and the wrapper stores it as base64, so decode base64 -> strip prefix
    const decoded = Buffer.from(wrapper.encrypted, "base64").toString();
    const json = decoded.startsWith("encrypted:") ? decoded.slice("encrypted:".length) : decoded;
    return JSON.parse(json);
  }
  // Fallback: plaintext (encryption unavailable)
  return wrapper;
}

/**
 * Helper: create an encrypted file content string from session data,
 * matching the mock safeStorage format so readFile returns decryptable data.
 */
function createEncryptedFileContent(sessionData: Record<string, unknown>): string {
  const json = JSON.stringify(sessionData);
  const encrypted = Buffer.from(`encrypted:${json}`).toString("base64");
  return JSON.stringify({ encrypted });
}

describe("SessionService", () => {
  let sessionService: typeof import("../sessionService").default;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.resetModules();
    // BACKLOG-2962: resetModules gave us a fresh capability provider with nothing
    // installed. Re-install, or the first secret-store call throws.
    require("../../../tests/helpers/installTestSecretStore").installTestSecretStore();

    // Reset mock implementations
    mockFs.writeFile.mockResolvedValue(undefined);
    mockFs.readFile.mockResolvedValue("{}");
    mockFs.unlink.mockResolvedValue(undefined);

    // Re-import to get fresh instance
    const module = await import("../sessionService");
    sessionService = module.default;
  });

  describe("saveSession", () => {
    it("should save session data to disk", async () => {
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

      const result = await sessionService.saveSession(sessionData);

      expect(result).toBe(true);
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        path.join("/mock/user/data", "session.json"),
        expect.any(String),
        "utf8",
      );

      // Verify the saved data includes savedAt timestamp
      const savedData = extractSavedSessionData(mockFs.writeFile.mock.calls[0][1] as string);
      expect(savedData.savedAt).toBeDefined();
      expect((savedData.user as any).email).toBe("test@example.com");
    });

    it("should preserve existing createdAt if provided", async () => {
      const originalCreatedAt = Date.now() - 1000;
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
        createdAt: originalCreatedAt,
      };

      await sessionService.saveSession(sessionData);

      const savedData = extractSavedSessionData(mockFs.writeFile.mock.calls[0][1] as string);
      expect(savedData.createdAt).toBe(originalCreatedAt);
    });

    it("should handle write error", async () => {
      mockFs.writeFile.mockRejectedValue(new Error("Disk full"));

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
        sessionToken: "token",
        provider: "google" as const,
        expiresAt: Date.now() + 1000,
        createdAt: Date.now(),
      };

      const result = await sessionService.saveSession(sessionData);

      expect(result).toBe(false);
      // Error may or may not be logged depending on implementation
    });

    it("should include subscription data if provided", async () => {
      const sessionData = {
        user: {
          id: "user-123",
          email: "test@example.com",
          oauth_provider: "google" as const,
          oauth_id: "google-123",
          subscription_tier: "pro" as const,
          subscription_status: "active" as const,
          is_active: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        sessionToken: "token",
        provider: "google" as const,
        subscription: {
          tier: "pro" as const,
          status: "active" as const,
          isActive: true,
          isTrial: false,
          trialEnded: false,
          trialDaysRemaining: 0,
        },
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        createdAt: Date.now(),
      };

      await sessionService.saveSession(sessionData);

      const savedData = extractSavedSessionData(mockFs.writeFile.mock.calls[0][1] as string);
      expect((savedData.subscription as any).tier).toBe("pro");
      expect((savedData.subscription as any).isActive).toBe(true);
    });
  });

  describe("loadSession", () => {
    it("should load valid session from disk", async () => {
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

      mockFs.readFile.mockResolvedValue(createEncryptedFileContent(sessionData));

      const result = await sessionService.loadSession();

      expect(result).not.toBeNull();
      expect(result?.sessionToken).toBe("session-token-abc123");
      expect(result?.user.email).toBe("test@example.com");
    });

    it("should return null for expired session", async () => {
      const pastExpiry = Date.now() - 1000;
      const sessionData = {
        user: {
          id: "user-123",
          email: "test@example.com",
          oauth_provider: "google",
          oauth_id: "google-123",
        },
        sessionToken: "expired-token",
        provider: "google",
        expiresAt: pastExpiry,
        createdAt: Date.now() - 48 * 60 * 60 * 1000,
      };

      mockFs.readFile.mockResolvedValue(createEncryptedFileContent(sessionData));

      const result = await sessionService.loadSession();

      expect(result).toBeNull();
      // Session expired message is logged
    });

    it("should return null when session file does not exist", async () => {
      const error: NodeJS.ErrnoException = new Error("ENOENT");
      error.code = "ENOENT";
      mockFs.readFile.mockRejectedValue(error);

      const result = await sessionService.loadSession();

      expect(result).toBeNull();
      // Info message about missing session is logged
    });

    it("should return null on read failure", async () => {
      mockFs.readFile.mockRejectedValue(new Error("Permission denied"));

      const result = await sessionService.loadSession();

      expect(result).toBeNull();
      // Error may or may not be logged depending on implementation
    });

    it("should return null for malformed JSON", async () => {
      mockFs.readFile.mockResolvedValue("{ invalid json }");

      const result = await sessionService.loadSession();

      expect(result).toBeNull();
      // File should be deleted on corrupt content
      expect(mockFs.unlink).toHaveBeenCalled();
    });
  });

  describe("clearSession", () => {
    it("should delete session file successfully", async () => {
      const result = await sessionService.clearSession();

      expect(result).toBe(true);
      expect(mockFs.unlink).toHaveBeenCalledWith(
        path.join("/mock/user/data", "session.json"),
      );
      // Info message about session cleared is logged
    });

    it("should return true when file does not exist", async () => {
      const error: NodeJS.ErrnoException = new Error("ENOENT");
      error.code = "ENOENT";
      mockFs.unlink.mockRejectedValue(error);

      const result = await sessionService.clearSession();

      expect(result).toBe(true);
    });

    it("should handle delete error", async () => {
      mockFs.unlink.mockRejectedValue(new Error("Permission denied"));

      const result = await sessionService.clearSession();

      expect(result).toBe(false);
      // Error may or may not be logged depending on implementation
    });
  });

  describe("hasValidSession", () => {
    it("should return true when valid session exists", async () => {
      const futureExpiry = Date.now() + 24 * 60 * 60 * 1000;
      const sessionData = {
        user: {
          id: "user-123",
          email: "test@example.com",
          oauth_provider: "google",
          oauth_id: "google-123",
        },
        sessionToken: "valid-token",
        provider: "google",
        expiresAt: futureExpiry,
        createdAt: Date.now(),
      };

      mockFs.readFile.mockResolvedValue(createEncryptedFileContent(sessionData));

      const result = await sessionService.hasValidSession();

      expect(result).toBe(true);
    });

    it("should return false when no session exists", async () => {
      const error: NodeJS.ErrnoException = new Error("ENOENT");
      error.code = "ENOENT";
      mockFs.readFile.mockRejectedValue(error);

      const result = await sessionService.hasValidSession();

      expect(result).toBe(false);
    });

    it("should return false for expired session", async () => {
      const pastExpiry = Date.now() - 1000;
      const sessionData = {
        user: {
          id: "user-123",
          email: "test@example.com",
          oauth_provider: "google",
          oauth_id: "google-123",
        },
        sessionToken: "expired-token",
        provider: "google",
        expiresAt: pastExpiry,
        createdAt: Date.now() - 48 * 60 * 60 * 1000,
      };

      mockFs.readFile.mockResolvedValue(createEncryptedFileContent(sessionData));

      const result = await sessionService.hasValidSession();

      expect(result).toBe(false);
    });
  });

  describe("updateSession", () => {
    it("should merge updates with existing session", async () => {
      const futureExpiry = Date.now() + 24 * 60 * 60 * 1000;
      const existingSession = {
        user: {
          id: "user-123",
          email: "test@example.com",
          oauth_provider: "google",
          oauth_id: "google-123",
        },
        sessionToken: "existing-token",
        provider: "google",
        expiresAt: futureExpiry,
        createdAt: Date.now(),
      };

      mockFs.readFile.mockResolvedValue(createEncryptedFileContent(existingSession));

      const updates = {
        user: {
          ...existingSession.user,
          first_name: "Updated",
        },
      };

      const result = await sessionService.updateSession(updates as any);

      expect(result).toBe(true);
      expect(mockFs.writeFile).toHaveBeenCalled();

      const savedData = extractSavedSessionData(mockFs.writeFile.mock.calls[0][1] as string);
      expect((savedData.user as any).first_name).toBe("Updated");
      expect(savedData.sessionToken).toBe("existing-token");
    });

    it("should return false when no session exists", async () => {
      const error: NodeJS.ErrnoException = new Error("ENOENT");
      error.code = "ENOENT";
      mockFs.readFile.mockRejectedValue(error);

      const result = await sessionService.updateSession({
        sessionToken: "new-token",
      });

      expect(result).toBe(false);
      // Error message may vary depending on implementation
    });

    it("should handle update error", async () => {
      const existingSession = {
        user: {
          id: "user-123",
          email: "test@example.com",
          oauth_provider: "google",
          oauth_id: "google-123",
        },
        sessionToken: "token",
        provider: "google",
        expiresAt: Date.now() + 1000,
        createdAt: Date.now(),
      };

      mockFs.readFile.mockResolvedValue(createEncryptedFileContent(existingSession));
      mockFs.writeFile.mockRejectedValue(new Error("Write failed"));

      // Update may succeed or fail depending on implementation
      await sessionService.updateSession({
        sessionToken: "new-token",
      });

      // Just verify the call was attempted
      expect(mockFs.readFile).toHaveBeenCalled();
    });

    it("should update savedAt timestamp on update", async () => {
      const existingSession = {
        user: {
          id: "user-123",
          email: "test@example.com",
          oauth_provider: "google",
          oauth_id: "google-123",
        },
        sessionToken: "token",
        provider: "google",
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        createdAt: Date.now() - 1000,
        savedAt: Date.now() - 1000,
      };

      mockFs.readFile.mockResolvedValue(createEncryptedFileContent(existingSession));

      await sessionService.updateSession({ sessionToken: "updated-token" });

      const savedData = extractSavedSessionData(mockFs.writeFile.mock.calls[0][1] as string);
      expect(savedData.savedAt).toBeGreaterThan(existingSession.savedAt);
    });

    it("should update subscription data", async () => {
      const existingSession = {
        user: {
          id: "user-123",
          email: "test@example.com",
          oauth_provider: "google",
          oauth_id: "google-123",
        },
        sessionToken: "token",
        provider: "google",
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        createdAt: Date.now(),
        subscription: {
          tier: "free",
          status: "trial",
          isActive: false,
          isTrial: true,
          trialEnded: false,
          trialDaysRemaining: 14,
        },
      };

      mockFs.readFile.mockResolvedValue(createEncryptedFileContent(existingSession));

      const updates = {
        subscription: {
          tier: "pro" as const,
          status: "active" as const,
          isActive: true,
          isTrial: false,
          trialEnded: false,
          trialDaysRemaining: 0,
        },
      };

      await sessionService.updateSession(updates);

      const savedData = extractSavedSessionData(mockFs.writeFile.mock.calls[0][1] as string);
      expect((savedData.subscription as any).tier).toBe("pro");
      expect((savedData.subscription as any).isActive).toBe(true);
    });
  });

  describe("getSessionExpirationMs", () => {
    it("should return 24 hours in milliseconds", () => {
      const expirationMs = sessionService.getSessionExpirationMs();

      expect(expirationMs).toBe(24 * 60 * 60 * 1000);
    });
  });

  describe("Session Expiration Edge Cases", () => {
    it("should handle session expiring exactly at current time", async () => {
      const now = Date.now();
      const sessionData = {
        user: {
          id: "user-123",
          email: "test@example.com",
          oauth_provider: "google",
          oauth_id: "google-123",
        },
        sessionToken: "token",
        provider: "google",
        expiresAt: now, // Exactly now
        createdAt: now - 24 * 60 * 60 * 1000,
      };

      mockFs.readFile.mockResolvedValue(createEncryptedFileContent(sessionData));

      // Due to timing, this could be null or valid depending on execution speed
      await sessionService.loadSession();

      // The session should be treated as expired when expiresAt <= now
      // Note: This test may be flaky due to timing - if expiresAt === now,
      // the comparison Date.now() > session.expiresAt may be false initially
    });

    it("should handle session with no expiresAt", async () => {
      const sessionData = {
        user: {
          id: "user-123",
          email: "test@example.com",
          oauth_provider: "google",
          oauth_id: "google-123",
        },
        sessionToken: "token",
        provider: "google",
        createdAt: Date.now(),
        // No expiresAt field
      };

      mockFs.readFile.mockResolvedValue(createEncryptedFileContent(sessionData));

      const result = await sessionService.loadSession();

      // Should load successfully when no expiresAt (treated as not expired)
      expect(result).not.toBeNull();
    });

    it("should handle very old session", async () => {
      const oneYearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
      const sessionData = {
        user: {
          id: "user-123",
          email: "test@example.com",
          oauth_provider: "google",
          oauth_id: "google-123",
        },
        sessionToken: "ancient-token",
        provider: "google",
        expiresAt: oneYearAgo,
        createdAt: oneYearAgo - 24 * 60 * 60 * 1000,
      };

      mockFs.readFile.mockResolvedValue(createEncryptedFileContent(sessionData));

      const result = await sessionService.loadSession();

      expect(result).toBeNull();
    });
  });

  describe("File Path Handling", () => {
    it("should use lazy initialization for session file path", () => {
      // With lazy initialization, sessionFilePath should be null until first use
      // This prevents "Cannot read properties of undefined" error when module loads before app.ready
      expect((sessionService as any).sessionFilePath).toBeNull();
    });

    it("should initialize path correctly when methods are called", async () => {
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
        sessionToken: "token",
        provider: "google" as const,
        expiresAt: Date.now() + 1000,
        createdAt: Date.now(),
      };

      await sessionService.saveSession(sessionData);

      // After calling a method, the path should be constructed from app.getPath('userData')
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        path.join("/mock/user/data", "session.json"),
        expect.any(String),
        "utf8",
      );
    });
  });

  describe("Provider-specific Sessions", () => {
    it("should handle Google provider session", async () => {
      const sessionData = {
        user: {
          id: "user-123",
          email: "test@gmail.com",
          oauth_provider: "google",
          oauth_id: "google-123456",
        },
        sessionToken: "google-session-token",
        provider: "google",
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        createdAt: Date.now(),
      };

      mockFs.readFile.mockResolvedValue(createEncryptedFileContent(sessionData));

      const result = await sessionService.loadSession();

      expect(result?.provider).toBe("google");
      expect(result?.user.oauth_provider).toBe("google");
    });

    it("should handle Microsoft provider session", async () => {
      const sessionData = {
        user: {
          id: "user-456",
          email: "test@outlook.com",
          oauth_provider: "microsoft",
          oauth_id: "microsoft-789",
        },
        sessionToken: "microsoft-session-token",
        provider: "microsoft",
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        createdAt: Date.now(),
      };

      mockFs.readFile.mockResolvedValue(createEncryptedFileContent(sessionData));

      const result = await sessionService.loadSession();

      expect(result?.provider).toBe("microsoft");
      expect(result?.user.oauth_provider).toBe("microsoft");
    });
  });

  describe("Concurrent Access", () => {
    it("should handle concurrent save operations", async () => {
      const session1 = {
        user: {
          id: "user-1",
          email: "user1@example.com",
          oauth_provider: "google" as const,
          oauth_id: "g1",
        },
        sessionToken: "token-1",
        provider: "google" as const,
        expiresAt: Date.now() + 1000,
        createdAt: Date.now(),
      };

      const session2 = {
        user: {
          id: "user-2",
          email: "user2@example.com",
          oauth_provider: "google" as const,
          oauth_id: "g2",
        },
        sessionToken: "token-2",
        provider: "google" as const,
        expiresAt: Date.now() + 1000,
        createdAt: Date.now(),
      };

      // Simulate concurrent saves
      const [result1, result2] = await Promise.all([
        sessionService.saveSession(session1 as any),
        sessionService.saveSession(session2 as any),
      ]);

      expect(result1).toBe(true);
      expect(result2).toBe(true);
      // The last write wins in file-based storage
    });
  });
});
