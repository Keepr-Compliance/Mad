/**
 * Backup Decryption Service
 * Handles decryption of iOS encrypted backups
 *
 * iOS backups use a multi-layer encryption scheme:
 * Password -> PBKDF2 -> Key Encryption Key (KEK) -> Unwrap Class Keys -> Decrypt Files
 *
 * Reference: https://github.com/jsharkey13/iphone_backup_decrypt
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import plist from "simple-plist";
import logService from "./logService";
import { MANIFEST_FILE_BY_ID_SQL } from "./db/iosBackupManifestSql";
import type {
  DecryptionResult,
  ManifestPlist,
  Keybag,
  KeybagItem,
  EncryptionKeys,
} from "../types/backup";

// Import better-sqlite3-multiple-ciphers for reading Manifest.db
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require("better-sqlite3-multiple-ciphers");

/**
 * Backup Decryption Service Class
 * Decrypts iOS encrypted backups to extract messages and contacts
 */
export class BackupDecryptionService {
  private static readonly SERVICE_NAME = "BackupDecryptionService";

  // Files we need to decrypt
  private readonly requiredFiles = [
    "3d0d7e5fb2ce288813306e4d4636395e047a3d28", // sms.db
    "31bb7ba8914766d4ba40d6dfb6113c8b614be442", // AddressBook.sqlitedb
  ];

