/**
 * @jest-environment node
 *
 * BACKLOG-2563 — the two compliance events that were never written down.
 *
 * ===========================================================================
 * WHAT WENT WRONG
 * ===========================================================================
 * `auditService.log` is called in the HANDLER, never in the service. Ten sites
 * honour that convention. Two do not:
 *
 *   `transactions:create-audited`  creates the transaction, fires two
 *                                  background syncs, and writes NO audit row.
 *                                  It is the primary user path for creating an
 *                                  audited transaction (`useAuditSubmission.ts`).
 *
 *   `transactions:resubmit`        re-sends the whole package to the broker
 *                                  portal and writes NO audit row.
 *
 * `audit_logs` feeds the CCPA/SOC2 export and the Supabase sync, so the trail
 * was missing the creation event for exactly the transactions that exist for
 * compliance, and recorded the first submission while silently dropping every
 * resubmit.
 *
 * The resubmit half is the harder one to SEE. That handler does call
 * `logService.info` on success, so a developer reading it sees logging and
 * moves on — but `logService` writes the application log, not `audit_logs`, so
 * it reaches neither the export nor the sync. A companion write that LOOKS
 * satisfied hides better than one that is plainly absent.
 *
 * ===========================================================================
 * WHY THESE ASSERTIONS READ THE DATABASE AND NOTHING ELSE
 * ===========================================================================
 * `auditService.log` SWALLOWS every write failure by design — `auditService.ts`
 * wraps `writeToLocal` in a `try` whose `catch` only calls `logService.error`
 * and drops a Sentry breadcrumb. **It never rethrows.** Two consequences, and
 * both of them decide the shape of this suite:
 *
 *   1. The handler returns `{ success: true }` whether the row landed or not.
 *      An assertion on the handler's return value therefore cannot fail for
 *      the reason this item exists. It is excluded.
 *
 *   2. `expect(auditService.log).toHaveBeenCalled()` on a MOCKED auditService
 *      is satisfied by a call that wrote nothing. A mock cannot see the CHECK
 *      constraint, which is the one failure mode that matters here (see below).
 *      It is excluded.
 *
 * So `auditService` is REAL, `auditLogDbService` is REAL, and the write lands
 * in a REAL SQLite `audit_logs` table built from the REAL `schema.sql` with the
 * REAL CHECK constraint and `PRAGMA foreign_keys = ON`. Every assertion is a
 * raw `SELECT` against that table, asserting an exact ROW SET — never a count,
 * never `COUNT(*) > 0`, which cannot tell "the right row" from "some row".
 *
 * ===========================================================================
 * THE TRAP IN THE FIX: THE VERB IS NOT A FREE CHOICE
 * ===========================================================================
 * `audit_logs.action` carries a CHECK listing the permitted verbs, and there is
 * NO `TRANSACTION_RESUBMIT` among them. Combined with the swallow above, a fix
 * that invented one would: throw on the CHECK violation inside `log()` → be
 * caught → write nothing → return success. **The resubmit would look audited
 * and the trail would still be empty** — this item's own defect, reintroduced
 * as its fix, and green on every check that does not read the table.
 *
 * SQLite cannot `ALTER` a CHECK, so extending the list means rebuilding an
 * append-only compliance table. The fix therefore uses the idiom already
 * documented in-repo at `transactionCrudHandlers.ts` (the contact-restore audit,
 * and BACKLOG-2365 before it): keep the verb inside the permitted set and let
 * `metadata.reason` name the specific act.
 *
 * `describe("the trap itself")` at the end pins both halves of that trap by
 * execution, so the reasoning above is a test rather than a comment.
 *
 * ===========================================================================
 * WHAT THIS SUITE DOES NOT PROVE
 * ===========================================================================
 * The Supabase-sync half (`auditService.syncToCloud`) is stubbed to a no-op.
 * These assertions prove the rows reach the LOCAL append-only table; they do
 * not prove the rows reach the cloud. Flagged as untraced on BACKLOG-2563.
 *
 * Fixture values are reserved-for-documentation only (`example.com`); the
 * property address and names are invented.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { readFileSync } from "fs";
import path from "path";
import type { IpcMainInvokeEvent } from "electron";
import { openTestDb, type TestDb } from "../services/__tests__/helpers/syncSqliteDriver";

// Real UUIDs, because `validateUserId` / `validateTransactionId` reject
// anything else outright — a readable "txn-2563" never reaches the audit call
// and would make this suite red for the wrong reason.
const USER = "2563a11d-0000-4000-8000-00000000c0de";
const TRANSACTION = "2563b22e-0000-4000-8000-00000000dead";
const PROPERTY = "1420 Marlin Court, Astoria OR";

let mockDb: TestDb | null = null;
const registeredHandlers = new Map<string, any>();

// ---------------------------------------------------------------------------
// MOCKS
//
// The line that must NOT be mocked is the one from `auditService.log` to the
// `audit_logs` INSERT. Everything mocked below is upstream of that line: the
// things that PRODUCE the transaction and the submission result, plus the
// background triggers and native-adjacent modules the two handler files import
// at load time.
// ---------------------------------------------------------------------------

jest.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: any) => {
      registeredHandlers.set(channel, fn);
    },
  },
  BrowserWindow: jest.fn(),
  app: { isPackaged: false, getPath: jest.fn(() => "/mock/user/data") },
}));

jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
  flush: jest.fn().mockResolvedValue(true),
}));

jest.mock("../services/logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});

// The REAL `auditLogDbService` reaches the database through this module, so
// redirecting it here is what puts the production INSERT — and the CHECK it
// has to satisfy — under the assertions below.
jest.mock("../services/db/core/dbConnection", () => ({
  ensureDb: () => mockDb,
  dbAll: (sql: string, params: unknown[] = []) =>
    mockDb!.prepare(sql).all(...(params as never[])),
  dbGet: (sql: string, params: unknown[] = []) =>
    mockDb!.prepare(sql).get(...(params as never[])),
  dbRun: (sql: string, params: unknown[] = []) => {
    const r = mockDb!.prepare(sql).run(...(params as never[]));
    return { lastInsertRowid: r.lastInsertRowid, changes: r.changes };
  },
  dbExec: (sql: string) => mockDb!.exec(sql),
  dbTransaction: <T,>(fn: () => T): T => mockDb!.transaction(fn)(),
  getDbPath: () => "/fake/path/mad.db",
  getEncryptionKey: () => "fake-key",
  isInitialized: () => true,
}));

const mockCreateAuditedTransaction = jest.fn();
const mockGetTransactionDetails = jest.fn();
const mockSubmitTransaction = jest.fn();
const mockResubmitTransaction = jest.fn();

jest.mock("../services/transactionService", () => ({
  __esModule: true,
  default: {
    createAuditedTransaction: (...a: any[]) => mockCreateAuditedTransaction(...a),
    getTransactionDetails: (...a: any[]) => mockGetTransactionDetails(...a),
  },
  getEarliestCommunicationDate: jest.fn(),
}));

jest.mock("../services/submissionService", () => ({
  __esModule: true,
  default: {
    submitTransaction: (...a: any[]) => mockSubmitTransaction(...a),
    resubmitTransaction: (...a: any[]) => mockResubmitTransaction(...a),
  },
}));

// Fire-and-forget background work. Stubbed so a create cannot reach the network
// (and so an unhandled rejection cannot fail an unrelated assertion).
jest.mock("../services/transactionSyncTrigger", () => ({
  triggerTransactionSyncInBackground: jest.fn(),
  isAutoSyncInFlight: jest.fn(() => false),
  ensureTransactionEmailsSynced: jest.fn().mockResolvedValue({ ran: false }),
}));
jest.mock("../services/messagesSyncTrigger", () => ({
  triggerMessagesSyncInBackground: jest.fn(),
  ensureTransactionMessagesSynced: jest.fn().mockResolvedValue({ ran: false }),
}));

// Module-load-time imports of the two handler files that are irrelevant to the
// audit trail but would otherwise drag native/OAuth code into the suite.
jest.mock("../services/databaseService", () => ({ __esModule: true, default: {} }));
jest.mock("../services/emailSyncService", () => ({ __esModule: true, default: {} }));
jest.mock("../services/autoLinkService", () => ({
  autoLinkCommunicationsForContact: jest.fn(),
}));
jest.mock("../services/auditCoverageService", () => ({
  getAuditCoverage: jest.fn(),
  checkExportCompleteness: jest.fn(),
}));
jest.mock("../services/submissionSyncService", () => ({ __esModule: true, default: {} }));
jest.mock("../services/supabaseService", () => ({ __esModule: true, default: {} }));
jest.mock("../services/enhancedExportService", () => ({ __esModule: true, default: {} }));
jest.mock("../services/folderExportService", () => ({ __esModule: true, default: {} }));
jest.mock("../services/exportGate", () => ({
  enforceExportGate: jest.fn(),
  emitExportCompleted: jest.fn(),
}));

// ---------------------------------------------------------------------------
// REAL modules under test
// ---------------------------------------------------------------------------

import auditService from "../services/auditService";
import * as auditLogDb from "../services/db/auditLogDbService";
import { registerTransactionCrudHandlers } from "../handlers/transactionCrudHandlers";
import { registerTransactionExportHandlers } from "../handlers/transactionExportHandlers";

const SCHEMA_PATH = path.join(__dirname, "../database/schema.sql");

/** A real `audit_logs`, with its real CHECK and its real append-only triggers. */
function buildDb(): TestDb {
  const db = openTestDb();
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  // `audit_logs.user_id` is a real FK and foreign keys are ON, so the owner row
  // has to exist. `oauth_provider` / `oauth_id` are NOT NULL in `schema.sql`.
  db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)",
  ).run(USER, "owner@example.com", "oauth-2563");
  return db;
}

