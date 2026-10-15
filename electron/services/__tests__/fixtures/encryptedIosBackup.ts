/**
 * SYNTHETIC, ORACLE-VALIDATED encrypted iOS backup (BACKLOG-3817).
 *
 * No real encrypted backup exists on the development machine, so this builder writes one
 * from the published format. The format is transcribed from the reference decryptor
 * jsharkey13/iphone_backup_decrypt (PyPI `iphone_backup_decrypt` 0.11.2 —
 * `utils.py` BackupKeyBag / FilePlist / aes_decrypt_chunked, `iphone_backup.py`
 * _decrypt_manifest_db_file), which is known to read real iPhone backups:
 *
 *  - Manifest.plist (binary plist): IsEncrypted, BackupKeyBag (TLV), ManifestKey
 *    (class as LITTLE-endian u32 + RFC 3394-wrapped key).
 *  - Keybag TLV: global VERS/TYPE/UUID/HMCK/WRAP/SALT/ITER/DPWT/DPIC/DPSL, then one block
 *    per protection class starting with UUID: CLAS/WRAP/KTYP/WPKY. Class keys with WRAP & 2
 *    are wrapped by PBKDF2-SHA1(PBKDF2-SHA256(password, DPSL, DPIC), SALT, ITER).
 *  - Manifest.db: SQLite `Files(fileID, domain, relativePath, flags, file)` encrypted as a
 *    whole with AES-256-CBC, zero IV, PKCS#7.
 *  - Files.file: NSKeyedArchiver binary plist; `$objects[$top.root]` = MBFile with
 *    ProtectionClass, Size, and EncryptionKey → UID → { NS.data: class(4, LE) + wrapped key }.
 *  - Content: `<backup>/<fileID[0:2]>/<fileID>`, fileID = sha1("<domain>-<relativePath>"),
 *    AES-256-CBC zero IV PKCS#7 under the per-file key.
 *
 * VALIDATION: a backup written by this builder was decrypted by the Python reference
 * (test_decryption() + extract_file of sms.db and an attachment, byte-identical) before any
 * TypeScript result was counted — record in pm_comments on BACKLOG-3817. Real-device
 * verification is the founder test (Finder "Encrypt local backup", then a Keepr sync).
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const bplistCreator = require("bplist-creator") as (value: unknown) => Buffer;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require("better-sqlite3-multiple-ciphers");

export interface FixtureFile {
  domain: string;
  relativePath: string;
  content: Buffer;
  protectionClass?: number;
}

export interface EncryptedBackupFixture {
  backupDir: string;
  password: string;
  /** fileID → plaintext */
  plaintext: Map<string, Buffer>;
}

export function fileIdFor(domain: string, relativePath: string): string {
  return crypto.createHash("sha1").update(`${domain}-${relativePath}`).digest("hex");
}

/** RFC 3394 AES key wrap (independent of the unwrap under test). */
export function aesKeyWrap(kek: Buffer, key: Buffer): Buffer {
  const n = key.length / 8;
  let a = Buffer.alloc(8, 0xa6);
  const r: Buffer[] = [];
  for (let i = 0; i < n; i++) r.push(Buffer.from(key.subarray(i * 8, i * 8 + 8)));
  for (let j = 0; j <= 5; j++) {
    for (let i = 1; i <= n; i++) {
      const cipher = crypto.createCipheriv(`aes-${kek.length * 8}-ecb`, kek, null);
      cipher.setAutoPadding(false);
      const b = Buffer.concat([cipher.update(Buffer.concat([a, r[i - 1]])), cipher.final()]);
      const t = Buffer.alloc(8);
      t.writeBigUInt64BE(BigInt(n * j + i), 0);
      a = Buffer.from(b.subarray(0, 8));
      for (let k = 0; k < 8; k++) a[k] ^= t[k];
      r[i - 1] = Buffer.from(b.subarray(8, 16));
    }
  }
  return Buffer.concat([a, ...r]);
}

