/**
 * @jest-environment node
 */
/**
 * BACKLOG-3892 S5 — reading the kept iPhone backup with no sync (the "Get older texts"
 * backfill): BackupAtRest.beginRead / endRead and buildParseCopy's `only` and `stop`.
 *
 * Harness copied from backupAtRest.test.ts: real fileCrypto, real files in a temp
 * Backups root, real SQLite Manifest.db (run under Electron's node for the driver).
 */
// The real driver (the jest config maps the module to a mock).
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
import { BACKUP_READ_STOPPED, BackupAtRest, BackupAtRestRefusal, readMarkerAt } from "../backupAtRest";
import { createFileCrypto, MAGIC, type KeyResolver } from "../fileCrypto";
import { createMarkerStore, MARKER_DIR_NAME } from "../markers";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(actualModulePath);

const KEY = crypto.randomBytes(32);
const KEY_ID = crypto.createHash("sha256").update(KEY).digest("hex").slice(0, 32);
const resolver: KeyResolver = {
  currentKey: async () => ({ keyId: KEY_ID, key: KEY }),
  keyFor: async () => KEY,
};
const files = createFileCrypto(resolver, { chunkSize: 64 });

const UDID = "00008110-000A1B2C3D4E5F60";
const ATTACHMENT_ID = crypto.createHash("sha1").update("MediaDomain-Library/SMS/Attachments/ab/01/IMG_1.jpg").digest("hex");
const OTHER_ID = "aa" + "1".repeat(38);

let userData: string;
let backups: string;
let chain: string;

/**
 * BACKLOG-3915: the progress tests below seal 300+ files each, and on a loaded
 * Windows runner the per-file data fsync took them past the 30 s timeout. Their
 * claims are about progress units, ticks and the banner, not durability, so they
 * run with the data fsync off. Every other test keeps it.
 */
let dataFsync = true;

function service(overrides: Partial<ConstructorParameters<typeof BackupAtRest>[0]> = {}): BackupAtRest {
  return new BackupAtRest({
    backupsRoot: () => backups,
    files: () => files,
    markers: () => createMarkerStore({ userData: () => userData }),
    ensureKey: async () => undefined,
    freeBytes: async () => Number.MAX_SAFE_INTEGER,
    sleep: async () => undefined,
    log: () => undefined,
    concurrency: 4,
    chunkSize: 64, // same as `files`: multi-chunk containers
    sealEngineOptions: dataFsync ? undefined : { skipDataFsyncForMeasurement: true },
    ...overrides,
  });
}

function write(rel: string, data: Buffer | string): string {
  const p = path.join(chain, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  return p;
}

/** A plaintext chain shaped like idevicebackup2 output (transcribed layout: root plists + Manifest.db + XX/<fileID>). */
function makeChain(opts: { appleEncrypted?: boolean } = {}): void {
  fs.mkdirSync(chain, { recursive: true });
  write("Info.plist", plist.stringify({ "Device Name": "Test" }));
  write("Status.plist", plist.stringify({ SnapshotState: "finished", IsFullBackup: false }));
  write("Manifest.plist", plist.stringify({ IsEncrypted: !!opts.appleEncrypted }));
  const db = new Database(path.join(chain, "Manifest.db"));
  db.exec("CREATE TABLE Files (fileID TEXT PRIMARY KEY, domain TEXT, relativePath TEXT, flags INTEGER, file BLOB)");
  const ins = db.prepare("INSERT INTO Files VALUES (?, ?, ?, 1, ?)");
  ins.run(SMS_DB_FILE_ID, "HomeDomain", "Library/SMS/sms.db", Buffer.alloc(0));
  ins.run(ADDRESS_BOOK_FILE_ID, "HomeDomain", "Library/AddressBook/AddressBook.sqlitedb", Buffer.alloc(0));
  ins.run(ATTACHMENT_ID, "MediaDomain", "Library/SMS/Attachments/ab/01/IMG_1.jpg", Buffer.alloc(0));
  ins.run(OTHER_ID, "AppDomain-x", "Documents/other", Buffer.alloc(0));
  db.close();
  write(`${SMS_DB_FILE_ID.slice(0, 2)}/${SMS_DB_FILE_ID}`, "sms database bytes ".repeat(20));
  write(`${ADDRESS_BOOK_FILE_ID.slice(0, 2)}/${ADDRESS_BOOK_FILE_ID}`, "address book ".repeat(9));
  write(`${ATTACHMENT_ID.slice(0, 2)}/${ATTACHMENT_ID}`, crypto.randomBytes(300));
  write(`${OTHER_ID.slice(0, 2)}/${OTHER_ID}`, "other app data");
  write("ff/" + "f".repeat(40), Buffer.alloc(0)); // empty file, as 93/200 sampled on the founder's PC
}

function allContentFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string, _root: boolean) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f, false);
      else out.push(f); // root plists included: sealed too (founder QA 2026-10-09)
    }
  };
  walk(chain, true);
  return out;
}

