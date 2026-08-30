/**
 * @jest-environment node
 *
 * C1 — THE REFUSAL CONTROL (BACKLOG-2993). The one that matters most: a real
 * pre-baseline database file, opened through the REAL initialize() path, must
 * be REFUSED, UNMODIFIED, and EXPLAINED — not migrated, not crashed, not
 * restore-looped, not silently reported as initialized.
 *
 * ---------------------------------------------------------------------------
 * THE FIXTURE IS A REAL PRODUCER'S TRANSCRIPT
 * ---------------------------------------------------------------------------
 * `fixtures/v2.27.0-populated.sql` is the shipped v2.27.0 database (schema
 * version 55, populated corpus), produced by the shipped code's own init path
 * (see buildV2270Fixture.gen.ts). It is replayed onto a real file that is
 * ENCRYPTED with the EXACT pragma text the production opener uses
 * (`key = "x'test-encryption-key-hex'"` — the interpolated string is not
 * valid raw-key hex, so the cipher derives it as a passphrase; keying the
 * fixture any other way makes the fence's readonly read fail with a decrypt
 * error and this suite would then be testing the wrong axis). The file is
 * deliberately left NON-WAL: that is the pre-WAL-era shape whose header the
 * read-write opener's `journal_mode = WAL` pragma would rewrite — the exact
 * write the readonly fence exists to prevent (SR review B2).
 *
 * ---------------------------------------------------------------------------
 * "UNMODIFIED" IS PROVEN BY CONTENT HASH, NEVER MTIME
 * ---------------------------------------------------------------------------
 * SHA-256 of the main database file before vs after, plus a fresh read-only
 * reopen asserting schema_version is unchanged (SR review E2 — under WAL,
 * mtime cannot separate pass from fail; for this non-WAL fixture the hash
 * equality is exact).
 *
 * Runs with the REAL better-sqlite3-multiple-ciphers driver.
 */

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";

// ---------------------------------------------------------------------------
// MOCKS — must be declared before databaseService is required.
// ---------------------------------------------------------------------------

// THE LOAD-BEARING ONE. jest.config.js maps better-sqlite3-multiple-ciphers
// to a stub; this factory overrides the mapping with the REAL module so that
// databaseService's OWN `new Database()` calls (the readonly fence and
// _openDatabase) run against the real driver — the whole point of this suite.
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
// _migrateToEncryptedDatabase, which REWRITES the file before the fence runs
// and falsifies the content-hash control.
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
import { initializationBroadcaster } from "../initializationBroadcaster";

// Real driver, bypassing the jest auto-mock.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

const FIXTURE_SQL_PATH = path.join(__dirname, "fixtures", "v2.27.0-populated.sql");

/**
 * EXACTLY the production opener's keying text (databaseService._openDatabase
 * interpolates `key = "x'<key>'"` and then `cipher_compatibility = 4`), with
 * the key the mocked databaseEncryptionService hands initialize().
 */
const PRODUCTION_KEY_PRAGMA = `key = "x'test-encryption-key-hex'"`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyService = any;

