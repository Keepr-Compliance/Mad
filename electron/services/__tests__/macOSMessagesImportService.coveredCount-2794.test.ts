/**
 * @jest-environment node
 *
 * BACKLOG-2794 — the import result must carry what the window COVERS, not only
 * what the run fetched, and must announce a collision as a collision.
 *
 * ─── WHY THE PRODUCER IS TESTED SEPARATELY FROM THE SENTENCE ─────────────────
 *
 * The dashboard's wrong sentence — "659,619 messages excluded by import limit"
 * where 645,576 were — is one subtraction with two operands, and the renderer
 * suite (`SyncOrchestratorService.excluded-2794.test.ts`) can only prove the
 * subtraction. It takes both operands from a mock. If `coveredCount` were wired
 * to the wrong quantity in this service, every assertion there would still pass
 * and the founder would still be told the wrong number.
 *
 * So this suite pins the operand: `coveredCount` is the ADMITTED set — the
 * `targetMessageCount` that `resolveAdmittedMessageSet` computes and that
 * `getAvailableMessageCount` returns to Settings as `filteredCount`, which is
 * what makes the two surfaces quote one number.
 *
 * ─── WHY IT DRIVES THE REAL SQL ENGINE ───────────────────────────────────────
 *
 * `jest.config.js` maps `^sqlite3$` to a stub whose `all` returns canned rows.
 * The counts under test ARE those queries, so a stubbed suite would assert
 * against a hand-written fake of the thing being measured. This follows
 * `macOSMessagesImportService.cap.test.ts` (BACKLOG-2744): the real driver by
 * absolute path, a real SQLite file on disk, `HOME` redirected to a temp dir.
 * The user's own `~/Library/Messages/chat.db` is never opened.
 *
 * ─── THE FIXTURE SEPARATES FETCHED FROM COVERED ──────────────────────────────
 *
 * That separation is the entire defect, and a fresh import cannot show it:
 * store everything you admit and the two numbers coincide. The founder's run
 * was a DELTA — 62,824 admitted, 48,781 actually written, 14,042 already there.
 * `storeMessages` is stubbed to report exactly that shape (some stored, the
 * rest skipped as already-present), so `messagesImported` and `coveredCount`
 * are different numbers here as they are on his machine.
 *
 * ─── NEGATIVE CONTROLS ───────────────────────────────────────────────────────
 *
 * Recorded on the PR. `coveredCount: messagesImported` reds the delta case;
 * `coveredCount: filteredMessageCount` reds the capped case; dropping
 * `alreadyInProgress` reds the collision case.
 */

import path from "path";
import fs from "fs";
import os from "os";

import { MAC_EPOCH } from "../../constants";

// The real driver, resolved by absolute path so jest's `^sqlite3$`
// moduleNameMapper (which points at a hand-written stub) does not intercept it.
jest.mock("sqlite3", () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(
    require("path").join(__dirname, "..", "..", "..", "node_modules", "sqlite3"),
  ),
);

jest.mock("../logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../permissionService", () => ({
  __esModule: true,
  default: {
    checkFullDiskAccess: jest.fn(async () => ({ hasPermission: true })),
  },
}));

/**
 * The force path asks for the app database before it builds its staging tables.
 * Returning null keeps this suite off the encrypted store — the collision under
 * test happens in `importMessages`, before `doImport` is even entered, so no
 * staging is required to reach it.
 */
jest.mock("../databaseService", () => ({
  __esModule: true,
  default: { getRawDatabase: () => null },
}));

jest.mock("../supportAccess/trace", () => ({
  __esModule: true,
  supportTrace: jest.fn(),
}));

import macOSMessagesImportService from "../macOSMessagesImportService/macOSMessagesImportService";
import permissionService from "../permissionService";
import type { RawMacMessage } from "../macOSMessagesImportService/types";
// BACKLOG-2772: plans are built by the REAL resolver, never hand-written.
import { testImportPlan } from "./helpers/importPlanFixture";

// ============================================================================
// Fixture — 16 importable messages, one NULL-guid row that is not importable
// ============================================================================

const DAY_MS = 24 * 60 * 60 * 1000;
/** Whole-second aligned against MAC_EPOCH; see the note in the cap suite. */
const NOW_MS = MAC_EPOCH + Math.floor((Date.now() - MAC_EPOCH) / 1000) * 1000;

function appleNanos(ms: number): number {
  return (ms - MAC_EPOCH) * 1_000_000;
}

interface FixtureRow {
  rowid: number;
  guid: string | null;
  text: string;
  dateMs: number;
}

