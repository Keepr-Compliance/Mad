/**
 * @jest-environment node
 *
 * BACKLOG-2797 — a second Force Re-import supersedes the first, against the REAL
 * sqlite drivers.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUITE IS FOR
 * ---------------------------------------------------------------------------
 * A Force Re-import that arrives while another import runs aborts that import.
 * It used to wait a fixed 500 ms and proceed. A previous run still busy after
 * 500 ms then had its staging tables swept underneath it, read the NEW run's
 * AbortController (so it never saw its own cancellation), and its finally cleared
 * the new run's lock. The new run now waits for the previous run to release the
 * service (bounded), and a Cancel pressed during that wait cancels the waiting
 * run.
 *
 * The harness (source chat.db, store schema, mocks) is the BACKLOG-2790 suite's,
 * transcribed rather than invented, and it drives the REAL drivers for the same
 * reason: a mocked database cannot show one run's tables being dropped under
 * another.
 *
 * Every test holds a run inside `getMessageText` to make the overlap
 * deterministic. `afterEach` releases every hold and awaits every run before the
 * database closes, and the per-test timeout is short, so a red fails in seconds.
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

// DELIBERATELY NOT MOCKED: ../db/readOnlySqlite, and `sqlite3` is resolved to the
// REAL driver by absolute path. `jest.config.js` maps `^sqlite3$` to a stub whose
// `all` calls back `[]` for every query — against that stub this suite would
// import zero messages and pass just as happily against broken code. Same reason,
// same pattern, as `macOSMessagesImportService.forceCancelRealDriver-2775.test.ts`.
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
  forceStagingLifecycle,
  STAGING_TABLE_PREFIX,
} from "../macOSMessagesImportService/forceStaging";

const USER = "user-force-supersede-2797";
const MESSAGE_COUNT = 150; // > BATCH_SIZE (100), so a cancel can land between batches

let homeDir: string;
let scratchDir: string;
let realHome: string | undefined;

/**
 * The subset of the macOS Messages schema the import queries, transcribed from
 * the SQL in `doImport` rather than invented.
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
    -- BACKLOG-2814: display_name is ALWAYS a column of Apple's real chat
    -- table. A fixture without it described a chat.db that cannot exist.
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
    -- BACKLOG-2790 control 4: the unrelated writer. Shaped like the real
    -- audit_logs columns this test writes; the point is that it is a DIFFERENT
    -- table on the SAME connection.
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY, user_id TEXT, action TEXT, synced_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

/** Every stored message by identity — internal row id AND macOS guid. */
function storedRowIdentities(): Array<{ id: string; external_id: string }> {
  return (
    mockDb
      .prepare("SELECT id, external_id FROM messages")
      .all() as Array<{ id: string; external_id: string }>
  ).sort((a, b) => a.external_id.localeCompare(b.external_id));
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

function importToCompletion(force = false): Promise<MacOSImportResult> {
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

  homeDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "keepr-2797-home-"));
  scratchDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "keepr-2797-app-"));
  await fs.mkdir(nodePath.join(homeDir, "Library", "Messages"), { recursive: true });
  createSourceDb(nodePath.join(homeDir, "Library", "Messages", "chat.db"));

  // The service builds the source path from HOME. Pointing it at the temp tree is
  // what keeps this suite away from the founder's real ~/Library.
  realHome = process.env.HOME;
  process.env.HOME = homeDir;

  (app.getPath as jest.Mock).mockImplementation((name: string) =>
    name === "userData" ? scratchDir : `/tmp/test-${name}`,
  );
  jest.spyOn(fsSync.promises, "statfs").mockResolvedValue({
    type: 26, bsize: 4096, blocks: 1e9, bfree: 5e7, bavail: 5e7, files: 10, ffree: 10,
  } as fsSync.StatsFs);
});

afterEach(async () => {
  jest.restoreAllMocks();
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  mockDb?.close();
  await fs.rm(homeDir, { recursive: true, force: true });
  await fs.rm(scratchDir, { recursive: true, force: true });
});

