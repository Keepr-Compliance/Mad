/**
 * Backup Decryption Service — reads an ENCRYPTED iOS backup (BACKLOG-3817).
 *
 * iOS backup encryption, as implemented by the reference decryptor
 * jsharkey13/iphone_backup_decrypt (`utils.py`, `iphone_backup.py`):
 *
 *   password ──PBKDF2-SHA256(DPSL, DPIC)──▶ ──PBKDF2-SHA1(SALT, ITER)──▶ passphrase key
 *   passphrase key ──RFC 3394 unwrap──▶ class keys   (only keybag entries with WRAP & 2)
 *   ManifestKey = class (4 bytes, LITTLE-endian) + wrapped key ──▶ Manifest.db key
 *   Manifest.db  = AES-256-CBC (zero IV, PKCS#7) under that key
 *   Files.file   = NSKeyedArchiver plist; `$objects[$top.root]` holds ProtectionClass and a
 *                  UID to `{ NS.data: class(4) + wrapped file key (40) }`
 *   each file    = AES-256-CBC (zero IV, PKCS#7) under its unwrapped file key, stored at
 *                  `<backup>/<fileID[0:2]>/<fileID>`
 *
 * ## Where plaintext goes
 *
 * Only into a parse-copy directory under `userData/at-rest-tmp/ios-<runId>/`, laid out
 * exactly like a backup (`XX/<fileID>`), so the parsers, `resolveAttachmentPath` and the
 * attachment copier read it unchanged. Nothing decrypted is ever written inside the backup
 * folder. The copy is removed by {@link BackupDecryptionService.cleanup} after persistence,
 * and any copy a crash left behind is removed by {@link BackupDecryptionService.sweepParseCopies}.
 *
 * ## What may be logged
 *
 * Counts and file IDs. Never a password, a derived key, or decrypted content.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import plist from "simple-plist";
import logService from "./logService";
import { hostAppPaths } from "../capabilities/appPathsProvider";
import type { DecryptionResult, ManifestPlist } from "../types/backup";

// Import better-sqlite3-multiple-ciphers for reading the decrypted Manifest.db
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require("better-sqlite3-multiple-ciphers");

/**
 * Parse copies live here, under userData. S6's temp sweep owns the shared
 * `AT_REST_TMP_DIR` constant (not on this base yet); this name must match it.
 */
export const AT_REST_TMP_DIRNAME = "at-rest-tmp";
/** Every parse-copy directory this service creates starts with this. */
export const IOS_PARSE_COPY_PREFIX = "ios-";

/** sms.db — HomeDomain-Library/SMS/sms.db */
export const SMS_DB_FILE_ID = "3d0d7e5fb2ce288813306e4d4636395e047a3d28";
/** AddressBook.sqlitedb — HomeDomain-Library/AddressBook/AddressBook.sqlitedb */
export const ADDRESS_BOOK_FILE_ID = "31bb7ba8914766d4ba40d6dfb6113c8b614be442";
/** Message attachments: MediaDomain rows under these roots (iosMessagesParser.ATTACHMENT_ROOTS). */
export const ATTACHMENT_RELATIVE_ROOTS: readonly string[] = [
  "Library/SMS/Attachments/",
  "Library/SMS/StickerCache/",
];

/** Keybag entries whose WRAP has this bit are wrapped by the passphrase key. */
const WRAP_PASSPHRASE = 2;
/** Upper bounds from the reference decryptor (`utils.py` _MAX_DPIC/_MAX_ITER_ITERATIONS). */
const MAX_DPIC_ITERATIONS = 20_000_000;
const MAX_ITER_ITERATIONS = 1_000_000;
const FILE_ID_PATTERN = /^[0-9a-f]{40}$/;

export class BackupPasswordIncorrectError extends Error {
  constructor() {
    super("Incorrect password");
    this.name = "BackupPasswordIncorrectError";
  }
}

interface ParsedKeybag {
  attrs: Map<string, Buffer | number>;
  classes: Map<number, { wrap: number; wpky: Buffer }>;
}

interface UnlockedBackup {
  manifest: ManifestPlist;
  classKeys: Map<number, Buffer>;
}

export interface DecryptStats {
  /** Files written to the parse copy. */
  decrypted: number;
  /** Rows the manifest listed but whose content was not on disk or could not be read. */
  skipped: number;
}

