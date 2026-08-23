/**
 * @jest-environment node
 *
 * BACKLOG-2790 — stage-and-swap force re-import, against the REAL sqlite drivers.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUITE IS FOR
 * ---------------------------------------------------------------------------
 * The force path no longer deletes anything until it has finished rebuilding.
 * It writes the rebuild into an ephemeral staging table with ordinary short
 * transactions and swaps that into place in ONE transaction at the end. The
 * whole value of that design is what happens when the run does NOT finish, so
 * the controls here are cancellations, an injected failure at the swap seam, a
 * crashed previous run's leftovers, and — the point of the architecture — an
 * unrelated writer working on the same connection while a force re-import is in
 * flight.
 *
 * It drives the REAL drivers for the same reason the BACKLOG-2775 suite does: a
 * mocked database cannot tell a committed write from an uncommitted one, so a
 * mocked version of every test below would pass against the old long-transaction
 * design too.
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
  forceSwapSteps,
  STAGING_TABLE_PREFIX,
  type ForceStaging,
} from "../macOSMessagesImportService/forceStaging";

const USER = "user-stage-and-swap-2790";
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
    -- BACKLOG-2814: display_name is ALWAYS a column of Apple's real `chat`
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

function auditLogIds(): string[] {
  return (mockDb.prepare("SELECT id FROM audit_logs").all() as Array<{ id: string }>)
    .map((r) => r.id)
    .sort();
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
 * Watch this run's staging tables without changing what they do.
 *
 * `drop()` is the last thing that touches them, so wrapping it is the only place
 * their contents can be counted — which is what distinguishes "cancelled with a
 * COMPLETE rebuild waiting to be swapped" from "cancelled early". Without that
 * count, a test asserting the live store is untouched would be equally green for
 * a run that gave up before staging anything.
 */
function watchStaging(): { rowsAtDrop: () => number | null } {
  let rowsAtDrop: number | null = null;
  const create = forceStagingLifecycle.create.bind(forceStagingLifecycle);
  jest
    .spyOn(forceStagingLifecycle, "create")
    .mockImplementation((db, userId): ForceStaging => {
      const staging = create(db, userId);
      return {
        ...staging,
        drop: () => {
          const row = mockDb
            .prepare(`SELECT COUNT(*) AS count FROM "${staging.messagesTable}"`)
            .get() as { count: number } | undefined;
          if (row) rowsAtDrop = row.count;
          staging.drop();
        },
      };
    });
  return { rowsAtDrop: () => rowsAtDrop };
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

  homeDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "keepr-2790-home-"));
  scratchDir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "keepr-2790-app-"));
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

describe("BACKLOG-2790 — an unrelated writer during a force re-import", () => {
  it("keeps an audit_logs row written mid-rebuild when the run is then cancelled", async () => {
    // THE POINT OF THE ARCHITECTURE, as a test.
    //
    // Under the BACKLOG-2775 design the force path held one BEGIN IMMEDIATE
    // transaction open for the whole run. Every write in this process goes
    // through the SAME better-sqlite3 handle, so an unrelated write landing in
    // that window silently JOINED the force transaction and was destroyed by its
    // rollback. That is exactly what the quiesce machinery was built to bound,
    // and it could only ever bound the two writers it knew about — the
    // event-driven `insertAuditLog` and submissionSyncService's realtime
    // subscription stayed exposed, and were documented as residuals.
    //
    // Stage-and-swap removes the window rather than narrowing it: the rebuild
    // writes to staging with ordinary short transactions, so this row commits on
    // its own and cannot be rolled back by anyone.
    //
    // RUN THIS AGAINST THE PRE-CHANGE CODE AND IT GOES RED: the row is written
    // inside BEGIN IMMEDIATE and the cancel's ROLLBACK takes it with it.
    await importToCompletion();
    const before = storedRowIdentities();
    expect(before).toHaveLength(MESSAGE_COUNT);

    let wroteAuditRow = false;
    let cancelSent = false;
    const result = await macOSMessagesImportService.importMessages(
      USER,
      (progress) => {
        if (!wroteAuditRow && progress.phase === "importing" && progress.current >= 1) {
          // An audited user action — an export, a permission grant, a sign-in —
          // happening while the re-import runs. Same connection, different table.
          wroteAuditRow = true;
          mockDb
            .prepare("INSERT INTO audit_logs (id, user_id, action) VALUES (?, ?, ?)")
            .run("audit-during-rebuild", USER, "export.generated");
        }
        if (wroteAuditRow && !cancelSent) {
          cancelSent = true;
          macOSMessagesImportService.requestCancellation();
        }
      },
      testImportPlan({
        mode: "reprocess",
        storedFilters: { lookbackMonths: null, maxMessages: null },
      }),
    );

    // The cancel behaved exactly as the founder verified it.
    expect(result.cancelled).toBe(true);
    expect(result.rolledBack).toBe(true);
    expect(storedRowIdentities()).toEqual(before);

    // ...and the bystander's work survived it. This is the assertion the old
    // design could not satisfy.
    expect(wroteAuditRow).toBe(true);
    expect(auditLogIds()).toEqual(["audit-during-rebuild"]);
  });
});

