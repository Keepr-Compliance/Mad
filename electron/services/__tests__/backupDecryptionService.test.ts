/**
 * @jest-environment node
 */

/**
 * Unit tests for BackupDecryptionService
 * Tests encryption detection, password verification, and decryption operations
 */

import crypto from "crypto";
import path from "path";

// Mock fs module
const mockExistsSync = jest.fn();
const mockReadFileSync = jest.fn();
const mockWriteFileSync = jest.fn();
const mockMkdirSync = jest.fn();
const mockReaddirSync = jest.fn();
const mockStatSync = jest.fn();
const mockUnlinkSync = jest.fn();
const mockRmdirSync = jest.fn();
const mockOpenSync = jest.fn();
const mockFstatSync = jest.fn();
const mockWriteSync = jest.fn();
const mockCloseSync = jest.fn();

jest.mock("fs", () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  mkdirSync: mockMkdirSync,
  readdirSync: mockReaddirSync,
  statSync: mockStatSync,
  unlinkSync: mockUnlinkSync,
  rmdirSync: mockRmdirSync,
  openSync: mockOpenSync,
  fstatSync: mockFstatSync,
  writeSync: mockWriteSync,
  closeSync: mockCloseSync,
}));

// Mock simple-plist
const mockPlistParse = jest.fn();
jest.mock("simple-plist", () => ({
  parse: mockPlistParse,
}));

// Mock better-sqlite3
const mockDbPrepare = jest.fn();
const mockDbClose = jest.fn();
const mockDbGet = jest.fn();

jest.mock("better-sqlite3-multiple-ciphers", () => {
  return jest.fn().mockImplementation(() => ({
    prepare: mockDbPrepare,
    close: mockDbClose,
  }));
});

// Mock logService
const mockLogInfo = jest.fn().mockResolvedValue(undefined);
const mockLogDebug = jest.fn().mockResolvedValue(undefined);
const mockLogWarn = jest.fn().mockResolvedValue(undefined);
const mockLogError = jest.fn().mockResolvedValue(undefined);

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
import {
  BackupDecryptionService,
  backupDecryptionService,
} from "../backupDecryptionService";