export interface BackupDecryptionDeps {
  /** Root that holds parse-copy directories. Default `userData/at-rest-tmp`. */
  tmpRoot?: () => string;
}

function u32(value: Buffer): number | Buffer {
  return value.length === 4 ? value.readUInt32BE(0) : value;
}

/** Parse the BackupKeyBag TLV blob (reference `BackupKeyBag._parse_bytes`). */
export function parseKeybag(bytes: Buffer): ParsedKeybag {
  const attrs = new Map<string, Buffer | number>();
  const classes = new Map<number, { wrap: number; wpky: Buffer }>();
  let sawUuid = false;
  let sawWrap = false;
  let current: Map<string, Buffer | number> | null = null;
  const flush = () => {
    if (!current) return;
    const clas = current.get("CLAS");
    const wrap = current.get("WRAP");
    const wpky = current.get("WPKY");
    if (typeof clas === "number" && typeof wrap === "number" && Buffer.isBuffer(wpky)) {
      classes.set(clas, { wrap, wpky });
    }
  };
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const tag = bytes.toString("latin1", offset, offset + 4);
    const length = bytes.readUInt32BE(offset + 4);
    const raw = bytes.subarray(offset + 8, offset + 8 + length);
    offset += 8 + length;
    const value = u32(raw);
    if (tag === "UUID" && !sawUuid) {
      sawUuid = true;
      attrs.set(tag, value);
    } else if (tag === "WRAP" && !sawWrap) {
      sawWrap = true;
      attrs.set(tag, value);
    } else if (tag === "UUID") {
      // A further UUID starts a new class-key block.
      flush();
      current = new Map([["UUID", value]]);
    } else if (["CLAS", "WRAP", "WPKY", "KTYP", "PBKY"].includes(tag)) {
      if (!current) throw new Error("Unexpected BackupKeyBag format");
      current.set(tag, tag === "WPKY" || tag === "PBKY" ? raw : value);
    } else {
      attrs.set(tag, value);
    }
  }
  flush();
  return { attrs, classes };
}

/** RFC 3394 AES key unwrap. Returns null when the integrity check fails (wrong key). */
export function aesKeyUnwrap(kek: Buffer, wrapped: Buffer): Buffer | null {
  if (wrapped.length < 24 || wrapped.length % 8 !== 0) return null;
  const n = wrapped.length / 8 - 1;
  const a = Buffer.from(wrapped.subarray(0, 8));
  const r = Buffer.from(wrapped.subarray(8));
  const decipher = crypto.createDecipheriv(`aes-${kek.length * 8}-ecb`, kek, null);
  decipher.setAutoPadding(false);
  const t = Buffer.alloc(8);
  for (let j = 5; j >= 0; j--) {
    for (let i = n; i >= 1; i--) {
      t.writeBigUInt64BE(BigInt(n * j + i), 0);
      for (let k = 0; k < 8; k++) a[k] ^= t[k];
      const block = decipher.update(Buffer.concat([a, r.subarray((i - 1) * 8, i * 8)]));
      block.copy(a, 0, 0, 8);
      block.copy(r, (i - 1) * 8, 8, 16);
    }
  }
  return a.equals(Buffer.alloc(8, 0xa6)) ? r : null;
}

function pbkdf2(password: crypto.BinaryLike, salt: Buffer, iterations: number, digest: string): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    crypto.pbkdf2(password, salt, iterations, 32, digest, (error, key) => (error ? reject(error) : resolve(key))),
  );
}

function boundedIterations(value: Buffer | number | undefined, name: string, max: number): number {
  if (typeof value !== "number" || value < 1 || value > max) {
    throw new Error(`BackupKeyBag ${name} iteration count is out of range`);
  }
  return value;
}

/** Decrypt a whole AES-256-CBC (zero IV, PKCS#7) file to `dest`. Validates padding. */
async function decryptCbcFile(key: Buffer, src: string, dest: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const size = (await fs.promises.stat(src)).size;
  if (size === 0) {
    await fs.promises.writeFile(dest, Buffer.alloc(0), { mode: 0o600 });
    return;
  }
  if (size % 16 !== 0) throw new Error("Encrypted file length is not a multiple of the AES block size");
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, Buffer.alloc(16, 0));
  // autoPadding (default) validates PKCS#7 on final() and throws on a bad pad.
  await pipeline(fs.createReadStream(src), decipher, fs.createWriteStream(dest, { mode: 0o600 }));
}

