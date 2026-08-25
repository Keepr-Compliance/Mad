/**
 * @jest-environment node
 *
 * BACKLOG-2870 — the Messages import must refuse a disk it cannot fit on, and
 * must survive one that fills underneath it.
 *
 * ---------------------------------------------------------------------------
 * WHAT FAILED
 * ---------------------------------------------------------------------------
 * The founder ran a force re-import on 2026-08-24. It died partway with SQLite's
 * raw `database or disk is full`. He got a partial run and an error naming no
 * number, no cause and nothing he could do; his disk was genuinely at 99% (17 GB
 * of 926 GB) while Finder showed ~176 GB, so he did not believe it.
 *
 * BACKLOG-2743 DID ship a space guard on this path, and it could not have caught
 * this. That guard sizes the ATTACHMENT COPY, and `evaluateAttachmentSpace`
 * short-circuits to `fits: true` at `estimatedBytes <= 0` — which is exactly what
 * a force re-import of an already-imported library looks like, since every
 * attachment content-dedups to zero new bytes. The run passed the only space
 * check on the path without measuring anything, and then filled the disk with
 * message rows, indexes and a staging copy that no check had ever counted.
 *
 * ---------------------------------------------------------------------------
 * WHY THE REAL DRIVER
 * ---------------------------------------------------------------------------
 * Two of the claims here cannot be tested against a mock:
 *
 *   - "refuses BEFORE any write" is a claim about what is NOT in the database.
 *     It is asserted by looking at `sqlite_master` for staging tables and at the
 *     live rows by identity.
 *   - "an ENOSPC mid-run leaves the live store untouched" is a claim about
 *     transaction boundaries. A mocked database cannot tell a committed write
 *     from an uncommitted one, so a mocked version of that test would pass
 *     against a force path that had destroyed the user's messages.
 *
 * The disk-full condition itself is produced by `PRAGMA max_page_count`, which
 * makes the REAL driver raise its REAL error — `SQLITE_FULL` /
 * `database or disk is full`, verified identical to the founder's string — on a
 * REAL write, without filling a volume. His machine is at 99% and the founder's
 * running dev app shares this checkout's `node_modules`; filling a disk to run a
 * test is not available and would not be a better test.
 */

import * as os from "os";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as nodePath from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

let mockDb: DatabaseType;

jest.mock("os", () => ({
  ...jest.requireActual("os"),
  platform: () => "darwin",
}));

jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});
jest.mock("../databaseService", () => ({
  __esModule: true,
  default: { getRawDatabase: () => mockDb },
}));
jest.mock("../permissionService", () => ({
  __esModule: true,
  default: { checkFullDiskAccess: jest.fn(async () => ({ hasPermission: true })) },
}));
jest.mock("../../utils/messageParser", () => ({
  __esModule: true,
  getMessageText: jest.fn(async () => "message text"),
}));
jest.mock("cli-progress", () => ({
  __esModule: true,
  default: {
    SingleBar: jest.fn().mockImplementation(() => ({
      start: jest.fn(), update: jest.fn(), increment: jest.fn(), stop: jest.fn(),
    })),
    Presets: { shades_classic: {} },
  },
}));
jest.mock("../auditService", () => ({
  __esModule: true,
  default: {
    suspendPeriodicSync: jest.fn(() => false),
    resumePeriodicSync: jest.fn(),
    isSyncInFlight: jest.fn(() => false),
  },
}));
jest.mock("../submissionSyncService", () => ({
  __esModule: true,
  default: {
    suspendPeriodicSync: jest.fn(() => false),
    resumePeriodicSync: jest.fn(),
    isSyncInFlight: jest.fn(() => false),
  },
}));

// DELIBERATELY NOT MOCKED, same reason as the 2775/2790 suites: `jest.config.js`
// maps `^sqlite3$` to a stub whose `all` calls back `[]` for every query. Against
// that stub this suite would import zero messages and pass just as happily
// against broken code.
jest.mock("sqlite3", () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(
    require("path").join(__dirname, "..", "..", "..", "node_modules", "sqlite3"),
  ),
);

import { app } from "electron";
import macOSMessagesImportService from "../macOSMessagesImportService";
import { testImportPlan } from "./helpers/importPlanFixture";
import type { MacOSImportResult } from "../macOSMessagesImportService/types";
import {
  forceSwapSteps,
  STAGING_TABLE_PREFIX,
} from "../macOSMessagesImportService/forceStaging";
import { FAKE_FREE_BYTES_ENV_VAR } from "../../utils/diskSpace";
import { DISK_SPACE_THRESHOLDS } from "../diagnostics/diskSpaceDiagnostics";