describe("BackupDecryptionService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDbPrepare.mockReturnValue({ get: mockDbGet });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("isBackupEncrypted", () => {
    it("should return false when Manifest.plist does not exist", async () => {
      mockExistsSync.mockReturnValue(false);

      const result =
        await backupDecryptionService.isBackupEncrypted("/path/to/backup");

      expect(result).toBe(false);
      expect(mockExistsSync).toHaveBeenCalledWith(
        path.join("/path/to/backup", "Manifest.plist"),
      );
    });

    it("should return true when backup is encrypted", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(Buffer.from("plist-data"));
      mockPlistParse.mockReturnValue({
        IsEncrypted: true,
        BackupKeyBag: Buffer.alloc(100),
      });

      const result =
        await backupDecryptionService.isBackupEncrypted("/path/to/backup");

      expect(result).toBe(true);
    });

    it("should return false when backup is not encrypted", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(Buffer.from("plist-data"));
      mockPlistParse.mockReturnValue({
        IsEncrypted: false,
      });

      const result =
        await backupDecryptionService.isBackupEncrypted("/path/to/backup");

      expect(result).toBe(false);
    });

    it("should return false on error", async () => {
      mockExistsSync.mockImplementation(() => {
        throw new Error("File access error");
      });

      const result =
        await backupDecryptionService.isBackupEncrypted("/path/to/backup");

      expect(result).toBe(false);
    });
  });

  describe("verifyPassword", () => {
    it("should return false when backup is not encrypted", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(Buffer.from("plist-data"));
      mockPlistParse.mockReturnValue({
        IsEncrypted: false,
      });

      const result = await backupDecryptionService.verifyPassword(
        "/path/to/backup",
        "password",
      );

      expect(result).toBe(false);
    });

    it("should return false when keybag is missing", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(Buffer.from("plist-data"));
      mockPlistParse.mockReturnValue({
        IsEncrypted: true,
        // No BackupKeyBag
      });

      const result = await backupDecryptionService.verifyPassword(
        "/path/to/backup",
        "password",
      );

      expect(result).toBe(false);
    });

    it("should return false on error", async () => {
      mockExistsSync.mockImplementation(() => {
        throw new Error("File access error");
      });

      const result = await backupDecryptionService.verifyPassword(
        "/path/to/backup",
        "password",
      );

      expect(result).toBe(false);
    });
  });

  describe("decryptBackup", () => {
    it("should fail when Manifest.plist does not exist", async () => {
      mockExistsSync.mockReturnValue(false);

      const result = await backupDecryptionService.decryptBackup(
        "/path/to/backup",
        "password",
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Manifest.plist not found");
      expect(result.decryptedPath).toBeNull();
    });

    it("should fail when backup is not encrypted", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(Buffer.from("plist-data"));
      mockPlistParse.mockReturnValue({
        IsEncrypted: false,
      });

      const result = await backupDecryptionService.decryptBackup(
        "/path/to/backup",
        "password",
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("Backup is not encrypted");
      expect(result.decryptedPath).toBeNull();
    });

    it("should log info when starting decryption", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(Buffer.from("plist-data"));
      mockPlistParse.mockReturnValue({
        IsEncrypted: true,
        BackupKeyBag: createMockKeybag(),
        ManifestKey: createMockManifestKey(),
      });

      await backupDecryptionService.decryptBackup(
        "/path/to/backup",
        "password",
      );

      expect(mockLogInfo).toHaveBeenCalledWith(
        "Starting backup decryption",
        "BackupDecryptionService",
        expect.objectContaining({ backupPath: "/path/to/backup" }),
      );
    });
  });

  describe("cleanup", () => {
    it("should do nothing when path does not exist", async () => {
      mockExistsSync.mockReturnValue(false);

      await backupDecryptionService.cleanup("/path/to/decrypted");

      expect(mockReaddirSync).not.toHaveBeenCalled();
    });

    it("should securely delete files and remove directory", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockReturnValue(["sms.db", "AddressBook.sqlitedb"]);
      mockOpenSync.mockReturnValue(42);
      mockFstatSync.mockReturnValue({ isFile: () => true, size: 1024 });

      await backupDecryptionService.cleanup("/path/to/decrypted");

      // Should open each file, overwrite with zeros via fd, and close
      expect(mockOpenSync).toHaveBeenCalledTimes(2);
      expect(mockWriteSync).toHaveBeenCalledTimes(2);
      expect(mockCloseSync).toHaveBeenCalledTimes(2);
      // Should delete each file
      expect(mockUnlinkSync).toHaveBeenCalledTimes(2);
      // Should remove directory
      expect(mockRmdirSync).toHaveBeenCalled();
    });

    it("should log warning on cleanup failure", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReaddirSync.mockImplementation(() => {
        throw new Error("Permission denied");
      });

      await backupDecryptionService.cleanup("/path/to/decrypted");

      expect(mockLogWarn).toHaveBeenCalledWith(
        "Failed to clean up decrypted files",
        "BackupDecryptionService",
        expect.objectContaining({ error: "Permission denied" }),
      );
    });
  });

  describe("BackupDecryptionService class", () => {
    it("should be instantiable", () => {
      const service = new BackupDecryptionService();
      expect(service).toBeDefined();
    });

    it("should export singleton instance", () => {
      expect(backupDecryptionService).toBeDefined();
      expect(backupDecryptionService).toBeInstanceOf(BackupDecryptionService);
    });
  });
});

/**
 * Helper to create a mock keybag buffer
 * Creates a minimal valid keybag structure
 */
function createMockKeybag(): Buffer {
  const parts: Buffer[] = [];

  // Add UUID tag
  parts.push(Buffer.from("UUID"));
  const uuidLen = Buffer.alloc(4);
  uuidLen.writeUInt32BE(16, 0);
  parts.push(uuidLen);
  parts.push(crypto.randomBytes(16));

  // Add TYPE tag (Backup = 1)
  parts.push(Buffer.from("TYPE"));
  const typeLen = Buffer.alloc(4);
  typeLen.writeUInt32BE(4, 0);
  parts.push(typeLen);
  const typeVal = Buffer.alloc(4);
  typeVal.writeUInt32BE(1, 0);
  parts.push(typeVal);

  // Add SALT tag
  parts.push(Buffer.from("SALT"));
  const saltLen = Buffer.alloc(4);
  saltLen.writeUInt32BE(20, 0);
  parts.push(saltLen);
  parts.push(crypto.randomBytes(20));

  // Add ITER tag
  parts.push(Buffer.from("ITER"));
  const iterLen = Buffer.alloc(4);
  iterLen.writeUInt32BE(4, 0);
  parts.push(iterLen);
  const iterVal = Buffer.alloc(4);
  iterVal.writeUInt32BE(10000, 0);
  parts.push(iterVal);

  return Buffer.concat(parts);
}

/**
 * Helper to create a mock manifest key
 */
function createMockManifestKey(): Buffer {
  // 4 bytes protection class + wrapped key
  const protectionClass = Buffer.alloc(4);
  protectionClass.writeUInt32BE(3, 0); // Protection class 3
  const wrappedKey = crypto.randomBytes(40);
  return Buffer.concat([protectionClass, wrappedKey]);
}