/**
 * The audit rows for one resource, read RAW — never through the code that wrote
 * them. `reason` is extracted in SQL so the assertion cannot be satisfied by a
 * metadata blob that merely CONTAINS the word.
 */
function auditRows(resourceId: string): Array<Record<string, unknown>> {
  return mockDb!
    .prepare(
      `SELECT action, resource_type, resource_id, user_id, success,
              json_extract(metadata, '$.reason') AS reason
         FROM audit_logs
        WHERE resource_id = ?
        ORDER BY timestamp, rowid`,
    )
    .all(resourceId) as Array<Record<string, unknown>>;
}

/** Every audit row in the table, for the "nothing else was written" assertions. */
function allAuditActions(): string[] {
  return (
    mockDb!.prepare("SELECT action FROM audit_logs ORDER BY rowid").all() as Array<{
      action: string;
    }>
  ).map((r) => r.action);
}

beforeAll(() => {
  // `auditService.writeToLocal` gates on `databaseService.isInitialized()` and,
  // when false, awaits `initializationBroadcaster.whenDbReady(5000)` and BUFFERS
  // the write instead of performing it — zero rows, five seconds, no error.
  // The stub below is production's own one-liner: `databaseService.insertAuditLog`
  // delegates straight to `auditLogDbService.insertAuditLog`, so the REAL INSERT
  // and the REAL CHECK still execute.
  auditService.initialize(
    {
      isInitialized: () => true,
      insertAuditLog: (entry: any) => auditLogDb.insertAuditLog(entry),
      getUnsyncedAuditLogs: async () => [],
      markAuditLogsSynced: async () => undefined,
    } as any,
    // Cloud sync is deliberately inert here — see "WHAT THIS SUITE DOES NOT PROVE".
    { batchInsertAuditLogs: async () => undefined } as any,
  );
  registerTransactionCrudHandlers(null);
  registerTransactionExportHandlers(null);
});