const ROWS: FixtureRow[] = [
  ...Array.from({ length: 16 }, (_, i): FixtureRow => {
    const n = i + 1;
    return {
      rowid: n * 10,
      guid: `msg-${String(n).padStart(2, "0")}`,
      text: `fixture message ${n}`,
      dateMs: NOW_MS - (17 - n) * DAY_MS,
    };
  }),
  // Not importable: the fetch filters `guid IS NOT NULL`. Present so the counts
  // asserted below are counts of IMPORTABLE rows, not rows.
  { rowid: 165, guid: null, text: "no guid", dateMs: NOW_MS - 1.5 * DAY_MS },
];

const IMPORTABLE = 16;

const CHAT_DB_DDL = [
  `CREATE TABLE message (
     ROWID INTEGER PRIMARY KEY,
     guid TEXT,
     text TEXT,
     attributedBody BLOB,
     date INTEGER,
     is_from_me INTEGER,
     handle_id INTEGER,
     service TEXT,
     cache_has_attachments INTEGER,
     associated_message_type INTEGER,
     associated_message_guid TEXT
   )`,
  `CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT)`,
  `CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, account_login TEXT)`,
  `CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER)`,
  `CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER)`,
  `CREATE TABLE attachment (
     ROWID INTEGER PRIMARY KEY,
     guid TEXT,
     filename TEXT,
     mime_type TEXT,
     transfer_name TEXT,
     total_bytes INTEGER,
     is_outgoing INTEGER
   )`,
  `CREATE TABLE message_attachment_join (attachment_id INTEGER, message_id INTEGER)`,
];

/**
 * Write a real, queryable chat.db with the real driver.
 *
 * Every phone number here is synthetic (555-01xx is the reserved fictional
 * range) — this repository is public.
 */
async function writeFixtureDb(dbPath: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sqlite3 = require("sqlite3");
  const db = await new Promise<{
    run: (sql: string, params?: unknown[]) => Promise<void>;
    close: () => Promise<void>;
  }>((resolve, reject) => {
    const handle = new sqlite3.Database(
      dbPath,
      sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
      (err: Error | null) => {
        if (err) {
          reject(err);
          return;
        }
        resolve({
          run: (sql: string, params: unknown[] = []) =>
            new Promise<void>((res, rej) => {
              handle.run(sql, params, (runErr: Error | null) =>
                runErr ? rej(runErr) : res(),
              );
            }),
          close: () =>
            new Promise<void>((res, rej) => {
              handle.close((closeErr: Error | null) =>
                closeErr ? rej(closeErr) : res(),
              );
            }),
        });
      },
    );
  });

  for (const ddl of CHAT_DB_DDL) await db.run(ddl);

  await db.run(`INSERT INTO handle (ROWID, id) VALUES (?, ?)`, [1, "+12025550142"]);
  await db.run(`INSERT INTO chat (ROWID, account_login) VALUES (?, ?)`, [1, "P:+12025550188"]);
  await db.run(`INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)`, [1, 1]);

  await db.run("BEGIN");
  for (const row of ROWS) {
    await db.run(
      `INSERT INTO message
         (ROWID, guid, text, attributedBody, date, is_from_me, handle_id,
          service, cache_has_attachments, associated_message_type,
          associated_message_guid)
       VALUES (?, ?, ?, NULL, ?, 0, 1, 'iMessage', 0, NULL, NULL)`,
      [row.rowid, row.guid, row.text, appleNanos(row.dateMs)],
    );
    await db.run(`INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)`, [
      1,
      row.rowid,
    ]);
  }
  await db.run("COMMIT");
  await db.close();
}

// ============================================================================
// Harness
// ============================================================================

interface ImportServiceInternals {
  storeMessages: (
    userId: string,
    messages: RawMacMessage[],
    chatMembersMap: Map<number, string[]>,
    chatAccountMap: Map<number, string>,
  ) => Promise<{
    stored: number;
    skipped: number;
    retagged: number;
    nullThreadIdCount: number;
    messageIdMap: Map<string, string>;
  }>;
  storeAttachments: () => Promise<{ stored: number; updated: number; skipped: number }>;
}

const internals = macOSMessagesImportService as unknown as ImportServiceInternals;

let storeMessagesSpy: jest.SpyInstance;
let storeAttachmentsSpy: jest.SpyInstance;

/**
 * Storage, reporting a DELTA: `alreadyPresent` of the fetched rows were already
 * in the store and are skipped, the rest are written. This is the shape that
 * makes `messagesImported` smaller than the admitted set — the founder's 48,781
 * of 62,824 — and it is the only reason the two numbers can be told apart.
 */
