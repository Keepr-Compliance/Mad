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
  BACKUP_AT_REST_QUARANTINED_MESSAGE,
  BackupAtRest,
  BackupAtRestRefusal,
  DELTA_UNSEAL_FILES,
  describeBackupAtRestProgress,
  PROGRESS_FILE_WEIGHT_BYTES,
  QUARANTINE_DIR_NAME,
  QUARANTINE_MAX_AGE_MS,
  type BackupAtRestProgress,
  BACKUP_SECURING_MESSAGE,
  BACKUP_SECURING_SENTENCE,
  markerProtectsChain,
  readMarkerAt,
  type BackupUnsealStrategy,
  BACKUP_UNSEAL_STRATEGY,
  isAppleEncryptedChain,
  idleRecoveryBackoffMs,
} from "../backupAtRest";
import { DataKeyUnavailableError } from "../dataKeyService";
import * as fileCryptoModule from "../fileCrypto";
import { createFileCrypto, KENC_TMP_SUFFIX, MAGIC, probeHeader, type KeyResolver } from "../fileCrypto";
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
    chunkSize: 64, // same as `files`: multi-chunk containers
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

describe("seal / scan", () => {
  it("seals every file INCLUDING the three root plists (Info.plist holds IMEI / phone number), skips empty files", async () => {
    makeChain();
    const before = Object.fromEntries(allContentFiles().map((f) => [f, fs.readFileSync(f)]));
    const s = service();
    const report = await s.seal(UDID);
    expect(report.failed).toBe(0);
    expect(report.empty).toBe(1);
    expect(plaintextLeft()).toEqual([]);
    for (const name of ["Info.plist", "Status.plist", "Manifest.plist"]) {
      expect(headerOf(path.join(chain, name)).equals(MAGIC)).toBe(true);
    }
    for (const [f, bytes] of Object.entries(before)) {
      expect((await files.readAllDecrypted(f)).equals(bytes)).toBe(true);
    }
    expect(await s.scan(UDID)).toEqual({ sealed: 8, plaintext: 0, empty: 1, damaged: 0 });
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
    const beforeSeal = () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("busy"), { code: "EBUSY" });
    };
    const report = await service({ sealEngineOptions: { beforeSeal, retryDelayMs: 0 } }).seal(UDID);
    expect(report.failed).toBe(0);
    expect(calls).toBeGreaterThan(report.changed); // the locked file was tried again
    expect(plaintextLeft()).toEqual([]);
  });
});