interface FileRecord {
  protectionClass: number;
  /** class(4) + wrapped key, or null for a folder / empty record */
  encryptionKey: Buffer | null;
}

/** Read the NSKeyedArchiver file record from Manifest.db (reference `FilePlist`). */
export function parseFileRecord(blob: Buffer): FileRecord {
  const archive = plist.parse(blob) as {
    $objects?: unknown[];
    $top?: { root?: { UID?: number } };
  };
  const objects = archive.$objects;
  const rootId = archive.$top?.root?.UID;
  if (!Array.isArray(objects) || typeof rootId !== "number") {
    throw new Error("File record is not a keyed archive");
  }
  const root = objects[rootId] as Record<string, unknown>;
  const protectionClass = root?.ProtectionClass;
  if (typeof protectionClass !== "number") throw new Error("File record has no ProtectionClass");
  const keyRef = root.EncryptionKey as { UID?: number } | undefined;
  if (!keyRef || typeof keyRef.UID !== "number") return { protectionClass, encryptionKey: null };
  const keyObj = objects[keyRef.UID] as { "NS.data"?: Buffer } | undefined;
  const data = keyObj?.["NS.data"];
  if (!Buffer.isBuffer(data)) throw new Error("File record EncryptionKey has no data");
  return { protectionClass, encryptionKey: data };
}

/**
 * Backup Decryption Service Class
 */
export class BackupDecryptionService {
  private static readonly SERVICE_NAME = "BackupDecryptionService";
  private readonly tmpRoot: () => string;

  constructor(deps: BackupDecryptionDeps = {}) {
    this.tmpRoot = deps.tmpRoot ?? (() => path.join(hostAppPaths.userData(), AT_REST_TMP_DIRNAME));
  }

  /** A fresh, empty parse-copy directory path (not yet created). */
  newParseCopyDir(): string {
    return path.join(this.tmpRoot(), `${IOS_PARSE_COPY_PREFIX}${crypto.randomUUID()}`);
  }