describe("BACKLOG-2790 — an interrupted force re-import leaves the live store alone", () => {
  it("cancel MID-REBUILD: every stored row keeps its identity, and the scratch is reclaimed", async () => {
    const seed = await importToCompletion();
    expect(seed.messagesImported).toBe(MESSAGE_COUNT);
    const before = storedRowIdentities();

    let cancelSent = false;
    const result = await macOSMessagesImportService.importMessages(
      USER,
      (progress) => {
        if (!cancelSent && progress.phase === "importing" && progress.current >= 1) {
          cancelSent = true;
          macOSMessagesImportService.requestCancellation();
        }
      },
      testImportPlan({
        mode: "reprocess",
        storedFilters: { lookbackMonths: null, maxMessages: null },
      }),
    );

    expect(result.cancelled).toBe(true);
    expect(result.rolledBack).toBe(true);
    // Identity, not count: a run that deleted 150 rows and wrote 150 new ones
    // has the same count and none of the same rows. `id` is a fresh
    // `crypto.randomUUID()` per stored message, so comparing the full
    // {id, external_id} set is what separates "untouched" from "replaced".
    expect(storedRowIdentities()).toEqual(before);
    expect(stagingTableNames()).toEqual([]);
  });

  it("cancel BETWEEN a completed rebuild and the swap: the finished rebuild is discarded whole", async () => {
    // The narrowest window there is, and the one the old design could not have
    // survived without its rollback: everything has been rebuilt and the store
    // is one transaction away from being replaced.
    const watcher = watchStaging();
    await importToCompletion();
    const before = storedRowIdentities();

    let cancelSent = false;
    const result = await macOSMessagesImportService.importMessages(
      USER,
      (progress) => {
        // The LAST message-phase event: every batch has been staged by the time
        // this fires, so the cancel is consumed at the pre-swap check.
        if (!cancelSent && progress.phase === "importing" && progress.current >= MESSAGE_COUNT) {
          cancelSent = true;
          macOSMessagesImportService.requestCancellation();
        }
      },
      testImportPlan({
        mode: "reprocess",
        storedFilters: { lookbackMonths: null, maxMessages: null },
      }),
    );

    expect(result.cancelled).toBe(true);
    expect(result.rolledBack).toBe(true);
    expect(result.messagesImported).toBe(0);
    expect(storedRowIdentities()).toEqual(before);

    // The distinguishing fact: the rebuild had FINISHED. Without this the test
    // would be equally green for a cancel that landed in the first batch.
    expect(watcher.rowsAtDrop()).toBe(MESSAGE_COUNT);
    expect(stagingTableNames()).toEqual([]);
  });

  it("a failure BETWEEN the swap's delete and its insert leaves the store intact", async () => {
    // THE ATOMICITY CONTROL, and the reason `forceSwapSteps` is an object of
    // named steps rather than three statements in a row: the claim is that the
    // delete and the insert are one indivisible act, and the only way to
    // demonstrate that is to interrupt them between.
    //
    // This stands in for a crash — a process killed after the delete has run,
    // which is the single most destructive moment in the whole design. THE
    // MUTATION THAT PROVES IT: run the steps in separate transactions inside
    // `swapStagingIntoLive` and this test goes red with the store emptied,
    // exactly as the founder's 162,961 messages were.
    await importToCompletion();
    const before = storedRowIdentities();

    const insertSpy = jest
      .spyOn(forceSwapSteps, "insertFromStaging")
      .mockImplementation(() => {
        throw new Error("process died between stage and swap");
      });

    const result = await importToCompletion(true);

    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.error).toBe("process died between stage and swap");
    // The failure card must not leave the user believing their messages are gone.
    expect(result.rolledBack).toBe(true);
    // And they are not.
    expect(storedRowIdentities()).toEqual(before);

    insertSpy.mockRestore();
  });

  it("CONTROL: the same force re-import, uninterrupted, does replace every row", async () => {
    // Without this, every test above would be equally green for a force path
    // that had quietly stopped working — a swap that never runs preserves the
    // store perfectly.
    await importToCompletion();
    const before = storedRowIdentities();

    const result = await importToCompletion(true);

    expect(result.success).toBe(true);
    expect(result.messagesImported).toBe(MESSAGE_COUNT);
    const after = storedRowIdentities();
    expect(after.map((r) => r.external_id)).toEqual(before.map((r) => r.external_id));
    // Genuinely re-created: not one internal id survives.
    expect(after.filter((r) => before.some((b) => b.id === r.id))).toEqual([]);
    // And the scratch space is gone on the success path too.
    expect(stagingTableNames()).toEqual([]);
  });
});

