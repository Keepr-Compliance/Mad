/**
 * Additional unit tests for Session Service
 * Tests for edge cases and branch coverage
 */

import sessionService from "../sessionService";
import { promises as fs } from "fs";

// Mock fs module
jest.mock("fs", () => ({
  promises: {
    writeFile: jest.fn(),
    readFile: jest.fn(),
    unlink: jest.fn(),
  },
}));

// Mock logService
jest.mock("../logService", () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

const mockFs = fs as jest.Mocked<typeof fs>;

/**
 * Helper: extract session data from encrypted writeFile output.
 * The global electron mock's encryptString produces Buffer.from(`encrypted:${str}`).
 */
function extractSavedSessionData(writeCallArg: string): Record<string, unknown> {
  const wrapper = JSON.parse(writeCallArg);
  if (wrapper.encrypted) {
    const decoded = Buffer.from(wrapper.encrypted, "base64").toString();
    const json = decoded.startsWith("encrypted:") ? decoded.slice("encrypted:".length) : decoded;
    return JSON.parse(json);
  }
  return wrapper;
}

/**
 * Helper: create encrypted file content for readFile mock.
 */
// Param widened to `object`: callers pass typed SessionData values, which have
// no index signature and so are not assignable to Record<string, unknown>.
function createEncryptedFileContent(sessionData: object): string {
  const json = JSON.stringify(sessionData);
  const encrypted = Buffer.from(`encrypted:${json}`).toString("base64");
  return JSON.stringify({ encrypted });
}

/** The SessionData argument accepted by sessionService.saveSession (not exported). */
type SessionDataArg = Parameters<typeof sessionService.saveSession>[0];

describe("SessionService - Additional Tests", () => {
  // Cast (below): `user` here is the minimal {id, email, name} identity the
  // service persists and re-reads, not a full User row (which additionally
  // requires oauth_provider / subscription / timestamps). Kept as-is because the
  // round-trip assertions compare exactly these fields.
  const mockSession = {
    user: {
      id: "user-123",
      email: "test@example.com",
      name: "Test User",
    },
    sessionToken: "token-abc",
    provider: "google" as const,
    expiresAt: Date.now() + 86400000, // 24 hours from now
    createdAt: Date.now(),
  } as unknown as SessionDataArg;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("saveSession", () => {
    it("should save session successfully", async () => {
      mockFs.writeFile.mockResolvedValue(undefined);

      const result = await sessionService.saveSession(mockSession);

      expect(result).toBe(true);
      expect(mockFs.writeFile).toHaveBeenCalled();
    });

    it("should return false on write error", async () => {
      mockFs.writeFile.mockRejectedValue(new Error("Disk full"));

      const result = await sessionService.saveSession(mockSession);

      expect(result).toBe(false);
    });

    it("should set createdAt if not provided", async () => {
      mockFs.writeFile.mockResolvedValue(undefined);

      const sessionWithoutCreatedAt = {
        ...mockSession,
        createdAt: undefined as any,
      };
      await sessionService.saveSession(sessionWithoutCreatedAt);

      const writeCall = mockFs.writeFile.mock.calls[0];
      const savedData = extractSavedSessionData(writeCall[1] as string);
      expect(savedData.createdAt).toBeDefined();
      expect(typeof savedData.createdAt).toBe("number");
    });
  });

  describe("loadSession", () => {
    it("should load valid session", async () => {
      mockFs.readFile.mockResolvedValue(createEncryptedFileContent(mockSession));

      const result = await sessionService.loadSession();

      expect(result).toEqual(mockSession);
    });

    it("should return null for expired session", async () => {
      const expiredSession = {
        ...mockSession,
        expiresAt: Date.now() - 1000, // Expired 1 second ago
      };
      mockFs.readFile.mockResolvedValue(createEncryptedFileContent(expiredSession));
      mockFs.unlink.mockResolvedValue(undefined);

      const result = await sessionService.loadSession();

      expect(result).toBeNull();
      expect(mockFs.unlink).toHaveBeenCalled(); // Should clear expired session
    });

    it("should return null when no session file exists", async () => {
      const error: NodeJS.ErrnoException = new Error("File not found");
      error.code = "ENOENT";
      mockFs.readFile.mockRejectedValue(error);

      const result = await sessionService.loadSession();

      expect(result).toBeNull();
    });

    it("should return null on other read errors", async () => {
      mockFs.readFile.mockRejectedValue(new Error("Permission denied"));

      const result = await sessionService.loadSession();

      expect(result).toBeNull();
    });

    it("should handle session without expiresAt", async () => {
      const sessionNoExpiry = { ...mockSession, expiresAt: undefined };
      mockFs.readFile.mockResolvedValue(createEncryptedFileContent(sessionNoExpiry));

      const result = await sessionService.loadSession();

      expect(result).toBeDefined();
    });
  });

  describe("clearSession", () => {
    it("should clear session successfully", async () => {
      mockFs.unlink.mockResolvedValue(undefined);

      const result = await sessionService.clearSession();

      expect(result).toBe(true);
    });

    it("should return true when file does not exist", async () => {
      const error: NodeJS.ErrnoException = new Error("File not found");
      error.code = "ENOENT";
      mockFs.unlink.mockRejectedValue(error);

      const result = await sessionService.clearSession();

      expect(result).toBe(true);
    });

    it("should return false on other delete errors", async () => {
      mockFs.unlink.mockRejectedValue(new Error("Permission denied"));

      const result = await sessionService.clearSession();

      expect(result).toBe(false);
    });
  });

  describe("hasValidSession", () => {
    it("should return true when valid session exists", async () => {
      mockFs.readFile.mockResolvedValue(createEncryptedFileContent(mockSession));

      const result = await sessionService.hasValidSession();

      expect(result).toBe(true);
    });

    it("should return false when no session exists", async () => {
      const error: NodeJS.ErrnoException = new Error("File not found");
      error.code = "ENOENT";
      mockFs.readFile.mockRejectedValue(error);

      const result = await sessionService.hasValidSession();

      expect(result).toBe(false);
    });
  });

  describe("updateSession", () => {
    it("should update existing session", async () => {
      mockFs.readFile.mockResolvedValue(createEncryptedFileContent(mockSession));
      mockFs.writeFile.mockResolvedValue(undefined);

      const result = await sessionService.updateSession({
        sessionToken: "new-token",
      });

      expect(result).toBe(true);
      const writeCall = mockFs.writeFile.mock.calls[0];
      const savedData = extractSavedSessionData(writeCall[1] as string);
      expect(savedData.sessionToken).toBe("new-token");
    });

    it("should return false when no session to update", async () => {
      const error: NodeJS.ErrnoException = new Error("File not found");
      error.code = "ENOENT";
      mockFs.readFile.mockRejectedValue(error);

      const result = await sessionService.updateSession({
        sessionToken: "new-token",
      });

      expect(result).toBe(false);
    });

    it("should call saveSession when updating", async () => {
      mockFs.readFile.mockResolvedValue(createEncryptedFileContent(mockSession));
      mockFs.writeFile.mockResolvedValue(undefined);

      const result = await sessionService.updateSession({
        sessionToken: "new-token",
      });

      expect(result).toBe(true);
      expect(mockFs.writeFile).toHaveBeenCalled();
    });
  });

  describe("getSessionExpirationMs", () => {
    it("should return 24 hours in milliseconds", () => {
      const result = sessionService.getSessionExpirationMs();

      expect(result).toBe(24 * 60 * 60 * 1000);
      expect(result).toBe(86400000);
    });
  });
});
