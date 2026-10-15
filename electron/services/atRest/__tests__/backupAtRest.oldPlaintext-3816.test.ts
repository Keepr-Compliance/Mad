/**
 * @jest-environment node
 */
/**
 * BACKLOG-3816 — defence in depth for the skipped verification walk: when the sync's parse
 * copy reads a PLAINTEXT file whose mtime is older than the sync's unseal time (not this
 * sync's delta, not an index file Keepr unsealed), the sync's end walks the whole chain.
 *
 * Real fileCrypto, real files in a temp Backups root, real SQLite Manifest.db (run under
 * Electron's node for the sqlite driver).
 */
const actualModulePath = require.resolve("better-sqlite3-multiple-ciphers", {
  paths: [require("path").join(__dirname, "../../../../node_modules")],
});
jest.mock("better-sqlite3-multiple-ciphers", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(actualModulePath);
});
jest.mock("../../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import plist from "simple-plist";

import { ADDRESS_BOOK_FILE_ID, SMS_DB_FILE_ID } from "../../backupDecryptionService";
import { BackupAtRest } from "../backupAtRest";
import { createFileCrypto, MAGIC, type KeyResolver } from "../fileCrypto";
import { createMarkerStore } from "../markers";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(actualModulePath);

const KEY = crypto.randomBytes(32);
const KEY_ID = crypto.createHash("sha256").update(KEY).digest("hex").slice(0, 32);
const resolver: KeyResolver = { currentKey: async () => ({ keyId: KEY_ID, key: KEY }), keyFor: async () => KEY };
const files = createFileCrypto(resolver, { chunkSize: 64 });

const UDID = "00008110-000A1B2C3D4E5F60";
const VERSION = "2.40.0";
const ATTACHMENT_ID = crypto.createHash("sha1").update("MediaDomain-Library/SMS/Attachments/ab/01/IMG_1.jpg").digest("hex");
/** In no Manifest.db row: the parse copy never reads it; only a walk reaches it. */
const BYSTANDER = `7f/${"7".repeat(40)}`;

let userData: string;
let backups: string;
let chain: string;
type Logged = { level: string; message: string; data?: Record<string, unknown> };

const markers = () => createMarkerStore({ userData: () => userData });
function service(logged: Logged[]): BackupAtRest {
  return new BackupAtRest({
    backupsRoot: () => backups,
    files: () => files,
    markers,
    ensureKey: async () => undefined,
    freeBytes: async () => Number.MAX_SAFE_INTEGER,
    sleep: async () => undefined,
    log: (level, message, data) => logged.push({ level, message, data }),
    concurrency: 4,
    chunkSize: 64,
    appVersion: () => VERSION,
  });
}
function write(rel: string, data: Buffer | string): string {
  const p = path.join(chain, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  return p;
}
const isSealed = (f: string) => fs.readFileSync(f).subarray(0, MAGIC.length).equals(Buffer.from(MAGIC));
const attachment = () => path.join(chain, ATTACHMENT_ID.slice(0, 2), ATTACHMENT_ID);

function makeChain(): void {
  fs.mkdirSync(chain, { recursive: true });
  write("Info.plist", plist.stringify({ "Device Name": "Test" }));
  write("Status.plist", plist.stringify({ SnapshotState: "finished", IsFullBackup: false }));
  write("Manifest.plist", plist.stringify({ IsEncrypted: false }));
  const db = new Database(path.join(chain, "Manifest.db"));
  db.exec("CREATE TABLE Files (fileID TEXT PRIMARY KEY, domain TEXT, relativePath TEXT, flags INTEGER, file BLOB)");
  const ins = db.prepare("INSERT INTO Files VALUES (?, ?, ?, 1, ?)");
  ins.run(SMS_DB_FILE_ID, "HomeDomain", "Library/SMS/sms.db", Buffer.alloc(0));
  ins.run(ADDRESS_BOOK_FILE_ID, "HomeDomain", "Library/AddressBook/AddressBook.sqlitedb", Buffer.alloc(0));
  ins.run(ATTACHMENT_ID, "MediaDomain", "Library/SMS/Attachments/ab/01/IMG_1.jpg", Buffer.alloc(0));
  db.close();
  write(`${SMS_DB_FILE_ID.slice(0, 2)}/${SMS_DB_FILE_ID}`, "sms database bytes ".repeat(20));
  write(`${ADDRESS_BOOK_FILE_ID.slice(0, 2)}/${ADDRESS_BOOK_FILE_ID}`, "address book ".repeat(9));
  write(`${ATTACHMENT_ID.slice(0, 2)}/${ATTACHMENT_ID}`, crypto.randomBytes(300));
}
function ageOne(f: string, hours = 2): void {
  const old = new Date(Date.now() - hours * 3600_000);
  fs.utimesSync(f, old, old);
}

/** A chain proven sealed by a full walk, then a plaintext bystander with an old mtime planted. */
async function provenChain(s: BackupAtRest): Promise<string> {
  makeChain();
  expect(await s.migrate(UDID)).toBe("encrypted");
  expect((await markers().readBackupMarker(UDID))?.verifiedBy).toBe(VERSION);
  const bystander = write(BYSTANDER, "plaintext with an old mtime: only the walk reaches it");
  const all: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk(path.join(d, e.name)) : all.push(path.join(d, e.name)));
  };
  walk(chain);
  all.forEach((f) => ageOne(f));
  return bystander;
}

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-oldplain-"));
  backups = path.join(userData, "Backups");
  chain = path.join(backups, UDID);
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(userData, { recursive: true, force: true });
});