function headerOf(file: string): Buffer {
  const fd = fs.openSync(file, "r");
  try {
    const b = Buffer.alloc(7);
    fs.readSync(fd, b, 0, 7, 0);
    return b;
  } finally {
    fs.closeSync(fd);
  }
}

/** Files that hold bytes and do NOT start with the KEPRENC magic. */
function plaintextLeft(): string[] {
  return allContentFiles().filter((f) => fs.statSync(f).size > 0 && !headerOf(f).equals(MAGIC));
}

/** Same, for any chain-shaped directory (root plists excluded). */
function plaintextIn(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, _root: boolean) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f, false);
      else out.push(f); // root plists included: sealed too (founder QA 2026-10-09)
    }
  };
  walk(dir, true);
  return out.filter((f) => fs.statSync(f).size > 0 && !headerOf(f).equals(MAGIC));
}

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-s4c-"));
  backups = path.join(userData, "Backups");
  chain = path.join(backups, UDID);
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(userData, { recursive: true, force: true });
});


/** sha256 of every file in the chain, by path (the bytes a read must never change). */
function chainDigest(): Record<string, string> {
  return Object.fromEntries(
    allContentFiles().map((f) => [f, crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex")]),
  );
}

const copyDir = (name: string): string => path.join(userData, "at-rest-tmp", `ios-${name}`);
const at = (dir: string, id: string): string => path.join(dir, id.slice(0, 2), id);

describe("BACKLOG-3892 S5: beginRead / buildParseCopy(only, stop)", () => {
  it("B2: a read copies only what it asks for; chain bytes, marker and plaintext state are unchanged", async () => {
    makeChain();
    const smsBytes = fs.readFileSync(at(chain, SMS_DB_FILE_ID));
    const s = service();
    await s.migrate(UDID);
    expect(plaintextLeft()).toEqual([]);
    const before = chainDigest();
    const marker = await readMarkerAt(backups, UDID);
    const start = await s.beginRead(UDID);
    if (!start.ok) throw new Error(`refused: ${start.reason}`);
    expect(s.busyReason(UDID)).toBe("reading");
    const out = copyDir("b2");
    const r = await s.buildParseCopy(UDID, out, { only: new Set([SMS_DB_FILE_ID]), stop: start.session.stop });
    expect(r).toEqual({ copied: 1, missing: 0, unreadable: 0 });
    expect(fs.readFileSync(at(out, SMS_DB_FILE_ID)).equals(smsBytes)).toBe(true);
    expect(fs.existsSync(at(out, ADDRESS_BOOK_FILE_ID))).toBe(false);
    expect(fs.existsSync(at(out, ATTACHMENT_ID))).toBe(false);
    expect(fs.existsSync(path.join(out, "Manifest.db"))).toBe(false);
    // Phase 2: only the attachment.
    await s.buildParseCopy(UDID, out, { only: new Set([ATTACHMENT_ID]), stop: start.session.stop });
    expect(fs.existsSync(at(out, ATTACHMENT_ID))).toBe(true);
    expect(fs.existsSync(at(out, ADDRESS_BOOK_FILE_ID))).toBe(false);
    s.endRead(start.session);
    expect(s.busyReason(UDID)).toBeNull();
    expect(chainDigest()).toEqual(before);
    expect(await readMarkerAt(backups, UDID)).toBe(marker);
    expect(plaintextLeft()).toEqual([]);
    expect(plaintextIn(chain)).toEqual([]);
  });

  it("refusals: busy (a seal/sync holds the phone, or another read), missing, apple-encrypted, key-unavailable; each releases", async () => {
    const s = service();
    expect(await s.beginRead(UDID)).toEqual({ ok: false, reason: "missing" });
    expect(s.busyReason(UDID)).toBeNull();
    makeChain();
    await s.migrate(UDID);
    const sync = await s.beginSync(UDID, { strategy: "delta" });
    expect(await s.beginRead(UDID)).toEqual({ ok: false, reason: "busy" });
    expect(s.busyReason(UDID)).toBe("syncing");
    await s.finishSync(sync);
    const first = await s.beginRead(UDID);
    expect(first.ok).toBe(true);
    expect(await s.beginRead(UDID)).toEqual({ ok: false, reason: "busy" });
    if (first.ok) s.endRead(first.session);
    const noKey = service({ ensureKey: async () => { throw new Error("no key"); } });
    expect(await noKey.beginRead(UDID)).toEqual({ ok: false, reason: "key-unavailable" });
    expect(noKey.busyReason(UDID)).toBeNull();
    fs.rmSync(chain, { recursive: true, force: true });
    makeChain({ appleEncrypted: true });
    expect(await s.beginRead(UDID)).toEqual({ ok: false, reason: "apple-encrypted" });
    expect(s.busyReason(UDID)).toBeNull();
  });

  it("B5: a sync that starts while a read holds the phone stops the read and gets the phone (no busy refusal)", async () => {
    makeChain();
    const s = service({ pauseWaitMs: 5 });
    await s.migrate(UDID);
    const start = await s.beginRead(UDID);
    if (!start.ok) throw new Error("refused");
    const progress: string[] = [];
    const syncing = s.beginSync(UDID, { strategy: "delta", onProgress: (p) => progress.push(p.phase) });
    await new Promise((r) => setImmediate(r));
    expect(Atomics.load(start.session.stop, 0)).toBe(1);
    // The read's copy now stops at its first file. The read is ended whatever the copy
    // did, so a broken stop reds this test instead of leaving the sync waiting forever.
    const out = copyDir("b5");
    let stopped: unknown;
    try {
      stopped = await s.buildParseCopy(UDID, out, { stop: start.session.stop }).then(
        () => null,
        (e: unknown) => e,
      );
    } finally {
      s.endRead(start.session);
    }
    expect(stopped).toBeInstanceOf(BackupAtRestRefusal);
    expect((stopped as BackupAtRestRefusal).reason).toBe("cancelled");
    expect((stopped as BackupAtRestRefusal).message).toBe(BACKUP_READ_STOPPED);
    expect(fs.existsSync(path.join(out, "Manifest.db"))).toBe(false);
    const session = await syncing;
    expect(session.kind).toBe("keepr");
    expect(progress).toContain("pausing");
    await s.finishSync(session);
    expect(s.busyReason(UDID)).toBeNull();
  });

  it("endRead is idempotent and never releases a phone another holder took", async () => {
    makeChain();
    const s = service();
    await s.migrate(UDID);
    const start = await s.beginRead(UDID);
    if (!start.ok) throw new Error("refused");
    s.endRead(start.session);
    const sync = await s.beginSync(UDID, { strategy: "delta" });
    s.endRead(start.session);
    expect(s.busyReason(UDID)).toBe("syncing");
    await s.finishSync(sync);
  });
});