const GB = 1024 * 1024 * 1024;
/**
 * An available-bytes figure below the floor.
 *
 * Integer on purpose: the BACKLOG-2762 override `Math.floor`s what it parses, so
 * a fractional fixture (`1.2 * GB` = 1288490188.8) would come back changed and
 * the assertion would be comparing the fixture against the override's rounding
 * rather than against the guard.
 */
const BELOW_FLOOR_BYTES = Math.floor(1.2 * GB);
const USER = "user-diskfull-2870";
const MESSAGE_COUNT = 150; // > BATCH_SIZE (100), so a failure can land mid-rebuild

/** The floor the pre-flight enforces, in bytes. */
const REQUIRED_BYTES = DISK_SPACE_THRESHOLDS.messagesImport * 1024 * 1024;

let homeDir: string;
let scratchDir: string;
let realHome: string | undefined;
let realFakeFreeBytes: string | undefined;

/**
 * The subset of the macOS Messages schema the import queries — transcribed from
 * the SQL in `doImport` (and from the 2790 suite that transcribed it first),
 * never invented. `chat.display_name` is always a column of Apple's real table.
 */
function createSourceDb(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE message (
      guid TEXT, text TEXT, attributedBody BLOB, date INTEGER,
      is_from_me INTEGER, handle_id INTEGER, service TEXT,
      cache_has_attachments INTEGER, associated_message_type INTEGER,
      associated_message_guid TEXT
    );
    CREATE TABLE handle (id TEXT);
    CREATE TABLE chat (account_login TEXT, display_name TEXT);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE attachment (
      guid TEXT, filename TEXT, mime_type TEXT, transfer_name TEXT,
      total_bytes INTEGER, is_outgoing INTEGER
    );
    CREATE TABLE message_attachment_join (attachment_id INTEGER, message_id INTEGER);
  `);

  db.prepare("INSERT INTO handle (id) VALUES (?)").run("+15550100");
  db.prepare("INSERT INTO chat (account_login) VALUES (?)").run("P:+15550199");
  db.prepare("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)").run(1, 1);

  const insertMessage = db.prepare(`
    INSERT INTO message (
      guid, text, attributedBody, date, is_from_me, handle_id, service,
      cache_has_attachments, associated_message_type, associated_message_guid
    ) VALUES (?, ?, NULL, ?, 0, 1, 'iMessage', 0, NULL, NULL)
  `);
  const joinChat = db.prepare("INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, ?)");
  const seed = db.transaction(() => {
    for (let n = 1; n <= MESSAGE_COUNT; n++) {
      insertMessage.run(`msg-guid-${n}`, `hello ${n}`, 700000000 * 1e9 + n);
      joinChat.run(n);
    }
  });
  seed();
  db.close();
}

function createStoreSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, channel TEXT, external_id TEXT,
      direction TEXT, body_text TEXT, participants TEXT, participants_flat TEXT,
      thread_id TEXT, sent_at DATETIME, has_attachments INTEGER DEFAULT 0,
      message_type TEXT, metadata TEXT, associated_message_type INTEGER,
      associated_message_guid TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY, message_id TEXT, external_message_id TEXT, filename TEXT,
      mime_type TEXT, file_size_bytes INTEGER, storage_path TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

/**
 * Pre-existing macOS messages, stamped the way `storeMessages` stamps them so
 * they fall inside the force set this run would replace.
 *
 * These are the rows at risk. Every "live store intact" assertion below is an
 * exact-identity comparison against THIS set, never a count — a count cannot
 * tell "unchanged" from "replaced by the same number of different rows".
 */
function seedExistingMessages(count: number): void {
  const insert = mockDb.prepare(`
    INSERT INTO messages (id, user_id, channel, external_id, direction, body_text, metadata)
    VALUES (?, ?, 'imessage', ?, 'inbound', ?, ?)
  `);
  const seed = mockDb.transaction(() => {
    for (let n = 1; n <= count; n++) {
      insert.run(
        `existing-${n}`,
        USER,
        `msg-guid-${n}`,
        `pre-existing body ${n}`,
        JSON.stringify({ source: "macos_messages", originalId: `msg-guid-${n}`, service: "iMessage" }),
      );
    }
  });
  seed();
}

/** Every stored message by identity — internal row id AND macOS guid. */
function storedRowIdentities(): Array<{ id: string; external_id: string }> {
  return (
    mockDb
      .prepare("SELECT id, external_id FROM messages")
      .all() as Array<{ id: string; external_id: string }>
  ).sort((a, b) => a.id.localeCompare(b.id));
}

function stagingTableNames(): string[] {
  return (
    mockDb
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ?`)
      .all(`${STAGING_TABLE_PREFIX}%`) as Array<{ name: string }>
  )
    .map((r) => r.name)
    .sort();
}

