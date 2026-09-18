/**
 * @jest-environment node
 *
 * BACKLOG-2553 — THE RESTORE DRAINS THE CONTACT WORKER, PROVEN AGAINST A REAL THREAD
 *
 * ===========================================================================
 * WHAT THIS FILE HAS TO PROVE, AND WHY A MOCK CANNOT PROVE IT
 * ===========================================================================
 * `restoreDatabase` replaces the database FILE. The contact worker holds its own
 * connection to that same file and is shut down nowhere but app quit. The claim
 * under test is therefore about an operating-system fact — no second thread
 * holds the file open at the instant `fs.copyFileSync` runs — and a mocked pool
 * can only report the order some jest.fn()s were called in.
 *
 * So this suite runs a REAL `Worker` thread, holding a REAL handle to a REAL
 * encrypted database, and samples the pool's state from INSIDE the copy.
 *
 * ===========================================================================
 * THE CORRECTED THREAT MODEL — READ BEFORE EDITING THE HEADER OF ANY OF THIS
 * ===========================================================================
 * The filing said a live worker's WRITES are silently lost across a restore.
 * That is false. `contactQueryWorker.ts:74` opens `{ readonly: true }` (BACKLOG-2536,
 * with a 14-line comment above it saying exactly why), so the worker cannot
 * write and no write can be lost. What a live worker actually costs:
 *
 *   Windows — `fs.copyFileSync` over the database can fail EBUSY/EPERM because a
 *             second thread holds the file open, so the restore fails outright.
 *   macOS   — the copy succeeds and the worker goes on READING the old unlinked
 *             inode, so a user who just restored a backup still sees pre-restore
 *             contacts until the pool restarts.
 *
 * Neither is corruption. Both are real defects and the drain fixes both. That
 * Windows locking is the EBUSY mechanism is INFERRED from the code and platform
 * semantics; it was not reproduced on a Windows machine.
 *
 * ===========================================================================
 * HOW THE REAL WORKER IS REACHED WITHOUT A PRODUCTION TEST SEAM
 * ===========================================================================
 * `getWorkerPath()` is `path.join(__dirname, 'contactQueryWorker.js')`. Under
 * ts-jest `__dirname` is the SOURCE directory, which holds only `.ts`, so
 * `new Worker(...)` cannot construct. In production `__dirname` is
 * `dist-electron/workers`, where the compiled file exists.
 *
 * The fix is entirely inside the test: `worker_threads` is mocked with a
 * subclass of the REAL `Worker` that ignores the path it is handed and passes an
 * esbuild bundle of the REAL `contactQueryWorker.ts` instead. Production keeps
 * its exact signature — no test-only parameter, and no way to point the shipped
 * app at the wrong file. The same subclass counts constructions, which is what
 * the double-worker control needs anyway.
 *
 * Because the bundle IS the production worker, control 3 below asserts against
 * production SQL (`EXTERNAL_CONTACTS_GET_ALL_SQL`), not a hand-written stand-in.
 *
 * The bundle is written under the WORKTREE ROOT, never `os.tmpdir()` and never
 * into `node_modules/`: `better-sqlite3-multiple-ciphers` is marked external, so
 * the worker resolves it by walking up to the worktree's `node_modules` symlink,
 * which a temp directory has no path to. `node_modules` is shared with the
 * founder's running dev app and is never written by a test.
 *
 * ===========================================================================
 * THE SEED MUST BE IN WAL MODE, AND THAT IS TRANSCRIBED, NOT INVENTED
 * ===========================================================================
 * The worker sets `journal_mode = WAL` (`contactQueryWorker.ts:79`) on a
 * READ-ONLY connection. On a database that is not already WAL that pragma has to
 * write, and the worker dies with "attempt to write a readonly database" —
 * observed here on the first run of this fixture, before the seed set WAL.
 * Production never hits it because `dbConnection.openDatabase()` sets WAL
 * (`:110`) on the main connection first. The seed below therefore applies the
 * same pragmas in the same order as that function.
 */

import fs from "fs";
import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";