function installStorageSpies(alreadyPresent = 0, onStore?: () => Promise<void>): void {
  storeMessagesSpy = jest
    .spyOn(internals, "storeMessages")
    .mockImplementation(async (_userId, messages) => {
      if (onStore) await onStore();
      const skipped = Math.min(alreadyPresent, messages.length);
      return {
        stored: messages.length - skipped,
        skipped,
        retagged: 0,
        nullThreadIdCount: 0,
        messageIdMap: new Map<string, string>(),
      };
    });

  storeAttachmentsSpy = jest
    .spyOn(internals, "storeAttachments")
    .mockImplementation(async () => ({ stored: 0, updated: 0, skipped: 0 }));
}

// The import is macOS-only — `doImport` returns early on any other platform.
const macOnly = process.platform === "darwin" ? describe : describe.skip;

macOnly("BACKLOG-2794 — the import result carries the admitted count", () => {
  let tmpHome: string;
  let realHome: string | undefined;

  beforeAll(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-2794-"));
    const messagesDir = path.join(tmpHome, "Library", "Messages");
    fs.mkdirSync(messagesDir, { recursive: true });
    await writeFixtureDb(path.join(messagesDir, "chat.db"));

    realHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });

  afterAll(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  afterEach(() => {
    storeMessagesSpy?.mockRestore();
    storeAttachmentsSpy?.mockRestore();
  });

  it("reports the ADMITTED set, which a delta run does not equal", async () => {
    // 16 importable, cap 5, and 3 of the 5 fetched are already in the store.
    installStorageSpies(3);

    const result = await macOSMessagesImportService.importMessages(
      "user-1",
      undefined,
      testImportPlan({ storedFilters: { lookbackMonths: null, maxMessages: 5 } }),
    );

    expect(result.success).toBe(true);
    expect(result.wasCapped).toBe(true);
    // The window.
    expect(result.totalAvailable).toBe(IMPORTABLE);
    // What the run WROTE. Smaller, because the store already had three of them.
    expect(result.messagesImported).toBe(2);
    // What the window COVERS: the cap, in full. This is the operand the
    // exclusion sentence subtracts.
    expect(result.coveredCount).toBe(5);
    // Named explicitly: conflating these two is the defect, and a build that
    // wired `coveredCount` to the fetch count would pass every count above.
    expect(result.coveredCount).not.toBe(result.messagesImported);

    // The sentence the dashboard will now build, and the one it used to.
    expect(result.totalAvailable! - result.coveredCount!).toBe(11);
    expect(result.totalAvailable! - result.messagesImported).toBe(14);
  });

  it("equals the window when no cap truncates it — the zero-exclusion case", async () => {
    installStorageSpies();

    const result = await macOSMessagesImportService.importMessages(
      "user-1",
      undefined,
      testImportPlan({ storedFilters: { lookbackMonths: null, maxMessages: null } }),
    );

    expect(result.wasCapped).toBeFalsy();
    expect(result.coveredCount).toBe(IMPORTABLE);
    expect(result.totalAvailable).toBe(IMPORTABLE);
    // Which is what makes the orchestrator emit no clause at all: nothing was
    // excluded, so there is nothing to say.
    expect(result.totalAvailable! - result.coveredCount!).toBe(0);
  });

  it("tracks the cap exactly across the boundary", async () => {
    // One input per branch cannot catch an off-by-one; sweep the edge.
    for (const cap of [1, 2, IMPORTABLE - 1, IMPORTABLE, IMPORTABLE + 1]) {
      installStorageSpies();
      const result = await macOSMessagesImportService.importMessages(
        "user-1",
        undefined,
        testImportPlan({ storedFilters: { lookbackMonths: null, maxMessages: cap } }),
      );
      expect(result.coveredCount).toBe(Math.min(cap, IMPORTABLE));
      storeMessagesSpy.mockRestore();
      storeAttachmentsSpy.mockRestore();
    }
  });
});