/**
 * Report a fixed number of app-available bytes through the BACKLOG-2762 dev
 * override — the mechanism built for exactly this, rather than a `statfs` spy.
 *
 * Using the override means these tests drive the SAME code path a human uses to
 * review the refusal on a healthy machine (`KEEPR_FAKE_FREE_BYTES=... npm run
 * dev`). A `statfs` spy would test the guard while leaving the override itself
 * unexercised, and the override is what the founder-facing review depends on.
 */
function fakeFreeBytes(bytes: number): void {
  process.env[FAKE_FREE_BYTES_ENV_VAR] = String(bytes);
}

/**
 * Cap the app database at its current size plus `slackPages` pages, so the next
 * writes raise a genuine `SQLITE_FULL` from the real driver.
 *
 * This is the disk-full condition, produced at the layer SQLite reports it from.
 * The error object it raises is the real one: message `database or disk is full`,
 * code `SQLITE_FULL` — the founder's exact string, which is why the copy tests
 * pin it verbatim.
 */
function capDatabasePages(slackPages: number): void {
  const [{ page_count: pageCount }] = mockDb.pragma("page_count") as Array<{ page_count: number }>;
  mockDb.pragma(`max_page_count = ${pageCount + slackPages}`);
}

/** Lift the cap so `afterEach` teardown is not itself starved. */
function uncapDatabasePages(): void {
  try {
    mockDb.pragma("max_page_count = 1073741823");
  } catch {
    // The DB may already be closed; nothing to restore.
  }
}

function runImport(force: boolean): Promise<MacOSImportResult> {
  return macOSMessagesImportService.importMessages(
    USER,
    undefined,
    testImportPlan({
      mode: force ? "reprocess" : "delta",
      storedFilters: { lookbackMonths: null, maxMessages: null },
    }),
  );
}

beforeEach(async () => {
  mockDb = new Database(":memory:");
  createStoreSchema(mockDb);

  homeDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "keepr-2870-home-"));
  scratchDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "keepr-2870-app-"));
  await fs.mkdir(nodePath.join(homeDir, "Library", "Messages"), { recursive: true });
  createSourceDb(nodePath.join(homeDir, "Library", "Messages", "chat.db"));

  realHome = process.env.HOME;
  process.env.HOME = homeDir;
  realFakeFreeBytes = process.env[FAKE_FREE_BYTES_ENV_VAR];
  delete process.env[FAKE_FREE_BYTES_ENV_VAR];

  (app.getPath as jest.Mock).mockImplementation((name: string) =>
    name === "userData" ? scratchDir : `/tmp/test-${name}`,
  );
});

afterEach(async () => {
  uncapDatabasePages();
  jest.restoreAllMocks();
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  if (realFakeFreeBytes === undefined) delete process.env[FAKE_FREE_BYTES_ENV_VAR];
  else process.env[FAKE_FREE_BYTES_ENV_VAR] = realFakeFreeBytes;
  mockDb?.close();
  await fs.rm(homeDir, { recursive: true, force: true });
  await fs.rm(scratchDir, { recursive: true, force: true });
});