describe("BACKLOG-2790 — staging left by a crashed run", () => {
  it("is reclaimed by the next force re-import, which still completes normally", async () => {
    // A process killed between the rebuild and the swap runs no exit path at
    // all, so its staging tables survive it. They are inert — nothing reads them
    // — and the live store is intact precisely because the swap never ran, but
    // they hold disk space. The next force run reclaims them; BACKLOG-2768 is
    // the durable reclaimer for a user who never runs another one.
    await importToCompletion();
    const before = storedRowIdentities();

    const orphan = `${STAGING_TABLE_PREFIX}deadbeefcafe_messages`;
    mockDb.exec(`CREATE TABLE "${orphan}" (id TEXT PRIMARY KEY, user_id TEXT, external_id TEXT)`);
    mockDb
      .prepare(`INSERT INTO "${orphan}" (id, user_id, external_id) VALUES (?, ?, ?)`)
      .run("stranded-row", USER, "msg-guid-1");
    expect(stagingTableNames()).toEqual([orphan]);

    const result = await importToCompletion(true);

    expect(result.success).toBe(true);
    expect(result.messagesImported).toBe(MESSAGE_COUNT);
    // Swept, along with this run's own.
    expect(stagingTableNames()).toEqual([]);
    // The orphan's contents never reached the live store: it is a dead run's
    // scratch, not a rebuild to be resumed.
    expect(storedRowIdentities().map((r) => r.external_id)).toEqual(
      before.map((r) => r.external_id),
    );
    expect(storedRowIdentities().some((r) => r.id === "stranded-row")).toBe(false);
  });
});

describe("BACKLOG-2790 — the staging rebuild reports progress exactly as the delta path does", () => {
  /**
   * Founder QA on the real build reported the progress indicator sitting on
   * "Importing messages…" with no percentage for the whole rebuild, where the
   * old path showed a moving per-batch figure. The first question is which side
   * stopped producing, and it is answerable here rather than by reading the
   * renderer: run both paths over the same corpus and compare the streams they
   * emit.
   *
   * PARITY is the assertion, not a count. "The force path emits some events" is
   * satisfied by a path that emits one; what has to be true is that a rebuild
   * into staging is indistinguishable, from the outside, from the delta import
   * whose progress display the founder is happy with.
   */
  const collect = async (mode: "delta" | "reprocess") => {
    const events: Array<{ phase: string; current: number; total: number; percent: number }> = [];
    await macOSMessagesImportService.importMessages(
      USER,
      (p) => events.push({ ...p }),
      testImportPlan({ mode, storedFilters: { lookbackMonths: null, maxMessages: null } }),
    );
    return events;
  };

  it("emits the same phases, counts and percentages as a delta import", async () => {
    const delta = await collect("delta");
    const force = await collect("reprocess");

    // Same events, field for field. A dropped emission, a missing `percent`, or
    // a phase that stopped being reported all break this.
    expect(force).toEqual(delta);

    const importing = force.filter((e) => e.phase === "importing");
    expect(importing.length).toBeGreaterThan(0);

    // Every event is renderable: a `percent` that arrives undefined renders as a
    // bare "%" in the settings bar, which is the founder's symptom exactly.
    for (const event of force) {
      expect(typeof event.percent).toBe("number");
      expect(Number.isFinite(event.percent)).toBe(true);
      expect(event.total).toBeGreaterThan(0);
    }

    // Monotonic: progress never goes backwards within a phase.
    const counts = importing.map((e) => e.current);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(counts[counts.length - 1]).toBe(MESSAGE_COUNT);
  });

  it("keeps reporting while writing to staging, not only at the end", async () => {
    // The specific regression shape: a rebuild that reports 0% until the swap
    // and 100% after it. At least one emission must land strictly between.
    const force = await collect("reprocess");
    const midRun = force.filter(
      (e) => e.phase === "importing" && e.current > 0 && e.current < MESSAGE_COUNT,
    );
    expect(midRun.length).toBeGreaterThan(0);
  });
});
