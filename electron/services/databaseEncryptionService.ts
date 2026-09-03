/**
 * Database Encryption Service
 * Manages encryption keys for SQLite database using Electron's safeStorage API
 * Keys are stored securely in the OS keychain (macOS Keychain, Windows DPAPI, Linux Secret Service)
 */

import { app } from "electron";
import type { SecretStore } from "../capabilities/secretStore";
import { hostSecretStore } from "../capabilities/secretStoreProvider";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import * as Sentry from "@sentry/electron/main";
import logService from "./logService";

/**
 * Key storage metadata interface
 */
interface KeyMetadata {
  keyId: string;
  createdAt: string;
  rotatedAt?: string;
  version: number;
}

/**
 * Key store structure saved to disk
 */
interface KeyStore {
  encryptedKey: string;
  metadata: KeyMetadata;
}

/**
 * Database Encryption Service Class
 * Handles encryption key generation, storage, and retrieval for database encryption
 */
export class DatabaseEncryptionService {
  private readonly KEY_STORE_FILENAME = "db-key-store.json";
  private readonly KEY_VERSION = 1;
  private keyStorePath: string | null = null;
  private cachedKey: string | null = null;
  private readonly secrets: SecretStore;

  /**
   * @param secrets - The host shell's secret store (BACKLOG-2962). Injected so
   *   the key-store paths can be exercised without Electron.
   */
  constructor(secrets: SecretStore) {
    this.secrets = secrets;
  }

  /**
   * Initialize the encryption service
   * Must be called after Electron app is ready
   */
  async initialize(): Promise<void> {
    try {
      const userDataPath = app.getPath("userData");
      this.keyStorePath = path.join(userDataPath, this.KEY_STORE_FILENAME);
      await logService.info(
        "Database encryption service initialized",
        "DatabaseEncryptionService",
      );
    } catch (error) {
      await logService.error(
        "Failed to initialize encryption service",
        "DatabaseEncryptionService",
        { error: error instanceof Error ? error.message : String(error) },
      );
      Sentry.captureException(error, {
        tags: { service: "database-encryption", operation: "initialize" },
      });
      throw error;
    }
  }

  /**
   * Check if encryption is available on this system
   * @returns {boolean} True if OS-level encryption is available
   */
  isEncryptionAvailable(): boolean {
    try {
      return this.secrets.isEncryptionAvailable();
    } catch (error) {
      logService.error(
        "Error checking encryption availability",
        "DatabaseEncryptionService",
        { error: error instanceof Error ? error.message : String(error) },
      );
      Sentry.captureException(error, {
        tags: { service: "database-encryption", operation: "isEncryptionAvailable" },
      });
      return false;
    }
  }

  /**
   * BACKLOG-1123: Synchronous getter for the cached key.
   * Returns null if the key hasn't been loaded yet (call getEncryptionKey() first).
   * Used by dbConnection to avoid duplicating the key in a separate module variable.
   */
  getCachedKey(): string | null {
    return this.cachedKey;
  }

  /**
   * Get or create database encryption key
   * Key is stored in OS keychain via Electron safeStorage
   * @returns {Promise<string>} The encryption key (hex encoded)
   */
  async getEncryptionKey(): Promise<string> {
    // Return cached key if available
    if (this.cachedKey) {
      return this.cachedKey;
    }

    if (!this.isEncryptionAvailable()) {
      const error = new Error(
        "Encryption not available. Database encryption requires OS-level encryption support.",
      );
      await logService.error(
        "Encryption not available on this system",
        "DatabaseEncryptionService",
      );
      throw error;
    }

    const existingKey = await this.getKeyFromStore();
    if (existingKey) {
      this.cachedKey = existingKey;
      return existingKey;
    }

    // Generate new key
    const newKey = await this.generateNewKey();
    this.cachedKey = newKey;
    return newKey;
  }

