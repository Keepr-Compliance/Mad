/**
 * @jest-environment node
 *
 * BACKLOG-2744 — the message-import cap must keep the NEWEST N, not the oldest.
 *
 * ─── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * The fetch in `doImport` is keyset pagination cursored on ROWID:
 *
 *   WHERE message.guid IS NOT NULL AND message.ROWID > ?  ORDER BY ROWID ASC  LIMIT ?
 *
 * When the cap applies (no audit period + an explicit `maxMessages`) the loop
 * simply stops once it has read `maxMessages` rows — which, walking ROWID
 * upward from 0, is the OLDEST N. The Settings copy promises "most recent N";
 * the import delivered the archive. The comment above the cap calculation shows
 * the authors knew: they exempted the audit-period case for exactly this reason
 * and left the casual case wrong.
 *
 * ─── WHY THIS SUITE DRIVES THE REAL SQL ENGINE ───────────────────────────────
 *
 * `jest.config.js` maps `^sqlite3$` to `tests/__mocks__/sqlite3.js`, whose `all`
 * returns canned rows. A suite running against that stub would be asserting
 * against a hand-written fake of the very query under test — it would pass just
 * as happily against the broken code. So this suite follows the pattern
 * established by `readOnlySqlite.test.ts` (BACKLOG-2403): require the REAL
 * driver by absolute path, build a REAL SQLite file on disk with the tables the
 * fetch phase queries, and point the service at it by redirecting `HOME` to a
 * temp dir. The user's real `~/Library/Messages/chat.db` is never opened.
 *
 * Storage is the one thing stubbed: `storeMessages` / `storeAttachments` are
 * spied on the service instance so the suite can capture the exact row set the
 * fetch phase produced without standing up the app's encrypted database. That
 * captured set IS the import window, which is where the defect lives.
 *
 * ─── NEGATIVE CONTROLS ───────────────────────────────────────────────────────
 *
 * Run against the unfixed service, "keeps the newest N" reported the OLDEST N
 * (msg-01..msg-05 where msg-08..msg-12 was expected) and "cap of 1 keeps only
 * the newest message" reported msg-01. Recorded on BACKLOG-2744.
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

const mockLogWarn = jest.fn();
const mockLogError = jest.fn();
jest.mock("../logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: (...args: unknown[]) => mockLogWarn(...args),
    error: (...args: unknown[]) => mockLogError(...args),
    debug: jest.fn(),
  },
}));

/**
 * Fault-injection seam for the cap window-start query.
 *
 * The `capWindowStartRowId === null` branch cannot be reached through any input:
 * the filtered COUNT has already proved there are more rows than the cap, so the
 * OFFSET is in range by construction. In production it is reachable by a race —
 * each `all()` is its own read against a live WAL-mode chat.db, so a bulk prune
 * between the COUNT and the window-start query sends OFFSET out of range — or by
 * an unchecked-cast bug, since `dbAll<{ start_rowid: number }>` yields
 * `undefined` for a renamed column alias rather than raising.
 *
 * The branch is therefore driven here rather than through the fixture: the real
 * `openSqliteReadOnly` handle is wrapped and the window-start query alone is made
 * to resolve nothing. Matching on SQL text would be a poor basis for production
 * routing; for injecting one fault into one query it is exactly right, and the
 * alternative — a test-only hook on the service — would put production code in a
 * path only tests use.
 *
 * The flag is an object, not a boolean, so the hoisted `jest.mock` factory closes
 * over a stable binding it dereferences only at call time. The `mock` prefix is
 * what permits referencing it from the factory at all.
 */
const mockWindowStartFault = {
  active: false,
  /**
   * How many times the fault actually replaced a result. Asserted by the tests
   * that use it: a fault seam that quietly stops matching turns a real control
   * into a test of the ordinary path, and it does so silently — the assertions
   * would simply describe the unfaulted behaviour and stay green.
   */
  hits: 0,
  /** The window-start query is the only one that orders ROWID descending. */
  matches: (sql: string): boolean => /ORDER BY\s+message\.ROWID\s+DESC/i.test(sql),
};