afterAll(() => {
  // `initialize()` starts a periodic sync interval; leaving it running keeps the
  // Jest worker alive.
  auditService.stopSyncInterval();
});

beforeEach(() => {
  mockDb = buildDb();
  jest.clearAllMocks();
  mockCreateAuditedTransaction.mockResolvedValue({
    id: TRANSACTION,
    user_id: USER,
    property_address: PROPERTY,
  });
  mockGetTransactionDetails.mockResolvedValue({
    id: TRANSACTION,
    user_id: USER,
    property_address: PROPERTY,
  });
});

afterEach(() => {
  mockDb?.close();
  mockDb = null;
});

const evt = {} as IpcMainInvokeEvent;

const invoke = (channel: string, ...args: unknown[]) => {
  const handler = registeredHandlers.get(channel);
  if (!handler) throw new Error(`Handler not registered: ${channel}`);
  return handler(evt, ...args);
};

// ===========================================================================
describe("transactions:create-audited writes the creation event to audit_logs", () => {
  it("writes exactly one TRANSACTION_CREATE row for the new transaction", async () => {
    const result = await invoke("transactions:create-audited", USER, {
      property_address: PROPERTY,
    });

    // The handler's own verdict is recorded but NOT relied on: it says `true`
    // whether or not the row landed. The next assertion is the real one.
    expect(result.success).toBe(true);

    expect(auditRows(TRANSACTION)).toEqual([
      {
        action: "TRANSACTION_CREATE",
        resource_type: "TRANSACTION",
        resource_id: TRANSACTION,
        user_id: USER,
        success: 1,
        reason: "audited_create",
      },
    ]);
  });

  it("carries the property address, so the export row identifies the deal", async () => {
    await invoke("transactions:create-audited", USER, { property_address: PROPERTY });

    const row = mockDb!
      .prepare(
        "SELECT json_extract(metadata, '$.propertyAddress') AS addr FROM audit_logs WHERE resource_id = ?",
      )
      .get(TRANSACTION) as { addr: string };
    expect(row.addr).toBe(PROPERTY);
  });

  it("writes the trail BEFORE the background syncs are fired", async () => {
    // The two triggers are fire-and-forget; if the audit write were sequenced
    // after them, a background failure could reorder or drop the trail entry.
    const { triggerTransactionSyncInBackground } =
      jest.requireMock("../services/transactionSyncTrigger");
    let rowsAtTriggerTime = -1;
    (triggerTransactionSyncInBackground as jest.Mock).mockImplementation(() => {
      rowsAtTriggerTime = auditRows(TRANSACTION).length;
    });

    await invoke("transactions:create-audited", USER, { property_address: PROPERTY });

    expect(triggerTransactionSyncInBackground).toHaveBeenCalled();
    expect(rowsAtTriggerTime).toBe(1);
  });

  it("writes nothing when the create itself fails", async () => {
    mockCreateAuditedTransaction.mockResolvedValue(undefined);

    await invoke("transactions:create-audited", USER, { property_address: PROPERTY });

    expect(allAuditActions()).toEqual([]);
  });
});

