/**
 * Database Encryption Service
 * Manages encryption keys for SQLite database using Electron's safeStorage API
 * Keys are stored securely in the OS keychain (macOS Keychain, Windows DPAPI, Linux Secret Service)
 */

import { hostAppPaths } from "../capabilities/appPathsProvider";
import type { SecretStore } from "../capabilities/secretStore";
import { hostSecretStore } from "../capabilities/secretStoreProvider";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { hostErrorReporter } from "../capabilities/errorReporterProvider";
import logService from "./logService";
import { DbKeyUnavailableError, type DbKeyUnavailableReason } from "../types/database";

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

// BACKLOG-3824: the error lives beside the other database errors so modules
// that mock this service (most databaseService suites) still see the class.
export { DbKeyUnavailableError } from "../types/database";
export type { DbKeyUnavailableReason } from "../types/database";

/** The plaintext SQLite header. Anything else in mad.db is treated as ciphertext. */
const SQLITE_PLAINTEXT_HEADER = "SQLite format 3\0";
/** The database file that lives beside the key store (databaseService derives the same name). */
const DB_FILENAME = "mad.db";
/** A raw SQLCipher key as generateNewKey() produces it: 32 bytes, hex. */
const KEY_HEX_PATTERN = /^[0-9a-f]{64}$/i;

