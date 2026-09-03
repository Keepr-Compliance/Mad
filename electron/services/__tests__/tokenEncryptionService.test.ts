/**
 * Unit tests for Token Encryption Service
 * Tests encryption/decryption and fail-safe behavior when encryption is unavailable
 */

interface MockSafeStorage {
  isEncryptionAvailable: jest.Mock;
  encryptString: jest.Mock;
  decryptString: jest.Mock;
}

// Mock Electron's safeStorage before requiring the service
const mockSafeStorage: MockSafeStorage = {
  isEncryptionAvailable: jest.fn(),
  encryptString: jest.fn(),
  decryptString: jest.fn(),
};

jest.mock("electron", () => ({
  safeStorage: mockSafeStorage,
}));

// Mock os module
jest.mock("os", () => ({
  platform: jest.fn().mockReturnValue("linux"),
}));

// Mock logService
jest.mock("../logService", () => ({
  __esModule: true,
  default: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const tokenEncryptionService = require("../tokenEncryptionService").default;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { EncryptionError } = require("../tokenEncryptionService");
// Type-only (erased at compile time, so the require()-based mocking above is
// untouched) - used to narrow `catch (error: unknown)` bindings below.
type EncryptionErrorShape = import("../tokenEncryptionService").EncryptionError;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require("os");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const logService = require("../logService").default;

describe("TokenEncryptionService", () => {
  beforeEach(() => {
    // Clear all mock calls and implementations
    jest.clearAllMocks();

    // BACKLOG-2962: this suite is the host, so it installs the secret store the
    // service will be handed — the same mocked `safeStorage` object it configures
    // below, so every existing expectation still points at the right mock.
    require("../../../tests/helpers/installTestSecretStore").installTestSecretStore();

    // Reset the service's internal state between tests
    tokenEncryptionService._resetState();

    // Setup default mock implementations
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);

    mockSafeStorage.encryptString.mockImplementation((text: string) => {
      return Buffer.from(`encrypted:${text}`);
    });

    mockSafeStorage.decryptString.mockImplementation((buffer: Buffer) => {
      const str = buffer.toString();
      return str.replace("encrypted:", "");
    });
  });

  describe("isEncryptionAvailable", () => {
    it("should return true when encryption is available", () => {
      mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);
      expect(tokenEncryptionService.isEncryptionAvailable()).toBe(true);
    });

    it("should return false when encryption is not available", () => {
      mockSafeStorage.isEncryptionAvailable.mockReturnValue(false);
      expect(tokenEncryptionService.isEncryptionAvailable()).toBe(false);
    });

    it("should return false when safeStorage throws an error", () => {
      mockSafeStorage.isEncryptionAvailable.mockImplementation(() => {
        throw new Error("safeStorage error");
      });
      expect(tokenEncryptionService.isEncryptionAvailable()).toBe(false);
    });
  });

  describe("encrypt", () => {
    it("should encrypt plaintext when encryption is available", () => {
      const plaintext = "my-secret-token";
      const result = tokenEncryptionService.encrypt(plaintext);

      expect(mockSafeStorage.encryptString).toHaveBeenCalledWith(plaintext);
      expect(result).toBe(
        Buffer.from("encrypted:my-secret-token").toString("base64"),
      );
    });

    it("should throw error when encryption is not available", () => {
      mockSafeStorage.isEncryptionAvailable.mockReturnValue(false);

      expect(() => {
        tokenEncryptionService.encrypt("my-secret-token");
      }).toThrow("Cannot encrypt token");
    });

    it("should throw error when encryptString fails", () => {
      mockSafeStorage.encryptString.mockImplementation(() => {
        throw new Error("Encryption failed");
      });

      expect(() => {
        tokenEncryptionService.encrypt("my-secret-token");
      }).toThrow("Failed to encrypt token");
    });

    it("should return base64-encoded encrypted data", () => {
      const plaintext = "test-token-123";
      mockSafeStorage.encryptString.mockReturnValue(
        Buffer.from("encrypted-bytes"),
      );

      const result = tokenEncryptionService.encrypt(plaintext);

      expect(result).toBe(Buffer.from("encrypted-bytes").toString("base64"));
    });
  });

  describe("decrypt", () => {
    it("should decrypt base64-encoded encrypted data when encryption is available", () => {
      const encrypted = Buffer.from("encrypted:my-secret-token").toString(
        "base64",
      );
      const result = tokenEncryptionService.decrypt(encrypted);

      expect(mockSafeStorage.decryptString).toHaveBeenCalled();
      expect(result).toBe("my-secret-token");
    });

    it("should throw error when encryption is not available", () => {
      mockSafeStorage.isEncryptionAvailable.mockReturnValue(false);
      const encrypted = Buffer.from("some-data").toString("base64");

      expect(() => {
        tokenEncryptionService.decrypt(encrypted);
      }).toThrow("Cannot decrypt token");
    });

    it("should throw error when decryptString fails", () => {
      mockSafeStorage.decryptString.mockImplementation(() => {
        throw new Error("Decryption failed");
      });

      const encrypted = Buffer.from("some-data").toString("base64");

      expect(() => {
        tokenEncryptionService.decrypt(encrypted);
      }).toThrow("Failed to decrypt token");
    });

    it("should decode base64 before decrypting", () => {
      const plaintext = "test-token";
      const encryptedBuffer = Buffer.from(`encrypted:${plaintext}`);
      const base64 = encryptedBuffer.toString("base64");

      tokenEncryptionService.decrypt(base64);

      // Verify that safeStorage.decryptString received the decoded buffer
      expect(mockSafeStorage.decryptString).toHaveBeenCalledWith(
        Buffer.from(base64, "base64"),
      );
    });
  });

  describe("encryptObject", () => {
    it("should encrypt an object by converting to JSON", () => {
      const obj = { token: "abc123", expires: 3600 };
      const result = tokenEncryptionService.encryptObject(obj);

      const jsonString = JSON.stringify(obj);
      expect(mockSafeStorage.encryptString).toHaveBeenCalledWith(jsonString);
      expect(result).toBe(
        Buffer.from(`encrypted:${jsonString}`).toString("base64"),
      );
    });

    it("should throw error when encryption is not available", () => {
      mockSafeStorage.isEncryptionAvailable.mockReturnValue(false);

      expect(() => {
        tokenEncryptionService.encryptObject({ token: "test" });
      }).toThrow("Cannot encrypt token");
    });
  });

  describe("decryptObject", () => {
    it("should decrypt and parse JSON object", () => {
      const obj = { token: "abc123", expires: 3600 };
      const jsonString = JSON.stringify(obj);
      const encrypted = Buffer.from(`encrypted:${jsonString}`).toString(
        "base64",
      );

      const result = tokenEncryptionService.decryptObject(encrypted);

      expect(result).toEqual(obj);
    });

    it("should throw error when encryption is not available", () => {
      mockSafeStorage.isEncryptionAvailable.mockReturnValue(false);
      const encrypted = Buffer.from("some-data").toString("base64");

      expect(() => {
        tokenEncryptionService.decryptObject(encrypted);
      }).toThrow("Cannot decrypt token");
    });
  });

  describe("fail-safe behavior", () => {
    it("should never store tokens in plaintext when encryption is unavailable", () => {
      mockSafeStorage.isEncryptionAvailable.mockReturnValue(false);

      // Attempting to encrypt should throw, not fall back to plaintext
      expect(() => {
        tokenEncryptionService.encrypt("sensitive-token");
      }).toThrow("Cannot encrypt token");

      // Verify safeStorage.encryptString was never called (no plaintext storage)
      expect(mockSafeStorage.encryptString).not.toHaveBeenCalled();
    });

    it("should never retrieve tokens as plaintext when encryption is unavailable", () => {
      mockSafeStorage.isEncryptionAvailable.mockReturnValue(false);

      // Attempting to decrypt should throw, not fall back to plaintext
      expect(() => {
        tokenEncryptionService.decrypt("some-data");
      }).toThrow("Cannot decrypt token");

      // Verify safeStorage.decryptString was never called (no plaintext retrieval)
      expect(mockSafeStorage.decryptString).not.toHaveBeenCalled();
    });
  });

  describe("EncryptionError", () => {
    it("should include platform information", () => {
      mockSafeStorage.isEncryptionAvailable.mockReturnValue(false);
      os.platform.mockReturnValue("linux");

      try {
        tokenEncryptionService.encrypt("test");
      } catch (error) {
        expect(error).toBeInstanceOf(EncryptionError);
        expect((error as EncryptionErrorShape).platform).toBe("linux");
        expect((error as EncryptionErrorShape).guidance).toContain("gnome-keyring");
      }
    });

    it("should provide Linux-specific guidance", () => {
      mockSafeStorage.isEncryptionAvailable.mockReturnValue(false);
      os.platform.mockReturnValue("linux");

      try {
        tokenEncryptionService.encrypt("test");
      } catch (error) {
        expect((error as EncryptionErrorShape).message).toContain("Linux secret service");
        expect((error as EncryptionErrorShape).guidance).toContain("gnome-keyring");
        expect((error as EncryptionErrorShape).guidance).toContain("KWallet");
      }
    });

    it("should provide macOS-specific guidance", () => {
      mockSafeStorage.isEncryptionAvailable.mockReturnValue(false);
      os.platform.mockReturnValue("darwin");

      try {
        tokenEncryptionService.encrypt("test");
      } catch (error) {
        expect((error as EncryptionErrorShape).message).toContain("macOS Keychain");
        expect((error as EncryptionErrorShape).guidance).toContain("Keychain Access");
      }
    });

    it("should provide Windows-specific guidance", () => {
      mockSafeStorage.isEncryptionAvailable.mockReturnValue(false);
      os.platform.mockReturnValue("win32");

      try {
        tokenEncryptionService.encrypt("test");
      } catch (error) {
        expect((error as EncryptionErrorShape).message).toContain("Windows DPAPI");
        expect((error as EncryptionErrorShape).guidance).toContain("administrator");
      }
    });
  });

  describe("getEncryptionStatus", () => {
    it("should return detailed status when encryption is available", () => {
      mockSafeStorage.isEncryptionAvailable.mockReturnValue(true);
      os.platform.mockReturnValue("darwin");

      const status = tokenEncryptionService.getEncryptionStatus();

      expect(status.available).toBe(true);
      expect(status.platform).toBe("darwin");
      expect(status.guidance).toBe("");
      expect(status.checked).toBe(true);
    });

    it("should return guidance when encryption is unavailable", () => {
      mockSafeStorage.isEncryptionAvailable.mockReturnValue(false);
      os.platform.mockReturnValue("linux");

      const status = tokenEncryptionService.getEncryptionStatus();

      expect(status.available).toBe(false);
      expect(status.platform).toBe("linux");
      expect(status.guidance).toContain("gnome-keyring");
      expect(status.checked).toBe(true);
    });
  });

  describe("error logging", () => {
    it("should log error when encryption is not available", () => {
      mockSafeStorage.isEncryptionAvailable.mockReturnValue(false);
      os.platform.mockReturnValue("linux");

      try {
        tokenEncryptionService.encrypt("test");
      } catch {
        // Expected to throw
      }

      expect(logService.error).toHaveBeenCalledWith(
        "Encryption not available",
        "TokenEncryption",
        expect.objectContaining({
          message: expect.stringContaining("Cannot encrypt token"),
          platform: "linux",
        }),
      );
    });

    it("should log error when decryption is not available", () => {
      mockSafeStorage.isEncryptionAvailable.mockReturnValue(false);
      os.platform.mockReturnValue("darwin");

      try {
        tokenEncryptionService.decrypt("test");
      } catch {
        // Expected to throw
      }

      expect(logService.error).toHaveBeenCalledWith(
        "Decryption not available",
        "TokenEncryption",
        expect.objectContaining({
          message: expect.stringContaining("Cannot decrypt token"),
        }),
      );
    });

    it("should log error when encryption operation fails", () => {
      mockSafeStorage.encryptString.mockImplementation(() => {
        throw new Error("Internal encryption error");
      });

      try {
        tokenEncryptionService.encrypt("test");
      } catch {
        // Expected to throw
      }

      expect(logService.error).toHaveBeenCalledWith(
        "Encryption operation failed",
        "TokenEncryption",
        expect.objectContaining({
          error: "Internal encryption error",
        }),
      );
    });

    it("should log error when decryption operation fails", () => {
      mockSafeStorage.decryptString.mockImplementation(() => {
        throw new Error("Internal decryption error");
      });

      const encrypted = Buffer.from("test").toString("base64");

      try {
        tokenEncryptionService.decrypt(encrypted);
      } catch {
        // Expected to throw
      }

      expect(logService.error).toHaveBeenCalledWith(
        "Decryption operation failed",
        "TokenEncryption",
        expect.objectContaining({
          error: "Internal decryption error",
        }),
      );
    });

    it("should log error when checking encryption availability fails", () => {
      mockSafeStorage.isEncryptionAvailable.mockImplementation(() => {
        throw new Error("safeStorage check failed");
      });

      tokenEncryptionService.isEncryptionAvailable();

      expect(logService.error).toHaveBeenCalledWith(
        "Error checking encryption availability",
        "TokenEncryption",
        expect.objectContaining({
          error: "safeStorage check failed",
        }),
      );
    });
  });
});
