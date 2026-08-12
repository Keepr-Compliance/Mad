/**
 * @jest-environment node
 */

/**
 * Tests for SessionService encryption functionality (TASK-2017)
 *
 * Tests cover:
 * - Encrypt/decrypt round-trip via safeStorage
 * - Plaintext migration (legacy session -> encrypted on first read)
 * - Decrypt failure -> returns null (force re-login), deletes corrupt file
 * - Encryption unavailable -> falls back to plaintext
 */

import path from "path";

// Mock safeStorage with controllable behavior
const mockSafeStorage = {
  isEncryptionAvailable: jest.fn(() => true),
  encryptString: jest.fn((str: string) => Buffer.from(`encrypted:${str}`)),
  decryptString: jest.fn((buf: Buffer) => {
    const str = buf.toString();
    if (str.startsWith("encrypted:")) return str.slice("encrypted:".length);
    throw new Error("Cannot decrypt");
  }),
};

jest.mock("electron", () => ({
  app: {
    getPath: jest.fn(() => "/mock/user/data"),
  },
  safeStorage: mockSafeStorage,
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

/**
 * Helper: get the current mock logService reference.
 * Must be called AFTER resetModules + re-import, since resetModules
 * invalidates the previous requireMock reference.
 */
function getMockLogService() {
  return jest.requireMock("../logService").default;
}

/**
 * Helper: create an encrypted file content string from session data,
 * matching the mock safeStorage format.
 */
function createEncryptedFileContent(
  sessionData: Record<string, unknown>,
): string {
  const json = JSON.stringify(sessionData);
  const encrypted = Buffer.from(`encrypted:${json}`).toString("base64");
  return JSON.stringify({ encrypted });
}

const validSessionData = {
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

describe("SessionService - Encryption (TASK-2017)", () => {
  let sessionService: typeof import("../sessionService").default;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.resetModules();

    // Reset mock implementations to defaults
    mockFs.writeFile.mockResolvedValue(undefined);
    mockFs.readFile.mockResolvedValue("{}");
    mockFs.unlink.mockResolvedValue(undefined);
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);
    mockSafeStorage.encryptString.mockImplementation(
      (str: string) => Buffer.from(`encrypted:${str}`),
    );
    mockSafeStorage.decryptString.mockImplementation((buf: Buffer) => {
      const str = buf.toString();
      if (str.startsWith("encrypted:"))
        return str.slice("encrypted:".length);
      throw new Error("Cannot decrypt");
    });

    // Re-import to get fresh instance
    const module = await import("../sessionService");
    sessionService = module.default;
  });

  describe("Encrypt/Decrypt Round-Trip", () => {
    it("should encrypt session data on save and decrypt on load", async () => {
      // Save session
      await sessionService.saveSession(validSessionData);

      // Verify writeFile was called with encrypted wrapper format
      expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
      const writtenContent = mockFs.writeFile.mock.calls[0][1] as string;
      const wrapper = JSON.parse(writtenContent);
      expect(wrapper).toHaveProperty("encrypted");
      expect(typeof wrapper.encrypted).toBe("string");

      // The encrypted field should be base64
      expect(() => Buffer.from(wrapper.encrypted, "base64")).not.toThrow();

      // Verify safeStorage.encryptString was called
      expect(mockSafeStorage.encryptString).toHaveBeenCalledTimes(1);

      // Now load the session back using the same encrypted content
      mockFs.readFile.mockResolvedValue(writtenContent);
      const loaded = await sessionService.loadSession();

      // Verify safeStorage.decryptString was called
      expect(mockSafeStorage.decryptString).toHaveBeenCalled();

      // Verify the loaded session matches the original
      expect(loaded).not.toBeNull();
      expect(loaded!.sessionToken).toBe("session-token-abc123");
      expect(loaded!.user.email).toBe("test@example.com");
      expect(loaded!.provider).toBe("google");
    });

    it("should handle supabaseTokens in encrypted session", async () => {
      const sessionWithTokens = {
        ...validSessionData,
        supabaseTokens: {
          access_token: "eyJ-access-token-secret",
          refresh_token: "refresh-token-secret-value",
        },
      };

      await sessionService.saveSession(sessionWithTokens);

      const writtenContent = mockFs.writeFile.mock.calls[0][1] as string;
      mockFs.readFile.mockResolvedValue(writtenContent);
      const loaded = await sessionService.loadSession();

      expect(loaded).not.toBeNull();
      expect(loaded!.supabaseTokens?.access_token).toBe(
        "eyJ-access-token-secret",
      );
      expect(loaded!.supabaseTokens?.refresh_token).toBe(
        "refresh-token-secret-value",
      );
    });
  });

  describe("Plaintext Migration", () => {
    it("should read plaintext session and re-encrypt on first load", async () => {
      // Simulate a pre-upgrade plaintext session.json
      const plaintextSession = {
        user: {
          id: "user-123",
          email: "test@example.com",
          oauth_provider: "google",
          oauth_id: "google-123",
        },
        sessionToken: "plaintext-token",
        provider: "google",
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        createdAt: Date.now(),
      };

      // File contains raw JSON (no encrypted wrapper)
      mockFs.readFile.mockResolvedValue(JSON.stringify(plaintextSession));

      const loaded = await sessionService.loadSession();

      // Should successfully load the plaintext session
      expect(loaded).not.toBeNull();
      expect(loaded!.sessionToken).toBe("plaintext-token");

      // Should re-save the session in encrypted format (migration)
      expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
      const writtenContent = mockFs.writeFile.mock.calls[0][1] as string;
      const wrapper = JSON.parse(writtenContent);
      expect(wrapper).toHaveProperty("encrypted");

      // Should log migration info
      expect(getMockLogService().info).toHaveBeenCalledWith(
        "Found plaintext session, will migrate to encrypted format",
        "SessionService",
      );
      expect(getMockLogService().info).toHaveBeenCalledWith(
        "Plaintext session migrated to encrypted format",
        "SessionService",
      );
    });

    it("should not migrate already-encrypted sessions", async () => {
      // Already encrypted file
      mockFs.readFile.mockResolvedValue(
        createEncryptedFileContent(validSessionData),
      );

      await sessionService.loadSession();

      // Should NOT re-write the file (no migration needed)
      expect(mockFs.writeFile).not.toHaveBeenCalled();
    });
  });

  describe("Decrypt Failure - Graceful Fallback", () => {
    it("should return null and delete session when decrypt fails", async () => {
      // Simulate a keychain conflict: encrypted data exists but decryptString throws
      mockSafeStorage.decryptString.mockImplementation(() => {
        throw new Error("The operation couldn't be completed. (OSStatus error -25293.)");
      });

      const encryptedContent = createEncryptedFileContent(validSessionData);
      mockFs.readFile.mockResolvedValue(encryptedContent);

      const loaded = await sessionService.loadSession();

      // Should return null (force re-login)
      expect(loaded).toBeNull();

      // Should delete the corrupt session file
      expect(mockFs.unlink).toHaveBeenCalledWith(
        path.join("/mock/user/data", "session.json"),
      );

      // Should log the warning
      expect(getMockLogService().warn).toHaveBeenCalledWith(
        "Failed to decrypt session (possible keychain conflict), forcing re-login",
        "SessionService",
        expect.objectContaining({ error: expect.any(String) }),
      );
    });

    it("should return null for corrupted (non-JSON) session file", async () => {
      mockFs.readFile.mockResolvedValue("this is not json at all %%%");

      const loaded = await sessionService.loadSession();

      expect(loaded).toBeNull();
      expect(mockFs.unlink).toHaveBeenCalled();
    });

    it("should return null for JSON with unrecognized format", async () => {
      // Valid JSON but not a session and not an encrypted wrapper
      mockFs.readFile.mockResolvedValue(
        JSON.stringify({ foo: "bar", baz: 123 }),
      );

      const loaded = await sessionService.loadSession();

      expect(loaded).toBeNull();
      expect(mockFs.unlink).toHaveBeenCalled();
      expect(getMockLogService().warn).toHaveBeenCalledWith(
        "Session file has unrecognized format, will be deleted",
        "SessionService",
      );
    });

    it("should return null when encrypted but safeStorage becomes unavailable", async () => {
      // Session was encrypted, but now safeStorage is not available
      // (e.g., OS keychain service down)
      mockSafeStorage.isEncryptionAvailable.mockReturnValue(false);

      const encryptedContent = createEncryptedFileContent(validSessionData);
      mockFs.readFile.mockResolvedValue(encryptedContent);

      const loaded = await sessionService.loadSession();

      expect(loaded).toBeNull();
      expect(mockFs.unlink).toHaveBeenCalled();
      expect(getMockLogService().warn).toHaveBeenCalledWith(
        "Session is encrypted but safeStorage not available, forcing re-login",
        "SessionService",
      );
    });
  });

  describe("Encryption Unavailable - Plaintext Fallback", () => {
    it("should save session as plaintext when encryption unavailable", async () => {
      mockSafeStorage.isEncryptionAvailable.mockReturnValue(false);

      await sessionService.saveSession(validSessionData);

      expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
      const writtenContent = mockFs.writeFile.mock.calls[0][1] as string;
      const parsed = JSON.parse(writtenContent);

      // Should NOT have encrypted wrapper -- should be raw session data
      expect(parsed).not.toHaveProperty("encrypted");
      expect(parsed.sessionToken).toBe("session-token-abc123");
      expect(parsed.user.email).toBe("test@example.com");

      // safeStorage.encryptString should NOT have been called
      expect(mockSafeStorage.encryptString).not.toHaveBeenCalled();

      // Should log a warning
      expect(getMockLogService().warn).toHaveBeenCalledWith(
        "safeStorage not available, saving session as plaintext",
        "SessionService",
      );
    });

    it("should load plaintext session when encryption unavailable", async () => {
      mockSafeStorage.isEncryptionAvailable.mockReturnValue(false);

      // Plaintext session (no encryption wrapper)
      mockFs.readFile.mockResolvedValue(
        JSON.stringify(validSessionData),
      );

      const loaded = await sessionService.loadSession();

      expect(loaded).not.toBeNull();
      expect(loaded!.sessionToken).toBe("session-token-abc123");

      // Should still attempt to re-save (migration), but it will save as plaintext
      // since encryption is unavailable
      expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
      const writtenContent = mockFs.writeFile.mock.calls[0][1] as string;
      const parsed = JSON.parse(writtenContent);
      expect(parsed).not.toHaveProperty("encrypted");
    });

    it("should fall back to plaintext when encryptString throws", async () => {
      mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);
      mockSafeStorage.encryptString.mockImplementation(() => {
        throw new Error("Keychain locked");
      });

      await sessionService.saveSession(validSessionData);

      expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
      const writtenContent = mockFs.writeFile.mock.calls[0][1] as string;
      const parsed = JSON.parse(writtenContent);

      // Should fall back to plaintext
      expect(parsed).not.toHaveProperty("encrypted");
      expect(parsed.sessionToken).toBe("session-token-abc123");

      expect(getMockLogService().warn).toHaveBeenCalledWith(
        "safeStorage encryption failed, saving session as plaintext",
        "SessionService",
        expect.objectContaining({ error: "Keychain locked" }),
      );
    });
  });

  describe("isEncryptionAvailable error handling", () => {
    it("should return false when isEncryptionAvailable throws", async () => {
      mockSafeStorage.isEncryptionAvailable.mockImplementation(() => {
        throw new Error("safeStorage not initialized");
      });

      await sessionService.saveSession(validSessionData);

      // Should fall back to plaintext
      const writtenContent = mockFs.writeFile.mock.calls[0][1] as string;
      const parsed = JSON.parse(writtenContent);
      expect(parsed).not.toHaveProperty("encrypted");
      expect(parsed.sessionToken).toBe("session-token-abc123");
    });
  });
});