import { getMessageText } from "../../utils/messageParser";

/** The private state these controls read. */
const svc = macOSMessagesImportService as unknown as {
  isImporting: boolean;
  forceReimportInProgress: boolean;
  forceSupersedeWaitMs: number;
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const externalIds = (): string[] =>
  storedRowIdentities()
    .map((r) => r.external_id)
    .sort();

/** Releases and runs left by the current test; drained in afterEach. */
let releases: Array<() => void> = [];
let runs: Array<Promise<unknown>> = [];

function startForce(): Promise<MacOSImportResult> {
  const run = importToCompletion(true);
  runs.push(run.catch(() => undefined));
  return run;
}

/**
 * Hold run A at its first `getMessageText`, and the run that creates the SECOND
 * staging set at its first `getMessageText` after that.
 */
function rig(): {
  holdA: ReturnType<typeof deferred>;
  aEntered: ReturnType<typeof deferred>;
  holdB: ReturnType<typeof deferred>;
  bEntered: ReturnType<typeof deferred>;
  created: string[];
} {
  const holdA = deferred();
  const aEntered = deferred();
  const holdB = deferred();
  const bEntered = deferred();
  releases.push(holdA.resolve, holdB.resolve);
  let calls = 0;
  let bStarted = false;
  let bHeld = false;
  (getMessageText as jest.Mock).mockImplementation(async () => {
    calls++;
    if (calls === 1) {
      aEntered.resolve();
      await holdA.promise;
    } else if (bStarted && !bHeld) {
      bHeld = true;
      bEntered.resolve();
      await holdB.promise;
    }
    return "message text";
  });
  const created: string[] = [];
  const realCreate = forceStagingLifecycle.create.bind(forceStagingLifecycle);
  jest.spyOn(forceStagingLifecycle, "create").mockImplementation((db, userId) => {
    const staging = realCreate(db, userId);
    created.push(staging.messagesTable);
    if (created.length === 2) bStarted = true;
    return staging;
  });
  return { holdA, aEntered, holdB, bEntered, created };
}

/** Resolves to the run's result, or to "still waiting" after `ms`. */
function within<T>(run: Promise<T>, ms: number): Promise<T | "still waiting"> {
  return Promise.race([run, sleep(ms).then(() => "still waiting" as const)]);
}

const TEST_TIMEOUT_MS = 8000;

describe("BACKLOG-2797 — a second Force Re-import waits for the first to stop", () => {
  afterEach(async () => {
    for (const release of releases) release();
    releases = [];
    await Promise.all(runs);
    runs = [];
    svc.forceSupersedeWaitMs = 30_000;
    (getMessageText as jest.Mock).mockImplementation(async () => "message text");
  });

  it(
    "C1/C2/C3: the superseded run ends cancelled (not 'no such table'), the live store is untouched during the overlap, the new run swaps, and no staging is left",
    async () => {
      await importToCompletion();
      const before = storedRowIdentities();
      const sourceIds = externalIds();
      expect(before).toHaveLength(MESSAGE_COUNT);
      const r = rig();

      const runA = startForce();
      await r.aEntered.promise;
      const aTables = stagingTableNames();
      expect(aTables).toHaveLength(2);

      const runB = startForce();
      await sleep(700); // past the old fixed 500 ms
      expect(stagingTableNames()).toEqual(aTables); // B has not swept A
      expect(storedRowIdentities()).toEqual(before); // C2 during the overlap

      r.holdA.resolve();
      const a = await runA;
      expect(a.error ?? "").not.toMatch(/no such table/); // C1
      expect(a.cancelled).toBe(true);
      expect(a.rolledBack).toBe(true);
      expect(storedRowIdentities()).toEqual(before); // C2 after A settles

      r.holdB.resolve();
      const b = await runB;
      expect(b.success).toBe(true);
      expect(b.messagesImported).toBe(MESSAGE_COUNT);
      expect(externalIds()).toEqual(sourceIds); // C2 after B swaps
      expect(stagingTableNames()).toEqual([]); // C3
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "C4: after the superseded run settles, the new run still owns the lock and Cancel reaches it",
    async () => {
      await importToCompletion();
      const before = storedRowIdentities();
      const r = rig();

      const runA = startForce();
      await r.aEntered.promise;
      const runB = startForce();
      await sleep(700);
      r.holdA.resolve();
      await runA;
      await r.bEntered.promise;

      expect(svc.isImporting).toBe(true);
      expect(svc.forceReimportInProgress).toBe(true);
      macOSMessagesImportService.requestCancellation();
      r.holdB.resolve();
      const b = await runB;
      expect(b.cancelled).toBe(true);
      expect(b.rolledBack).toBe(true);
      expect(storedRowIdentities()).toEqual(before);
      expect(stagingTableNames()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "C5: a previous run that does not stop within the bound gets a plain failure (not a coalesce), and its staging is kept",
    async () => {
      await importToCompletion();
      const before = storedRowIdentities();
      const r = rig();
      svc.forceSupersedeWaitMs = 100;

      const runA = startForce();
      await r.aEntered.promise;
      const aTables = stagingTableNames();

      const b = await within(startForce(), 2000);
      expect(b).not.toBe("still waiting");
      const refused = b as MacOSImportResult;
      expect(refused.success).toBe(false);
      expect(refused.alreadyInProgress).toBeFalsy();
      expect(refused.cancelled).toBeFalsy();
      expect(refused.error).toBe(
        "The previous import is still stopping. Try the re-import again in a minute.",
      );
      expect(stagingTableNames()).toEqual(aTables);

      r.holdA.resolve();
      const a = await runA;
      expect(a.cancelled).toBe(true);
      expect(storedRowIdentities()).toEqual(before);
      expect(stagingTableNames()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "C6: Cancel pressed while the new run waits cancels the new run; it creates no staging and changes nothing",
    async () => {
      await importToCompletion();
      const before = storedRowIdentities();
      const r = rig();

      const runA = startForce();
      await r.aEntered.promise;
      const aTables = stagingTableNames();

      const runB = startForce();
      await sleep(200); // B is waiting on A
      macOSMessagesImportService.requestCancellation();

      // A is still held: B must answer without waiting for it.
      const b = await within(runB, 2000);
      expect(b).not.toBe("still waiting");
      const cancelled = b as MacOSImportResult;
      expect(cancelled.success).toBe(false);
      expect(cancelled.cancelled).toBe(true);
      expect(cancelled.rolledBack).toBe(true);
      expect(stagingTableNames()).toEqual(aTables); // B created none, swept none
      expect(r.created).toHaveLength(1);

      r.holdA.resolve();
      const a = await runA;
      expect(a.cancelled).toBe(true);
      expect(storedRowIdentities()).toEqual(before);
      expect(stagingTableNames()).toEqual([]);
      expect(r.created).toHaveLength(1); // B never resumed after A settled
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "C7: two force runs waiting on the same run — exactly one takes the lock, the other is refused as already in progress",
    async () => {
      await importToCompletion();
      const sourceIds = externalIds();
      const r = rig();

      const runA = startForce();
      await r.aEntered.promise;
      const runB = startForce();
      const runC = startForce();
      await sleep(200);

      r.holdA.resolve();
      const a = await runA;
      expect(a.cancelled).toBe(true);

      const c = await within(runC, 2000);
      expect(c).not.toBe("still waiting");
      const refused = c as MacOSImportResult;
      expect(refused.success).toBe(false);
      expect(refused.alreadyInProgress).toBe(true);
      expect(svc.isImporting).toBe(true);
      expect(svc.forceReimportInProgress).toBe(true);

      r.holdB.resolve();
      const b = await runB;
      expect(b.success).toBe(true);
      expect(b.messagesImported).toBe(MESSAGE_COUNT);
      expect(r.created).toHaveLength(2); // A's and B's; C never staged
      expect(externalIds()).toEqual(sourceIds);
      expect(stagingTableNames()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});