/** Another writer created the store between our read and our create. */
class KeyStoreExistsError extends Error {}

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
      const userDataPath = hostAppPaths.userData();
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
      hostErrorReporter.captureException(error, {
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
      hostErrorReporter.captureException(error, {
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
   *
   * BACKLOG-3824: creates a key ONLY on a true first run (no store file and no
   * encrypted mad.db). Every other failure throws {@link DbKeyUnavailableError}
   * and writes nothing — see that class for why.
   *
   * @returns {Promise<string>} The encryption key (hex encoded)
   */
  async getEncryptionKey(): Promise<string> {
    // Return cached key if available
    if (this.cachedKey) {
      return this.cachedKey;
    }

    if (!this.isEncryptionAvailable()) {
      await logService.error(
        "Encryption not available on this system",
        "DatabaseEncryptionService",
      );
      // An existing key or database means this is "cannot unlock", not
      // "cannot set up" — typed, so startup offers Retry instead of a dead end.
      if (this.storeFileExists() || this.hasEncryptedDatabase()) {
        throw new DbKeyUnavailableError("secure_storage_unavailable");
      }
      throw new Error(
        "Encryption not available. Database encryption requires OS-level encryption support.",
      );
    }

    const existingKey = await this.getKeyFromStore();
    if (existingKey) {
      this.cachedKey = existingKey;
      return existingKey;
    }

    // The store is absent (ENOENT). That is a first run ONLY if nothing on disk
    // is already sealed under a key we no longer have.
    if (this.hasEncryptedDatabase()) {
      await logService.error(
        "Encrypted database found but its key store is missing; NOT creating a new key",
        "DatabaseEncryptionService",
      );
      throw new DbKeyUnavailableError("store_missing");
    }

    let newKey: string;
    try {
      newKey = await this.generateNewKey();
    } catch (error) {
      if (!(error instanceof KeyStoreExistsError)) throw error;
      // Another writer won the race. Its key is the key; read it back.
      const winner = await this.getKeyFromStore();
      if (!winner) throw new DbKeyUnavailableError("store_unreadable");
      newKey = winner;
    }
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
      if (error instanceof KeyStoreExistsError) throw error;
      await logService.error(
        "Failed to generate encryption key",
        "DatabaseEncryptionService",
        { error: error instanceof Error ? error.message : String(error) },
      );
      hostErrorReporter.captureException(error, {
        tags: { service: "database-encryption", operation: "generateNewKey" },
      });
      throw error;
    }
  }

  /**
   * Retrieve encryption key from storage.
   *
   * BACKLOG-3824: returns null ONLY when the store file does not exist. A store
   * that exists but cannot be read, parsed or unwrapped throws
   * {@link DbKeyUnavailableError} — returning null there is what used to make
   * getEncryptionKey() overwrite it with a new key.
   *
   * The underlying error text goes to the local log only, never to Sentry.
   *
   * @returns {Promise<string | null>} The decrypted key, or null if no store exists
   */
  private async getKeyFromStore(): Promise<string | null> {
    if (!this.keyStorePath) {
      throw new Error("Encryption service not initialized");
    }

    let storeContent: string;
    try {
      storeContent = fs.readFileSync(this.keyStorePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return null;
      }
      await this.logKeyFailure("store_unreadable", error);
      throw new DbKeyUnavailableError("store_unreadable");
    }

    let keyStore: Partial<KeyStore> | null;
    try {
      keyStore = JSON.parse(storeContent) as Partial<KeyStore> | null;
    } catch (error) {
      await this.logKeyFailure("store_corrupt", error);
      throw new DbKeyUnavailableError("store_corrupt");
    }
    if (!keyStore || typeof keyStore.encryptedKey !== "string" || !keyStore.encryptedKey) {
      await this.logKeyFailure("store_corrupt", "key store contains no wrapped key");
      throw new DbKeyUnavailableError("store_corrupt");
    }

    let decryptedKey: string;
    try {
      // Decrypt the key using OS keychain
      decryptedKey = this.secrets.decryptString(Buffer.from(keyStore.encryptedKey, "base64"));
    } catch (error) {
      await this.logKeyFailure("unwrap_failed", error);
      throw new DbKeyUnavailableError("unwrap_failed");
    }
    if (typeof decryptedKey !== "string" || !KEY_HEX_PATTERN.test(decryptedKey)) {
      await this.logKeyFailure("unwrap_failed", "unwrapped value is not a database key");
      throw new DbKeyUnavailableError("unwrap_failed");
    }

    await logService.debug(
      "Retrieved encryption key from store",
      "DatabaseEncryptionService",
      { keyId: keyStore.metadata?.keyId, version: keyStore.metadata?.version },
    );

    return decryptedKey;
  }

  private async logKeyFailure(reason: DbKeyUnavailableReason, error: unknown): Promise<void> {
    await logService.error(
      "Database key store exists but the key cannot be produced; NOT creating a new key",
      "DatabaseEncryptionService",
      { reason, error: error instanceof Error ? error.message : String(error) },
    );
  }

  /** Whether the key store file is present (any type of entry counts). */
  private storeFileExists(): boolean {
    if (!this.keyStorePath) return this.hasKeyStore();
    try {
      fs.lstatSync(this.keyStorePath);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException)?.code !== "ENOENT";
    }
  }

  /**
   * BACKLOG-3824: is there a mad.db beside the key store that a NEW key could not
   * open? True for a non-empty file whose header is not the plaintext SQLite
   * header, and — failing closed — for one that exists but cannot be read.
   * A missing or zero-byte file is not evidence (nothing is sealed in it), and a
   * plaintext legacy database is migrated under a new key by databaseService.
   *
   * Deliberately NOT isDatabaseEncrypted(): that returns false on a read error,
   * which here would mean "unreadable database → create a key over it".
   */
  private hasEncryptedDatabase(): boolean {
    let dir: string;
    try {
      dir = this.keyStorePath ? path.dirname(this.keyStorePath) : hostAppPaths.userData();
    } catch {
      return false;
    }
    const dbPath = path.join(dir, DB_FILENAME);
    let fd: number;
    try {
      fd = fs.openSync(dbPath, "r");
    } catch (error) {
      return (error as NodeJS.ErrnoException)?.code !== "ENOENT";
    }
    try {
      const size = fs.fstatSync(fd).size;
      if (size === 0) return false;
      const header = Buffer.alloc(16);
      const read = fs.readSync(fd, header, 0, 16, 0);
      return read < 16 || header.toString("utf8", 0, 16) !== SQLITE_PLAINTEXT_HEADER;
    } catch {
      return true;
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        /* the answer matters, not the close */
      }
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

      // BACKLOG-3824: CREATE, never replace. Write a private temp file, then
      // link it into place — link(2) fails with EEXIST instead of overwriting a
      // store another writer created a moment ago, and a crash mid-write leaves
      // only the temp file behind, never a half-written store.
      const tmpPath = `${this.keyStorePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
      try {
        const fd = fs.openSync(tmpPath, "wx", 0o600); // Read/write only for owner
        try {
          fs.writeSync(fd, JSON.stringify(keyStore, null, 2));
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        try {
          fs.linkSync(tmpPath, this.keyStorePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
            throw new KeyStoreExistsError();
          }
          throw error;
        }
      } finally {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          /* already gone */
        }
      }

      await logService.info(
        "Saved encryption key to store",
        "DatabaseEncryptionService",
        { keyId: keyStore.metadata.keyId },
      );
    } catch (error) {
      if (error instanceof KeyStoreExistsError) throw error;
      await logService.error(
        "Failed to save encryption key to store",
        "DatabaseEncryptionService",
        { error: error instanceof Error ? error.message : String(error) },
      );
      hostErrorReporter.captureException(error, {
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
      hostErrorReporter.captureException(error, {
        tags: { service: "database-encryption", operation: "isDatabaseEncrypted" },
      });
      return false;
    }
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
        const userDataPath = hostAppPaths.userData();
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
      hostErrorReporter.captureException(error, {
        tags: { service: "database-encryption", operation: "getKeyMetadata" },
      });
      return null;
    }
  }
}

// Export singleton instance
export const databaseEncryptionService = new DatabaseEncryptionService(hostSecretStore);
export default databaseEncryptionService;