describe("the parse copy reads a plaintext file older than the sync", () => {
  it("an old-mtime plaintext file read by the parse copy forces the full walk at the sync's end, which seals it; logged once with a count and no path", async () => {
    const logged: Logged[] = [];
    const s = service(logged);
    const bystander = await provenChain(s);
    // The attachment is plaintext with an old mtime (nothing this sync wrote).
    fs.writeFileSync(attachment(), "old plaintext attachment");
    ageOne(attachment());

    const session = await s.beginSync(UDID, { strategy: "delta" });
    const copy = await s.buildParseCopy(UDID, path.join(userData, "at-rest-tmp", "ios-1"));
    expect(copy.copied).toBeGreaterThanOrEqual(3);
    await s.finishSync(session, undefined, { toolOk: true, cleanEnd: true });

    expect(isSealed(attachment())).toBe(true);
    expect(isSealed(path.join(chain, BYSTANDER))).toBe(true); // the walk ran
    expect(isSealed(bystander)).toBe(true);
    const lines = logged.filter((l) => l.data?.reasonCode === "OLD_PLAINTEXT_SEEN");
    expect(lines).toHaveLength(1);
    expect(lines[0].data).toMatchObject({ count: 1 });
    expect(JSON.stringify(logged)).not.toContain(ATTACHMENT_ID);
    expect(await markers().readBackupMarker(UDID)).toMatchObject({ state: "encrypted", verifiedBy: VERSION });
  });

  it("a plaintext file written by this sync (fresh mtime) is delta: no walk, the old bystander stays plaintext", async () => {
    const logged: Logged[] = [];
    const s = service(logged);
    const bystander = await provenChain(s);

    const session = await s.beginSync(UDID, { strategy: "delta" });
    fs.writeFileSync(attachment(), "attachment the tool wrote during this sync"); // fresh mtime
    await s.buildParseCopy(UDID, path.join(userData, "at-rest-tmp", "ios-2"));
    await s.finishSync(session, undefined, { toolOk: true, cleanEnd: true });

    expect(isSealed(attachment())).toBe(true); // sealed as part of the delta
    expect(isSealed(bystander)).toBe(false); // the walk did not run
    expect(logged.some((l) => l.data?.reasonCode === "OLD_PLAINTEXT_SEEN")).toBe(false);
  });

  it("the signal is per sync: a later clean sync with nothing old skips the walk again", async () => {
    const s = service([]);
    const bystander = await provenChain(s);
    fs.writeFileSync(attachment(), "old plaintext attachment");
    ageOne(attachment());
    const first = await s.beginSync(UDID, { strategy: "delta" });
    await s.buildParseCopy(UDID, path.join(userData, "at-rest-tmp", "ios-3"));
    await s.finishSync(first, undefined, { toolOk: true, cleanEnd: true });
    expect(isSealed(bystander)).toBe(true);

    const planted2 = write(`6e/${"6".repeat(40)}`, "another old plaintext bystander");
    ageOne(planted2);
    const second = await s.beginSync(UDID, { strategy: "delta" });
    await s.buildParseCopy(UDID, path.join(userData, "at-rest-tmp", "ios-4"));
    await s.finishSync(second, undefined, { toolOk: true, cleanEnd: true });
    expect(isSealed(planted2)).toBe(false);
  });
});