jest.mock("../db/readOnlySqlite", () => {
  const actual = jest.requireActual("../db/readOnlySqlite");
  return {
    ...actual,
    openSqliteReadOnly: async (dbPath: string, context?: string) => {
      const handle = await actual.openSqliteReadOnly(dbPath, context);
      return {
        ...handle,
        all: (sql: string, params?: unknown) => {
          if (mockWindowStartFault.active && mockWindowStartFault.matches(sql)) {
            mockWindowStartFault.hits += 1;
            // Exactly what a raced, out-of-range OFFSET returns: no rows, no error.
            return Promise.resolve([]);
          }
          return handle.all(sql, params);
        },
      };
    },
  };
});

jest.mock("../permissionService", () => ({
  __esModule: true,
  default: {
    checkFullDiskAccess: jest.fn(async () => ({ hasPermission: true })),
  },
}));

jest.mock("../supportAccess/trace", () => ({
  __esModule: true,
  supportTrace: jest.fn(),
}));

import macOSMessagesImportService from "../macOSMessagesImportService/macOSMessagesImportService";
import type { RawMacMessage } from "../macOSMessagesImportService/types";

// ============================================================================
// Fixture
// ============================================================================

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The audit-period window used below, deliberately offset by HALF A DAY so no
 * fixture message sits on the cutoff instant.
 *
 * This is not fussiness. The service interpolates the cutoff into SQL as
 * `AND message.date > ${appleDateCutoffNano}`, and that value — milliseconds
 * since 2001 multiplied by 1e6 — is ~7.9e17, well past `Number.MAX_SAFE_INTEGER`.
 * JS prints the shortest decimal that round-trips, which for about half of all
 * instants is NOT the double's exact integer value: e.g. the double at
 * 808527267713000000 is exactly 808527267712999936 and prints as
 * ...713000000. The bound fixture value keeps the exact form while the
 * interpolated literal takes the printed one, so a message stored AT the cutoff
 * falls inside or outside depending on the wall-clock instant the suite runs at.
 * An earlier draft used a whole-day offset, put msg-05 exactly on the boundary,
 * and flipped between runs. The ±64ns fuzz is harmless in production; a fixture
 * standing on it is not. Keep the half-day gap.
 */
const AUDIT_WINDOW_MS = 7.5 * DAY_MS;

/** Convert a JS epoch-millisecond instant to Apple's nanoseconds-since-2001. */
function appleNanos(ms: number): number {
  return (ms - MAC_EPOCH) * 1_000_000;
}

/**
 * The corpus, described the way the assertions read it.
 *
 * ROWIDs are spaced with gaps and the recent block starts well above the old
 * block, because the fix walks ROWIDs and must not assume they are contiguous.
 *
 * `msg-01` … `msg-12` are the RECENT block: msg-NN is (13 - NN) days old, so
 * msg-12 is the newest message in the database and msg-01 the oldest recent one.
 * `old-01` … `old-05` sit ~200 days back, below the recent block in ROWID order,
 * and exist so a lookback window has something to exclude.
 *
 * One row carries a NULL guid at ROWID 115 — ABOVE the seed point of every
 * capped case below. The shipped fetch filters `guid IS NOT NULL`, so this row
 * must be invisible to the import; putting it high in ROWID order is what makes
 * the WHERE-parity control able to fail. A start-ROWID query that forgot
 * `guid IS NOT NULL` would count it and land one row too high, and the import
 * would come up short.
 */
const BASE_MS = Date.UTC(2026, 0, 15, 12, 0, 0); // fixed instant, not "now"
const NOW_MS = Date.now();

interface FixtureRow {
  rowid: number;
  guid: string | null;
  text: string;
  dateMs: number;
  handleRowId: number;
  chatId: number;
}

const RECENT_ROWS: FixtureRow[] = Array.from({ length: 12 }, (_, i) => {
  const n = i + 1;
  return {
    rowid: n * 10, // 10, 20, … 120 (gaps on purpose)
    guid: `msg-${String(n).padStart(2, "0")}`,
    text: `fixture message ${n}`,
    dateMs: NOW_MS - (13 - n) * DAY_MS,
    handleRowId: 1,
    chatId: 1,
  };
});

const OLD_ROWS: FixtureRow[] = Array.from({ length: 5 }, (_, i) => {
  const n = i + 1;
  return {
    rowid: n, // 1 … 5 — below the whole recent block
    guid: `old-${String(n).padStart(2, "0")}`,
    text: `fixture archive message ${n}`,
    dateMs: NOW_MS - (200 + n) * DAY_MS,
    handleRowId: 1,
    chatId: 1,
  };
});