const WORKTREE_ROOT = path.resolve(__dirname, "..", "..", "..");
const REAL_DRIVER_PATH = path.join(
  WORKTREE_ROOT,
  "node_modules",
  "better-sqlite3-multiple-ciphers",
);
const BUNDLE_DIR = path.join(WORKTREE_ROOT, ".tmp-2553");
const BUNDLE_PATH = path.join(BUNDLE_DIR, "contactQueryWorker.bundle.js");

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(REAL_DRIVER_PATH) as typeof import("better-sqlite3-multiple-ciphers");

/**
 * Observations of the REAL worker threads the pool creates.
 *
 * `constructions` is what makes the double-worker control non-vacuous: an
 * assertion that no SECOND worker appeared is worthless unless a FIRST one
 * provably did.
 */
const mockWorkerState = { constructions: 0, exits: 0 };

jest.mock("worker_threads", () => {
  const actual = jest.requireActual("worker_threads");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require("path");
  const bundle = nodePath.join(
    nodePath.resolve(__dirname, "..", "..", ".."),
    ".tmp-2553",
    "contactQueryWorker.bundle.js",
  );
  class RedirectedWorker extends actual.Worker {
    constructor(requestedPath: string, options?: object) {
      /**
       * ONLY the contact worker is redirected, and that is not tidiness.
       *
       * `esbuild.buildSync` — which this suite calls to produce the bundle —
       * starts a `worker_threads` Worker of its OWN. A blanket redirect hands
       * esbuild the contact worker instead of its own script, and the build
       * never returns: the suite hangs before its first assertion, with no
       * output, because jest buffers the reporter until the run ends. Observed
       * here; the step log stopped at the constructor and never reached the
       * line after the build.
       *
       * Matching on the path the pool actually asks for also makes the
       * construction counter mean "workers the POOL created", which is what the
       * double-worker control asserts on.
       */
      const isContactWorker =
        typeof requestedPath === "string" &&
        requestedPath.endsWith("contactQueryWorker.js");
      super(isContactWorker ? bundle : requestedPath, options);
      if (isContactWorker) {
        mockWorkerState.constructions++;
        this.on("exit", () => { mockWorkerState.exits++; });
      }
    }
  }
  return { ...actual, Worker: RedirectedWorker };
});

jest.mock("better-sqlite3-multiple-ciphers", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require("path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(
    nodePath.join(
      nodePath.resolve(__dirname, "..", "..", ".."),
      "node_modules",
      "better-sqlite3-multiple-ciphers",
    ),
  );
});

const mockUserDataDir = { path: "" };
jest.mock("electron", () => ({
  app: { getPath: (name: string) => (name === "userData" ? mockUserDataDir.path : mockUserDataDir.path) },
}));

jest.mock("@sentry/electron/main", () => ({ captureException: jest.fn() }));