// ===========================================================================
describe("transactions:resubmit writes the resubmission to audit_logs", () => {
  // Both broker calls return NO submissionId, so both rows fall back to the
  // transaction id and land under one `resource_id` — which is what makes
  // "the trail for THIS deal" a single readable set rather than two lookups.
  const brokerOk = {
    success: true,
    messagesCount: 12,
    attachmentsCount: 3,
  };

  it("writes a TRANSACTION_SUBMIT row marked as a resubmit", async () => {
    mockResubmitTransaction.mockResolvedValue(brokerOk);

    const result = await invoke("transactions:resubmit", TRANSACTION);
    expect(result.success).toBe(true);

    expect(auditRows(TRANSACTION)).toEqual([
      {
        action: "TRANSACTION_SUBMIT",
        resource_type: "SUBMISSION",
        resource_id: TRANSACTION,
        user_id: USER,
        success: 1,
        reason: "resubmit",
      },
    ]);
  });

  it("submit then resubmit leaves TWO rows that can be told apart", async () => {
    // This is what "records the first submission but silently drops every
    // resubmit" cashes out to: the export must show two distinct events, not
    // one, and must be able to say which was which.
    mockSubmitTransaction.mockResolvedValue(brokerOk);
    mockResubmitTransaction.mockResolvedValue(brokerOk);

    await invoke("transactions:submit", TRANSACTION);
    await invoke("transactions:resubmit", TRANSACTION);

    expect(auditRows(TRANSACTION).map((r) => [r.action, r.reason])).toEqual([
      ["TRANSACTION_SUBMIT", null],
      ["TRANSACTION_SUBMIT", "resubmit"],
    ]);
  });

  it("carries the package size the broker actually received", async () => {
    mockResubmitTransaction.mockResolvedValue(brokerOk);

    await invoke("transactions:resubmit", TRANSACTION);

    const row = mockDb!
      .prepare(
        `SELECT json_extract(metadata, '$.messagesCount')    AS messages,
                json_extract(metadata, '$.attachmentsCount') AS attachments,
                json_extract(metadata, '$.propertyAddress')  AS addr
           FROM audit_logs WHERE resource_id = ?`,
      )
      .get(TRANSACTION) as Record<string, unknown>;
    expect(row).toEqual({ messages: 12, attachments: 3, addr: PROPERTY });
  });

  it("writes nothing when the broker rejects the resubmission", async () => {
    // Matches `transactions:submit`, which also logs only inside `if (success)`.
    // Whether FAILED broker submissions should be audited is an open question on
    // BACKLOG-2563; this pins the shipped behaviour so a change to it is visible.
    mockResubmitTransaction.mockResolvedValue({ success: false, error: "portal 503" });

    await invoke("transactions:resubmit", TRANSACTION);

    expect(allAuditActions()).toEqual([]);
  });
});

// ===========================================================================
describe("the trap itself — why the verb had to stay inside the CHECK", () => {
  // These two tests are the reason the fix uses `metadata.reason` instead of a
  // `TRANSACTION_RESUBMIT` verb. Without them that decision is a comment; with
  // them it is a measurement, and a future change that removes the swallow (see
  // BACKLOG-2554) will show up here rather than silently.

  it("the CHECK is live in this harness: an unlisted verb is REJECTED by SQLite", async () => {
    await expect(
      auditLogDb.insertAuditLog({
        id: "audit-illegal-2563",
        timestamp: new Date(),
        userId: USER,
        action: "TRANSACTION_RESUBMIT" as any,
        resourceType: "SUBMISSION",
        resourceId: TRANSACTION,
        success: true,
      } as any),
    ).rejects.toThrow(/CHECK constraint failed/i);

    expect(allAuditActions()).toEqual([]);
  });

  it("and auditService.log SWALLOWS that rejection — reports nothing, writes nothing", async () => {
    // The whole reason a mocked auditService could not have caught this bug.
    await expect(
      auditService.log({
        userId: USER,
        action: "TRANSACTION_RESUBMIT" as any,
        resourceType: "SUBMISSION",
        resourceId: TRANSACTION,
        success: true,
      }),
    ).resolves.toBeUndefined();

    expect(allAuditActions()).toEqual([]);
  });
});