const NULL_GUID_ROW: FixtureRow = {
  rowid: 115, // between msg-11 (110) and msg-12 (120)
  guid: null,
  text: "fixture row with no guid",
  dateMs: NOW_MS - 1.5 * DAY_MS,
  handleRowId: 1,
  chatId: 1,
};

const ALL_ROWS: FixtureRow[] = [...OLD_ROWS, ...RECENT_ROWS, NULL_GUID_ROW];

/** Every importable guid, oldest ROWID first — the order the fetch produces. */
const IMPORTABLE_GUIDS_ASC = [...OLD_ROWS, ...RECENT_ROWS]
  .slice()
  .sort((a, b) => a.rowid - b.rowid)
  .map((r) => r.guid as string);

const RECENT_GUIDS_ASC = RECENT_ROWS.map((r) => r.guid as string);

/** The newest `n` importable guids, in the ascending order the fetch returns. */
function newestGuids(n: number, from: string[] = IMPORTABLE_GUIDS_ASC): string[] {
  return from.slice(Math.max(0, from.length - n));
}

/** The oldest `n` importable guids — what the BROKEN code returned. */
function oldestGuids(n: number, from: string[] = IMPORTABLE_GUIDS_ASC): string[] {
  return from.slice(0, n);
}

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
 * Every phone number and address here is synthetic (555-01xx is the reserved
 * fictional range) — this repository is public.
 */
async function writeFixtureDb(dbPath: string, rows: FixtureRow[]): Promise<void> {
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

  for (const ddl of CHAT_DB_DDL) {
    await db.run(ddl);
  }

  await db.run(`INSERT INTO handle (ROWID, id) VALUES (?, ?)`, [
    1,
    "+12025550142",
  ]);
  await db.run(`INSERT INTO chat (ROWID, account_login) VALUES (?, ?)`, [
    1,
    "P:+12025550188",
  ]);
  await db.run(
    `INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)`,
    [1, 1],
  );

  await db.run("BEGIN");
  for (const row of rows) {
    await db.run(
      `INSERT INTO message
         (ROWID, guid, text, attributedBody, date, is_from_me, handle_id,
          service, cache_has_attachments, associated_message_type,
          associated_message_guid)
       VALUES (?, ?, ?, NULL, ?, 0, ?, 'iMessage', 0, NULL, NULL)`,
      [row.rowid, row.guid, row.text, appleNanos(row.dateMs), row.handleRowId],
    );
    await db.run(
      `INSERT INTO chat_message_join (chat_id, message_id) VALUES (?, ?)`,
      [row.chatId, row.rowid],
    );
  }
  await db.run("COMMIT");

  await db.close();
}

// ============================================================================
// Harness
// ============================================================================

/** The private methods this suite stubs, named so the casts stay honest. */
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
  storeAttachments: () => Promise<{
    stored: number;
    updated: number;
    skipped: number;
  }>;
}

const internals = macOSMessagesImportService as unknown as ImportServiceInternals;

let capturedMessages: RawMacMessage[] = [];
let storeMessagesSpy: jest.SpyInstance;
let storeAttachmentsSpy: jest.SpyInstance;

function installStorageSpies(): void {
  storeMessagesSpy = jest
    .spyOn(internals, "storeMessages")
    .mockImplementation(async (_userId, messages) => {
      capturedMessages = messages;
      return {
        stored: messages.length,
        skipped: 0,
        retagged: 0,
        nullThreadIdCount: 0,
        messageIdMap: new Map<string, string>(),
      };
    });

  storeAttachmentsSpy = jest
    .spyOn(internals, "storeAttachments")
    .mockImplementation(async () => ({ stored: 0, updated: 0, skipped: 0 }));
}

/** The guids the fetch phase handed to storage, in the order it handed them. */
function importedGuids(): string[] {
  return capturedMessages.map((m) => m.guid);
}

/**
 * Errors emitted by the cap window-start fallback.
 *
 * Asserted as ERROR, not warn: an import that silently ignores the user's cap is
 * a wrong-data class, and the level is the difference between a support trace
 * that answers "why did I get everything?" and one that does not.
 */
function windowStartFailures(): string[] {
  return mockLogError.mock.calls
    .map((c) => String(c[0]))
    .filter((m) => m.includes("window-start ROWID could not be resolved"));
}

// The import is macOS-only — `doImport` returns early on any other platform, so
// on Windows every assertion below would be asserting on that early return.
const macOnly = process.platform === "darwin" ? describe : describe.skip;

