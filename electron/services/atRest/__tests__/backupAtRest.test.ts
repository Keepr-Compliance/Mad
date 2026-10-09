/**
 * @jest-environment node
 */
/**
 * BACKLOG-3816 S4-C — the kept iPhone backup sealed at rest with the data key.
 *
 * Real fileCrypto, real files in a temp Backups root, real SQLite Manifest.db (run
 * under Electron's node for the sqlite driver).
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
import {
  BackupAtRest,
  BackupAtRestRefusal,
  BACKUP_SECURING_MESSAGE,
  BACKUP_SECURING_SENTENCE,
  markerProtectsChain,
  readMarkerAt,
  type BackupUnsealStrategy,
} from "../backupAtRest";
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
  const walk = (d: string, root: boolean) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f, false);
      else if (!(root && ["Info.plist", "Status.plist", "Manifest.plist"].includes(e.name))) out.push(f);
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

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !cond(); i++) await new Promise((r) => setImmediate(r));
  if (!cond()) throw new Error("condition never became true");
}

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-s4c-"));
  backups = path.join(userData, "Backups");
  chain = path.join(backups, UDID);
});
afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

describe("seal / scan", () => {
  it("seals every content file, leaves the three root plists plain, skips empty files", async () => {
    makeChain();
    const before = Object.fromEntries(allContentFiles().map((f) => [f, fs.readFileSync(f)]));
    const s = service();
    const report = await s.seal(UDID);
    expect(report.failed).toBe(0);
    expect(report.empty).toBe(1);
    expect(plaintextLeft()).toEqual([]);
    for (const name of ["Info.plist", "Status.plist", "Manifest.plist"]) {
      expect(headerOf(path.join(chain, name)).equals(MAGIC)).toBe(false);
    }
    for (const [f, bytes] of Object.entries(before)) {
      expect((await files.readAllDecrypted(f)).equals(bytes)).toBe(true);
    }
    expect(await s.scan(UDID)).toEqual({ sealed: 5, plaintext: 0, empty: 1, damaged: 0 });
  });

  it("is idempotent: a second seal changes nothing (no double encryption after a kill)", async () => {
    makeChain();
    const s = service();
    await s.seal(UDID);
    const sealed = Object.fromEntries(allContentFiles().map((f) => [f, fs.readFileSync(f)]));
    const again = await s.seal(UDID);
    expect(again.changed).toBe(0);
    for (const [f, bytes] of Object.entries(sealed)) expect(fs.readFileSync(f).equals(bytes)).toBe(true);
  });

  it("leaves a damaged-header file (magic, not a valid container) untouched and counts it", async () => {
    makeChain();
    const damaged = write("dd/" + "d".repeat(40), Buffer.concat([MAGIC, Buffer.from("not a header at all, just bytes")]));
    const original = fs.readFileSync(damaged);
    const report = await service().seal(UDID);
    expect(report.damaged).toBe(1);
    expect(fs.readFileSync(damaged).equals(original)).toBe(true);
    expect((await service().scan(UDID)).damaged).toBe(1);
  });

  it("removes orphaned *.kenc-tmp files (a killed unseal leaves PLAINTEXT temps)", async () => {
    makeChain();
    const tmp = write(`${SMS_DB_FILE_ID.slice(0, 2)}/${SMS_DB_FILE_ID}.abcdef123456.kenc-tmp`, "plaintext temp");
    const report = await service().seal(UDID);
    expect(report.tempsRemoved).toBe(1);
    expect(fs.existsSync(tmp)).toBe(false);
  });

  it("refuses to start when free space is below the largest file + 1 GB", async () => {
    makeChain();
    const report = await service({ freeBytes: async () => 10 }).seal(UDID);
    expect(report.failedCodes.DISK_SPACE).toBeGreaterThan(0);
    expect(report.changed).toBe(0);
  });

  it("retries a locked file (EBUSY) and then seals it", async () => {
    makeChain();
    let calls = 0;
    const flaky = {
      ...files,
      encryptFileInPlace: async (p: string) => {
        calls++;
        if (calls === 1) throw Object.assign(new Error("busy"), { code: "EBUSY" });
        return files.encryptFileInPlace(p);
      },
    };
    const report = await service({ files: () => flaky, concurrency: 1 }).seal(UDID);
    expect(report.failed).toBe(0);
    expect(plaintextLeft()).toEqual([]);
  });
});

describe("markers and the 3598 classifier input", () => {
  it("readMarkerAt: absent / state / unreadable", async () => {
    expect(await readMarkerAt(backups, UDID)).toBe("absent");
    await createMarkerStore({ userData: () => userData }).writeBackupMarker(UDID, "encrypted");
    expect(await readMarkerAt(backups, UDID)).toBe("encrypted");
    fs.writeFileSync(path.join(backups, MARKER_DIR_NAME, `${UDID}.json`), "{not json");
    expect(await readMarkerAt(backups, UDID)).toBe("unreadable");
    expect(markerProtectsChain("encrypted")).toBe(true);
    expect(markerProtectsChain("syncing")).toBe(true);
    expect(markerProtectsChain("migrating")).toBe(true);
    expect(markerProtectsChain("plaintext")).toBe(false);
    expect(markerProtectsChain("absent")).toBe(false);
  });
});

describe.each<BackupUnsealStrategy>(["full", "delta"])("sync lifecycle (%s)", (strategy) => {
  it("unseals per strategy, marks syncing, and finishSync seals everything and marks encrypted", async () => {
    makeChain();
    const s = service();
    await s.migrate(UDID);
    expect(await readMarkerAt(backups, UDID)).toBe("encrypted");

    const session = await s.beginSync(UDID, { strategy });
    expect(session.kind).toBe("keepr");
    expect(await readMarkerAt(backups, UDID)).toBe("syncing");
    expect(headerOf(path.join(chain, "Manifest.db")).equals(MAGIC)).toBe(false); // idevicebackup2 can read it
    const smsPath = path.join(chain, SMS_DB_FILE_ID.slice(0, 2), SMS_DB_FILE_ID);
    expect(headerOf(smsPath).equals(MAGIC)).toBe(strategy === "delta");
    expect(s.busyReason(UDID)).toBe("syncing");

    // idevicebackup2 stand-in: the phone sends a new file and a changed one.
    write("12/" + "2".repeat(40), "a brand new message attachment");
    write(`${OTHER_ID.slice(0, 2)}/${OTHER_ID}`, "changed other app data");

    await s.finishSync(session);
    expect(plaintextLeft()).toEqual([]);
    expect(await readMarkerAt(backups, UDID)).toBe("encrypted");
    expect(s.busyReason(UDID)).toBeNull();
  });

  it("C-DELTA parse copy: sms.db/AddressBook/attachments decrypted into the copy dir, Manifest.db copy removed", async () => {
    makeChain();
    const smsBytes = fs.readFileSync(path.join(chain, SMS_DB_FILE_ID.slice(0, 2), SMS_DB_FILE_ID));
    const s = service();
    await s.migrate(UDID);
    const session = await s.beginSync(UDID, { strategy });
    const out = path.join(userData, "at-rest-tmp", "ios-test");
    const result = await s.buildParseCopy(UDID, out);
    expect(result.copied).toBe(3);
    expect(fs.readFileSync(path.join(out, SMS_DB_FILE_ID.slice(0, 2), SMS_DB_FILE_ID)).equals(smsBytes)).toBe(true);
    expect(fs.existsSync(path.join(out, "Manifest.db"))).toBe(false);
    expect(fs.existsSync(path.join(out, OTHER_ID.slice(0, 2), OTHER_ID))).toBe(false);
    await s.finishSync(session);
  });
});

describe("refusals and special chains", () => {
  it("an Apple-encrypted chain is never sealed and a stale marker is removed", async () => {
    makeChain({ appleEncrypted: true });
    await createMarkerStore({ userData: () => userData }).writeBackupMarker(UDID, "encrypted");
    const before = Object.fromEntries(allContentFiles().map((f) => [f, fs.readFileSync(f)]));
    const s = service();
    expect(await s.migrate(UDID)).toBe("apple");
    const session = await s.beginSync(UDID);
    expect(session.kind).toBe("apple");
    await s.finishSync(session);
    for (const [f, bytes] of Object.entries(before)) expect(fs.readFileSync(f).equals(bytes)).toBe(true);
    expect(await readMarkerAt(backups, UDID)).toBe("absent");
  });

  it("key unavailable → refused before anything is unsealed", async () => {
    makeChain();
    const s = service();
    await s.migrate(UDID);
    const locked = service({ ensureKey: async () => { throw new Error("DataKeyUnavailableError"); } });
    await expect(locked.beginSync(UDID)).rejects.toMatchObject({ reason: "key-unavailable" });
    expect(plaintextLeft()).toEqual([]);
  });

  it("a backup being migrated refuses the sync with the founder sentence", async () => {
    makeChain();
    const s = service();
    const migrating = s.migrate(UDID);
    await new Promise((r) => setImmediate(r));
    await waitFor(() => s.busyReason(UDID) === "migrating");
    await expect(s.beginSync(UDID)).rejects.toBeInstanceOf(BackupAtRestRefusal);
    await expect(s.beginSync(UDID)).rejects.toThrow(BACKUP_SECURING_SENTENCE);
    expect(BACKUP_SECURING_MESSAGE).toContain("Syncing your iPhone will be available when this finishes.");
    await migrating;
  });

  it("first backup: no marker before it exists; sealed and marked once Manifest.db is there", async () => {
    const s = service();
    const session = await s.beginSync(UDID);
    expect(session.kind).toBe("first");
    expect(await readMarkerAt(backups, UDID)).toBe("absent");
    makeChain();
    await s.finishSync(session);
    expect(plaintextLeft()).toEqual([]);
    expect(await readMarkerAt(backups, UDID)).toBe("encrypted");
  });

  it("an unfinished first backup (no Manifest.db) is sealed but gets NO marker, so 3598 can still remove it", async () => {
    const s = service();
    const session = await s.beginSync(UDID);
    fs.mkdirSync(chain, { recursive: true });
    write("ab/" + "b".repeat(40), "partial plaintext");
    await s.finishSync(session);
    expect(plaintextLeft()).toEqual([]);
    expect(await readMarkerAt(backups, UDID)).toBe("absent");
  });

  it("a sealed file that cannot be opened (wrong key) refuses the sync and re-seals what was unsealed", async () => {
    makeChain();
    const s = service();
    await s.migrate(UDID);
    const other = crypto.randomBytes(32);
    const foreign = createFileCrypto({ currentKey: async () => ({ keyId: KEY_ID, key: other }), keyFor: async () => other }, { chunkSize: 64 });
    const bad = path.join(chain, "ee", "e".repeat(40));
    fs.mkdirSync(path.dirname(bad), { recursive: true });
    await foreign.encryptStreamToFile([Buffer.from("sealed under another key")], bad);
    await expect(s.beginSync(UDID, { strategy: "full" })).rejects.toMatchObject({ reason: "unreadable" });
    expect(plaintextLeft()).toEqual([]);
    expect(s.busyReason(UDID)).toBeNull();
  });
});

describe("launch job", () => {
  it("C3: a 'syncing' marker left by a crash is sealed at launch → encrypted", async () => {
    makeChain();
    await createMarkerStore({ userData: () => userData }).writeBackupMarker(UDID, "syncing");
    const s = service();
    const outcomes = await s.runLaunchJob();
    expect(outcomes[UDID]).toBe("encrypted");
    expect(plaintextLeft()).toEqual([]);
    expect(await readMarkerAt(backups, UDID)).toBe("encrypted");
  });

  it("C3: a sync started before the launch job ran seals a 'syncing' chain FIRST", async () => {
    makeChain();
    await createMarkerStore({ userData: () => userData }).writeBackupMarker(UDID, "syncing");
    const s = service();
    const sealSpy = jest.spyOn(s, "seal");
    const unsealSpy = jest.spyOn(s, "unseal");
    const session = await s.beginSync(UDID, { strategy: "full" });
    expect(sealSpy).toHaveBeenCalled();
    expect(sealSpy.mock.invocationCallOrder[0]).toBeLessThan(unsealSpy.mock.invocationCallOrder[0]);
    await s.finishSync(session);
  });

  it("migrates a pre-2.40 plaintext chain and is resumable", async () => {
    makeChain();
    const s = service();
    expect(await s.migrate(UDID)).toBe("encrypted");
    expect(plaintextLeft()).toEqual([]);
    expect(await s.migrate(UDID)).toBe("encrypted");
  });
});
