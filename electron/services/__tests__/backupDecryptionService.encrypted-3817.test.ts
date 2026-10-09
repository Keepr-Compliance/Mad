/**
 * BACKLOG-3817: an ENCRYPTED iPhone backup syncs end to end — messages, contacts and
 * attachments — on the real SQLite driver.
 *
 * Fixture: SYNTHETIC, ORACLE-VALIDATED (see fixtures/encryptedIosBackup.ts). Run under
 * Electron's node for the real driver:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js <this file> --bail=0
 */
const actualModulePath = require.resolve("better-sqlite3-multiple-ciphers", {
  paths: [require("path").join(__dirname, "../../../node_modules")],
});
jest.mock("better-sqlite3-multiple-ciphers", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(actualModulePath);
});
jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(actualModulePath);
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import {
  BackupDecryptionService,
  SMS_DB_FILE_ID,
  ADDRESS_BOOK_FILE_ID,
  ATTACHMENT_RELATIVE_ROOTS,
} from "../backupDecryptionService";
import { iOSMessagesParser } from "../iosMessagesParser";
import { iOSContactsParser } from "../iosContactsParser";
import { createTestDatabase, getAllAttachments } from "./fixtures/fake-ios-backup";
import { buildEncryptedBackup, fileIdFor, type FixtureFile } from "./fixtures/encryptedIosBackup";

const PASSWORD = "correct horse battery staple";

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