  /**
   * Decrypt what the sync reads — sms.db, AddressBook and every message attachment — into
   * a parse copy laid out like a backup. Returns the copy's path as `decryptedPath`.
   */
  async decryptBackup(
    backupPath: string,
    password: string,
    options: { outputDir?: string } = {},
  ): Promise<DecryptionResult & { stats?: DecryptStats }> {
    const outputPath = options.outputDir ?? this.newParseCopyDir();
    let unlocked: UnlockedBackup | null = null;
    try {
      await logService.info("Starting backup decryption", BackupDecryptionService.SERVICE_NAME);
      unlocked = await this.unlock(backupPath, password);
      await fs.promises.mkdir(outputPath, { recursive: true, mode: 0o700 });
      const manifestDbPath = path.join(outputPath, "Manifest.db");
      await this.decryptManifestDb(backupPath, unlocked, manifestDbPath);
      let stats: DecryptStats;
      try {
        stats = await this.decryptReadFiles(backupPath, manifestDbPath, unlocked, outputPath);
      } finally {
        await fs.promises.rm(manifestDbPath, { force: true });
      }
      await logService.info("Backup decryption completed", BackupDecryptionService.SERVICE_NAME, {
        decrypted: stats.decrypted,
        skipped: stats.skipped,
      });
      return { success: true, error: null, decryptedPath: outputPath, stats };
    } catch (error) {
      // Never leave a half-written parse copy behind.
      await this.cleanup(outputPath);
      const incorrect = error instanceof BackupPasswordIncorrectError;
      await logService.error("Decryption failed", BackupDecryptionService.SERVICE_NAME, {
        error: incorrect ? "Incorrect password" : error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        error: incorrect ? "Incorrect password" : error instanceof Error ? error.message : "Unknown decryption error",
        decryptedPath: null,
      };
    } finally {
      if (unlocked) for (const key of unlocked.classKeys.values()) key.fill(0);
    }
  }

  /** Check if a backup is encrypted (Manifest.plist IsEncrypted). */
  async isBackupEncrypted(backupPath: string): Promise<boolean> {
    try {
      const manifest = this.readManifest(path.join(backupPath, "Manifest.plist"));
      return manifest.IsEncrypted === true;
    } catch {
      return false;
    }
  }

  /** True when `password` unlocks this backup's keybag. Never throws. */
  async verifyPassword(backupPath: string, password: string): Promise<boolean> {
    try {
      const unlocked = await this.unlock(backupPath, password);
      for (const key of unlocked.classKeys.values()) key.fill(0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The full round trip: the password unlocks the keybag AND Manifest.db decrypts to a
   * SQLite database with file rows. Used before an older backup is deleted (S4). The
   * decrypted index is written to a parse-copy dir and removed before returning.
   */
  async verifyManifestRoundTrip(backupPath: string, password: string): Promise<boolean> {
    const dir = this.newParseCopyDir();
    let unlocked: UnlockedBackup | null = null;
    try {
      unlocked = await this.unlock(backupPath, password);
      await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
      const dbPath = path.join(dir, "Manifest.db");
      await this.decryptManifestDb(backupPath, unlocked, dbPath);
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db.prepare("SELECT COUNT(*) AS n FROM Files").get() as { n: number };
        return row.n > 0;
      } finally {
        db.close();
      }
    } catch {
      return false;
    } finally {
      if (unlocked) for (const key of unlocked.classKeys.values()) key.fill(0);
      await this.cleanup(dir);
    }
  }

  private readManifest(manifestPath: string): ManifestPlist {
    const parsed = plist.parse(fs.readFileSync(manifestPath)) as Record<string, unknown>;
    return {
      IsEncrypted: parsed.IsEncrypted as boolean,
      ManifestKey: parsed.ManifestKey as Buffer | undefined,
      BackupKeyBag: parsed.BackupKeyBag as Buffer | undefined,
      Lockdown: parsed.Lockdown as ManifestPlist["Lockdown"],
    };
  }

  /** Unlock the keybag. Throws BackupPasswordIncorrectError on a wrong password. */
  private async unlock(backupPath: string, password: string): Promise<UnlockedBackup> {
    const manifest = this.readManifest(path.join(backupPath, "Manifest.plist"));
    if (manifest.IsEncrypted !== true || !manifest.BackupKeyBag) {
      throw new Error("Backup is not encrypted");
    }
    const keybag = parseKeybag(manifest.BackupKeyBag);
    const dpsl = keybag.attrs.get("DPSL");
    const salt = keybag.attrs.get("SALT");
    if (!Buffer.isBuffer(dpsl) || !Buffer.isBuffer(salt)) throw new Error("BackupKeyBag has no salts");
    const dpic = boundedIterations(keybag.attrs.get("DPIC"), "DPIC", MAX_DPIC_ITERATIONS);
    const iter = boundedIterations(keybag.attrs.get("ITER"), "ITER", MAX_ITER_ITERATIONS);

    const round1 = await pbkdf2(password, dpsl, dpic, "sha256");
    const passphraseKey = await pbkdf2(round1, salt, iter, "sha1");
    round1.fill(0);

    const classKeys = new Map<number, Buffer>();
    try {
      for (const [clas, entry] of keybag.classes) {
        if ((entry.wrap & WRAP_PASSPHRASE) === 0) continue;
        const key = aesKeyUnwrap(passphraseKey, entry.wpky);
        if (!key) {
          for (const k of classKeys.values()) k.fill(0);
          throw new BackupPasswordIncorrectError();
        }
        classKeys.set(clas, key);
      }
    } finally {
      passphraseKey.fill(0);
    }
    if (classKeys.size === 0) throw new BackupPasswordIncorrectError();
    return { manifest, classKeys };
  }

  private unwrapFor(unlocked: UnlockedBackup, protectionClass: number, wrapped: Buffer): Buffer {
    const classKey = unlocked.classKeys.get(protectionClass);
    if (!classKey) throw new Error(`No class key for protection class ${protectionClass}`);
    if (wrapped.length !== 0x28) throw new Error("Invalid wrapped key length");
    const key = aesKeyUnwrap(classKey, wrapped);
    if (!key) throw new Error("A file key did not unwrap");
    return key;
  }

  private async decryptManifestDb(backupPath: string, unlocked: UnlockedBackup, dest: string): Promise<void> {
    const manifestKey = unlocked.manifest.ManifestKey;
    if (!Buffer.isBuffer(manifestKey) || manifestKey.length < 8) throw new Error("Manifest.plist has no ManifestKey");
    // The class prefix is little-endian (reference: struct.unpack('<l', ManifestKey[:4])).
    const key = this.unwrapFor(unlocked, manifestKey.readUInt32LE(0), manifestKey.subarray(4));
    try {
      await decryptCbcFile(key, path.join(backupPath, "Manifest.db"), dest);
    } finally {
      key.fill(0);
    }
  }

  private async decryptReadFiles(
    backupPath: string,
    manifestDbPath: string,
    unlocked: UnlockedBackup,
    outputPath: string,
  ): Promise<DecryptStats> {
    const db = new Database(manifestDbPath, { readonly: true });
    let rows: Array<{ fileID: string; domain: string; relativePath: string; file: Buffer }>;
    try {
      const attachmentClauses = ATTACHMENT_RELATIVE_ROOTS.map(() => "substr(relativePath, 1, ?) = ?").join(" OR ");
      const rootParams = ATTACHMENT_RELATIVE_ROOTS.flatMap((root) => [root.length, root]);
      rows = db
        .prepare(
          `SELECT fileID, domain, relativePath, file FROM Files
           WHERE flags = 1 AND (fileID IN (?, ?) OR (domain = 'MediaDomain' AND (${attachmentClauses})))`,
        )
        .all(SMS_DB_FILE_ID, ADDRESS_BOOK_FILE_ID, ...rootParams) as typeof rows;
    } finally {
      db.close();
    }

    const stats: DecryptStats = { decrypted: 0, skipped: 0 };
    const required = new Set([SMS_DB_FILE_ID]);
    for (const row of rows) {
      const fileId = String(row.fileID).toLowerCase();
      if (!FILE_ID_PATTERN.test(fileId)) {
        stats.skipped++;
        continue;
      }
      const src = path.join(backupPath, fileId.slice(0, 2), fileId);
      const dest = path.join(outputPath, fileId.slice(0, 2), fileId);
      try {
        const record = parseFileRecord(row.file);
        if (!record.encryptionKey) {
          stats.skipped++;
          continue;
        }
        const key = this.unwrapFor(unlocked, record.protectionClass, record.encryptionKey.subarray(4));
        try {
          await decryptCbcFile(key, src, dest);
        } finally {
          key.fill(0);
        }
        stats.decrypted++;
        required.delete(fileId);
      } catch (error) {
        if (fileId === SMS_DB_FILE_ID) throw error;
        await fs.promises.rm(dest, { force: true });
        stats.skipped++;
        await logService.warn("Could not decrypt a backup file", BackupDecryptionService.SERVICE_NAME, {
          fileId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (required.size > 0) throw new Error("The backup has no messages database");
    return stats;
  }

  /**
   * Remove a parse copy. Refuses (logs, deletes nothing) anything that is not a direct
   * `ios-*` child of the parse-copy root — this is the only recursive delete in the
   * service, and it must never reach a backup.
   */
  async cleanup(decryptedPath: string): Promise<boolean> {
    const root = path.resolve(this.tmpRoot());
    const target = path.resolve(decryptedPath);
    if (path.dirname(target) !== root || !path.basename(target).startsWith(IOS_PARSE_COPY_PREFIX)) {
      await logService.warn("Refused to remove a path outside the parse-copy area", BackupDecryptionService.SERVICE_NAME);
      return false;
    }
    try {
      const stats = await fs.promises.lstat(target);
      if (!stats.isDirectory()) return false;
      await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
      await logService.warn("Failed to clean up decrypted files", BackupDecryptionService.SERVICE_NAME, {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /** Remove every parse copy (launch, or before a new sync). Returns how many were removed. */
  async sweepParseCopies(): Promise<number> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(this.tmpRoot(), { withFileTypes: true });
    } catch {
      return 0;
    }
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(IOS_PARSE_COPY_PREFIX)) continue;
      if (await this.cleanup(path.join(this.tmpRoot(), entry.name))) removed++;
    }
    return removed;
  }
}

// Export singleton instance
export const backupDecryptionService = new BackupDecryptionService();
export default backupDecryptionService;