describe("BACKLOG-2870 — CONTROL 1: refuse before any write", () => {
  /**
   * The refusal has to land before the first byte, not after N rows. The founder
   * got a partial import; a guard that stops halfway would reproduce that with
   * nicer wording.
   *
   * Asserted by ABSENCE, three ways, because "it refused" is a claim about what
   * did not happen: no staging table was ever created, the live rows are the
   * exact set that was there before, and the run reports zero of everything.
   */
  it("refuses a force re-import on a too-full disk without creating a staging table or touching a row", async () => {
    seedExistingMessages(10);
    const before = storedRowIdentities();
    fakeFreeBytes(BELOW_FLOOR_BYTES); // below the 3 GB floor

    const result = await runImport(true);

    expect(result.success).toBe(false);
    expect(result.refusedForDiskSpace).toEqual({
      requiredBytes: REQUIRED_BYTES,
      availableBytes: BELOW_FLOOR_BYTES,
      snapshotCount: expect.anything(),
      phase: "before",
    });

    // NOTHING was written — this is the whole claim.
    expect(stagingTableNames()).toEqual([]);
    expect(storedRowIdentities()).toEqual(before);
    expect(result.messagesImported).toBe(0);
    expect(result.attachmentsImported).toBe(0);

    // A force run that changed nothing must SAY it changed nothing, or the
    // failure card leaves the user believing their messages are gone.
    expect(result.rolledBack).toBe(true);
  });

  it("refuses a plain delta import too — the floor is not force-only", async () => {
    seedExistingMessages(5);
    const before = storedRowIdentities();
    fakeFreeBytes(100 * 1024 * 1024);

    const result = await runImport(false);

    expect(result.success).toBe(false);
    expect(result.refusedForDiskSpace?.phase).toBe("before");
    expect(storedRowIdentities()).toEqual(before);
    expect(stagingTableNames()).toEqual([]);
  });

  /**
   * The number in the message is the number the guard decided on. If these ever
   * drift, the user is being shown one figure and refused on another — which is
   * the shape of the bug that made him disbelieve the app in the first place.
   */
  it("tells the user what it needs and what is really there", async () => {
    fakeFreeBytes(BELOW_FLOOR_BYTES);

    const result = await runImport(true);

    expect(result.error).toContain("3 GB");
    expect(result.error).toContain("1.2 GB");
    expect(result.error).toMatch(/actually available/i);
    // The raw driver sentence must never be what the user reads.
    expect(result.error).not.toMatch(/database or disk is full/i);
  });

  /**
   * The margin is the point of a floor. An import with 3 GB free is admitted and
   * one with a hair under is not — a guard that only fires at zero bytes free is
   * a guard that fires after the damage.
   */
  it("admits an import exactly at the floor and refuses just below it", async () => {
    fakeFreeBytes(REQUIRED_BYTES);
    expect((await runImport(false)).refusedForDiskSpace).toBeUndefined();

    fakeFreeBytes(REQUIRED_BYTES - 1);
    expect((await runImport(false)).refusedForDiskSpace?.phase).toBe("before");
  });
});

