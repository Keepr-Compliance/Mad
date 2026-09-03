/**
 * @jest-environment node
 */

/**
 * Unit tests for DatabaseEncryptionService
 * Tests encryption key generation, storage, and retrieval
 */


// Create mock functions first
const mockIsEncryptionAvailable = jest.fn();
const mockEncryptString = jest.fn();
const mockDecryptString = jest.fn();
const mockGetPath = jest.fn(() => "/mock/user/data");

const mockExistsSync = jest.fn();
const mockReadFileSync = jest.fn();
const mockWriteFileSync = jest.fn();
const mockMkdirSync = jest.fn();
const mockOpenSync = jest.fn();
const mockReadSync = jest.fn();
const mockCloseSync = jest.fn();

const mockLogInfo = jest.fn().mockResolvedValue(undefined);
const mockLogDebug = jest.fn().mockResolvedValue(undefined);
const mockLogWarn = jest.fn().mockResolvedValue(undefined);
const mockLogError = jest.fn().mockResolvedValue(undefined);

// Mock Electron modules before importing the service
jest.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: mockIsEncryptionAvailable,
    encryptString: mockEncryptString,
    decryptString: mockDecryptString,
  },
  app: {
    getPath: mockGetPath,
  },
}));

// Mock fs module
jest.mock("fs", () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  mkdirSync: mockMkdirSync,
  openSync: mockOpenSync,
  readSync: mockReadSync,
  closeSync: mockCloseSync,
}));

// Mock logService with proper default export structure
jest.mock("../logService", () => ({
  __esModule: true,
  default: {
    info: mockLogInfo,
    debug: mockLogDebug,
    warn: mockLogWarn,
    error: mockLogError,
  },
}));

// Import the service after mocks are set up
import { databaseEncryptionService } from "../databaseEncryptionService";