  /**
   * Generate a new encryption key and store it
   * @returns {Promise<string>} The new encryption key (hex encoded)
   */
  private async generateNewKey(): Promise<string> {
    try {
      // Generate 256-bit (32 bytes) key using cryptographically secure random
      const keyBuffer = crypto.randomBytes(32);
      const keyHex = keyBuffer.toString("hex");

      // Encrypt and store the key
      await this.saveKeyToStore(keyHex);

      await logService.info(
        "Generated new database encryption key",
        "DatabaseEncryptionService",
      );

      return keyHex;
    } catch (error) {
      await logService.error(
        "Failed to generate encryption key",
        "DatabaseEncryptionService",
        { error: error instanceof Error ? error.message : String(error) },
      );
      Sentry.captureException(error, {
        tags: { service: "database-encryption", operation: "generateNewKey" },
      });
      throw error;
    }
  }

  /**
   * Retrieve encryption key from storage
   * @returns {Promise<string | null>} The decrypted key or null if not found
   */
  private async getKeyFromStore(): Promise<string | null> {
    if (!this.keyStorePath) {
      throw new Error("Encryption service not initialized");
    }

    try {
      if (!fs.existsSync(this.keyStorePath)) {
        return null;
      }

      const storeContent = fs.readFileSync(this.keyStorePath, "utf8");
      const keyStore: KeyStore = JSON.parse(storeContent);

      if (!keyStore.encryptedKey) {
        await logService.warn(
          "Key store exists but contains no encrypted key",
          "DatabaseEncryptionService",
        );
        return null;
      }

      // Decrypt the key using OS keychain
      const encryptedBuffer = Buffer.from(keyStore.encryptedKey, "base64");
      const decryptedKey = this.secrets.decryptString(encryptedBuffer);

      await logService.debug(
        "Retrieved encryption key from store",
        "DatabaseEncryptionService",
        { keyId: keyStore.metadata.keyId, version: keyStore.metadata.version },
      );

      return decryptedKey;
    } catch (error) {
      await logService.error(
        "Failed to retrieve encryption key from store",
        "DatabaseEncryptionService",
        { error: error instanceof Error ? error.message : String(error) },
      );
      Sentry.captureException(error, {
        tags: { service: "database-encryption", operation: "getKeyFromStore" },
      });
      return null;
    }
  }