jest.mock("../../services/logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

/**
 * `databaseService` stands in for the main-thread connection only.
 *
 * It is NOT the subject: this file is about the WORKER's handle. What the real
 * service contributes to the restore — closing and reopening the main
 * connection, and running migrations — is covered by its own suites. What
 * matters here is that `isInitialized()` answers honestly, because the restart
 * gate reads it.
 */
const mockDbState = { initialized: true };
jest.mock("../../services/databaseService", () => ({
  __esModule: true,
  default: {
    close: jest.fn(async () => { mockDbState.initialized = false; }),
    initialize: jest.fn(async () => { mockDbState.initialized = true; return true; }),
    isInitialized: jest.fn(() => mockDbState.initialized),
  },
}));

const mockKey = { hex: "a1".repeat(32) };
jest.mock("../../services/databaseEncryptionService", () => ({
  databaseEncryptionService: {
    getEncryptionKey: jest.fn(async () => mockKey.hex),
    getCachedKey: jest.fn(() => mockKey.hex),
  },
}));

import {
  initializePool,
  queryContacts,
  isPoolReady,
  drainPoolForExclusiveAccess,
  restartPoolAfterExclusiveAccess,
  POOL_HELD_FOR_RESTORE,
} from "../contactWorkerPool";
import { restoreDatabase, RESTORE_POOL_DRAIN_REFUSAL } from "../../services/sqliteBackupService";

const USER = "user-2553";

/** The four tables `EXTERNAL_CONTACTS_GET_ALL_SQL` touches, and nothing else. */
const SCHEMA = `
  CREATE TABLE external_contacts (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT,
    phones_json TEXT, emails_json TEXT, phones_normalized_json TEXT,
    company TEXT, last_message_at TEXT, external_record_id TEXT,
    source TEXT, synced_at TEXT, external_uuid TEXT
  );
  CREATE TABLE phone_last_message (
    user_id TEXT, phone_normalized TEXT, last_message_at TEXT
  );
  CREATE TABLE email_participants (email_id TEXT, email_address TEXT);
  CREATE TABLE emails (id TEXT, user_id TEXT, sent_at TEXT, received_at TEXT);
`;

/**
 * Create a real encrypted database carrying one external contact.
 *
 * The pragma order is transcribed from `dbConnection.openDatabase()` (`:94-123`),
 * which is the function that opens this file in production — WAL included, for
 * the reason in the header.
 */
function seedDatabase(file: string, contactId: string, name: string): void {
  const db = new RealDatabase(file) as DatabaseType;
  db.pragma(`key = "x'${mockKey.hex}'"`);
  db.pragma("cipher_compatibility = 4");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  db.prepare(
    `INSERT INTO external_contacts (id, user_id, name, phones_json, emails_json, source)
     VALUES (?, ?, ?, '[]', '[]', 'test')`,
  ).run(contactId, USER, name);
  db.close();
}

interface ExternalRow { id: string; name: string }

describe("BACKLOG-2553 — restoreDatabase drains the contact worker pool", () => {
  let tmpDir: string;
  let dbPath: string;
  let backupPath: string;

  beforeAll(() => {
    fs.mkdirSync(BUNDLE_DIR, { recursive: true });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const esbuild = require("esbuild");
    esbuild.buildSync({
      entryPoints: [path.join(WORKTREE_ROOT, "electron", "workers", "contactQueryWorker.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: BUNDLE_PATH,
      external: ["better-sqlite3-multiple-ciphers"],
    });
    expect(fs.existsSync(BUNDLE_PATH)).toBe(true);
  });

  afterAll(() => {
    fs.rmSync(BUNDLE_DIR, { recursive: true, force: true });
  });

  beforeEach(() => {
    mockWorkerState.constructions = 0;
    mockWorkerState.exits = 0;
    mockDbState.initialized = true;
    tmpDir = fs.mkdtempSync(path.join(WORKTREE_ROOT, ".tmp-2553", "run-"));
    mockUserDataDir.path = tmpDir;
    dbPath = path.join(tmpDir, "mad.db");
    backupPath = path.join(tmpDir, "keepr-backup.db");
    seedDatabase(dbPath, "live-contact", "Before Restore");
    seedDatabase(backupPath, "backup-contact", "After Restore");
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    // Leave no thread holding a file: Windows refuses to remove a directory
    // whose files are open, and macOS hides the leak entirely.
    await drainPoolForExclusiveAccess(2_000, 2_000);
    await restartPoolAfterExclusiveAccess(null, null, false);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * CONTROL 1 — pool state sampled from INSIDE the copy.
   *
   * The four pre-assertions are load-bearing, not ceremony. `isPoolReady()` is
   * `ready && worker !== null`, so it is ALSO false on a pool that never
   * started: without proving a worker was up and running first, "not ready at
   * copy time" is satisfied by a test that never created one. And without
   * asserting the spy actually fired on `(backupPath, dbPath)`, a run where the
   * copy never happened would skip the assertion rather than fail.
   */
  it("the worker thread has exited before the backup file is copied over the database", async () => {
    await initializePool(dbPath, mockKey.hex);

    expect(isPoolReady()).toBe(true);                 // (1) a worker is really up
    expect(mockWorkerState.constructions).toBe(1);    // (2) exactly one, and it is ours

    let snapshot: { poolReady: boolean; workerExited: boolean } | null = null;
    const realCopy = fs.copyFileSync;
    jest.spyOn(fs, "copyFileSync").mockImplementation(((src: string, dest: string) => {
      if (src === backupPath && dest === dbPath) {
        snapshot = { poolReady: isPoolReady(), workerExited: mockWorkerState.exits >= 1 };
      }
      return realCopy(src, dest);
    }) as typeof fs.copyFileSync);

    const result = await restoreDatabase(backupPath);

    expect(result).toEqual({ success: true });        // (4) the restore really ran
    expect(snapshot).not.toBeNull();                  // (3) the sample was taken
    expect(snapshot).toEqual({ poolReady: false, workerExited: true });

    // And the pool is back up afterwards, on the same call.
    expect(isPoolReady()).toBe(true);
  }, 30_000);

  /**
   * CONTROL 1b — the double-worker window is closed.
   *
   * `initializePool` early-returns only while `initPromise` is non-null, and the
   * worker's own `exit` handler sets it to null. So between worker-exit and the
   * end of the restore, only `exclusiveHold` stands between a concurrent caller
   * and a SECOND `Worker` constructed over the file being replaced.
   *
   * Asserting the specific message, not merely "it rejected": any thrown error
   * would satisfy a bare rejects.toThrow, including one from a broken fixture.
   */
  it("refuses to build a second worker while the pool is held for a restore", async () => {
    await initializePool(dbPath, mockKey.hex);
    expect(mockWorkerState.constructions).toBe(1);

    const drain = await drainPoolForExclusiveAccess();
    expect(drain.drained).toBe(true);

    await expect(initializePool(dbPath, mockKey.hex)).rejects.toThrow(POOL_HELD_FOR_RESTORE);
    expect(mockWorkerState.constructions).toBe(1); // no second thread was created

    await restartPoolAfterExclusiveAccess(null, null, true);
    expect(mockWorkerState.constructions).toBe(2); // and the hold really did lift
  }, 30_000);

  /**
   * CONTROL 1c — the hold cannot leak, even when the drain throws.
   *
   * `postMessage` can throw; the quit path wraps the identical call for that
   * reason. If that escaped the drain, `exclusiveHold` would stay set for the
   * life of the process and EVERY later `initializePool` would reject — a dead
   * contact pool until app quit, with no route back. That is the same
   * half-broken-app failure this item exists to prevent, so it gets its own test.
   */
  it("recovers the pool when the shutdown message throws instead of sending", async () => {
    await initializePool(dbPath, mockKey.hex);
    expect(isPoolReady()).toBe(true);

    const { Worker } = jest.requireMock("worker_threads") as { Worker: { prototype: { postMessage: unknown } } };
    const throwingPost = jest
      .spyOn(Worker.prototype as unknown as { postMessage: () => void }, "postMessage")
      .mockImplementation(() => { throw new Error("worker channel is closed"); });

    // The drain still settles — a thrown postMessage is caught, and the worker
    // that never got the message is terminated instead.
    const drain = await drainPoolForExclusiveAccess(200, 5_000);
    throwingPost.mockRestore();

    expect(drain.drained).toBe(true);
    expect(drain.via).toBe("terminate");

    // The hold lifted: the pool comes back rather than rejecting forever.
    await restartPoolAfterExclusiveAccess(null, null, true);
    expect(isPoolReady()).toBe(true);
    await expect(initializePool(dbPath, mockKey.hex)).resolves.toBeUndefined();
  }, 30_000);

  /**
   * CONTROL 2a — a worker that will not exit is refused, and refused CHEAPLY.
   *
   * Called directly with 20 ms budgets rather than through `restoreDatabase`,
   * which passes no timings: at the production defaults this case costs five
   * seconds of wall clock, and slow tests are how controls get skipped.
   */
  it("refuses the drain when the worker never exits", async () => {
    await initializePool(dbPath, mockKey.hex);

    const { Worker } = jest.requireMock("worker_threads") as { Worker: { prototype: object } };
    jest.spyOn(Worker.prototype as unknown as { postMessage: () => void }, "postMessage")
      .mockImplementation(() => { /* swallowed: the worker never hears it */ });
    jest.spyOn(Worker.prototype as unknown as { terminate: () => Promise<number> }, "terminate")
      .mockImplementation(() => new Promise<number>(() => { /* never settles */ }));

    const drain = await drainPoolForExclusiveAccess(20, 20);

    expect(drain.drained).toBe(false);
    expect(drain.reason).toContain("did not exit");

    /**
     * AND THE REFUSAL IS NOT A NO-OP FOR THE POOL. The drain marks the pool
     * not-ready and rejects in-flight queries BEFORE it posts the shutdown
     * message, and a posted message cannot be un-posted. So a refused restore
     * leaves the database file untouched and the pool unusable until the app
     * restarts — which is exactly what the user-facing message says to do.
     * Asserted, not assumed.
     */
    expect(isPoolReady()).toBe(false);

    /**
     * AND THE HOLD LIFTED — the regression control for the leak.
     *
     * If `exclusiveHold` were still set, this call would REJECT with
     * `POOL_HELD_FOR_RESTORE` and every later one would too: a contact pool dead
     * until app quit, with no route back. Control 1b asserts that rejection
     * happens while a drain is genuinely in force, so the pair distinguishes
     * "held" from "not held" rather than resting on one direction.
     *
     * It resolves WITHOUT bringing the pool up, and that is the honest outcome,
     * not a gap: the stranded worker never exited, so the pool's `initPromise`
     * was never cleared and this call returned that already-settled promise. A
     * refused restore leaves the database file untouched and the contact pool
     * down until the app restarts — which is what the user-facing message says
     * to do. Waking the pool back up here would be worse: the shutdown message
     * has already been posted and cannot be un-posted, so the worker may exit at
     * any moment under a query we just promised to serve.
     */
    jest.restoreAllMocks();
    await expect(initializePool(dbPath, mockKey.hex)).resolves.toBeUndefined();
    expect(isPoolReady()).toBe(false);
    expect(mockWorkerState.constructions).toBe(1);
  }, 30_000);

  /**
   * CONTROL 3 — the restored database is what the restarted worker reads.
   *
   * By identity, not by count: the live database and the backup each hold ONE
   * external contact, with different ids. "One row came back" is true before and
   * after the restore and would prove nothing. The query is the production
   * `EXTERNAL_CONTACTS_GET_ALL_SQL`, because the worker under test is the real
   * one, bundled.
   */
  it("serves rows from the restored database, not the replaced one, after the pool restarts", async () => {
    await initializePool(dbPath, mockKey.hex);

    const before = (await queryContacts("external", USER)) as ExternalRow[];
    expect(before.map((r) => r.id)).toEqual(["live-contact"]);

    const result = await restoreDatabase(backupPath);
    expect(result).toEqual({ success: true });
    expect(isPoolReady()).toBe(true);

    const after = (await queryContacts("external", USER)) as ExternalRow[];
    expect(after.map((r) => r.id)).toEqual(["backup-contact"]);
  }, 30_000);

  /**
   * CONTROL 2b (ordering half) — a refused drain touches no bytes.
   *
   * The file-level half of the refusal contract: nothing closed, no safety copy
   * written, no database replaced. Verified against the real files rather than
   * against mock call order — the database on disk must be byte-identical to
   * what it was before the attempt.
   */
  it("refuses the restore and touches no bytes when the pool cannot be drained", async () => {
    await initializePool(dbPath, mockKey.hex);
    const before = fs.readFileSync(dbPath);

    const { Worker } = jest.requireMock("worker_threads") as { Worker: { prototype: object } };
    jest.spyOn(Worker.prototype as unknown as { postMessage: () => void }, "postMessage")
      .mockImplementation(() => { /* never delivered */ });
    jest.spyOn(Worker.prototype as unknown as { terminate: () => Promise<number> }, "terminate")
      .mockImplementation(() => new Promise<number>(() => { /* never settles */ }));

    const result = await restoreDatabase(backupPath);

    expect(result.success).toBe(false);
    expect(result.error).toBe(RESTORE_POOL_DRAIN_REFUSAL);
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
    expect(fs.existsSync(`${dbPath}.safety-restore-copy`)).toBe(false);
    expect(isPoolReady()).toBe(false);

    jest.restoreAllMocks();
    await restartPoolAfterExclusiveAccess(null, null, true);
  }, 30_000);
});