describe("BACKLOG-2870 — CONTROL 2: the check at t0 does not bind the disk at t+5min", () => {
  /**
   * THE PATH THE FOUNDER ACTUALLY HIT, with the pre-flight in place.
   *
   * A pre-flight reserves nothing. Another process, a new Time Machine snapshot,
   * or simply an import larger than the floor can consume the margin while this
   * run is writing. So the mid-run failure needs its own handling, and this test
   * exists to prove the guard did not merely move the raw error later.
   *
   * The pre-check PASSES here — 500 GB reported free — and the disk-full arrives
   * from the real driver during the rebuild.
   */
  it("translates a real mid-rebuild SQLITE_FULL into something a person can act on", async () => {
    seedExistingMessages(10);
    fakeFreeBytes(500 * GB); // pre-flight passes comfortably
    capDatabasePages(2); // ...and the driver runs out anyway

    const result = await runImport(true);

    expect(result.success).toBe(false);
    expect(result.refusedForDiskSpace?.phase).toBe("during");
    // Translated, not passed through.
    expect(result.error).not.toMatch(/database or disk is full/i);
    expect(result.error).toMatch(/ran out of disk space/i);
    expect(result.error).toMatch(/Nothing was changed/i);
  });

  /**
   * THE MID-WRITE OBSERVATION — asserted by QUERYING THE LIVE TABLES, not by
   * reading the stage-and-swap code and believing its header comment.
   *
   * BACKLOG-2790 claims "cancel, crash, disk-full, a thrown error — leaves live
   * exactly as it was, by construction". This runs the disk-full case and checks
   * the store afterwards. The comparison is over exact row IDENTITY: a count
   * would be equally green for a store that had been emptied and refilled with
   * different rows.
   */
  it("leaves the live message store byte-identical when the disk fills mid-rebuild", async () => {
    seedExistingMessages(10);
    const before = storedRowIdentities();
    expect(before).toHaveLength(10);

    fakeFreeBytes(500 * GB);
    capDatabasePages(2);

    const result = await runImport(true);
    expect(result.success).toBe(false);

    // OBSERVED, not inferred: the rows are the ones that were there, by identity.
    // A count would be equally green for a store emptied and refilled with 10
    // different rows.
    expect(storedRowIdentities()).toEqual(before);
    // The user is told the store is intact, and it is.
    expect(result.rolledBack).toBe(true);

    /**
     * ------------------------------------------------------------------------
     * FOUND BY RUNNING THIS, NOT BY READING THE CODE: the staging tables LEAK on
     * a genuinely full disk.
     * ------------------------------------------------------------------------
     * `forceStaging.ts`'s header says "cancel, crash, disk-full, a thrown error —
     * leaves live exactly as it was". The live half is true and is asserted
     * above. The scratch half is not, and disk-full is the one interruption
     * where it fails: `doImport`'s `finally` calls `staging.drop()`, `DROP TABLE`
     * is itself a WRITE, and on a full disk that write fails like any other. The
     * drop is best-effort by design ("a failure here costs disk space, never
     * data"), so the failure is swallowed and logged.
     *
     * The consequence is specific to this scenario and worth stating plainly: the
     * one interruption that leaves scratch space behind is the one where the user
     * has no space to spare. They are left with LESS free disk than before a run
     * that reported changing nothing.
     *
     * Asserted as the CURRENT behaviour rather than papered over, so that a
     * future fix has to come here and change it deliberately.
     */
    expect(stagingTableNames()).toHaveLength(1);
    expect(stagingTableNames()[0]).toContain(STAGING_TABLE_PREFIX);
  });

  /**
   * The leak above is bounded — OBSERVED, not taken from `sweepStaleStaging`'s
   * doc comment. Once there is room again, the next force run reclaims it.
   *
   * This is what makes the leak a disk-space annoyance rather than unbounded
   * growth, and it is the reason it is reported rather than fixed here: there is
   * no way to DROP a table on a volume with no room to write the drop.
   */
  it("reclaims the leaked staging tables on the next force run, once there is room", async () => {
    seedExistingMessages(10);
    fakeFreeBytes(500 * GB);
    capDatabasePages(2);

    await runImport(true);
    expect(stagingTableNames()).toHaveLength(1); // leaked, as above

    // The disk has room again.
    uncapDatabasePages();
    await runImport(true);

    expect(stagingTableNames()).toEqual([]);
  });

  /**
   * The harder half: the disk fills INSIDE the swap transaction, after the
   * rebuild has completed. This is the only window in which live rows are
   * actually being deleted, so it is the only window where a disk-full could
   * destroy data. The swap is one `db.transaction()`, so SQLITE_FULL must roll
   * the whole thing back — delete included.
   */
  it("leaves the live store intact when the disk fills INSIDE the swap transaction", async () => {
    seedExistingMessages(10);
    const before = storedRowIdentities();

    fakeFreeBytes(500 * GB);

    // Let the rebuild finish, then starve the swap at the moment it starts
    // inserting — i.e. after `deleteLiveForceSet` has already removed the live
    // rows inside the transaction.
    const realInsert = forceSwapSteps.insertFromStaging.bind(forceSwapSteps);
    jest
      .spyOn(forceSwapSteps, "insertFromStaging")
      .mockImplementation((db, staging) => {
        capDatabasePages(0);
        return realInsert(db, staging);
      });

    const result = await runImport(true);
    uncapDatabasePages();

    expect(result.success).toBe(false);
    // The DELETE happened inside the same transaction and must have gone with it.
    expect(storedRowIdentities()).toEqual(before);
    expect(stagingTableNames()).toEqual([]);
    expect(result.rolledBack).toBe(true);
  });
});

describe("BACKLOG-2870 — CONTROL 3: the guard does not block healthy machines", () => {
  it("imports normally when there is plenty of room, and reports no refusal", async () => {
    fakeFreeBytes(500 * GB);

    const result = await runImport(false);

    expect(result.refusedForDiskSpace).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.messagesImported).toBe(MESSAGE_COUNT);
    expect(storedRowIdentities()).toHaveLength(MESSAGE_COUNT);
  });

  /**
   * FAIL OPEN on a broken sensor, matching `getAvailableDiskBytes`'s documented
   * contract. Refusing every import because `statfs` is unavailable is worse than
   * the risk it guards against, and the ENOSPC translation is the backstop.
   */
  it("proceeds when free space cannot be read at all", async () => {
    // No override set, and the real read fails.
    jest.spyOn(fsSync.promises, "statfs").mockRejectedValue(new Error("statfs unavailable"));

    const result = await runImport(false);

    expect(result.refusedForDiskSpace).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.messagesImported).toBe(MESSAGE_COUNT);
  });
});