  /**
   * Decrypt an iOS backup using the provided password
   * @param backupPath - Path to the backup directory
   * @param password - User's backup password
   * @returns DecryptionResult with success status and decrypted path
   */
  async decryptBackup(
    backupPath: string,
    password: string,
  ): Promise<DecryptionResult> {
    try {
      await logService.info(
        "Starting backup decryption",
        BackupDecryptionService.SERVICE_NAME,
        { backupPath },
      );

      // 1. Read and parse Manifest.plist to get encryption info
      const manifestPath = path.join(backupPath, "Manifest.plist");
      if (!fs.existsSync(manifestPath)) {
        return {
          success: false,
          error: "Manifest.plist not found - invalid backup",
          decryptedPath: null,
        };
      }

      const manifest = await this.readManifest(manifestPath);
      if (!manifest.IsEncrypted) {
        return {
          success: false,
          error: "Backup is not encrypted",
          decryptedPath: null,
        };
      }

      // 2. Parse the keybag from Manifest.plist
      const keybag = this.parseKeybag(manifest.BackupKeyBag!);

      // 3. Derive decryption keys using PBKDF2
      const keys = await this.deriveKeys(password, keybag);

      // 4. Verify password is correct by attempting to unwrap class keys
      const classKeysUnwrapped = this.unwrapClassKeys(
        keybag,
        keys.keyEncryptionKey,
      );
      if (!classKeysUnwrapped) {
        return {
          success: false,
          error: "Incorrect password",
          decryptedPath: null,
        };
      }
      keys.classKeys = classKeysUnwrapped;

      // 5. Decrypt Manifest.db to get file list
      const manifestDbPath = path.join(backupPath, "Manifest.db");
      const decryptedManifestDb = await this.decryptManifestDb(
        manifestDbPath,
        manifest.ManifestKey!,
        keys,
      );

      // 6. Create output directory for decrypted files
      const outputPath = path.join(backupPath, "decrypted");
      if (!fs.existsSync(outputPath)) {
        fs.mkdirSync(outputPath, { recursive: true });
      }

      // 7. Decrypt only the files we need
      await this.decryptRequiredFiles(
        backupPath,
        decryptedManifestDb,
        keys,
        outputPath,
      );

      await logService.info(
        "Backup decryption completed successfully",
        BackupDecryptionService.SERVICE_NAME,
        { outputPath },
      );

      // Clear sensitive data from memory
      this.clearSensitiveData(keys);

      return {
        success: true,
        error: null,
        decryptedPath: outputPath,
      };
    } catch (error) {
      await logService.error(
        "Decryption failed",
        BackupDecryptionService.SERVICE_NAME,
        { error: error instanceof Error ? error.message : String(error) },
      );

      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Unknown decryption error",
        decryptedPath: null,
      };
    }
  }

  /**
   * Check if a backup is encrypted
   * @param backupPath - Path to the backup directory
   * @returns true if backup is encrypted
   */
  async isBackupEncrypted(backupPath: string): Promise<boolean> {
    try {
      const manifestPath = path.join(backupPath, "Manifest.plist");
      if (!fs.existsSync(manifestPath)) {
        return false;
      }
      const manifest = await this.readManifest(manifestPath);
      return manifest.IsEncrypted === true;
    } catch {
      return false;
    }
  }

  /**
   * Verify a backup password without fully decrypting
   * @param backupPath - Path to the backup directory
   * @param password - Password to verify
   * @returns true if password is correct
   */
  async verifyPassword(backupPath: string, password: string): Promise<boolean> {
    try {
      const manifestPath = path.join(backupPath, "Manifest.plist");
      const manifest = await this.readManifest(manifestPath);

      if (!manifest.IsEncrypted || !manifest.BackupKeyBag) {
        return false;
      }

      const keybag = this.parseKeybag(manifest.BackupKeyBag);
      const keys = await this.deriveKeys(password, keybag);
      const classKeys = this.unwrapClassKeys(keybag, keys.keyEncryptionKey);

      // Clear sensitive data
      keys.keyEncryptionKey.fill(0);

      return classKeys !== null;
    } catch {
      return false;
    }
  }

  /**
   * Read and parse Manifest.plist
   */
  private async readManifest(manifestPath: string): Promise<ManifestPlist> {
    const manifestData = fs.readFileSync(manifestPath);
    const parsed = plist.parse(manifestData) as Record<string, unknown>;

    return {
      IsEncrypted: parsed.IsEncrypted as boolean,
      ManifestKey: parsed.ManifestKey as Buffer | undefined,
      BackupKeyBag: parsed.BackupKeyBag as Buffer | undefined,
      Lockdown: parsed.Lockdown as ManifestPlist["Lockdown"],
    };
  }

  /**
   * Parse the keybag from backup metadata
   * The keybag contains wrapped class keys that protect file data
   */
  private parseKeybag(keybagData: Buffer): Keybag {
    const keybag: Keybag = {
      uuid: Buffer.alloc(0),
      type: 0,
      classKeys: new Map(),
    };

    let offset = 0;
    let currentClass: number | null = null;
    let currentItem: Partial<KeybagItem> = {};

    while (offset < keybagData.length) {
      if (offset + 8 > keybagData.length) break;

      // Read tag (4 bytes) and length (4 bytes)
      const tag = keybagData.toString("ascii", offset, offset + 4);
      const length = keybagData.readUInt32BE(offset + 4);
      offset += 8;

      if (offset + length > keybagData.length) break;

      const value = keybagData.subarray(offset, offset + length);
      offset += length;

      switch (tag) {
        case "UUID":
          if (currentClass === null) {
            keybag.uuid = Buffer.from(value);
          } else {
            currentItem.uuid = Buffer.from(value);
          }
          break;
        case "TYPE":
          keybag.type = value.readUInt32BE(0);
          break;
        case "HMCK":
          keybag.hmck = Buffer.from(value);
          break;
        case "WRAP":
          if (currentClass === null) {
            keybag.wrap = value.readUInt32BE(0);
          } else {
            currentItem.wrap = value.readUInt32BE(0);
          }
          break;
        case "SALT":
          if (currentClass === null) {
            keybag.salt = Buffer.from(value);
          } else {
            currentItem.salt = Buffer.from(value);
          }
          break;
        case "ITER":
          if (currentClass === null) {
            keybag.iter = value.readUInt32BE(0);
          } else {
            currentItem.iter = value.readUInt32BE(0);
          }
          break;
        case "DPWT":
          if (currentClass === null) {
            keybag.dpwt = value.readUInt32BE(0);
          } else {
            currentItem.dpwt = value.readUInt32BE(0);
          }
          break;
        case "DPIC":
          if (currentClass === null) {
            keybag.dpic = value.readUInt32BE(0);
          } else {
            currentItem.dpic = value.readUInt32BE(0);
          }
          break;
        case "DPSL":
          if (currentClass === null) {
            keybag.dpsl = Buffer.from(value);
          } else {
            currentItem.dpsl = Buffer.from(value);
          }
          break;
        case "CLAS":
          // Save previous class item if any
          if (currentClass !== null && currentItem.wpky) {
            keybag.classKeys.set(currentClass, currentItem as KeybagItem);
          }
          currentClass = value.readUInt32BE(0);
          currentItem = { clas: currentClass };
          break;
        case "KTYP":
          currentItem.ktyp = value.readUInt32BE(0);
          break;
        case "WPKY":
          currentItem.wpky = Buffer.from(value);
          break;
        case "PBKY":
          currentItem.publicKey = Buffer.from(value);
          break;
      }
    }

    // Save last class item
    if (currentClass !== null && currentItem.wpky) {
      keybag.classKeys.set(currentClass, currentItem as KeybagItem);
    }

    return keybag;
  }

  /**
   * Derive encryption keys from password using PBKDF2
   * iOS uses double PBKDF2 for backup encryption
   */
  private async deriveKeys(
    password: string,
    keybag: Keybag,
  ): Promise<EncryptionKeys> {
    // First round: derive key from password
    const iterations1 = keybag.dpic || 10000;
    const salt1 = keybag.dpsl || keybag.salt || Buffer.alloc(20);

    const derivedKey1 = crypto.pbkdf2Sync(
      password,
      salt1,
      iterations1,
      32,
      "sha256",
    );

    // Second round: derive KEK from first derived key
    const iterations2 = keybag.iter || 1;
    const salt2 = keybag.salt || Buffer.alloc(20);

    const keyEncryptionKey = crypto.pbkdf2Sync(
      derivedKey1,
      salt2,
      iterations2,
      32,
      "sha1",
    );

    // Clear intermediate key
    derivedKey1.fill(0);

    return {
      keyEncryptionKey,
      classKeys: new Map(),
    };
  }

  /**
   * Unwrap class keys using the Key Encryption Key
   * Uses RFC 3394 AES Key Wrap algorithm
   */
  private unwrapClassKeys(
    keybag: Keybag,
    kek: Buffer,
  ): Map<number, Buffer> | null {
    const classKeys = new Map<number, Buffer>();

    for (const [classNum, item] of keybag.classKeys) {
      if (!item.wpky) continue;

      // Skip asymmetric keys (wrap type 2)
      if (item.wrap === 2) continue;

      try {
        const unwrappedKey = this.aesKeyUnwrap(kek, item.wpky);
        if (unwrappedKey) {
          classKeys.set(classNum, unwrappedKey);
        }
      } catch {
        // If any key fails to unwrap, password is likely wrong
        return null;
      }
    }

    // We need at least one class key to succeed
    if (classKeys.size === 0) {
      return null;
    }

    return classKeys;
  }

  /**
   * AES Key Unwrap (RFC 3394)
   * Used to unwrap class keys protected by KEK
   */
  private aesKeyUnwrap(kek: Buffer, wrappedKey: Buffer): Buffer | null {
    if (wrappedKey.length < 24 || wrappedKey.length % 8 !== 0) {
      return null;
    }

    const n = wrappedKey.length / 8 - 1;
    const a = Buffer.from(wrappedKey.subarray(0, 8));
    const r = Buffer.alloc(n * 8);
    wrappedKey.copy(r, 0, 8);

    // Create decipher
    const decipher = crypto.createDecipheriv("aes-256-ecb", kek, null);
    decipher.setAutoPadding(false);

    // Perform unwrap iterations
    for (let j = 5; j >= 0; j--) {
      for (let i = n; i >= 1; i--) {
        const t = BigInt(n * j + i);

        // A ^ t
        const tBuf = Buffer.alloc(8);
        tBuf.writeBigUInt64BE(t, 0);
        for (let k = 0; k < 8; k++) {
          a[k] ^= tBuf[k];
        }

        // Decrypt A || R[i]
        const block = Buffer.concat([a, r.subarray((i - 1) * 8, i * 8)]);
        const decrypted = Buffer.concat([decipher.update(block)]);

        // Update A and R[i]
        decrypted.copy(a, 0, 0, 8);
        decrypted.copy(r, (i - 1) * 8, 8, 16);
      }
    }

    // Verify IV (should be 0xA6A6A6A6A6A6A6A6)
    const expectedIv = Buffer.from([
      0xa6, 0xa6, 0xa6, 0xa6, 0xa6, 0xa6, 0xa6, 0xa6,
    ]);
    if (!a.equals(expectedIv)) {
      return null;
    }

    return r;
  }

  /**
   * Decrypt Manifest.db to get file metadata
   */
  private async decryptManifestDb(
    manifestDbPath: string,
    manifestKey: Buffer,
    keys: EncryptionKeys,
  ): Promise<string> {
    // The manifest key has the class prepended (4 bytes)
    const protectionClass = manifestKey.readUInt32BE(0);
    const wrappedDbKey = manifestKey.subarray(4);

    // Get the class key for this protection class
    const classKey = keys.classKeys.get(protectionClass);
    if (!classKey) {
      throw new Error(`No class key for protection class ${protectionClass}`);
    }

    // Unwrap the database key
    const dbKey = this.aesKeyUnwrap(classKey, wrappedDbKey);
    if (!dbKey) {
      throw new Error("Failed to unwrap Manifest.db key");
    }

    // Decrypt Manifest.db
    const encryptedDb = fs.readFileSync(manifestDbPath);
    const decryptedDb = this.decryptAesCbc(dbKey, encryptedDb);

    // Write decrypted database to temp location
    const decryptedDbPath = manifestDbPath + ".decrypted";
    fs.writeFileSync(decryptedDbPath, decryptedDb);

    // Clear key
    dbKey.fill(0);

    return decryptedDbPath;
  }

  /**
   * Decrypt data using AES-256-CBC with zero IV
   */
  private decryptAesCbc(key: Buffer, data: Buffer): Buffer {
    const iv = Buffer.alloc(16, 0);
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
    decipher.setAutoPadding(false);

    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);

    // Remove PKCS7 padding
    const paddingLength = decrypted[decrypted.length - 1];
    if (paddingLength > 0 && paddingLength <= 16) {
      return decrypted.subarray(0, decrypted.length - paddingLength);
    }

    return decrypted;
  }

  /**
   * Decrypt only the files we need from the backup
   */
  private async decryptRequiredFiles(
    backupPath: string,
    manifestDbPath: string,
    keys: EncryptionKeys,
    outputPath: string,
  ): Promise<void> {
    // Open decrypted Manifest.db
    const db = new Database(manifestDbPath, { readonly: true });

    try {
      for (const fileHash of this.requiredFiles) {
        await this.decryptFile(backupPath, fileHash, db, keys, outputPath);
      }
    } finally {
      db.close();
      // Clean up decrypted Manifest.db
      try {
        fs.unlinkSync(manifestDbPath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Decrypt a single file from the backup
   */
  private async decryptFile(
    backupPath: string,
    fileHash: string,
    manifestDb: typeof Database,
    keys: EncryptionKeys,
    outputPath: string,
  ): Promise<void> {
    // Look up file in Manifest.db
    const row = manifestDb
      .prepare(MANIFEST_FILE_BY_ID_SQL)
      .get(fileHash) as
      | { fileID: string; domain: string; relativePath: string; file: Buffer }
      | undefined;

    if (!row) {
      await logService.warn(
        `File not found in manifest: ${fileHash}`,
        BackupDecryptionService.SERVICE_NAME,
      );
      return;
    }

    // Parse the file metadata plist
    let fileMetadata: Record<string, unknown>;
    try {
      fileMetadata = plist.parse(row.file) as Record<string, unknown>;
    } catch {
      await logService.warn(
        `Failed to parse file metadata for ${fileHash}`,
        BackupDecryptionService.SERVICE_NAME,
      );
      return;
    }

    const protectionClass = (fileMetadata.ProtectionClass as number) || 0;
    const encryptionKey = fileMetadata.EncryptionKey as Buffer | undefined;

    if (!encryptionKey) {
      await logService.warn(
        `No encryption key for file ${fileHash}`,
        BackupDecryptionService.SERVICE_NAME,
      );
      return;
    }

    // Get the class key
    const classKey = keys.classKeys.get(protectionClass);
    if (!classKey) {
      await logService.warn(
        `No class key for protection class ${protectionClass}`,
        BackupDecryptionService.SERVICE_NAME,
      );
      return;
    }

    // The encryption key has the class prepended
    const wrappedFileKey = encryptionKey.subarray(4);
    const fileKey = this.aesKeyUnwrap(classKey, wrappedFileKey);
    if (!fileKey) {
      await logService.warn(
        `Failed to unwrap file key for ${fileHash}`,
        BackupDecryptionService.SERVICE_NAME,
      );
      return;
    }

    // Read and decrypt the file
    // Files are stored in subdirectories based on first 2 chars of hash
    const encryptedFilePath = path.join(
      backupPath,
      fileHash.substring(0, 2),
      fileHash,
    );

    if (!fs.existsSync(encryptedFilePath)) {
      await logService.warn(
        `Encrypted file not found: ${encryptedFilePath}`,
        BackupDecryptionService.SERVICE_NAME,
      );
      fileKey.fill(0);
      return;
    }

    const encryptedData = fs.readFileSync(encryptedFilePath);
    const decryptedData = this.decryptAesCbc(fileKey, encryptedData);

    // Write decrypted file
    const outputFilePath = path.join(
      outputPath,
      path.basename(row.relativePath),
    );
    fs.writeFileSync(outputFilePath, decryptedData);

    await logService.debug(
      `Decrypted file: ${row.relativePath}`,
      BackupDecryptionService.SERVICE_NAME,
      { outputPath: outputFilePath },
    );

    // Clear file key
    fileKey.fill(0);
  }

  /**
   * Clear sensitive data from memory
   */
  private clearSensitiveData(keys: EncryptionKeys): void {
    keys.keyEncryptionKey.fill(0);
    for (const key of keys.classKeys.values()) {
      key.fill(0);
    }
    keys.classKeys.clear();
  }

  /**
   * Clean up decrypted files after parsing is complete
   * @param decryptedPath - Path to the decrypted files directory
   */
  async cleanup(decryptedPath: string): Promise<void> {
    try {
      if (fs.existsSync(decryptedPath)) {
        // Securely overwrite files before deletion
        const files = fs.readdirSync(decryptedPath);
        for (const file of files) {
          const filePath = path.join(decryptedPath, file);
          try {
            // Open file exclusively to avoid TOCTOU race between stat and write
            const fd = fs.openSync(filePath, "r+");
            try {
              const stats = fs.fstatSync(fd);
              if (stats.isFile()) {
                // Overwrite with zeros using the same fd
                const zeros = Buffer.alloc(stats.size, 0);
                fs.writeSync(fd, zeros, 0, zeros.length, 0);
              }
            } finally {
              fs.closeSync(fd);
            }
            fs.unlinkSync(filePath);
          } catch {
            // File may have been removed concurrently; skip
          }
        }
        fs.rmdirSync(decryptedPath);
        await logService.debug(
          "Cleaned up decrypted files",
          BackupDecryptionService.SERVICE_NAME,
          { path: decryptedPath },
        );
      }
    } catch (error) {
      await logService.warn(
        "Failed to clean up decrypted files",
        BackupDecryptionService.SERVICE_NAME,
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
  }
}

// Export singleton instance
export const backupDecryptionService = new BackupDecryptionService();
export default backupDecryptionService;
