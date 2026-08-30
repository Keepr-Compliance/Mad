/**
 * @jest-environment node
 *
 * C4 — THE BOUNDARY SWEEP (BACKLOG-2993). One input per branch cannot catch an
 * off-by-one, so the baseline fence's strictly-greater boundary is swept at
 * 68 / 69 / 70 / 71 on REAL files built from committed transcripts of real
 * producers, through the REAL initialize() path:
 *
 *   68 → REFUSE   (chain-v68-schema.sql — old schema.sql + real runner
 *                  clipped to <=68; frozen at 0bd6703bb, irreplaceable)
 *   69 → REFUSE   (chain-v69-schema.sql — old schema.sql + FULL real chain;
 *                  frozen at 0bd6703bb, irreplaceable. 69 is the case that
 *                  matters: a fence at "< 69" would ACCEPT the chain-built
 *                  databases the reset exists to reject)
 *   70 → ACCEPT   (fresh-v70-schema.sql — fresh install on the new schema.sql)
 *   71 → ACCEPT   (fresh-v71-schema.sql — the v70 build plus the one
 *                  documented synthetic edit; a NEWER build's number, and
 *                  refusing it would brick a downgrade with no upside)
 *
 * Plus the structural cases of the predicate (see _evaluateSchemaBaseline):
 * user tables with no schema_version → refuse; empty/absent file → fresh
 * install proceeds and LANDS AT 70; schema_version row missing → refuse; and
 * the hot-WAL canary below.
 *
 * ---------------------------------------------------------------------------
 * THE HOT-WAL CANARY
 * ---------------------------------------------------------------------------
 * A healthy v70 database whose last writer was SIGKILLed (hot -wal, no clean
 * close) must be ACCEPTED — a crashed session is not a pre-reset database.
 * Live experiment for the SR review addendum measured that a readonly
 * open+read of this shape SUCCEEDS under better-sqlite3-multiple-ciphers
 * (with and without the -shm file, main file hash unchanged), so the fence's
 * readonly half never even sees a failure here. This test is therefore a
 * DRIVER-BEHAVIOUR CANARY, stated plainly: no single-line mutation of the
 * fence flips it today; it exists so that a future driver upgrade that starts
 * failing readonly WAL recovery turns a silent behaviour change into a red
 * test, reopening the fall-through question the addendum settled empirically.
 * The corrupt-file axis control lives in the refusal suite and carries the
 * "cannot-open is not pre-reset" discrimination.
 */

import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";

// ---------------------------------------------------------------------------
// MOCKS — must be declared before databaseService is required.
// ---------------------------------------------------------------------------

// Override the moduleNameMapper stub with the REAL driver so databaseService's
// own opens (the readonly fence and _openDatabase) are real.
jest.mock("better-sqlite3-multiple-ciphers", () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../../node_modules/better-sqlite3-multiple-ciphers"),
);

let userDataDir = "/tmp/unset-baseline-sweep";

const showMessageBoxMock = jest.fn();
const quitMock = jest.fn();

jest.mock("electron", () => ({
  app: {
    getPath: jest.fn(() => userDataDir),
    isPackaged: true,
    isReady: jest.fn(() => true),
    whenReady: jest.fn(() => Promise.resolve()),
    quit: (...args: unknown[]) => quitMock(...args),
  },
  dialog: {
    showMessageBox: (...args: unknown[]) => showMessageBoxMock(...args),
  },
  BrowserWindow: { getAllWindows: jest.fn(() => []) },
}));

jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
}));

jest.mock("../logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});

// true: the sweep files are already encrypted; the plaintext-migration path
// must not rewrite them before the fence runs.
jest.mock("../databaseEncryptionService", () => {
  const m = {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("test-encryption-key-hex"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(true),
    getCachedKey: jest.fn(() => "test-encryption-key-hex"),
    getKeyMetadata: jest.fn().mockResolvedValue({}),
  };
  return { __esModule: true, default: m, databaseEncryptionService: m };
});

jest.mock("../contactsService", () => ({ getContactNames: jest.fn(() => Promise.resolve([])) }));
jest.mock("../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: jest.fn(() => false),
}));

import { SchemaBaselineRefusalError } from "../../types";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

const DRIVER_PATH = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "node_modules",
  "better-sqlite3-multiple-ciphers",
);
const FIXTURES = path.join(__dirname, "fixtures");
const PRODUCTION_KEY_PRAGMA = `key = "x'test-encryption-key-hex'"`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyService = any;