macOnly("BACKLOG-2794 — a refused concurrent import says so", () => {
  let tmpHome: string;
  let realHome: string | undefined;

  beforeAll(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-2794-collide-"));
    const messagesDir = path.join(tmpHome, "Library", "Messages");
    fs.mkdirSync(messagesDir, { recursive: true });
    await writeFixtureDb(path.join(messagesDir, "chat.db"));

    realHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });

  afterAll(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  afterEach(() => {
    storeMessagesSpy?.mockRestore();
    storeAttachmentsSpy?.mockRestore();
  });

  it("refuses a delta import while a FORCE re-import holds the service", async () => {
    /*
     * THE SECOND REFUSAL SITE, driven rather than described.
     *
     * `importMessages` has TWO gates that refuse a caller because another run
     * owns the service, and they are reached by different state:
     *   - `forceReimportInProgress && !forceReimport`  (the one under test)
     *   - `isImporting`                                (the next test)
     * Both now carry `alreadyInProgress`, and the flag on the FIRST was
     * unpinned: SR deleted it and 12,650 tests stayed green, because the only
     * thing "covering" it was an orchestrator test restating the shape by hand.
     * A fixture that repeats what a producer emits cannot fail when the producer
     * changes — the same defect I found in the strip guard, one file over.
     *
     * So the flag is really set here: a REAL force run is held inside
     * `doImport` (blocked at the permission check, which is the first thing it
     * awaits and is already a seam in this suite), and a REAL delta call arrives
     * while it holds. `error` is asserted by IDENTITY, because it is the only
     * thing that distinguishes this gate from the `isImporting` one below —
     * without it, this test would pass on a build where only the other site
     * carried the flag.
     */
    installStorageSpies();

    let releaseForce: () => void = () => {};
    const forceIsInsideDoImport = new Promise<void>((resolve) => {
      (permissionService.checkFullDiskAccess as jest.Mock).mockImplementationOnce(
        async () => {
          resolve();
          await new Promise<void>((res) => { releaseForce = res; });
          return { hasPermission: true };
        },
      );
    });

    const force = macOSMessagesImportService.importMessages(
      "user-1",
      undefined,
      testImportPlan({
        mode: "reprocess",
        storedFilters: { lookbackMonths: null, maxMessages: null },
      }),
    );
    await forceIsInsideDoImport;

    const refused = await macOSMessagesImportService.importMessages(
      "user-1",
      undefined,
      testImportPlan({ storedFilters: { lookbackMonths: null, maxMessages: null } }),
    );

    /*
     * The release is in a `finally` because a failed assertion here would
     * otherwise leave the force run parked on the permission gate FOREVER —
     * `isImporting` and `forceReimportInProgress` both still set — and every
     * later test in this file would be refused for a reason it never asked
     * about. Observed while running the control: deleting the flag reddened
     * this test AND the next one, and only one of those reds was real. A test
     * that poisons its neighbours reports failures nobody can locate.
     */
    try {
      expect(refused.alreadyInProgress).toBe(true);
      expect(refused.success).toBe(false);
      // Identity, not shape: this refusal came from the FORCE gate.
      expect(refused.error).toBe("Force reimport in progress");
      expect(refused.messagesImported).toBe(0);
    } finally {
      releaseForce();
      await force.catch(() => undefined);
    }

    // The refusal was scoped to the window, not a wedged service — otherwise
    // every later assertion in this file would be describing a dead lock.
    const after = await macOSMessagesImportService.importMessages(
      "user-1",
      undefined,
      testImportPlan({ storedFilters: { lookbackMonths: null, maxMessages: null } }),
    );
    expect(after.alreadyInProgress).toBeUndefined();
    expect(after.success).toBe(true);
  });

  it("returns alreadyInProgress rather than a bare failure", async () => {
    // The real serialization, driven the way production reaches it: a second
    // caller arriving while the first still holds the service. The first import
    // is held inside `storeMessages` — genuinely in flight, `isImporting` set by
    // the service itself, not by poking a private field.
    let releaseFirst: () => void = () => {};
    const firstIsStoring = new Promise<void>((resolve) => {
      installStorageSpies(0, async () => {
        resolve();
        await new Promise<void>((res) => { releaseFirst = res; });
      });
    });

    const first = macOSMessagesImportService.importMessages(
      "user-1",
      undefined,
      testImportPlan({ storedFilters: { lookbackMonths: null, maxMessages: null } }),
    );
    await firstIsStoring;

    const collided = await macOSMessagesImportService.importMessages(
      "user-1",
      undefined,
      testImportPlan({ storedFilters: { lookbackMonths: null, maxMessages: null } }),
    );

    // The typed discriminator the orchestrator coalesces on. Without it the
    // refusal is indistinguishable from a dead chat.db at the boundary, and the
    // consumer is left string-matching `error`.
    expect(collided.alreadyInProgress).toBe(true);
    expect(collided.success).toBe(false);
    expect(collided.error).toBe("Import already in progress");
    expect(collided.messagesImported).toBe(0);

    releaseFirst();
    const firstResult = await first;
    // The run that owned the service was untouched by the refusal.
    expect(firstResult.success).toBe(true);
    expect(firstResult.alreadyInProgress).toBeUndefined();
  });
});