function sha256(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

describe("schema-baseline fence — refusal of a real pre-baseline database (BACKLOG-2993, C1)", () => {
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

  /**
   * Replay the shipped-v2.27.0 transcript onto a real file, encrypted with
   * the production pragma text, journal mode left at the pre-WAL default.
   */
  function buildEncryptedV55Fixture(): void {
    const db = new RealDatabase(dbFile) as DatabaseType;
    db.pragma(PRODUCTION_KEY_PRAGMA);
    db.pragma("cipher_compatibility = 4");
    db.exec(fs.readFileSync(FIXTURE_SQL_PATH, "utf8"));
    db.close();
  }

  it("PRECONDITION: the fixture opens with the production keying and reads schema_version 55", () => {
    buildEncryptedV55Fixture();
    // Open the way the fence and the production opener do — if this read
    // fails, every refusal below would be a decrypt error wearing a green
    // coat, not a baseline verdict.
    const probe = new RealDatabase(dbFile, { readonly: true }) as DatabaseType;
    try {
      probe.pragma(PRODUCTION_KEY_PRAGMA);
      probe.pragma("cipher_compatibility = 4");
      const version = (
        probe.prepare("SELECT version FROM schema_version WHERE id = 1").get() as {
          version: number;
        }
      ).version;
      expect(version).toBe(55);
      // Populated, not hollow: the corpus this transcript carries.
      const contacts = (
        probe.prepare("SELECT COUNT(*) AS n FROM contacts").get() as { n: number }
      ).n;
      expect(contacts).toBeGreaterThan(0);
      // And genuinely non-WAL — the pre-WAL-era shape B2 is about.
      const mode = (probe.pragma("journal_mode") as Array<{ journal_mode: string }>)[0]
        .journal_mode;
      expect(mode).not.toBe("wal");
    } finally {
      probe.close();
    }
  });

  it("C1: refuses the shipped v2.27.0 database — terminally, byte-identical, no backup, no restore, not initialized", async () => {
    buildEncryptedV55Fixture();
    const hashBefore = sha256(dbFile);
    const siblingsBefore = fs.readdirSync(tmpDir).sort();

    const restoreSpy = jest.spyOn(service, "_attemptAutoRestore");
    const broadcastSpy = jest.spyOn(initializationBroadcaster, "broadcast");

    await expect(service.initialize()).rejects.toThrow(SchemaBaselineRefusalError);

    // Terminal and DISTINCT from migration failure: auto-restore never ran.
    expect(restoreSpy).not.toHaveBeenCalled();

    // Not initialized — through EITHER predicate the 46 call sites gate on.
    expect(service.isInitialized()).toBe(false);
    expect(dbConnectionIsInitialized()).toBe(false);

    // UNMODIFIED, by content hash (never mtime — SR review E2)...
    expect(sha256(dbFile)).toBe(hashBefore);
    // ...by a fresh read-only reopen still reading the OLD version...
    const reopen = new RealDatabase(dbFile, { readonly: true }) as DatabaseType;
    try {
      reopen.pragma(PRODUCTION_KEY_PRAGMA);
      reopen.pragma("cipher_compatibility = 4");
      expect(
        (reopen.prepare("SELECT version FROM schema_version WHERE id = 1").get() as {
          version: number;
        }).version,
      ).toBe(55);
    } finally {
      reopen.close();
    }
    // ...and by the directory: no pre-migration backup, no .encrypted/.backup
    // scratch, no -wal/-shm — nothing was written anywhere.
    expect(fs.readdirSync(tmpDir).sort()).toEqual(siblingsBefore);

    // EXPLAINED: the dialog carried the message and the database path.
    expect(showMessageBoxMock).toHaveBeenCalledTimes(1);
    const dialogArg = showMessageBoxMock.mock.calls[0][0] as {
      message: string;
      detail: string;
    };
    expect(dialogArg.message).toContain("older version");
    expect(dialogArg.detail).toContain(dbFile);

    // ...and the app exited.
    expect(quitMock).toHaveBeenCalledTimes(1);

    // The broadcast is telemetry-only (SR review C) but its shape is pinned:
    // a permanent condition must not be broadcast as retryable.
    expect(broadcastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "error",
        error: expect.objectContaining({ retryable: false }),
      }),
    );
  });

  it("ORDER CONTROL: the dialog is awaited, THEN app.quit() — dropping the await goes red here", async () => {
    buildEncryptedV55Fixture();

    let resolveDialog!: (v: { response: number }) => void;
    showMessageBoxMock.mockReset();
    showMessageBoxMock.mockImplementation(
      () => new Promise<{ response: number }>((r) => (resolveDialog = r)),
    );

    const initPromise = service.initialize();
    const rejection = expect(initPromise).rejects.toThrow(SchemaBaselineRefusalError);

    // Let initialize() run up to the awaited dialog.
    await new Promise((r) => setTimeout(r, 50));
    expect(showMessageBoxMock).toHaveBeenCalledTimes(1);
    // The dialog is OPEN and UNANSWERED: the app must still be running.
    // (The mutation this control exists for: remove the `await` on
    // showMessageBox and quit fires here — the user never learns why.)
    expect(quitMock).not.toHaveBeenCalled();

    resolveDialog({ response: 0 });
    await rejection;
    expect(quitMock).toHaveBeenCalledTimes(1);
  });

  it("AXIS CONTROL: a file that cannot be OPENED is not 'pre-reset' — it fails with a decrypt error, no dialog, no quit", async () => {
    // Version and openability are independent axes (SR review addendum). A
    // refusal here would tell the owner of a corrupt-but-current database to
    // reinstall and lose their data for no reason. The mutation this control
    // exists for: map the fence's open/read failure to a refusal.
    fs.writeFileSync(dbFile, Buffer.from("not a database, not even close"));

    let caught: unknown;
    try {
      await service.initialize();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught).not.toBeInstanceOf(SchemaBaselineRefusalError);
    // The canonical failure is the driver's own, from the read-write opener's
    // key pragma hitting a non-database header — byte-identical to the
    // pre-fence behaviour for a garbage file.
    expect(String((caught as Error).message)).toContain("file is not a database");

    expect(showMessageBoxMock).not.toHaveBeenCalled();
    expect(quitMock).not.toHaveBeenCalled();
  });

  it("AXIS CONTROL: a valid pre-baseline file under the WRONG key fails as a driver error, never a refusal", async () => {
    // The other openability failure: the file is a real encrypted database,
    // but this machine's key cannot read it. The fence's readonly read fails
    // and DEFERS; the read-write opener then throws the driver's own
    // "file is not a database" from its first post-key pragma — measured as
    // today's actual wrong-key behaviour (the cipher_integrity_check wrap is
    // never reached; the earlier pragma throws first, fence or no fence).
    const db = new RealDatabase(dbFile) as DatabaseType;
    db.pragma(`key = "x'some-other-key-entirely'"`);
    db.pragma("cipher_compatibility = 4");
    db.exec(fs.readFileSync(FIXTURE_SQL_PATH, "utf8"));
    db.close();

    let caught: unknown;
    try {
      await service.initialize();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught).not.toBeInstanceOf(SchemaBaselineRefusalError);
    expect(String((caught as Error).message)).toContain("file is not a database");

    expect(showMessageBoxMock).not.toHaveBeenCalled();
    expect(quitMock).not.toHaveBeenCalled();
  });
});