function cbcEncrypt(key: Buffer, data: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-256-cbc", key, Buffer.alloc(16, 0));
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

function tlv(tag: string, value: Buffer | number): Buffer {
  const data = typeof value === "number" ? Buffer.alloc(4) : value;
  if (typeof value === "number") data.writeUInt32BE(value, 0);
  const head = Buffer.alloc(8);
  head.write(tag, 0, 4, "latin1");
  head.writeUInt32BE(data.length, 4);
  return Buffer.concat([head, data]);
}

function classPrefixLE(clas: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(clas, 0);
  return b;
}

function fileRecord(protectionClass: number, size: number, wrappedWithClass: Buffer): Buffer {
  return bplistCreator({
    $version: 100000,
    $archiver: "NSKeyedArchiver",
    $top: { root: { UID: 1 } },
    $objects: [
      "$null",
      {
        $class: { UID: 3 },
        ProtectionClass: protectionClass,
        Size: size,
        Mode: 33188,
        Flags: 0,
        InodeNumber: 1234,
        UserID: 501,
        GroupID: 501,
        LastModified: 1700000000,
        LastStatusChange: 1700000000,
        Birth: 1700000000,
        EncryptionKey: { UID: 2 },
      },
      { "NS.data": wrappedWithClass, $class: { UID: 4 } },
      { $classname: "MBFile", $classes: ["MBFile", "NSObject"] },
      { $classname: "NSMutableData", $classes: ["NSMutableData", "NSData", "NSObject"] },
    ],
  });
}

export function buildEncryptedBackup(options: {
  backupDir: string;
  password: string;
  files: FixtureFile[];
  /** Real backups use ~10,000,000; kept small so the suite stays fast. */
  dpic?: number;
  iter?: number;
}): EncryptedBackupFixture {
  const { backupDir, password, files } = options;
  const dpic = options.dpic ?? 1000;
  const iter = options.iter ?? 10;
  fs.mkdirSync(backupDir, { recursive: true });

  const dpsl = crypto.randomBytes(20);
  const salt = crypto.randomBytes(20);
  const passphraseKey = crypto.pbkdf2Sync(crypto.pbkdf2Sync(password, dpsl, dpic, 32, "sha256"), salt, iter, 32, "sha1");

  // Passphrase-wrapped classes, plus one device-wrapped class (WRAP=1) whose WPKY is not
  // wrapped by the passphrase key — a decryptor must skip it, as the reference does.
  const classKeys = new Map<number, Buffer>();
  const blocks: Buffer[] = [
    tlv("VERS", 3),
    tlv("TYPE", 1),
    tlv("UUID", crypto.randomBytes(16)),
    tlv("HMCK", crypto.randomBytes(40)),
    tlv("WRAP", 2),
    tlv("SALT", salt),
    tlv("ITER", iter),
    tlv("DPWT", 1),
    tlv("DPIC", dpic),
    tlv("DPSL", dpsl),
  ];
  for (const clas of [1, 2, 3, 4, 6, 7, 8, 9, 10, 11]) {
    const key = crypto.randomBytes(32);
    classKeys.set(clas, key);
    blocks.push(tlv("UUID", crypto.randomBytes(16)), tlv("CLAS", clas), tlv("WRAP", 2), tlv("KTYP", 0));
    blocks.push(tlv("WPKY", aesKeyWrap(passphraseKey, key)));
  }
  blocks.push(tlv("UUID", crypto.randomBytes(16)), tlv("CLAS", 5), tlv("WRAP", 1), tlv("KTYP", 0));
  blocks.push(tlv("WPKY", crypto.randomBytes(40)));
  const keybag = Buffer.concat(blocks);

  // Plain Manifest.db, then encrypted in place.
  const plainDbPath = path.join(backupDir, "Manifest.db.plain");
  const db = new Database(plainDbPath);
  db.exec(`CREATE TABLE Files (fileID TEXT PRIMARY KEY, domain TEXT, relativePath TEXT, flags INTEGER, file BLOB);
           CREATE INDEX FilesDomainIdx ON Files(domain);
           CREATE INDEX FilesRelativePathIdx ON Files(relativePath);
           CREATE INDEX FilesFlagsIdx ON Files(flags);
           CREATE TABLE Properties (key TEXT PRIMARY KEY, value BLOB);`);
  const insert = db.prepare("INSERT INTO Files VALUES (?, ?, ?, ?, ?)");
  const plaintext = new Map<string, Buffer>();
  for (const file of files) {
    const fileId = fileIdFor(file.domain, file.relativePath);
    const protectionClass = file.protectionClass ?? 3;
    const fileKey = crypto.randomBytes(32);
    const wrapped = Buffer.concat([classPrefixLE(protectionClass), aesKeyWrap(classKeys.get(protectionClass)!, fileKey)]);
    insert.run(fileId, file.domain, file.relativePath, 1, fileRecord(protectionClass, file.content.length, wrapped));
    fs.mkdirSync(path.join(backupDir, fileId.slice(0, 2)), { recursive: true });
    fs.writeFileSync(path.join(backupDir, fileId.slice(0, 2), fileId), cbcEncrypt(fileKey, file.content));
    plaintext.set(fileId, file.content);
  }
  // A directory row (flags = 2) — never a file to decrypt.
  insert.run(fileIdFor("MediaDomain", "Library/SMS/Attachments"), "MediaDomain", "Library/SMS/Attachments", 2, bplistCreator({
    $version: 100000,
    $archiver: "NSKeyedArchiver",
    $top: { root: { UID: 1 } },
    $objects: ["$null", { $class: { UID: 2 }, ProtectionClass: 0, Mode: 16877, Size: 0 }, { $classname: "MBFile", $classes: ["MBFile", "NSObject"] }],
  }));
  db.close();

  const manifestKeyClass = 4;
  const manifestDbKey = crypto.randomBytes(32);
  fs.writeFileSync(path.join(backupDir, "Manifest.db"), cbcEncrypt(manifestDbKey, fs.readFileSync(plainDbPath)));
  fs.rmSync(plainDbPath);
  const manifestKey = Buffer.concat([classPrefixLE(manifestKeyClass), aesKeyWrap(classKeys.get(manifestKeyClass)!, manifestDbKey)]);

  fs.writeFileSync(
    path.join(backupDir, "Manifest.plist"),
    bplistCreator({
      BackupKeyBag: keybag,
      Version: "10.0",
      Date: "2026-10-08T00:00:00Z",
      SystemDomainsVersion: "24.0",
      ManifestKey: manifestKey,
      WasPasscodeSet: true,
      Lockdown: { ProductVersion: "18.0", DeviceName: "Fixture iPhone", UniqueDeviceID: "00008110-0000000000000000" },
      IsEncrypted: true,
    }),
  );
  return { backupDir, password, plaintext };
}