function buildPlainSources(work: string): FixtureFile[] {
  const smsPath = path.join(work, "sms.db");
  const sms = createTestDatabase({ filePath: smsPath }).db;
  // The shared fixture predates two columns the parser's message query selects
  // (iosMessagesParser.test.ts declares them); add them so the query runs.
  sms.exec("ALTER TABLE message ADD COLUMN attributedBody BLOB; ALTER TABLE message ADD COLUMN audio_transcript TEXT;");
  sms.close();

  const abPath = path.join(work, "AddressBook.sqlitedb");
  const ab = new Database(abPath);
  ab.exec(`
    CREATE TABLE ABPerson (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, first TEXT, last TEXT, middle TEXT,
      organization TEXT, note TEXT, guid TEXT);
    CREATE TABLE ABMultiValue (UID INTEGER PRIMARY KEY, record_id INTEGER, property INTEGER, identifier INTEGER,
      label INTEGER, value TEXT);
    CREATE TABLE ABMultiValueLabel (ROWID INTEGER PRIMARY KEY, value TEXT);
    INSERT INTO ABPerson (ROWID, first, last) VALUES (1, 'Ada', 'Lovelace');
    INSERT INTO ABMultiValue (UID, record_id, property, identifier, label, value) VALUES (1, 1, 3, 0, NULL, '555-555-0104');
  `);
  ab.close();

  const files: FixtureFile[] = [
    { domain: "HomeDomain", relativePath: "Library/SMS/sms.db", content: fs.readFileSync(smsPath) },
    { domain: "HomeDomain", relativePath: "Library/AddressBook/AddressBook.sqlitedb", content: fs.readFileSync(abPath) },
    // Not read by the sync — must not be decrypted.
    { domain: "HomeDomain", relativePath: "Library/Notes/notes.sqlite", content: Buffer.from("not for keepr") },
  ];
  for (const attachment of getAllAttachments()) {
    const relativePath = attachment.filename.replace(/^~\//, "");
    files.push({
      domain: "MediaDomain",
      relativePath,
      // Spans several AES blocks and is not block-aligned.
      content: crypto.randomBytes(5000 + attachment.id * 37),
      protectionClass: attachment.id % 2 === 0 ? 2 : 3,
    });
  }
  return files;
}

describe("BACKLOG-3817 encrypted backup → parse copy", () => {
  let work: string;
  let backupDir: string;
  let tmpRoot: string;
  let service: BackupDecryptionService;
  let plaintext: Map<string, Buffer>;
  let backupFilesBefore: string[];

  beforeAll(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-3817-"));
    backupDir = path.join(work, "Backups", "00008110-0000000000000000");
    tmpRoot = path.join(work, "userData", "at-rest-tmp");
    plaintext = buildEncryptedBackup({ backupDir, password: PASSWORD, files: buildPlainSources(work) }).plaintext;
    backupFilesBefore = listFiles(backupDir);
  });
  afterAll(() => fs.rmSync(work, { recursive: true, force: true }));
  beforeEach(() => {
    service = new BackupDecryptionService({ tmpRoot: () => tmpRoot });
  });

  it("decrypts sms.db, AddressBook and every attachment into a hashed-layout parse copy", async () => {
    const result = await service.decryptBackup(backupDir, PASSWORD);
    expect(result.success).toBe(true);
    const copy = result.decryptedPath!;
    try {
      expect(path.dirname(copy)).toBe(tmpRoot);
      const attachmentIds = getAllAttachments().map((a) => fileIdFor("MediaDomain", a.filename.replace(/^~\//, "")));
      const expected = [SMS_DB_FILE_ID, ADDRESS_BOOK_FILE_ID, ...attachmentIds].map((id) => path.join(id.slice(0, 2), id)).sort();
      // Exactly those files: no Notes, no decrypted Manifest.db left behind.
      expect(listFiles(copy)).toEqual(expected);
      for (const id of [SMS_DB_FILE_ID, ADDRESS_BOOK_FILE_ID, ...attachmentIds]) {
        expect(fs.readFileSync(path.join(copy, id.slice(0, 2), id)).equals(plaintext.get(id)!)).toBe(true);
      }
      expect(result.stats).toEqual({ decrypted: expected.length, skipped: 0 });
      // Nothing decrypted was written inside the backup.
      expect(listFiles(backupDir)).toEqual(backupFilesBefore);
    } finally {
      await service.cleanup(copy);
    }
  });

  it("the parsers read messages, contacts and attachment paths from the parse copy", async () => {
    const result = await service.decryptBackup(backupDir, PASSWORD);
    const copy = result.decryptedPath!;
    const messages = new iOSMessagesParser();
    const contacts = new iOSContactsParser();
    try {
      messages.open(copy);
      const conversations = await messages.getConversationsAsync();
      expect(conversations.length).toBeGreaterThan(0);
      let messageCount = 0;
      for (const c of conversations) messageCount += (await messages.getMessagesAsync(c.chatId)).length;
      expect(messageCount).toBeGreaterThan(0);

      await contacts.open(copy);
      const people = contacts.getAllContacts();
      expect(people.map((p) => p.firstName)).toContain("Ada");

      for (const attachment of getAllAttachments()) {
        const resolved = iOSMessagesParser.resolveAttachmentPath(copy, attachment.filename);
        expect(resolved).not.toBeNull();
        const id = fileIdFor("MediaDomain", attachment.filename.replace(/^~\//, ""));
        expect(fs.readFileSync(resolved!).equals(plaintext.get(id)!)).toBe(true);
      }
    } finally {
      messages.close();
      contacts.close();
      await service.cleanup(copy);
    }
  });

  it("a wrong password is reported as incorrect and leaves no parse copy", async () => {
    const result = await service.decryptBackup(backupDir, "wrong password");
    expect(result).toEqual({ success: false, error: "Incorrect password", decryptedPath: null });
    expect(fs.existsSync(tmpRoot) ? fs.readdirSync(tmpRoot) : []).toEqual([]);
    expect(await service.verifyPassword(backupDir, "wrong password")).toBe(false);
    expect(await service.verifyPassword(backupDir, PASSWORD)).toBe(true);
  });

  it("verifyManifestRoundTrip opens Manifest.db with the right password only, and cleans up", async () => {
    expect(await service.verifyManifestRoundTrip(backupDir, PASSWORD)).toBe(true);
    expect(await service.verifyManifestRoundTrip(backupDir, "nope")).toBe(false);
    expect(fs.readdirSync(tmpRoot)).toEqual([]);
  });

  it("cleanup never removes anything outside the parse-copy area (the backup survives)", async () => {
    expect(await service.cleanup(backupDir)).toBe(false);
    expect(await service.cleanup(tmpRoot)).toBe(false);
    expect(await service.cleanup(path.join(tmpRoot, "..", "Backups"))).toBe(false);
    fs.mkdirSync(path.join(tmpRoot, "not-ours"), { recursive: true });
    expect(await service.cleanup(path.join(tmpRoot, "not-ours"))).toBe(false);
    expect(listFiles(backupDir)).toEqual(backupFilesBefore);
    expect(fs.existsSync(path.join(tmpRoot, "not-ours"))).toBe(true);
    fs.rmSync(path.join(tmpRoot, "not-ours"), { recursive: true });
  });

  it("decrypts exactly the attachment roots the messages parser resolves (parity)", () => {
    // A root added to the parser but not here would resolve to a file never decrypted.
    expect([...ATTACHMENT_RELATIVE_ROOTS]).toEqual([
      ...(iOSMessagesParser as unknown as { ATTACHMENT_ROOTS: readonly string[] }).ATTACHMENT_ROOTS,
    ]);
  });

  it("isBackupEncrypted reads Manifest.plist; missing or plaintext backups are not encrypted", async () => {
    expect(await service.isBackupEncrypted(backupDir)).toBe(true);
    expect(await service.isBackupEncrypted(path.join(work, "nowhere"))).toBe(false);
    const plain = path.join(work, "plain-backup");
    fs.mkdirSync(plain, { recursive: true });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    fs.writeFileSync(path.join(plain, "Manifest.plist"), require("bplist-creator")({ IsEncrypted: false }));
    expect(await service.isBackupEncrypted(plain)).toBe(false);
    const result = await service.decryptBackup(plain, PASSWORD);
    expect(result.success).toBe(false);
    expect(result.error).toBe("Backup is not encrypted");
  });

  it("sweepParseCopies removes leftover ios-* copies and nothing else", async () => {
    fs.mkdirSync(path.join(tmpRoot, "ios-leftover", "3d"), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, "ios-leftover", "3d", "x"), "plain");
    fs.mkdirSync(path.join(tmpRoot, "open"), { recursive: true });
    expect(await service.sweepParseCopies()).toBe(1);
    expect(fs.readdirSync(tmpRoot)).toEqual(["open"]);
    fs.rmSync(path.join(tmpRoot, "open"), { recursive: true });
  });
});