describe("`encrypted` only after a clean scan", () => {
  it("a file that keeps failing (locked) leaves the marker short of encrypted, and the next run finishes it", async () => {
    makeChain();
    const smsPath = path.join(chain, SMS_DB_FILE_ID.slice(0, 2), SMS_DB_FILE_ID);
    const locked = {
      retryDelayMs: 0,
      beforeSeal: (p: string) => {
        if (p === smsPath) throw Object.assign(new Error("locked"), { code: "EACCES" });
      },
    };
    const s = service({ sealEngineOptions: locked });
    expect(await s.migrate(UDID)).toBe("incomplete");
    expect(await readMarkerAt(backups, UDID)).toBe("migrating");
    const session = await service().beginSync(UDID, { strategy: "full" });
    const lockedAgain = service({ sealEngineOptions: locked });
    await lockedAgain.finishSync(session);
    expect(await readMarkerAt(backups, UDID)).toBe("sealing");
    expect(await service().migrate(UDID)).toBe("encrypted");
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

describe("default strategy is C-DELTA (Step 0b)", () => {
  it("the constant, and a beginSync with no strategy leaves unchanged content files sealed", async () => {
    expect(BACKUP_UNSEAL_STRATEGY).toBe("delta");
    makeChain();
    const s = service();
    await s.migrate(UDID);
    const session = await s.beginSync(UDID);
    expect(session).toMatchObject({ kind: "keepr", strategy: "delta" });
    const smsPath = path.join(chain, SMS_DB_FILE_ID.slice(0, 2), SMS_DB_FILE_ID);
    expect(headerOf(smsPath).equals(MAGIC)).toBe(true);
    expect(headerOf(path.join(chain, "Manifest.db")).equals(MAGIC)).toBe(false);
    await s.finishSync(session);
  });

  it("the three root plists: sealed after migration, plain for idevicebackup2 during a delta sync, sealed again after it; readable sealed", async () => {
    makeChain();
    const plists = ["Info.plist", "Status.plist", "Manifest.plist"].map((n) => path.join(chain, n));
    const original = plists.map((p) => fs.readFileSync(p));
    const s = service();
    await s.migrate(UDID);
    for (const p of plists) expect(headerOf(p).equals(MAGIC)).toBe(true);
    // Readers outside a sync decrypt them (the Apple-encrypted check reads Manifest.plist).
    for (const [i, p] of plists.entries()) expect((await files.readAllDecrypted(p)).equals(original[i])).toBe(true);
    const session = await s.beginSync(UDID);
    for (const [i, p] of plists.entries()) {
      expect(headerOf(p).equals(MAGIC)).toBe(false);
      expect(fs.readFileSync(p).equals(original[i])).toBe(true);
    }
    await s.finishSync(session, undefined, { succeeded: true });
    for (const p of plists) expect(headerOf(p).equals(MAGIC)).toBe(true);
    expect(await readMarkerAt(backups, UDID)).toBe("encrypted");
  });

  it("an Apple-encrypted chain is still recognised after a Keepr seal never touched it, and a SEALED Manifest.plist is read decrypted", async () => {
    makeChain({ appleEncrypted: true });
    expect(await isAppleEncryptedChain(chain, (p) => files.readAllDecrypted(p))).toBe(true);
    // Seal Manifest.plist by hand (a Keepr chain never says IsEncrypted, so this only proves the read path).
    await files.encryptFileInPlace(path.join(chain, "Manifest.plist"));
    expect(headerOf(path.join(chain, "Manifest.plist")).equals(MAGIC)).toBe(true);
    expect(await isAppleEncryptedChain(chain, (p) => files.readAllDecrypted(p))).toBe(true);
  });

  it("a delta sync that leaves a damaged file forces C-FULL for the next sync, recorded with a reason; a clean full sync clears it", async () => {
    makeChain();
    const s = service();
    await s.migrate(UDID);
    const session = await s.beginSync(UDID);
    // The tool truncated a still-sealed file: header magic kept, structure broken.
    const smsPath = path.join(chain, SMS_DB_FILE_ID.slice(0, 2), SMS_DB_FILE_ID);
    fs.writeFileSync(smsPath, fs.readFileSync(smsPath).subarray(0, 30));
    await s.finishSync(session);
    expect(await s.forcedFullReason(UDID)).toBe("DELTA_DAMAGED");
    // A restart: a brand-new service (fresh in-memory state) reads the flag from the marker file.
    const afterRestart = service();
    expect(await readMarkerAt(backups, UDID)).toBe("encrypted");
    const next = await afterRestart.beginSync(UDID);
    expect(next).toMatchObject({ kind: "keepr", strategy: "full" });
    fs.writeFileSync(smsPath, Buffer.from("rewritten by the phone"));
    await afterRestart.finishSync(next, undefined, { succeeded: true });
    expect(await afterRestart.forcedFullReason(UDID)).toBeNull();
    expect(await readMarkerAt(backups, UDID)).toBe("encrypted");
  });

  describe("R1: the force-full flag clears only when the forced C-FULL sync SUCCEEDED", () => {
    async function forcedFull() {
      makeChain();
      const s = service();
      await s.migrate(UDID);
      const first = await s.beginSync(UDID);
      await s.finishSync(first, undefined, { forceFullNext: "DELTA_TOOL_FAILED" });
      expect(await s.forcedFullReason(UDID)).toBe("DELTA_TOOL_FAILED");
      const forced = await s.beginSync(UDID);
      expect(forced).toMatchObject({ kind: "keepr", strategy: "full" });
      return { s, forced };
    }

    it("a forced C-FULL that FAILED keeps the flag", async () => {
      const { s, forced } = await forcedFull();
      await s.finishSync(forced, undefined, { succeeded: false });
      expect(await s.forcedFullReason(UDID)).toBe("DELTA_TOOL_FAILED");
      expect(await service().beginSync(UDID)).toMatchObject({ strategy: "full" });
    });

    it("a forced C-FULL that was CANCELLED (no succeeded option) keeps the flag", async () => {
      const { s, forced } = await forcedFull();
      await s.finishSync(forced);
      expect(await s.forcedFullReason(UDID)).toBe("DELTA_TOOL_FAILED");
    });

    it("a forced C-FULL that SUCCEEDED clears the flag", async () => {
      const { s, forced } = await forcedFull();
      await s.finishSync(forced, undefined, { succeeded: true });
      expect(await s.forcedFullReason(UDID)).toBeNull();
    });
  });

  it("D1: a delta sync whose backup tool failed forces C-FULL even though no file is damaged; a restart still reads it", async () => {
    makeChain();
    const s = service();
    await s.migrate(UDID);
    const session = await s.beginSync(UDID);
    // The tool read a still-sealed file and exited non-zero: nothing is damaged.
    await s.finishSync(session, undefined, { forceFullNext: "DELTA_TOOL_FAILED" });
    expect(await readMarkerAt(backups, UDID)).toBe("encrypted");
    expect(await s.forcedFullReason(UDID)).toBe("DELTA_TOOL_FAILED");
    const afterRestart = service();
    expect(await afterRestart.beginSync(UDID)).toMatchObject({ kind: "keepr", strategy: "full" });
  });

  it("D1: a sync that was already C-FULL does not record a tool failure (nothing was left sealed)", async () => {
    makeChain();
    const s = service();
    await s.migrate(UDID);
    const session = await s.beginSync(UDID, { strategy: "full" });
    await s.finishSync(session, undefined, { forceFullNext: "DELTA_TOOL_FAILED" });
    expect(await s.forcedFullReason(UDID)).toBeNull();
  });

  it("S1: the force-full flag survives a marker rewrite after a crash (marker left `syncing`, launch reseals)", async () => {
    makeChain();
    const s = service();
    await s.migrate(UDID);
    const first = await s.beginSync(UDID);
    await s.finishSync(first, undefined, { forceFullNext: "DELTA_TOOL_FAILED" });
    // The forced C-FULL sync starts (marker `syncing`, plaintext on disk) and the app dies before finishSync.
    const crashed = service();
    await crashed.beginSync(UDID);
    expect(await readMarkerAt(backups, UDID)).toBe("syncing");
    // Next launch: the reseal rewrites the marker to `encrypted`.
    const relaunched = service();
    await relaunched.runLaunchJob();
    expect(await readMarkerAt(backups, UDID)).toBe("encrypted");
    expect(await relaunched.forcedFullReason(UDID)).toBe("DELTA_TOOL_FAILED");
    expect(await service().beginSync(UDID)).toMatchObject({ strategy: "full" });
  });

  it("the damaged count is per scan: an early-return seal does not reuse the last scan's count", async () => {
    makeChain();
    const logs: string[] = [];
    const s = service({ log: (_level, message) => void logs.push(String(message)) });
    await s.migrate(UDID);
    const smsPath = path.join(chain, SMS_DB_FILE_ID.slice(0, 2), SMS_DB_FILE_ID);
    const damagedSession = await s.beginSync(UDID);
    fs.writeFileSync(smsPath, fs.readFileSync(smsPath).subarray(0, 30));
    await s.finishSync(damagedSession);
    expect(logs.some((m) => m.includes("left damaged files"))).toBe(true);
    // A second delta sync whose chain is gone when it ends: the seal returns "absent" without scanning.
    fs.rmSync(chain, { recursive: true, force: true });
    makeChain();
    await s.migrate(UDID);
    await createMarkerStore({ userData: () => userData }).setNextStrategy(UDID, null);
    logs.length = 0;
    const second = await s.beginSync(UDID, { strategy: "delta" });
    fs.rmSync(chain, { recursive: true, force: true });
    await s.finishSync(second);
    expect(logs.some((m) => m.includes("left damaged files"))).toBe(false);
  });

  it("a clean delta sync does not force C-FULL", async () => {
    makeChain();
    const s = service();
    await s.migrate(UDID);
    const session = await s.beginSync(UDID);
    write("12/" + "2".repeat(40), "a brand new message attachment");
    await s.finishSync(session);
    expect(await s.forcedFullReason(UDID)).toBeNull();
    expect(await s.beginSync(UDID)).toMatchObject({ strategy: "delta" });
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
  it("an Apple-encrypted chain is never sealed; a stale Keepr marker becomes apple-encrypted (SR ruling)", async () => {
    makeChain({ appleEncrypted: true });
    await createMarkerStore({ userData: () => userData }).writeBackupMarker(UDID, "encrypted");
    const before = Object.fromEntries(allContentFiles().map((f) => [f, fs.readFileSync(f)]));
    const s = service();
    expect(await s.migrate(UDID)).toBe("apple");
    const session = await s.beginSync(UDID);
    expect(session.kind).toBe("apple");
    await s.finishSync(session);
    for (const [f, bytes] of Object.entries(before)) expect(fs.readFileSync(f).equals(bytes)).toBe(true);
    expect(await readMarkerAt(backups, UDID)).toBe("apple-encrypted");
    expect(markerProtectsChain("apple-encrypted")).toBe(true);
    // migration skips it too
    expect(await s.migrate(UDID)).toBe("apple");
    for (const [f, bytes] of Object.entries(before)) expect(fs.readFileSync(f).equals(bytes)).toBe(true);
  });

  it("a phone that turned encryption OFF: the apple session's new plaintext chain is sealed at the end", async () => {
    makeChain({ appleEncrypted: true });
    const s = service();
    const session = await s.beginSync(UDID);
    expect(session.kind).toBe("apple");
    write("Manifest.plist", plist.stringify({ IsEncrypted: false })); // idevicebackup2 wrote a plaintext chain
    await s.finishSync(session);
    expect(plaintextLeft()).toEqual([]);
    expect(await readMarkerAt(backups, UDID)).toBe("encrypted");
  });

  it("a moved-aside plaintext chain (.keepr-replaced-<udid>-*) is sealed at launch and at the end of that phone's sync", async () => {
    makeChain();
    const aside = path.join(backups, `.keepr-replaced-${UDID}-1700000000000`);
    fs.renameSync(chain, aside);
    const asideFiles = () => {
      const out: string[] = [];
      const walk = (d: string, root: boolean) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const f = path.join(d, e.name);
          if (e.isDirectory()) walk(f, false);
          else out.push(f); // root plists included: sealed too
        }
      };
      walk(aside, true);
      return out.filter((f) => fs.statSync(f).size > 0 && !headerOf(f).equals(MAGIC));
    };
    expect(asideFiles().length).toBeGreaterThan(0);
    const s = service();
    const outcomes = await s.runLaunchJob();
    expect(outcomes.aside).toBe("1");
    expect(asideFiles()).toEqual([]);
    expect(headerOf(path.join(aside, "Manifest.plist")).equals(MAGIC)).toBe(true);

    // and through a sync's end (new Apple-encrypted chain beside it)
    fs.rmSync(aside, { recursive: true });
    makeChain();
    fs.renameSync(chain, aside);
    makeChain({ appleEncrypted: true });
    const session = await s.beginSync(UDID);
    await s.finishSync(session);
    expect(asideFiles()).toEqual([]);
  });

  it("key unavailable → refused before anything is unsealed", async () => {
    makeChain();
    const s = service();
    await s.migrate(UDID);
    const locked = service({ ensureKey: async () => { throw new Error("DataKeyUnavailableError"); } });
    await expect(locked.beginSync(UDID)).rejects.toMatchObject({ reason: "key-unavailable" });
    expect(plaintextLeft()).toEqual([]);
  });

  it("a sync requested during the launch migration PAUSES it at a file boundary, runs, and its own seal finishes the rest", async () => {
    makeChain();
    let sealedBeforePause = 0;
    let s: BackupAtRest | null = null;
    // Pause request lands after the first file is sealed (a real migration is mid-way).
    let syncing: Promise<unknown> | null = null;
    const progress: BackupAtRestProgress[] = [];
    s = service({
      sealEngineOptions: {
        beforeSeal: () => {
          sealedBeforePause++;
          if (sealedBeforePause === 1) syncing = (s as BackupAtRest).beginSync(UDID, { onProgress: (p) => progress.push(p) });
        },
      },
    });
    const migrated = await s.migrate(UDID);
    expect(migrated).toBe("paused");
    const session = (await (syncing as unknown as Promise<unknown>)) as Awaited<ReturnType<BackupAtRest["beginSync"]>>;
    expect(session).toMatchObject({ kind: "keepr", udid: UDID, strategy: "delta" });
    expect(progress[0]).toMatchObject({ phase: "pausing" });
    // The migration stopped before sealing everything: plaintext is still there mid-sync.
    expect(plaintextLeft().length).toBeGreaterThan(0);
    expect(await readMarkerAt(backups, UDID)).toBe("syncing");
    // This sync's seal resumes it: nothing plaintext left, marker encrypted.
    await s.finishSync(session, undefined, { succeeded: true });
    expect(plaintextLeft()).toEqual([]);
    expect(await readMarkerAt(backups, UDID)).toBe("encrypted");
    expect(s.busyReason(UDID)).toBeNull();
  });

  it("a sync requested during the seal after the previous sync pauses that seal too (no refusal, no wait for the whole seal)", async () => {
    makeChain();
    await service().migrate(UDID);
    const first = await service().beginSync(UDID, { strategy: "full" }); // everything plaintext again
    let s: BackupAtRest | null = null;
    let second: Promise<unknown> | null = null;
    let n = 0;
    s = service({
      sealEngineOptions: {
        beforeSeal: () => {
          if (++n === 1) second = (s as BackupAtRest).beginSync(UDID);
        },
      },
    });
    await s.finishSync(first, undefined, { succeeded: true });
    const session = (await (second as unknown as Promise<unknown>)) as Awaited<ReturnType<BackupAtRest["beginSync"]>>;
    expect(session.kind).toBe("keepr");
    expect(plaintextLeft().length).toBeGreaterThan(0);
    await service().finishSync(session, undefined, { succeeded: true });
    expect(plaintextLeft()).toEqual([]);
    expect(await readMarkerAt(backups, UDID)).toBe("encrypted");
  });

  it("a paused migration whose sync is then refused is resumed in the background, not left until the next launch", async () => {
    makeChain();
    let s: BackupAtRest | null = null;
    let refused: Promise<unknown> | null = null;
    let n = 0;
    let failNextKey = false;
    s = service({
      ensureKey: async () => {
        if (failNextKey) {
          failNextKey = false; // only the sync's check fails; the resumed migration's passes
          throw new DataKeyUnavailableError("gone");
        }
      },
      sealEngineOptions: {
        beforeSeal: () => {
          if (++n === 1) {
            failNextKey = true;
            refused = (s as BackupAtRest).beginSync(UDID).catch((e) => e);
          }
        },
      },
    });
    expect(await s.migrate(UDID)).toBe("paused");
    expect(await refused).toMatchObject({ reason: "key-unavailable" });
    // The resume runs on the next turn; wait for the lock to come back.
    for (let i = 0; i < 200 && (plaintextLeft().length > 0 || s.busyReason(UDID)); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(plaintextLeft()).toEqual([]);
    expect(await readMarkerAt(backups, UDID)).toBe("encrypted");
  });

  it("the check after a seal opens only files the pass did not see; a plaintext file that appeared meanwhile keeps the marker short of encrypted", async () => {
    makeChain();
    let late: string | null = null;
    const s = service({
      sealEngineOptions: {
        beforeSeal: () => {
          // Appears after the pass listed the chain (the pass never sees it).
          late ??= write("ee/" + "e".repeat(40), "written after the listing");
        },
      },
    });
    expect(await s.migrate(UDID)).toBe("incomplete");
    expect(await readMarkerAt(backups, UDID)).toBe("migrating");
    expect(plaintextLeft()).toEqual([late]);
    expect(await service().migrate(UDID)).toBe("encrypted");
  });

  it("the check does not re-open files the pass already gave a verdict for (must-fix #2: no second 573k-file walk)", async () => {
    makeChain();
    const s = service();
    const internals = s as unknown as { pass: (...a: unknown[]) => Promise<unknown> };
    const real = internals.pass.bind(s);
    const modes: string[] = [];
    internals.pass = (...a: unknown[]) => {
      modes.push(a[1] as string);
      return real(...a);
    };
    expect(await s.migrate(UDID)).toBe("encrypted");
    expect(modes).toEqual(["seal"]); // no classify pass over the chain afterwards
  });

  it("a sync requested during the check pauses it too; partial counts never write `encrypted`", async () => {
    makeChain();
    await service().migrate(UDID);
    const first = await service().beginSync(UDID, { strategy: "full" });
    let s: BackupAtRest | null = null;
    let second: Promise<unknown> | null = null;
    let wrote = false;
    s = service({
      sealEngineOptions: {
        beforeSeal: () => {
          if (wrote) return;
          wrote = true;
          write("ee/" + "e".repeat(40), "appears after the listing: the check must open it");
        },
      },
    });
    const internals = s as unknown as { checkAfterSeal: (...a: unknown[]) => Promise<unknown> };
    const realCheck = internals.checkAfterSeal.bind(s);
    internals.checkAfterSeal = (...a: unknown[]) => {
      second = (s as BackupAtRest).beginSync(UDID); // pause flag set before the check's pass
      return realCheck(...a);
    };
    await s.finishSync(first, undefined, { succeeded: true });
    expect(await readMarkerAt(backups, UDID)).not.toBe("encrypted");
    const session = (await (second as unknown as Promise<unknown>)) as Awaited<ReturnType<BackupAtRest["beginSync"]>>;
    await service().finishSync(session, undefined, { succeeded: true });
    expect(plaintextLeft()).toEqual([]);
    expect(await readMarkerAt(backups, UDID)).toBe("encrypted");
  });

  it.each(["migrating", "syncing"] as const)(
    "a crash in the middle of a %s pass (part sealed, orphan temps of both kinds): the launch job finishes it",
    async (state) => {
      makeChain();
      // Seal part of it, then "crash": leave a ciphertext temp and a plaintext temp behind.
      let n = 0;
      await service({
        sealEngineOptions: {
          beforeSeal: () => {
            if (++n > 2) throw Object.assign(new Error("killed"), { code: "EIO" });
          },
        },
      }).seal(UDID);
      const sub = path.join(chain, SMS_DB_FILE_ID.slice(0, 2));
      fs.writeFileSync(path.join(sub, `${SMS_DB_FILE_ID}.aaaaaaaaaaaa${KENC_TMP_SUFFIX}`), "plaintext temp from a killed unseal");
      fs.writeFileSync(path.join(sub, `${SMS_DB_FILE_ID}.bbbbbbbbbbbb${KENC_TMP_SUFFIX}`), Buffer.concat([MAGIC, Buffer.alloc(80)]));
      await createMarkerStore({ userData: () => userData }).writeBackupMarker(UDID, state);
      expect(plaintextLeft().length).toBeGreaterThan(0);
      const outcomes = await service().runLaunchJob();
      expect(outcomes[UDID]).toBe("encrypted");
      expect(plaintextLeft()).toEqual([]);
      expect(fs.readdirSync(sub).filter((f) => f.endsWith(KENC_TMP_SUFFIX))).toEqual([]);
      expect(await readMarkerAt(backups, UDID)).toBe("encrypted");
    },
  );

  it("a second sync while a sync holds the phone is still refused with the founder sentence (not a pausable pass)", async () => {
    makeChain();
    const s = service();
    const session = await s.beginSync(UDID, { strategy: "full" });
    await expect(s.beginSync(UDID)).rejects.toBeInstanceOf(BackupAtRestRefusal);
    await expect(s.beginSync(UDID)).rejects.toThrow(BACKUP_SECURING_SENTENCE);
    expect(BACKUP_SECURING_MESSAGE).toContain("Syncing your iPhone will be available when this finishes.");
    await s.finishSync(session);
  });

  it("a sync that started first makes a launch migration in the same tick stand aside", async () => {
    makeChain();
    const s = service();
    const syncing = s.beginSync(UDID, { strategy: "full" });
    expect(await s.migrate(UDID)).toBe("busy");
    await s.finishSync(await syncing);
    expect(plaintextLeft()).toEqual([]);
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

  it("a sealed file that cannot be opened (wrong key) is quarantined sealed, and the sync becomes a full backup (B2)", async () => {
    makeChain();
    const s = service({ now: () => 1_700_000_000_000 });
    await s.migrate(UDID);
    const other = crypto.randomBytes(32);
    const foreign = createFileCrypto({ currentKey: async () => ({ keyId: KEY_ID, key: other }), keyFor: async () => other }, { chunkSize: 64 });
    const bad = path.join(chain, "ee", "e".repeat(40));
    fs.mkdirSync(path.dirname(bad), { recursive: true });
    await foreign.encryptStreamToFile((async function* () { yield Buffer.from("sealed under another key"); })(), bad);
    const session = await s.beginSync(UDID, { strategy: "full" });
    expect(session).toEqual({ kind: "first", udid: UDID, quarantined: { reasonCode: "INTEGRITY" } });
    const moved = path.join(backups, QUARANTINE_DIR_NAME, `${UDID}-1700000000000`);
    expect(fs.existsSync(chain)).toBe(false);
    expect(plaintextIn(moved)).toEqual([]);
    expect(s.busyReason(UDID)).toBe("syncing");
    await s.finishSync(session);
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

  it("C3 (seal throughput): a sync started before the launch job ran does NOT seal a 'syncing' chain first; its own seal at the end does", async () => {
    makeChain();
    await createMarkerStore({ userData: () => userData }).writeBackupMarker(UDID, "syncing");
    const s = service();
    const sealSpy = jest.spyOn(s, "seal");
    const session = await s.beginSync(UDID);
    expect(sealSpy).not.toHaveBeenCalled();
    expect(plaintextLeft().length).toBeGreaterThan(0); // a part-sealed chain is fine under C-DELTA
    await s.finishSync(session);
    expect(sealSpy).toHaveBeenCalled();
    expect(plaintextLeft()).toEqual([]);
    expect(await readMarkerAt(backups, UDID)).toBe("encrypted");
  });

  it("migrates a pre-2.40 plaintext chain and is resumable", async () => {
    makeChain();
    const s = service();
    expect(await s.migrate(UDID)).toBe("encrypted");
    expect(plaintextLeft()).toEqual([]);
    expect(await s.migrate(UDID)).toBe("encrypted");
  });
});

// ---------------------------------------------------------------------------
// B2 — a sealed backup that fails authentication does not end iPhone sync
// ---------------------------------------------------------------------------
describe("B2: unreadable kept backup → quarantine + full backup", () => {
  const T0 = 1_760_000_000_000;
  const smsFile = () => path.join(chain, SMS_DB_FILE_ID.slice(0, 2), SMS_DB_FILE_ID);

  /** Flip one byte INSIDE the first chunk's ciphertext (not the header: a header flip reads as "damaged"). */
  function flipByteInChunk(file: string): Buffer {
    const buf = fs.readFileSync(file);
    buf[60 + 5] ^= 0x01;
    fs.writeFileSync(file, buf);
    return buf;
  }

  async function walkFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else out.push(f);
      }
    };
    walk(dir);
    return out;
  }

  it("one flipped byte: the chain moves to Backups/.quarantine/<udid>-<ms> sealed and untouched; the sync is a full backup", async () => {
    makeChain();
    const s = service({ now: () => T0 });
    await s.migrate(UDID);
    const flipped = flipByteInChunk(smsFile());
    const session = await s.beginSync(UDID, { strategy: "full" });

    expect(session).toEqual({ kind: "first", udid: UDID, quarantined: { reasonCode: "INTEGRITY" } });
    const moved = path.join(backups, QUARANTINE_DIR_NAME, `${UDID}-${T0}`);
    expect(fs.existsSync(chain)).toBe(false);
    expect(fs.existsSync(path.join(moved, "Manifest.db"))).toBe(true);
    // Sealed: every content file with bytes is a KEPRENC container, no temp left behind.
    const movedFiles = await walkFiles(moved);
    expect(movedFiles.filter((f) => f.endsWith(KENC_TMP_SUFFIX))).toEqual([]);
    expect(plaintextIn(moved)).toEqual([]);
    for (const f of movedFiles) {
      if (path.basename(f).endsWith(".plist") || fs.statSync(f).size === 0) continue;
      expect((await probeHeader(f)).encrypted).toBe(true);
    }
    // Untouched: the damaged file is byte-identical to what failed.
    expect(fs.readFileSync(path.join(moved, SMS_DB_FILE_ID.slice(0, 2), SMS_DB_FILE_ID))).toEqual(flipped);
    // Marker gone with the chain; the lock is still this sync's until finishSync.
    expect(await readMarkerAt(backups, UDID)).toBe("absent");
    expect(s.busyReason(UDID)).toBe("syncing");
    await s.finishSync(session);
    expect(s.busyReason(UDID)).toBeNull();

    // The next sync is not blocked: no chain → first backup, no second quarantine.
    const next = await s.beginSync(UDID, { strategy: "full" });
    expect(next).toEqual({ kind: "first", udid: UDID });
    await s.finishSync(next);
  });

  it("a data key that is no longer held (KEY_MISSING) is quarantined too", async () => {
    makeChain();
    await service().migrate(UDID);
    const gone = createFileCrypto(
      {
        currentKey: async () => ({ keyId: KEY_ID, key: KEY }),
        keyFor: async () => {
          throw new DataKeyUnavailableError("no key with that id");
        },
      },
      { chunkSize: 64 },
    );
    const s = service({ files: () => gone, now: () => T0 });
    const session = await s.beginSync(UDID, { strategy: "full" });
    expect(session).toEqual({ kind: "first", udid: UDID, quarantined: { reasonCode: "KEY_MISSING" } });
    expect(fs.existsSync(path.join(backups, QUARANTINE_DIR_NAME, `${UDID}-${T0}`))).toBe(true);
    await s.finishSync(session);
  });

  it("disk space still refuses and keeps the chain in place (a later try can succeed)", async () => {
    makeChain();
    await service().migrate(UDID);
    const s = service({ freeBytes: async () => 10 });
    await expect(s.beginSync(UDID, { strategy: "full" })).rejects.toMatchObject({ reason: "disk-space" });
    expect(fs.existsSync(path.join(chain, "Manifest.db"))).toBe(true);
    expect(fs.existsSync(path.join(backups, QUARANTINE_DIR_NAME))).toBe(false);
    expect(s.busyReason(UDID)).toBeNull();
  });

  it("an I/O error alongside an authentication failure still refuses (only unrecoverable-only quarantines)", async () => {
    makeChain();
    await service().migrate(UDID);
    flipByteInChunk(smsFile());
    const flaky = {
      ...files,
      decryptToFile: async (src: string, dest: string, opts?: { requireEncrypted?: boolean }) => {
        if (src.endsWith(OTHER_ID)) throw Object.assign(new Error("i/o"), { code: "EIO" });
        return files.decryptToFile(src, dest, opts);
      },
    };
    const s = service({ files: () => flaky });
    await expect(s.beginSync(UDID, { strategy: "full" })).rejects.toMatchObject({ reason: "unreadable" });
    expect(fs.existsSync(path.join(chain, "Manifest.db"))).toBe(true);
    expect(plaintextLeft()).toEqual([]);
    expect(s.busyReason(UDID)).toBeNull();
  });

  it("X1: a chain whose re-seal did not finish is NOT moved to quarantine (no plaintext at rest there); the marker stays", async () => {
    makeChain();
    await service().migrate(UDID);
    flipByteInChunk(smsFile());
    // The attachment file opens fine during the unseal but cannot be sealed again (EIO).
    const flaky = {
      beforeSeal: (p: string) => {
        if (p.endsWith(OTHER_ID)) throw Object.assign(new Error("i/o"), { code: "EIO" });
      },
    };
    const s = service({ sealEngineOptions: flaky, now: () => T0 });
    await expect(s.beginSync(UDID, { strategy: "full" })).rejects.toMatchObject({ reason: "unreadable" });
    const quarantineRoot = path.join(backups, QUARANTINE_DIR_NAME);
    expect(fs.existsSync(quarantineRoot)).toBe(false);
    expect(fs.existsSync(path.join(chain, "Manifest.db"))).toBe(true);
    // Marker says `sealing` (not encrypted), so the next launch/sync seals the leftover plaintext.
    expect(await readMarkerAt(backups, UDID)).toBe("sealing");
    expect(s.busyReason(UDID)).toBeNull();
  });

  it("deleteOldestQuarantined removes the oldest quarantined copy only, and reports when none is left", async () => {
    const root = path.join(backups, QUARANTINE_DIR_NAME);
    const older = path.join(root, `${UDID}-${T0 - 5_000}`);
    const newer = path.join(root, `${UDID}-${T0 - 1_000}`);
    for (const d of [newer, older]) {
      fs.mkdirSync(path.join(d, "ab"), { recursive: true });
      fs.writeFileSync(path.join(d, "ab", "x"), "sealed bytes");
    }
    const s = service({ now: () => T0 });
    expect(await s.deleteOldestQuarantined()).toBe(true);
    expect(fs.existsSync(older)).toBe(false);
    expect(fs.existsSync(newer)).toBe(true);
    expect(await s.deleteOldestQuarantined()).toBe(true);
    expect(fs.existsSync(newer)).toBe(false);
    expect(await s.deleteOldestQuarantined()).toBe(false);
  });

  it("launch deletes quarantined chains older than 30 days and keeps younger ones", async () => {
    const root = path.join(backups, QUARANTINE_DIR_NAME);
    const old = path.join(root, `${UDID}-${T0 - QUARANTINE_MAX_AGE_MS - 60_000}`);
    const young = path.join(root, `${UDID}-${T0 - QUARANTINE_MAX_AGE_MS + 60_000}`);
    for (const d of [old, young]) {
      fs.mkdirSync(path.join(d, "ab"), { recursive: true });
      fs.writeFileSync(path.join(d, "ab", "x"), "sealed bytes");
    }
    const outcomes = await service({ now: () => T0 }).runLaunchJob();
    expect(outcomes.quarantinePurged).toBe("1");
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(young)).toBe(true);
  });

  it("the plain sentence the user is shown", () => {
    expect(BACKUP_AT_REST_QUARANTINED_MESSAGE).toBe(
      "Keepr couldn't read the saved iPhone backup, so it will make a fresh full backup — this takes longer.",
    );
  });
});

// ---------------------------------------------------------------------------
// Should-fix: the lock is claimed before the new-chain step moves the chain
// ---------------------------------------------------------------------------
describe("per-phone lock covers the new-chain step (underLock)", () => {
  it("a launch migration during underLock stands aside; the chain is not moved under it", async () => {
    makeChain();
    const s = service();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const begun = s.beginSync(UDID, { strategy: "full", underLock: () => gate });
    await new Promise((r) => setImmediate(r));
    expect(await s.migrate(UDID)).toBe("busy");
    release();
    const session = await begun;
    await s.finishSync(session);
    expect(s.busyReason(UDID)).toBeNull();
  });

  it("an error in underLock propagates unchanged (not a refusal) and releases the lock", async () => {
    makeChain();
    const s = service();
    const boom = new Error("move failed");
    await expect(s.beginSync(UDID, { underLock: async () => { throw boom; } })).rejects.toBe(boom);
    expect(s.busyReason(UDID)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Should-fix: progress for passes no sync is watching
// ---------------------------------------------------------------------------
describe("founder must-fix 2026-10-09: reseal at once, on quit, and while idle", () => {
  const indexFiles = () => ["Manifest.db", "Info.plist", "Status.plist", "Manifest.plist"].map((n) => path.join(chain, n));

  it("quit during a sync: the unsealed index files are sealed before exit; the rest is left to the launch job", async () => {
    makeChain();
    const s = service();
    await s.migrate(UDID);
    expect(s.sealIndexForQuit(1000)).toBeNull(); // nothing unsealed: the quit is not held
    await s.beginSync(UDID); // C-DELTA: index + plists unsealed
    const sent = write("cd/" + "c".repeat(40), "a file the phone sent before the quit");
    for (const f of indexFiles()) expect(headerOf(f).equals(MAGIC)).toBe(false);
    const quitting = s.sealIndexForQuit(5000);
    expect(quitting).not.toBeNull();
    await quitting;
    for (const f of indexFiles()) expect(headerOf(f).equals(MAGIC)).toBe(true);
    expect(headerOf(sent).equals(MAGIC)).toBe(false); // the launch job's
    expect(await readMarkerAt(backups, UDID)).toBe("syncing");
    // Next launch: sealed, and the marker reads `sealing` while it runs.
    const seen: string[] = [];
    const launch = service({ sealEngineOptions: { beforeSeal: () => void readMarkerAt(backups, UDID).then((m) => seen.push(m)) } });
    expect((await launch.runLaunchJob())[UDID]).toBe("encrypted");
    expect(plaintextLeft()).toEqual([]);
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(["sealing"]));
  });

  it("quit while a background seal runs: it is paused, then the index is sealed, within the bound", async () => {
    makeChain();
    const s = service();
    await s.migrate(UDID);
    const session = await s.beginSync(UDID);
    let quitting: Promise<void> | null = null;
    let n = 0;
    const s2 = service({
      sealEngineOptions: {
        beforeSeal: () => {
          if (++n === 1) quitting = s2.sealIndexForQuit(5000);
        },
      },
    });
    // (a fresh service shares the disk, not the in-memory state: hand it the open index)
    (s2 as unknown as { indexUnsealed: Set<string> }).indexUnsealed.add(UDID);
    // Make the newest-first pass reach a content file first so the pause lands before the index.
    write("cd/" + "d".repeat(40), "new");
    await s2.finishSync(session);
    await (quitting as unknown as Promise<void>);
    for (const f of indexFiles()) expect(headerOf(f).equals(MAGIC)).toBe(true);
  });

  it("the quit wait is bounded: a pass that never stops does not hold the quit", async () => {
    makeChain();
    const s = service();
    const internals = s as unknown as { busy: Map<string, string>; pausable: Map<string, Int32Array> };
    internals.busy.set(UDID, "sealing");
    internals.pausable.set(UDID, new Int32Array(new SharedArrayBuffer(4)));
    const t0 = Date.now();
    await s.sealIndexForQuit(80);
    expect(Date.now() - t0).toBeLessThan(2000);
    internals.busy.delete(UDID);
    internals.pausable.delete(UDID);
  });

  it("idle recovery: a chain left `syncing` with no pass on it is resealed without a restart; a busy phone is left alone", async () => {
    makeChain();
    const s = service();
    await s.migrate(UDID);
    await s.beginSync(UDID);
    write("cd/" + "e".repeat(40), "written by the sync");
    // The sync's seal never ran (the founder's beta.3 case); the lock is still held.
    expect(await s.recoverIdle()).toEqual({});
    (s as unknown as { release: (u: string) => void }).release(UDID);
    expect(await s.recoverIdle()).toEqual({ [UDID]: "encrypted" });
    expect(plaintextLeft()).toEqual([]);
    expect(await readMarkerAt(backups, UDID)).toBe("encrypted");
  });

  it("idle recovery backs off 5, 10, 20 min … on a chain whose pass keeps ending incomplete; a new sync starts it over", async () => {
    makeChain();
    let clock = 1_000_000;
    const min = 60_000;
    let attempts = 0;
    let broken: string | null = null;
    const s = service({
      now: () => clock,
      sealEngineOptions: {
        retryDelayMs: 0,
        beforeSeal: (f) => {
          if (broken && f === broken) {
            attempts++;
            throw Object.assign(new Error("i/o"), { code: "EIO" });
          }
        },
      },
    });
    await s.migrate(UDID);
    const session = await s.beginSync(UDID);
    broken = write("cd/" + "f".repeat(40), "a file that can never be sealed");
    (s as unknown as { release: (u: string) => void }).release(UDID); // the sync's seal never ran
    // Attempt times (minutes after the first): 0, 5, 15, 35 — then the gaps keep doubling.
    const seen: Array<[number, number]> = [];
    for (let t = 0; t <= 40; t++) {
      clock = 1_000_000 + t * min;
      const before = attempts;
      const out = await s.recoverIdle();
      if (attempts > before) {
        seen.push([t, attempts - before]);
        expect(out[UDID]).not.toBe("encrypted");
      }
    }
    expect(seen).toEqual([[0, 1], [5, 1], [15, 1], [35, 1]]);
    expect(idleRecoveryBackoffMs(1)).toBe(5 * min);
    expect(idleRecoveryBackoffMs(2)).toBe(10 * min);
    expect(idleRecoveryBackoffMs(20)).toBe(6 * 60 * min); // capped
    // A new sync starts it over: the next idle pass is not held back.
    const hold = await s.beginSync(UDID).catch(() => null);
    expect(hold).not.toBeNull();
    (s as unknown as { release: (u: string) => void }).release(UDID);
    const before = attempts;
    await s.recoverIdle();
    expect(attempts).toBe(before + 1);
    void session;
    broken = null;
    // Once the file can be sealed the pass completes and the back-off is cleared.
    clock += 24 * 60 * min;
    expect((await s.recoverIdle())[UDID]).toBe("encrypted");
  });

  it("a stale pause flag (no pass holds the lock) does not hang a sync: it starts promptly", async () => {
    makeChain();
    const lines: string[] = [];
    const s = service({ log: (_l, m) => lines.push(m) });
    await s.migrate(UDID);
    (s as unknown as { pausable: Map<string, Int32Array> }).pausable.set(UDID, new Int32Array(new SharedArrayBuffer(4)));
    expect(s.busyReason(UDID)).toBeNull();
    const session = await s.beginSync(UDID);
    expect(session.udid).toBe(UDID);
    expect(lines).toContain("[BackupAtRest] cleared a stale pause flag; no pass holds the phone");
    (s as unknown as { release: (u: string) => void }).release(UDID);
  }, 3000);

  it("a seal pass logs its start with the work to do (an interrupted run leaves a trace); counts only, no paths", async () => {
    makeChain();
    const lines: Array<{ m: string; d?: Record<string, unknown> }> = [];
    await service({ log: (_l, m, d) => lines.push({ m, d }) }).migrate(UDID);
    const startLine = lines.find((l) => l.m === "[BackupAtRest] seal pass started");
    expect(startLine?.d).toMatchObject({ phase: "migrating", files: 9 });
    expect(JSON.stringify(lines)).not.toContain(chain);
  });

  it("must-fix #2: crash mid-sync (incl. a READ-ONLY file the phone sent) → launch reseal → `encrypted`; the SECOND launch does no work and the phone is free", async () => {
    makeChain();
    const s = service();
    await s.migrate(UDID);
    await s.beginSync(UDID);
    const ro = write("cd/" + "9".repeat(40), "a file the phone sent read-only");
    fs.chmodSync(ro, 0o444);
    // What Windows does: a rename cannot replace a read-only file.
    const realRename = fs.renameSync;
    jest.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (fs.existsSync(to) && (fs.statSync(to).mode & 0o200) === 0) {
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      }
      return realRename(from, to);
    });
    // "Crash": the process is gone; a new one launches.
    const first = service();
    expect((await first.runLaunchJob())[UDID]).toBe("encrypted");
    expect(plaintextLeft()).toEqual([]);
    expect(await readMarkerAt(backups, UDID)).toBe("encrypted");
    // Second launch: no pass, no progress, nothing touched, and a sync can start at once.
    const second = service();
    const events: unknown[] = [];
    second.on("progress", (p) => events.push(p));
    const seal = jest.spyOn(second, "seal");
    const mtimes = allContentFiles().map((f) => fs.statSync(f).mtimeMs);
    expect((await second.runLaunchJob())[UDID]).toBe("encrypted");
    expect(seal).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(allContentFiles().map((f) => fs.statSync(f).mtimeMs)).toEqual(mtimes);
    expect(second.busyReason(UDID)).toBeNull();
    const session = await second.beginSync(UDID);
    expect(session.kind).toBe("keepr");
    await second.finishSync(session);
  });

  it("a seal pass takes the newest files first (what the last sync wrote, the unsealed index)", async () => {
    makeChain();
    const old = new Date(Date.now() - 86_400_000);
    for (const f of allContentFiles()) fs.utimesSync(f, old, old);
    const fresh = write("cd/" + "f".repeat(40), "just written");
    const order: string[] = [];
    await service({ sealEngineOptions: { beforeSeal: (p) => order.push(p) } }).seal(UDID);
    expect(order[0]).toBe(fresh);
  });
});

describe("durability of the renames (seal throughput: one directory fsync per touched directory)", () => {
  it("every directory a seal renamed into is fsynced before the marker says encrypted", async () => {
    makeChain();
    const order: string[] = [];
    const realFsyncDir = fileCryptoModule.fsyncDir;
    jest.spyOn(fileCryptoModule, "fsyncDir").mockImplementation(async (d: string) => {
      order.push(`dir:${path.relative(chain, d) || "."}`);
      return realFsyncDir(d);
    });
    const store = createMarkerStore({ userData: () => userData });
    const realWrite = store.writeBackupMarker.bind(store);
    jest.spyOn(store, "writeBackupMarker").mockImplementation(async (u, state) => {
      order.push(`marker:${state}`);
      return realWrite(u, state);
    });
    await service({ markers: () => store }).migrate(UDID);
    const sealedDirs = new Set(
      fs
        .readdirSync(chain, { recursive: true })
        .map(String)
        .filter((rel) => fs.statSync(path.join(chain, rel)).isFile() && fs.statSync(path.join(chain, rel)).size > 0 && !rel.endsWith(".plist"))
        .map((rel) => `dir:${path.dirname(rel)}`),
    );
    const encryptedAt = order.indexOf("marker:encrypted");
    expect(encryptedAt).toBeGreaterThan(0);
    for (const d of sealedDirs) {
      expect(order.indexOf(d)).toBeGreaterThanOrEqual(0);
      expect(order.indexOf(d)).toBeLessThan(encryptedAt);
    }
  });
});

describe("progress", () => {
  it("the percentage is by bytes plus a per-file weight, so a few large files are not 'done' when the many small ones are", () => {
    const p = { udid: UDID, phase: "sealing" as const, done: 900, total: 1000, doneUnits: 10, totalUnits: 100 };
    expect(describeBackupAtRestProgress(p).percent).toBe(10);
    expect(describeBackupAtRestProgress({ udid: UDID, phase: "sealing", done: 900, total: 1000 }).percent).toBe(90);
  });

  it("the securing line carries a time-based estimate once there is one (banner, outside the sync screen)", () => {
    const base = { udid: UDID, phase: "migrating" as const, done: 10, total: 100, doneUnits: 42, totalUnits: 100 };
    expect(describeBackupAtRestProgress({ ...base, etaMs: 12 * 60_000 }).message).toBe("Securing your iPhone backup… 42% (about 12 min left)");
    expect(describeBackupAtRestProgress({ ...base, etaMs: 65 * 60_000 }).message).toBe("Securing your iPhone backup… 42% (about 1 h 5 min left)");
    expect(describeBackupAtRestProgress({ ...base, etaMs: 20_000 }).message).toBe("Securing your iPhone backup… 42% (less than a minute left)");
    expect(describeBackupAtRestProgress(base).message).toBe("Securing your iPhone backup… 42%");
  });

  it("Cancel while waiting for a background pass to pause: the sync ends as cancelled and the pass resumes to the end", async () => {
    makeChain();
    const ac = new AbortController();
    let s: BackupAtRest | null = null;
    let waiting: Promise<unknown> | null = null;
    let n = 0;
    s = service({
      sealEngineOptions: {
        beforeSeal: () => {
          if (++n === 1) {
            waiting = (s as BackupAtRest).beginSync(UDID, { signal: ac.signal }).catch((e) => e);
            ac.abort();
          }
        },
      },
    });
    expect(await s.migrate(UDID)).toBe("paused");
    expect(await (waiting as unknown as Promise<unknown>)).toMatchObject({ reason: "cancelled" });
    for (let i = 0; i < 300 && (plaintextLeft().length > 0 || s.busyReason(UDID)); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(plaintextLeft()).toEqual([]);
    expect(await readMarkerAt(backups, UDID)).toBe("encrypted");
  });

  it("a seal pass reports units that end exactly at the total, and at most about once a second in between", async () => {
    makeChain();
    const s = service();
    const seen: BackupAtRestProgress[] = [];
    await s.seal(UDID, (p) => seen.push(p));
    expect(seen[0]).toMatchObject({ done: 0, doneUnits: 0 });
    const last = seen[seen.length - 1];
    expect(last.doneUnits).toBe(last.totalUnits);
    expect(seen.length).toBeLessThanOrEqual(3); // start, end (+1 if a second passed): never per file
  });

  describe("seal progress measures this pass's work (BACKLOG-3816)", () => {
    const BIG = 5 * 1024 * 1024;
    const W = PROGRESS_FILE_WEIGHT_BYTES;

    function sealedChainWithMany(): string[] {
      makeChain();
      const extra: string[] = [];
      for (let i = 0; i < 300; i++) {
        extra.push(write(`${String(i % 100).padStart(2, "0")}/${"a".repeat(30)}${String(i).padStart(10, "0")}`, crypto.randomBytes(200)));
      }
      return extra;
    }
    function age(files: string[]): void {
      const old = new Date(Date.now() - 2 * 3600_000);
      for (const f of files) fs.utimesSync(f, old, old);
    }
    /** A sync: delta unseal, the "backup tool" writes `during`, then the post-sync seal. */
    async function incremental(s: BackupAtRest, during: () => void): Promise<{ seen: BackupAtRestProgress[]; opensAtFirst: number; index: number }> {
      const session = await s.beginSync(UDID, { strategy: "delta" });
      during();
      const index = indexUnits(); // the index files, unsealed, as the pass will find them
      const seen: BackupAtRestProgress[] = [];
      let opens = 0;
      let opensAtFirst = -1;
      const spy = jest.spyOn(fs.promises, "open");
      try {
        await s.finishSync(session, (p) => {
          if (opensAtFirst < 0) opensAtFirst = spy.mock.calls.length;
          seen.push(p);
        });
        opens = spy.mock.calls.length;
      } finally {
        spy.mockRestore();
      }
      expect(opens).toBeGreaterThan(0); // the spy is live: the engine opens files
      return { seen, opensAtFirst, index };
    }
    const indexUnits = (): number =>
      DELTA_UNSEAL_FILES.reduce((n, rel) => n + fs.statSync(path.join(chain, rel)).size + W, 0);

    it("one new file among many sealed ones: 0% to 100% over that file's bytes, no open of the unchanged files before the first report", async () => {
      const extra = sealedChainWithMany();
      const s = service();
      await s.seal(UDID);
      age(allContentFiles());
      const { seen, opensAtFirst, index } = await incremental(s, () => {
        write(`ee/${"e".repeat(40)}`, crypto.randomBytes(BIG));
      });
      const expected = index + BIG + W;
      expect(seen[0]).toMatchObject({ doneUnits: 0, totalUnits: expected });
      expect(describeBackupAtRestProgress(seen[0]).percent).toBe(0);
      const last = seen[seen.length - 1];
      expect(last).toMatchObject({ doneUnits: expected, totalUnits: expected });
      expect(describeBackupAtRestProgress(last).percent).toBe(100);
      for (const p of seen) expect(p.doneUnits as number).toBeLessThanOrEqual(p.totalUnits as number);
      expect(opensAtFirst).toBeLessThan(10); // fixed setup reads only (plists); a pre-pass would open all 300+ files
      expect(plaintextLeft()).toEqual([]);
      expect(extra.length).toBe(300);
    });

    it("a sealed file with a new mtime (estimate too high): the total shrinks and the pass ends at 100%", async () => {
      const extra = sealedChainWithMany();
      const s = service();
      await s.seal(UDID);
      age(allContentFiles());
      const { seen, index } = await incremental(s, () => {
        const now = new Date();
        fs.utimesSync(extra[0], now, now);
      });
      expect(seen[0].totalUnits as number).toBeGreaterThan(index);
      const last = seen[seen.length - 1];
      expect(last.totalUnits).toBe(index);
      expect(last.doneUnits).toBe(last.totalUnits);
    });

    it("a plaintext file with an old mtime (estimate too low): still sealed, counted, done never above total", async () => {
      sealedChainWithMany();
      const s = service();
      await s.seal(UDID);
      age(allContentFiles());
      // A clock that moves 1.5 s per reading makes every batch emit, so updates exist
      // MID-pass (the real throttle is one per second). The missed file is older than the
      // estimate's cut but newer than the sealed files, so it is handled early and files
      // still follow it.
      let clock = Date.now();
      const clockSpy = jest.spyOn(Date, "now").mockImplementation(() => (clock += 1500));
      let seen: BackupAtRestProgress[];
      let index: number;
      try {
        ({ seen, index } = await incremental(s, () => {
          const f = write(`dd/${"d".repeat(40)}`, crypto.randomBytes(1000));
          const hourAgo = new Date(clock - 3600_000);
          fs.utimesSync(f, hourAgo, hourAgo);
        }));
      } finally {
        clockSpy.mockRestore();
      }
      const missed = 1000 + W;
      const mid = seen.slice(1, -1);
      expect(mid.length).toBeGreaterThan(5);
      for (const p of seen) expect(p.doneUnits as number).toBeLessThanOrEqual(p.totalUnits as number);
      // once the missed file has been sealed, the total includes it
      const afterMissed = mid.filter((p) => (p.doneUnits as number) >= index + missed);
      expect(afterMissed.length).toBeGreaterThan(0);
      for (const p of afterMissed) expect(p.totalUnits as number).toBeGreaterThanOrEqual(index + missed);
      const last = seen[seen.length - 1];
      expect(last.doneUnits).toBe(index + 1000 + W);
      expect(last.totalUnits).toBe(last.doneUnits);
      expect(plaintextLeft()).toEqual([]);
    });

    it("state unknown (no sync in this process): the estimate is the whole chain", async () => {
      sealedChainWithMany();
      const s = service();
      await s.seal(UDID);
      age(allContentFiles());
      const seen: BackupAtRestProgress[] = [];
      await s.seal(UDID, (p) => seen.push(p));
      const whole = allContentFiles().reduce((n, f) => n + fs.statSync(f).size + W, 0);
      expect(seen[0].totalUnits).toBe(whole);
      // everything was sealed already: the verdicts take the total down to nothing
      const last = seen[seen.length - 1];
      expect(last).toMatchObject({ doneUnits: 0, totalUnits: 0 });
      expect(describeBackupAtRestProgress(last).percent).toBe(100);
    });

    it("a sync requested during the post-sync pass pauses it at the next file", async () => {
      sealedChainWithMany();
      let s: BackupAtRest | null = null;
      let n = 0;
      let waiting: Promise<unknown> | null = null;
      s = service({
        sealEngineOptions: {
          beforeSeal: () => {
            if (++n === 1) waiting = (s as BackupAtRest).beginSync(UDID, { strategy: "delta" }).catch((e) => e);
          },
        },
      });
      expect(await s.migrate(UDID)).toBe("paused");
      const next = (await (waiting as unknown as Promise<unknown>)) as { kind?: string };
      expect(next.kind).toBe("keepr");
    });
  });

  it("a seal with no caller callback reports through the 'progress' event, start to 100%", async () => {
    makeChain();
    const s = service();
    const seen: BackupAtRestProgress[] = [];
    s.on("progress", (p: BackupAtRestProgress) => seen.push(p));
    await s.migrate(UDID);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[0]).toMatchObject({ udid: UDID, phase: "migrating", done: 0 });
    const last = seen[seen.length - 1];
    expect(last.done).toBe(last.total);
    expect(describeBackupAtRestProgress(last).message).toBe("Securing your iPhone backup… 100%");
  });

  it("a caller callback receives the progress instead of the event (no double reporting)", async () => {
    makeChain();
    const s = service();
    const viaEvent: BackupAtRestProgress[] = [];
    const viaCallback: BackupAtRestProgress[] = [];
    s.on("progress", (p: BackupAtRestProgress) => viaEvent.push(p));
    await s.seal(UDID, (p) => viaCallback.push(p));
    expect(viaCallback.length).toBeGreaterThan(0);
    expect(viaEvent).toEqual([]);
  });

  it("unsealing keeps its file-count wording", () => {
    expect(describeBackupAtRestProgress({ udid: UDID, phase: "unsealing", done: 500, total: 1000 }).message).toBe(
      "Preparing your saved iPhone backup (500 of 1,000 files)...",
    );
  });
});
