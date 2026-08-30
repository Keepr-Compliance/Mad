/**
 * @jest-environment node
 *
 * THE REFUSAL CONTROL (BACKLOG-2993) — the one test the founder's scope cut
 * kept, because it is the off-by-one guard nothing else can replace:
 *
 *   A real chain-built VERSION 69 database, opened through the REAL
 *   initialize() path, must be REFUSED — not migrated, not half-written by
 *   schema.sql, not crashed, not restore-looped, not reported initialized.
 *
 * WHY 69 SPECIFICALLY. The baseline rule is "strictly greater than any
 * version any existing database can hold", and 69 is that maximum (develop
 * and shipped main both topped out there at the reset). A fence at 69
 * instead of 70 would silently ACCEPT the chain-built databases the reset
 * exists to reject — with no visible symptom anywhere else in CI. This test
 * is what makes 70-not-69 provable.
 *
 * THE FIXTURE IS IRREPLACEABLE. fixtures/chain-v69-schema.sql is the
 * transcript of the OLD schema.sql + the FULL real migration chain, captured
 * at 0bd6703bb in the one-way window before BACKLOG-2993 deleted the chain.
 * It is also the frozen side of the schema-parity control
 * (databaseService.schema-parity.test.ts). Never regenerate it; never "fix"
 * a red run by editing it.
 *
 * The file is encrypted with the EXACT pragma text the production opener
 * uses (`key = "x'test-encryption-key-hex'"` — not valid raw-key hex, so the
 * cipher derives it as a passphrase; keyed any other way the fence would see
 * a decrypt error, not a version, and this suite would be testing the wrong
 * axis).
 *
 * Runs with the REAL better-sqlite3-multiple-ciphers driver.
 *
 * SCOPE NOTE (founder ruling, 2026-08-30): the wider control matrix this
 * suite once carried — a 68/69/70/71 boundary sweep on four fixtures, a
 * dialog-then-quit ordering control, byte-identical SHA-256 proofs, hot-WAL
 * and cannot-open axis cases — was deliberately dropped. Three known users,
 * all reinstalling fresh via the cleanup scripts; the refusal path is a
 * backstop for a case being actively prevented. What remains is this file
 * plus the fresh-install assertion below.
 */

import fs from "fs";
import os from "os";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";

// ---------------------------------------------------------------------------
// MOCKS — must be declared before databaseService is required.
// ---------------------------------------------------------------------------

// THE LOAD-BEARING ONE. jest.config.js maps better-sqlite3-multiple-ciphers
// to a stub; this factory overrides the mapping with the REAL module so that
// databaseService's OWN opens run against the real driver.
jest.mock("better-sqlite3-multiple-ciphers", () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../../node_modules/better-sqlite3-multiple-ciphers"),
);

/** Set per-test; electron's app.getPath("userData") answers with this. */
let userDataDir = "/tmp/unset-baseline-refusal";

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

// isDatabaseEncrypted MUST resolve true: with the standard `false` mock,
// _checkMigrationNeeded() would send the fixture through
// _migrateToEncryptedDatabase, which rewrites the file before the fence runs.
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
import { isInitialized as dbConnectionIsInitialized } from "../db/core/dbConnection";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

const V69_TRANSCRIPT_PATH = path.join(__dirname, "fixtures", "chain-v69-schema.sql");

/** EXACTLY the production opener's keying text (databaseService._openDatabase). */
const PRODUCTION_KEY_PRAGMA = `key = "x'test-encryption-key-hex'"`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyService = any;

describe("schema-baseline fence — a chain-built v69 database is refused (BACKLOG-2993)", () => {
  let service: AnyService;
  let tmpDir: string;
  let dbFile: string;
  const createdTmpDirs: string[] = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-baseline-refusal-"));
    createdTmpDirs.push(tmpDir);
    userDataDir = tmpDir;
    dbFile = path.join(tmpDir, "mad.db");

    showMessageBoxMock.mockReset();
    showMessageBoxMock.mockResolvedValue({ response: 0 });
    quitMock.mockReset();

    // Deferred require so the jest.mock factories above are applied first.
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

  /** Replay the frozen v69 transcript onto an encrypted real file at mad.db. */
  function buildEncryptedV69Fixture(): void {
    const db = new RealDatabase(dbFile) as DatabaseType;
    db.pragma(PRODUCTION_KEY_PRAGMA);
    db.pragma("cipher_compatibility = 4");
    db.exec(fs.readFileSync(V69_TRANSCRIPT_PATH, "utf8"));
    db.close();
  }

  /** schema_version read back through a fresh keyed readonly connection. */
  function readVersionFromDisk(): number {
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

  it("PRECONDITION: the fixture opens with the production keying and reads schema_version 69", () => {
    buildEncryptedV69Fixture();
    expect(readVersionFromDisk()).toBe(69);
  });

  it("REFUSES the v69 database: terminal dialog + quit — not migrated, not half-written, not crashed, not restored, not initialized", async () => {
    buildEncryptedV69Fixture();

    const restoreSpy = jest.spyOn(service, "_attemptAutoRestore");

    let caught: unknown;
    try {
      await service.initialize();
    } catch (e) {
      caught = e;
    }

    // Refused with the DISTINCT error class — not a crash, not a migration
    // failure, and initialize() did not lie with `return true`.
    expect(caught).toBeInstanceOf(SchemaBaselineRefusalError);
    expect((caught as SchemaBaselineRefusalError).foundVersion).toBe(69);

    // Terminal: auto-restore never ran (every restorable backup is also
    // pre-baseline; that path would restore-and-refuse in a loop).
    expect(restoreSpy).not.toHaveBeenCalled();

    // Not initialized — through EITHER predicate the 46 call sites gate on.
    expect(service.isInitialized()).toBe(false);
    expect(dbConnectionIsInitialized()).toBe(false);

    // Not migrated and not half-written: the version on disk is still 69,
    // and no migration machinery touched the directory (no rolling backup,
    // no encryption-migration scratch files).
    expect(readVersionFromDisk()).toBe(69);
    const siblings = fs.readdirSync(tmpDir);
    expect(siblings.filter((f) => f.includes("-backup-"))).toEqual([]);
    expect(siblings.filter((f) => f.endsWith(".encrypted") || f.endsWith(".backup"))).toEqual([]);

    // Explained, then exited: the dialog names the problem and the cleanup
    // scripts, and the app quits.
    expect(showMessageBoxMock).toHaveBeenCalledTimes(1);
    const dialogArg = showMessageBoxMock.mock.calls[0][0] as { message: string; detail: string };
    expect(dialogArg.message).toContain("older version");
    expect(dialogArg.detail).toContain("cleanup");
    expect(quitMock).toHaveBeenCalledTimes(1);
  });

  it("fresh install (no file) lands at schema_version 70 with the four previously-chain-only tables present", async () => {
    expect(fs.existsSync(dbFile)).toBe(false);

    await expect(service.initialize()).resolves.toBe(true);
    expect(service.isInitialized()).toBe(true);
    expect(quitMock).not.toHaveBeenCalled();
    expect(showMessageBoxMock).not.toHaveBeenCalled();

    const version = (
      service.db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as {
        version: number;
      }
    ).version;
    expect(version).toBe(70);

    // Not just the number: the four tables only the old chain used to create
    // must exist on a fresh install — the exact loss the schema regeneration
    // exists to prevent.
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
});