macOnly("macOS message import cap keeps the NEWEST messages (BACKLOG-2744)", () => {
  let tmpHome: string;
  let realHome: string | undefined;

  beforeAll(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-2744-"));
    const messagesDir = path.join(tmpHome, "Library", "Messages");
    fs.mkdirSync(messagesDir, { recursive: true });
    await writeFixtureDb(path.join(messagesDir, "chat.db"), ALL_ROWS);

    realHome = process.env.HOME;
    // The service builds the chat.db path from HOME at call time, so this
    // redirect is what keeps the suite away from the real Messages database.
    process.env.HOME = tmpHome;
  });

  afterAll(() => {
    if (realHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = realHome;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  beforeEach(() => {
    capturedMessages = [];
    mockLogWarn.mockClear();
    mockLogError.mockClear();
    mockWindowStartFault.active = false;
    mockWindowStartFault.hits = 0;
    installStorageSpies();
  });

  afterEach(() => {
    storeMessagesSpy.mockRestore();
    storeAttachmentsSpy.mockRestore();
  });

  // ==========================================================================
  // 1. The defect itself
  // ==========================================================================

  it("keeps the NEWEST N when the cap bites, not the oldest N", async () => {
    const result = await macOSMessagesImportService.importMessages(
      "user-1",
      undefined,
      false,
      { maxMessages: 5 },
    );

    expect(result.success).toBe(true);
    // Identity, not counts: the exact set, and the exact set the bug produced.
    expect(importedGuids()).toEqual(newestGuids(5));
    expect(importedGuids()).not.toEqual(oldestGuids(5));
    expect(result.wasCapped).toBe(true);
    // The claim the Settings copy makes: the newest message is in the import.
    expect(importedGuids()).toContain("msg-12");
  });

  it("reports wasCapped and the pre-cap total alongside the newest-N window", async () => {
    const result = await macOSMessagesImportService.importMessages(
      "user-1",
      undefined,
      false,
      { maxMessages: 5 },
    );

    expect(result.wasCapped).toBe(true);
    // 17 rows in the file, 16 importable (the NULL-guid row is not).
    expect(result.totalAvailable).toBe(IMPORTABLE_GUIDS_ASC.length);
    expect(result.messagesImported).toBe(5);
  });

  // ==========================================================================
  // 2. Boundary sweep
  // ==========================================================================

  it("cap of 1 keeps exactly the newest message", async () => {
    const result = await macOSMessagesImportService.importMessages(
      "user-1",
      undefined,
      false,
      { maxMessages: 1 },
    );

    expect(importedGuids()).toEqual(["msg-12"]);
    expect(result.wasCapped).toBe(true);
  });

  it("cap of total-1 drops exactly the single oldest message", async () => {
    const total = IMPORTABLE_GUIDS_ASC.length;
    const result = await macOSMessagesImportService.importMessages(
      "user-1",
      undefined,
      false,
      { maxMessages: total - 1 },
    );

    expect(importedGuids()).toEqual(newestGuids(total - 1));
    expect(importedGuids()).not.toContain(IMPORTABLE_GUIDS_ASC[0]);
    expect(result.wasCapped).toBe(true);
  });

  it("cap exactly equal to the total imports everything and does not report a cap", async () => {
    const total = IMPORTABLE_GUIDS_ASC.length;
    const result = await macOSMessagesImportService.importMessages(
      "user-1",
      undefined,
      false,
      { maxMessages: total },
    );

    expect(importedGuids()).toEqual(IMPORTABLE_GUIDS_ASC);
    expect(result.wasCapped).toBe(false);
    // At cap EXACTLY equal to the total this assertion cannot fail, and saying so
    // is the point. OFFSET (cap - 1) is still in range here: the query would
    // succeed, return the oldest row, and seed a walk over the identical window
    // that seed 0 walks. The guard is behaviour-neutral at this boundary — it is
    // the cap > total case below that gives it its reason to exist.
    expect(windowStartFailures()).toHaveLength(0);
  });

  it("cap above the total imports everything and does not report a cap", async () => {
    const total = IMPORTABLE_GUIDS_ASC.length;
    const result = await macOSMessagesImportService.importMessages(
      "user-1",
      undefined,
      false,
      { maxMessages: total + 1 },
    );

    expect(importedGuids()).toEqual(IMPORTABLE_GUIDS_ASC);
    expect(result.wasCapped).toBe(false);
    // THIS is the discriminator for the `importWasCapped` guard. Above the total,
    // OFFSET (cap - 1) goes out of range, the query resolves nothing, and an
    // unguarded call would take the fallback path and log a failure for an import
    // that was never truncated. Widening the guard to `capApplies` turns this red.
    expect(windowStartFailures()).toHaveLength(0);
  });

  it("no cap at all imports everything", async () => {
    const result = await macOSMessagesImportService.importMessages(
      "user-1",
      undefined,
      false,
      { maxMessages: null },
    );

    expect(importedGuids()).toEqual(IMPORTABLE_GUIDS_ASC);
    expect(result.wasCapped).toBe(false);
  });

  // ==========================================================================
  // 3. WHERE parity between the count, the window start, and the fetch
  // ==========================================================================

  it("never imports the NULL-guid row, and does not let it shift the cap window", async () => {
    // The NULL-guid row sits at ROWID 115, above the start of a 5-message
    // window. A window-start query that dropped `guid IS NOT NULL` would count
    // it, land one ROWID too high, and return only four messages.
    const result = await macOSMessagesImportService.importMessages(
      "user-1",
      undefined,
      false,
      { maxMessages: 5 },
    );

    expect(importedGuids()).toEqual(newestGuids(5));
    expect(importedGuids()).toHaveLength(5);
    expect(result.messagesImported).toBe(5);
  });

  it("applies the cap to the DATE-FILTERED set, keeping that set's newest N", async () => {
    // A one-month lookback excludes the five ~200-day-old rows, so the window
    // is the recent block only and the newest 4 of THAT are what must land.
    const result = await macOSMessagesImportService.importMessages(
      "user-1",
      undefined,
      false,
      { lookbackMonths: 1, maxMessages: 4 },
    );

    expect(importedGuids()).toEqual(newestGuids(4, RECENT_GUIDS_ASC));
    expect(result.totalAvailable).toBe(RECENT_GUIDS_ASC.length);
    expect(result.wasCapped).toBe(true);
    for (const old of OLD_ROWS) {
      expect(importedGuids()).not.toContain(old.guid);
    }
  });

  // ==========================================================================
  // 4. The audit-period exemption is untouched
  // ==========================================================================

  it("does NOT cap an audit-period import — the full window lands and it warns", async () => {
    // Audit start 7.5 days back: msg-06 … msg-12 are inside the window (7 rows),
    // which is more than the cap of 3, so the cap must be relaxed entirely.
    const auditStart = new Date(NOW_MS - AUDIT_WINDOW_MS).toISOString();
    const expected = RECENT_GUIDS_ASC.slice(RECENT_GUIDS_ASC.length - 7);

    const result = await macOSMessagesImportService.importMessages(
      "user-1",
      undefined,
      false,
      { auditPeriodStart: auditStart, maxMessages: 3 },
    );

    expect(importedGuids()).toEqual(expected);
    expect(importedGuids().length).toBeGreaterThan(3);
    expect(result.wasCapped).toBe(false);

    const warned = mockLogWarn.mock.calls.map((c) => String(c[0]));
    expect(
      warned.some((m) => m.includes("importing the FULL audit window")),
    ).toBe(true);
  });

  it("leaves an audit-period import alone when it already fits under the cap", async () => {
    const auditStart = new Date(NOW_MS - AUDIT_WINDOW_MS).toISOString();
    const expected = RECENT_GUIDS_ASC.slice(RECENT_GUIDS_ASC.length - 7);

    const result = await macOSMessagesImportService.importMessages(
      "user-1",
      undefined,
      false,
      { auditPeriodStart: auditStart, maxMessages: 5000 },
    );

    expect(importedGuids()).toEqual(expected);
    expect(result.wasCapped).toBe(false);

    const warned = mockLogWarn.mock.calls.map((c) => String(c[0]));
    expect(
      warned.some((m) => m.includes("importing the FULL audit window")),
    ).toBe(false);
  });

  // ==========================================================================
  // 5. The unresolved-window fallback (fault-injected — no input reaches it)
  // ==========================================================================

  it("imports the FULL filtered window — not the oldest N — when the window start cannot be resolved", async () => {
    // The first version of this fix got exactly this wrong. It resolved the
    // window start AFTER the target count had been pinned to `maxMessages`, so
    // the fallback fell back to ROWID 0 and still stopped at `maxMessages` rows:
    // the oldest N, the original defect, behind a comment claiming the opposite.
    // Nothing in the suite caught it, because nothing drove this branch.
    mockWindowStartFault.active = true;

    const result = await macOSMessagesImportService.importMessages(
      "user-1",
      undefined,
      false,
      { maxMessages: 5 },
    );

    expect(mockWindowStartFault.hits).toBe(1);
    expect(result.success).toBe(true);
    // The whole filtered window, in ROWID order — over-importing is the safe
    // direction. Above all: NOT the oldest 5.
    expect(importedGuids()).toEqual(IMPORTABLE_GUIDS_ASC);
    expect(importedGuids()).not.toEqual(oldestGuids(5));
    // The newest message is present, which is the claim the Settings copy makes
    // and the only thing the user would notice going wrong.
    expect(importedGuids()).toContain("msg-12");
  });

  it("reports the unresolved window honestly rather than claiming a cap it did not apply", async () => {
    mockWindowStartFault.active = true;

    const result = await macOSMessagesImportService.importMessages(
      "user-1",
      undefined,
      false,
      { maxMessages: 5 },
    );

    expect(mockWindowStartFault.hits).toBe(1);
    // Nothing was truncated, so `wasCapped` must not say it was — the renderer
    // shows a "capped" notice off this flag.
    expect(result.wasCapped).toBe(false);
    expect(result.totalAvailable).toBe(IMPORTABLE_GUIDS_ASC.length);
    expect(result.messagesImported).toBe(IMPORTABLE_GUIDS_ASC.length);

    // ERROR, not warn. An import that quietly ignores the user's cap has to be
    // findable in a support trace without anyone reasoning about ROWIDs.
    expect(windowStartFailures()).toHaveLength(1);
    expect(windowStartFailures()[0]).toContain("importing the FULL filtered window");
    expect(mockLogWarn.mock.calls.map((c) => String(c[0]))).not.toContain(
      expect.stringContaining("window-start ROWID could not be resolved"),
    );
  });

  it("does not take the fallback path when the window start resolves normally", async () => {
    // The control that keeps the two tests above honest: same cap, fault off.
    const result = await macOSMessagesImportService.importMessages(
      "user-1",
      undefined,
      false,
      { maxMessages: 5 },
    );

    expect(importedGuids()).toEqual(newestGuids(5));
    expect(result.wasCapped).toBe(true);
    expect(windowStartFailures()).toHaveLength(0);
  });
});

// ============================================================================
// 5. The cap window survives the multi-batch pagination loop
// ============================================================================

/**
 * The batch size is `max(10% of target, MIN_QUERY_BATCH_SIZE = 10000)`, so the
 * corpus above is always fetched in ONE batch and proves nothing about the
 * cursor. This corpus is large enough to force a second batch, which is where a
 * seeded cursor could plausibly be lost.
 */
macOnly("cap window survives multi-batch pagination (BACKLOG-2744)", () => {
  const TOTAL = 10_050;
  const CAP = 10_020;

  let tmpHome: string;
  let realHome: string | undefined;

  beforeAll(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-2744-big-"));
    const messagesDir = path.join(tmpHome, "Library", "Messages");
    fs.mkdirSync(messagesDir, { recursive: true });

    const rows: FixtureRow[] = Array.from({ length: TOTAL }, (_, i) => ({
      rowid: (i + 1) * 3, // gaps again
      guid: `bulk-${String(i + 1).padStart(6, "0")}`,
      text: `fixture bulk message ${i + 1}`,
      dateMs: BASE_MS + i * 1000,
      handleRowId: 1,
      chatId: 1,
    }));
    await writeFixtureDb(path.join(messagesDir, "chat.db"), rows);

    realHome = process.env.HOME;
    process.env.HOME = tmpHome;
  }, 120_000);

  afterAll(() => {
    if (realHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = realHome;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  beforeEach(() => {
    capturedMessages = [];
    installStorageSpies();
  });

  afterEach(() => {
    storeMessagesSpy.mockRestore();
    storeAttachmentsSpy.mockRestore();
  });

  it("keeps the newest CAP messages across two query batches", async () => {
    const result = await macOSMessagesImportService.importMessages(
      "user-1",
      undefined,
      false,
      { maxMessages: CAP },
    );

    const expected = Array.from({ length: CAP }, (_, i) => {
      const n = TOTAL - CAP + i + 1;
      return `bulk-${String(n).padStart(6, "0")}`;
    });

    expect(result.wasCapped).toBe(true);
    expect(importedGuids()).toEqual(expected);
    // The first 30 (oldest) are the ones dropped — the opposite of the defect.
    expect(importedGuids()[0]).toBe("bulk-000031");
    expect(importedGuids()[importedGuids().length - 1]).toBe("bulk-010050");
  }, 120_000);
});

// ============================================================================
// 6. The window start must apply the DATE filter, not just the guid filter
// ============================================================================

/**
 * The corpus above cannot tell whether the window-start query carries
 * `${dateFilterClause}`. Date-excluded rows are always OLD, and in a corpus
 * where age tracks ROWID they therefore sit BELOW the window start — so the
 * offset lands on the same row with or without the clause, for every cap that
 * triggers the cap at all.
 *
 * The shape that separates them is a row that is old by DATE but high by ROWID,
 * and macOS Messages does emit it: ROWID is local insert order while `date` is
 * the original send time, so an iCloud restore or a device sync writes years-old
 * messages at the top of the ROWID space. This is not a state the producer
 * cannot reach (the BACKLOG-2439 prohibition) — it is the same divergence
 * recorded as a caveat on this fix, made observable.
 *
 * With the clause: the offset is measured over the date-filtered set and the cap
 * delivers its full N. Without it: the backfilled row occupies an offset slot,
 * the window starts one row too high, and the user gets N-1.
 */
macOnly("the cap window respects the date filter, not just the guid filter (BACKLOG-2744)", () => {
  const BACKFILL_GUID = "backfill-01";

  let tmpHome: string;
  let realHome: string | undefined;

  beforeAll(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-2744-backfill-"));
    const messagesDir = path.join(tmpHome, "Library", "Messages");
    fs.mkdirSync(messagesDir, { recursive: true });

    // The recent block, plus one row restored from iCloud: written between
    // msg-11 (110) and msg-12 (120) in ROWID order, but sent 200 days ago.
    const rows: FixtureRow[] = [
      ...RECENT_ROWS,
      {
        rowid: 118,
        guid: BACKFILL_GUID,
        text: "fixture message restored from backup",
        dateMs: NOW_MS - 200 * DAY_MS,
        handleRowId: 1,
        chatId: 1,
      },
    ];
    await writeFixtureDb(path.join(messagesDir, "chat.db"), rows);

    realHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });

  afterAll(() => {
    if (realHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = realHome;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  beforeEach(() => {
    capturedMessages = [];
    mockLogWarn.mockClear();
    mockLogError.mockClear();
    mockWindowStartFault.active = false;
    mockWindowStartFault.hits = 0;
    installStorageSpies();
  });

  afterEach(() => {
    storeMessagesSpy.mockRestore();
    storeAttachmentsSpy.mockRestore();
  });

  it("the backfilled row IS importable — without this the test below proves nothing", async () => {
    // If the row failed to insert, or were excluded for some reason other than
    // its date, the capped assertion below would pass vacuously. Import with no
    // date filter and no cap: the row must be there, high in ROWID order.
    const result = await macOSMessagesImportService.importMessages(
      "user-1",
      undefined,
      false,
      {},
    );

    expect(result.success).toBe(true);
    expect(importedGuids()).toEqual([
      ...RECENT_GUIDS_ASC.slice(0, 11), // msg-01 … msg-11 (ROWIDs 10 … 110)
      BACKFILL_GUID, // ROWID 118
      "msg-12", // ROWID 120
    ]);
  });

  it("delivers the full cap: a backfilled old row must not consume a slot in the window", async () => {
    // One month back excludes the 200-day-old row by DATE while leaving it above
    // the window start by ROWID — the only arrangement that can tell whether the
    // window-start query filters on date.
    const result = await macOSMessagesImportService.importMessages(
      "user-1",
      undefined,
      false,
      { lookbackMonths: 1, maxMessages: 4 },
    );

    expect(importedGuids()).toEqual(["msg-09", "msg-10", "msg-11", "msg-12"]);
    expect(importedGuids()).not.toContain(BACKFILL_GUID);
    // The cap promised four and four arrived. Dropping the date clause from the
    // window-start query yields three.
    expect(importedGuids()).toHaveLength(4);
    expect(result.wasCapped).toBe(true);
    expect(result.totalAvailable).toBe(RECENT_GUIDS_ASC.length);
  });
});