  /**
   * Save encryption key to storage (encrypted with OS keychain)
   * @param {string} key - The encryption key to store
   */
  private async saveKeyToStore(key: string): Promise<void> {
    if (!this.keyStorePath) {
      throw new Error("Encryption service not initialized");
    }

    try {
      // Encrypt the key using OS keychain
      const encryptedBuffer = this.secrets.encryptString(key);
      const encryptedBase64 = encryptedBuffer.toString("base64");

      const keyStore: KeyStore = {
        encryptedKey: encryptedBase64,
        metadata: {
          keyId: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
          version: this.KEY_VERSION,
        },
      };

      // Ensure directory exists
      const dir = path.dirname(this.keyStorePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Write key store to disk
      fs.writeFileSync(this.keyStorePath, JSON.stringify(keyStore, null, 2), {
        encoding: "utf8",
        mode: 0o600, // Read/write only for owner
      });

      await logService.info(
        "Saved encryption key to store",
        "DatabaseEncryptionService",
        { keyId: keyStore.metadata.keyId },
      );
    } catch (error) {
      await logService.error(
        "Failed to save encryption key to store",
        "DatabaseEncryptionService",
        { error: error instanceof Error ? error.message : String(error) },
      );
      Sentry.captureException(error, {
        tags: { service: "database-encryption", operation: "saveKeyToStore" },
      });
      throw error;
    }
  }

  /**
   * Check if a database file is encrypted
   * SQLite encrypted databases don't have the standard SQLite header
   * @param {string} dbPath - Path to the database file
   * @returns {Promise<boolean>} True if the database appears to be encrypted
   */
  async isDatabaseEncrypted(dbPath: string): Promise<boolean> {
    try {
      // Open directly and handle ENOENT, avoiding TOCTOU race with existsSync
      let fd: number;
      try {
        fd = fs.openSync(dbPath, "r");
      } catch (err: unknown) {
        if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOENT") {
          return false; // New database, will be created encrypted
        }
        throw err;
      }

      // Read the first 16 bytes of the file
      const buffer = Buffer.alloc(16);
      fs.readSync(fd, buffer, 0, 16, 0);
      fs.closeSync(fd);

      // SQLite files start with "SQLite format 3\0"
      const sqliteHeader = "SQLite format 3\0";
      const headerMatch = buffer.toString("utf8", 0, 16) === sqliteHeader;

      // If it matches SQLite header, it's NOT encrypted
      // If it doesn't match, it's either encrypted or not a SQLite file
      return !headerMatch;
    } catch (error) {
      await logService.warn(
        "Could not check database encryption status",
        "DatabaseEncryptionService",
        {
          dbPath,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      Sentry.captureException(error, {
        tags: { service: "database-encryption", operation: "isDatabaseEncrypted" },
      });
      return false;
    }
  }

  /**
   * Rotate the encryption key (for future implementation)
   * This creates a new key while keeping the old one for migration
   * @returns {Promise<{ oldKey: string; newKey: string }>} The old and new keys
   */
  async rotateKey(): Promise<{ oldKey: string; newKey: string }> {
    if (!this.keyStorePath) {
      throw new Error("Encryption service not initialized");
    }

    const oldKey = await this.getEncryptionKey();

    // Generate new key
    const newKeyBuffer = crypto.randomBytes(32);
    const newKey = newKeyBuffer.toString("hex");

    // Update key store with new key and rotation timestamp
    const encryptedBuffer = this.secrets.encryptString(newKey);
    const encryptedBase64 = encryptedBuffer.toString("base64");

    const keyStore: KeyStore = {
      encryptedKey: encryptedBase64,
      metadata: {
        keyId: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        rotatedAt: new Date().toISOString(),
        version: this.KEY_VERSION,
      },
    };

    fs.writeFileSync(this.keyStorePath, JSON.stringify(keyStore, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });

    // Clear cached key
    this.cachedKey = newKey;

    await logService.info(
      "Encryption key rotated successfully",
      "DatabaseEncryptionService",
      { newKeyId: keyStore.metadata.keyId },
    );

    return { oldKey, newKey };
  }

  /**
   * Clear cached key (useful for testing)
   */
  clearCache(): void {
    this.cachedKey = null;
  }

  /**
   * Check if the encryption key store file exists
   * This does NOT trigger any keychain prompts - it just checks file existence
   * Useful for determining if this is a new user vs returning user
   * @returns {boolean} True if key store file exists
   */
  hasKeyStore(): boolean {
    if (!this.keyStorePath) {
      // Service not initialized yet, check default path
      try {
        const userDataPath = app.getPath("userData");
        const defaultKeyStorePath = path.join(
          userDataPath,
          this.KEY_STORE_FILENAME,
        );
        return fs.existsSync(defaultKeyStorePath);
      } catch {
        return false;
      }
    }
    return fs.existsSync(this.keyStorePath);
  }

  /**
   * Get key metadata for diagnostics (does not expose key)
   * @returns {Promise<KeyMetadata | null>} Key metadata or null if not found
   */
  async getKeyMetadata(): Promise<KeyMetadata | null> {
    if (!this.keyStorePath || !fs.existsSync(this.keyStorePath)) {
      return null;
    }

    try {
      const storeContent = fs.readFileSync(this.keyStorePath, "utf8");
      const keyStore: KeyStore = JSON.parse(storeContent);
      return keyStore.metadata;
    } catch (error) {
      await logService.error(
        "Failed to read key metadata",
        "DatabaseEncryptionService",
        { error: error instanceof Error ? error.message : String(error) },
      );
      Sentry.captureException(error, {
        tags: { service: "database-encryption", operation: "getKeyMetadata" },
      });
      return null;
    }
  }
}

// Export singleton instance
export const databaseEncryptionService = new DatabaseEncryptionService(hostSecretStore);
export default databaseEncryptionService;