describe("schema-baseline fence — boundary sweep 68/69/70/71 + structural cases (BACKLOG-2993, C4)", () => {
  let service: AnyService;
  let tmpDir: string;
  let dbFile: string;
  const createdTmpDirs: string[] = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-baseline-sweep-"));
    createdTmpDirs.push(tmpDir);
    userDataDir = tmpDir;
    dbFile = path.join(tmpDir, "mad.db");

    showMessageBoxMock.mockReset();
    showMessageBoxMock.mockResolvedValue({ response: 0 });
    quitMock.mockReset();

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    service = require("../databaseService").default;
    service.db = null;
    service.dbPath = null;
    service.encryptionKey = null;
  });

  afterEach(() => {
    try {
      service.db?.close();
    } catch {
      /* ignore */
    }
    service.db = null;
    service.dbPath = null;
    for (const d of createdTmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  /** Replay a committed transcript onto an encrypted real file at dbFile. */
  function installFixture(fixtureName: string): void {
    const db = new RealDatabase(dbFile) as DatabaseType;
    db.pragma(PRODUCTION_KEY_PRAGMA);
    db.pragma("cipher_compatibility = 4");
    db.exec(fs.readFileSync(path.join(FIXTURES, fixtureName), "utf8"));
    db.close();
  }

  /** schema_version read back through a fresh keyed readonly connection. */
  function readVersion(): number {
    const db = new RealDatabase(dbFile, { readonly: true }) as DatabaseType;
    try {
      db.pragma(PRODUCTION_KEY_PRAGMA);
      db.pragma("cipher_compatibility = 4");
      return (
        db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as {
          version: number;
        }
      ).version;
    } finally {
      db.close();
    }
  }

  async function expectRefusal(expectedVersion: number): Promise<void> {
    let caught: unknown;
    try {
      await service.initialize();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SchemaBaselineRefusalError);
    expect((caught as SchemaBaselineRefusalError).foundVersion).toBe(expectedVersion);
    expect(service.isInitialized()).toBe(false);
    expect(quitMock).toHaveBeenCalled();
    // Untouched: the version on disk is still the old one.
    expect(readVersion()).toBe(expectedVersion);
  }

  async function expectAcceptance(expectedVersion: number): Promise<void> {
    await expect(service.initialize()).resolves.toBe(true);
    expect(service.isInitialized()).toBe(true);
    expect(quitMock).not.toHaveBeenCalled();
    expect(showMessageBoxMock).not.toHaveBeenCalled();
    const version = (
      service.db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as {
        version: number;
      }
    ).version;
    expect(version).toBe(expectedVersion);
  }

  it("68 → REFUSED (one below the last version the chain could produce)", async () => {
    installFixture("chain-v68-schema.sql");
    await expectRefusal(68);
  });

  it("69 → REFUSED (the chain's own head — the boundary case that proves strictly-greater)", async () => {
    installFixture("chain-v69-schema.sql");
    await expectRefusal(69);
  });

  it("70 → ACCEPTED (the baseline itself), and stays at 70", async () => {
    installFixture("fresh-v70-schema.sql");
    await expectAcceptance(70);
  });

  it("71 → ACCEPTED (a newer build's number — refusing would brick a downgrade), and stays at 71", async () => {
    installFixture("fresh-v71-schema.sql");
    await expectAcceptance(71);
  });

  it("STRUCTURAL: user tables but NO schema_version table → REFUSED (pre-baseline relic)", async () => {
    const db = new RealDatabase(dbFile) as DatabaseType;
    db.pragma(PRODUCTION_KEY_PRAGMA);
    db.pragma("cipher_compatibility = 4");
    db.exec("CREATE TABLE some_ancient_table (id TEXT PRIMARY KEY); INSERT INTO some_ancient_table VALUES ('r1');");
    db.close();

    let caught: unknown;
    try {
      await service.initialize();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SchemaBaselineRefusalError);
    expect(String((caught as Error).message)).toContain("no schema_version");
    expect(service.isInitialized()).toBe(false);
  });

  it("STRUCTURAL: schema_version table present but the row is GONE → REFUSED (errs toward refusal, inverting the old runner's default)", async () => {
    installFixture("fresh-v70-schema.sql");
    const db = new RealDatabase(dbFile) as DatabaseType;
    db.pragma(PRODUCTION_KEY_PRAGMA);
    db.pragma("cipher_compatibility = 4");
    db.prepare("DELETE FROM schema_version").run();
    db.close();

    let caught: unknown;
    try {
      await service.initialize();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SchemaBaselineRefusalError);
    expect(String((caught as Error).message)).toContain("no readable version row");
    expect(service.isInitialized()).toBe(false);
  });

  it("STRUCTURAL: no file at all → fresh install proceeds and LANDS AT 70 with the chain-only tables present", async () => {
    expect(fs.existsSync(dbFile)).toBe(false);
    await expectAcceptance(70);
    // Not just the number: the four tables only the old chain used to create
    // must exist on a fresh install — the C3 claim at the initialize() level.
    const tables = new Set(
      (
        service.db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
          .all() as Array<{ name: string }>
      ).map((r: { name: string }) => r.name),
    );
    for (const t of [
      "contact_source_links",
      "transaction_unlocks_cache",
      "contact_link_proposals",
      "contact_link_verdicts",
    ]) {
      expect(tables.has(t)).toBe(true);
    }
  });

  it("STRUCTURAL: an EMPTY existing file (crashed before first schema exec) → fresh install proceeds to 70", async () => {
    fs.writeFileSync(dbFile, Buffer.alloc(0));
    await expectAcceptance(70);
  });

  it("HOT-WAL CANARY: a healthy v70 database with a crashed writer's hot -wal → ACCEPTED, not refused", async () => {
    // Produce the crashed writer for real: a child process that builds the
    // v70 shape in WAL mode and SIGKILLs itself mid-session.
    const writer = path.join(FIXTURES, "hotWalWriter.cjs");
    const result = spawnSync(
      process.execPath,
      [writer, DRIVER_PATH, dbFile, path.join(FIXTURES, "fresh-v70-schema.sql")],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8" },
    );
    // SIGKILL is the SUCCESS path; a zero exit means it did not die hot.
    expect(result.stdout).toContain("HOT_WAL_READY");
    expect(result.signal).toBe("SIGKILL");
    expect(fs.existsSync(`${dbFile}-wal`)).toBe(true);
    expect(fs.statSync(`${dbFile}-wal`).size).toBeGreaterThan(0);

    await expectAcceptance(70);
  });
});