describe("DatabaseEncryptionService", () => {
  beforeEach(() => {
    // Clear all mock calls
    jest.clearAllMocks();

    // BACKLOG-2962: this suite is the host, so it installs the secret store the
    // service will be handed — the same mocked `safeStorage` object it configures
    // below, so every existing expectation still points at the right mock.
    require("../../../tests/helpers/installTestSecretStore").installTestSecretStore();

    // Reset the service state by clearing cache
    databaseEncryptionService.clearCache();

    // Reset default mock behaviors
    mockGetPath.mockReturnValue("/mock/user/data");
    mockIsEncryptionAvailable.mockReturnValue(true);
  });

  describe("isEncryptionAvailable", () => {
    it("should return true when encryption is available", () => {
      mockIsEncryptionAvailable.mockReturnValue(true);

      const result = databaseEncryptionService.isEncryptionAvailable();

      expect(result).toBe(true);
      expect(mockIsEncryptionAvailable).toHaveBeenCalled();
    });

    it("should return false when encryption is not available", () => {
      mockIsEncryptionAvailable.mockReturnValue(false);

      const result = databaseEncryptionService.isEncryptionAvailable();

      expect(result).toBe(false);
    });

    it("should return false when checking availability throws error", () => {
      mockIsEncryptionAvailable.mockImplementation(() => {
        throw new Error("Not available");
      });

      const result = databaseEncryptionService.isEncryptionAvailable();

      expect(result).toBe(false);
    });
  });

  describe("initialize", () => {
    it("should set keyStorePath correctly", async () => {
      mockGetPath.mockReturnValue("/mock/user/data");

      await databaseEncryptionService.initialize();

      expect(mockGetPath).toHaveBeenCalledWith("userData");
    });
  });

  describe("getEncryptionKey", () => {
    beforeEach(async () => {
      mockIsEncryptionAvailable.mockReturnValue(true);
      mockGetPath.mockReturnValue("/mock/user/data");
      await databaseEncryptionService.initialize();
      databaseEncryptionService.clearCache();
    });

    it("should generate and store a new key when no key exists", async () => {
      // No existing key store file
      mockExistsSync.mockReturnValue(false);

      // Mock encryption
      const mockEncryptedBuffer = Buffer.from("encrypted-key-data");
      mockEncryptString.mockReturnValue(mockEncryptedBuffer);

      const key = await databaseEncryptionService.getEncryptionKey();

      // Key should be a 64-character hex string (32 bytes)
      expect(key).toMatch(/^[0-9a-f]{64}$/);

      // Should have saved the key
      expect(mockWriteFileSync).toHaveBeenCalled();
      expect(mockEncryptString).toHaveBeenCalled();
    });

    it("should retrieve existing key from store", async () => {
      const storedKey = "stored-encryption-key-hex";
      const keyStore = {
        encryptedKey: Buffer.from("encrypted").toString("base64"),
        metadata: {
          keyId: "test-key-id",
          createdAt: new Date().toISOString(),
          version: 1,
        },
      };

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(keyStore));
      mockDecryptString.mockReturnValue(storedKey);

      const key = await databaseEncryptionService.getEncryptionKey();

      expect(key).toBe(storedKey);
      expect(mockDecryptString).toHaveBeenCalled();
    });

    it("should cache the key after first retrieval", async () => {
      const storedKey = "cached-key-value";
      const keyStore = {
        encryptedKey: Buffer.from("encrypted").toString("base64"),
        metadata: {
          keyId: "id",
          createdAt: new Date().toISOString(),
          version: 1,
        },
      };

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(keyStore));
      mockDecryptString.mockReturnValue(storedKey);

      // First call
      const key1 = await databaseEncryptionService.getEncryptionKey();
      // Second call should use cache
      const key2 = await databaseEncryptionService.getEncryptionKey();

      expect(key1).toBe(key2);
      // decryptString should only be called once due to caching
      expect(mockDecryptString).toHaveBeenCalledTimes(1);
    });

    it("should throw error when encryption is not available", async () => {
      mockIsEncryptionAvailable.mockReturnValue(false);
      databaseEncryptionService.clearCache();

      await expect(
        databaseEncryptionService.getEncryptionKey(),
      ).rejects.toThrow("Encryption not available");
    });
  });

  describe("isDatabaseEncrypted", () => {
    beforeEach(async () => {
      mockGetPath.mockReturnValue("/mock/user/data");
      await databaseEncryptionService.initialize();
    });

    it("should return false for non-existent database", async () => {
      const enoent = new Error("ENOENT: no such file or directory") as Error & { code: string };
      enoent.code = "ENOENT";
      mockOpenSync.mockImplementation(() => { throw enoent; });

      const result =
        await databaseEncryptionService.isDatabaseEncrypted("/path/to/db");

      expect(result).toBe(false);
    });

    it("should return false for unencrypted SQLite database", async () => {
      const sqliteHeader = "SQLite format 3\0";

      mockExistsSync.mockReturnValue(true);
      mockOpenSync.mockReturnValue(1);
      mockReadSync.mockImplementation((_fd: number, buffer: Buffer) => {
        buffer.write(sqliteHeader);
        return 16;
      });
      mockCloseSync.mockReturnValue(undefined);

      const result =
        await databaseEncryptionService.isDatabaseEncrypted("/path/to/db");

      expect(result).toBe(false);
    });

    it("should return true for encrypted database (no SQLite header)", async () => {
      const encryptedHeader = Buffer.alloc(16).fill(0xff); // Random encrypted bytes

      mockExistsSync.mockReturnValue(true);
      mockOpenSync.mockReturnValue(1);
      mockReadSync.mockImplementation((_fd: number, buffer: Buffer) => {
        encryptedHeader.copy(buffer);
        return 16;
      });
      mockCloseSync.mockReturnValue(undefined);

      const result =
        await databaseEncryptionService.isDatabaseEncrypted("/path/to/db");

      expect(result).toBe(true);
    });
  });

  describe("rotateKey", () => {
    beforeEach(async () => {
      mockIsEncryptionAvailable.mockReturnValue(true);
      mockGetPath.mockReturnValue("/mock/user/data");
      await databaseEncryptionService.initialize();
    });

    it("should generate new key and return both old and new keys", async () => {
      const oldKey = "old-key-value";
      const keyStore = {
        encryptedKey: Buffer.from("encrypted").toString("base64"),
        metadata: {
          keyId: "id",
          createdAt: new Date().toISOString(),
          version: 1,
        },
      };

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(keyStore));
      mockDecryptString.mockReturnValue(oldKey);
      mockEncryptString.mockReturnValue(Buffer.from("new-encrypted"));

      databaseEncryptionService.clearCache();

      const result = await databaseEncryptionService.rotateKey();

      expect(result.oldKey).toBe(oldKey);
      expect(result.newKey).toMatch(/^[0-9a-f]{64}$/);
      expect(result.oldKey).not.toBe(result.newKey);
      expect(mockWriteFileSync).toHaveBeenCalled();
    });
  });

  describe("getKeyMetadata", () => {
    beforeEach(async () => {
      mockGetPath.mockReturnValue("/mock/user/data");
      await databaseEncryptionService.initialize();
    });

    it("should return null when no key store exists", async () => {
      mockExistsSync.mockReturnValue(false);

      const result = await databaseEncryptionService.getKeyMetadata();

      expect(result).toBeNull();
    });

    it("should return metadata when key store exists", async () => {
      const metadata = {
        keyId: "test-key-id",
        createdAt: "2024-01-01T00:00:00.000Z",
        version: 1,
      };
      const keyStore = {
        encryptedKey: "encrypted-data",
        metadata,
      };

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(keyStore));

      const result = await databaseEncryptionService.getKeyMetadata();

      expect(result).toEqual(metadata);
    });
  });

  describe("clearCache", () => {
    it("should clear the cached key", async () => {
      mockIsEncryptionAvailable.mockReturnValue(true);
      mockGetPath.mockReturnValue("/mock/user/data");
      await databaseEncryptionService.initialize();

      const keyStore = {
        encryptedKey: Buffer.from("encrypted").toString("base64"),
        metadata: {
          keyId: "id",
          createdAt: new Date().toISOString(),
          version: 1,
        },
      };

      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(keyStore));
      mockDecryptString.mockReturnValue("cached-key");

      // First call to populate cache
      await databaseEncryptionService.getEncryptionKey();
      expect(mockDecryptString).toHaveBeenCalledTimes(1);

      // Clear cache
      databaseEncryptionService.clearCache();

      // Should need to decrypt again
      await databaseEncryptionService.getEncryptionKey();
      expect(mockDecryptString).toHaveBeenCalledTimes(2);
    });
  });
});
