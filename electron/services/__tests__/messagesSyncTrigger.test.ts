/**
 * @jest-environment node
 *
 * BACKLOG-2292 unit test for messagesSyncTrigger.ensureTransactionMessagesSynced
 * against a REAL in-memory better-sqlite3 DB (setDb). The macOS importer,
 * auto-link, expansion, and importer-availability probe are mocked so the test
 * asserts the trigger's POLICY (SR-corrections a/d/g + the per-user coalescer):
 *   - start < floor + importer available → ONE global import with the correct
 *     auditPeriodStart, then expansion, then last_import_at/last_expansion_at set
 *   - start >= floor → NO import, expansion still runs
 *   - importer unavailable → NO import, NO throw, expansion still runs
 *   - throttle bypass for date-change vs throttled "open"
 *   - concurrent same-user calls COALESCE onto ONE import
 */
import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("@sentry/electron/main", () => ({ captureException: jest.fn(), addBreadcrumb: jest.fn() }));
jest.mock("../logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});
jest.mock("../macOSMessagesImportService", () => ({
  __esModule: true,
  default: { importMessages: jest.fn() },
}));
jest.mock("../autoLinkService", () => ({
  __esModule: true,
  expandAttachedThreadsForUser: jest.fn().mockResolvedValue({ messagesLinked: 0, errors: 0 }),
  autoLinkNewMessagesForUser: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../auditCoverageService", () => {
  const actual = jest.requireActual<typeof import("../auditCoverageService")>("../auditCoverageService");
  return {
    __esModule: true,
    ...actual,
    isMessagesImporterAvailable: jest.fn().mockResolvedValue(true),
  };
});

import { setDb } from "../db/core/dbConnection";
import macOSMessagesImportService from "../macOSMessagesImportService";
import { expandAttachedThreadsForUser } from "../autoLinkService";
import { isMessagesImporterAvailable } from "../auditCoverageService";
import { getState } from "../db/messageImportStateService";
import {
  ensureTransactionMessagesSynced,
  __resetMessagesSyncStateForTests,
} from "../messagesSyncTrigger";

const USER = "user-trigger";
const importMessages = macOSMessagesImportService.importMessages as jest.Mock;
const expandMock = expandAttachedThreadsForUser as jest.Mock;
const importerAvailableMock = isMessagesImporterAvailable as jest.Mock;

let db: DatabaseType;
function makeDb(): DatabaseType {
  const d = new Database(":memory:") as DatabaseType;
  d.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, user_id TEXT, channel TEXT, sent_at DATETIME,
      duplicate_of TEXT, associated_message_type INTEGER
    );
    CREATE TABLE transactions (
      id TEXT PRIMARY KEY, user_id TEXT, started_at DATETIME, created_at DATETIME,
      closed_at DATETIME, status TEXT
    );
    CREATE TABLE message_import_state (
      user_id TEXT PRIMARY KEY, last_import_at DATETIME, last_expansion_at DATETIME,
      deepest_import_start DATETIME, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return d;
}
function insMsg(id: string, sentAt: string) {
  db.prepare(
    "INSERT INTO messages (id, user_id, channel, sent_at) VALUES (?, ?, 'imessage', ?)",
  ).run(id, USER, sentAt);
}

beforeEach(() => {
  db = makeDb();
  setDb(db);
  importMessages.mockReset().mockResolvedValue({ success: true, messagesImported: 3 });
  expandMock.mockClear();
  importerAvailableMock.mockReset().mockResolvedValue(true);
  __resetMessagesSyncStateForTests();
});
afterEach(() => db.close());

describe("ensureTransactionMessagesSynced (BACKLOG-2292)", () => {
  it("start < floor + importer available → ONE global import with auditPeriodStart, then expansion + state", async () => {
    insMsg("m1", "2026-05-01T00:00:00.000Z"); // floor
    const result = await ensureTransactionMessagesSynced({
      userId: USER,
      reason: "date-change",
      proposedStartISO: "2026-01-01T00:00:00.000Z", // < floor
    });

    expect(importMessages).toHaveBeenCalledTimes(1);
    // (userId, onProgress, forceReimport=false, { auditPeriodStart })
    const args = importMessages.mock.calls[0];
    expect(args[0]).toBe(USER);
    expect(args[2]).toBe(false);
    expect(args[3]).toEqual({ auditPeriodStart: "2026-01-01T00:00:00.000Z" });

    expect(expandMock).toHaveBeenCalledTimes(1);
    expect(result.importRan).toBe(true);
    expect(result.expansionRan).toBe(true);

    const state = getState(USER);
    expect(state?.last_import_at).toBeTruthy();
    expect(state?.last_expansion_at).toBeTruthy();
  });

  it("start >= floor → NO import, expansion still runs", async () => {
    insMsg("m1", "2026-01-01T00:00:00.000Z"); // floor older than proposed start
    const result = await ensureTransactionMessagesSynced({
      userId: USER,
      reason: "date-change",
      proposedStartISO: "2026-06-01T00:00:00.000Z", // >= floor
    });
    expect(importMessages).not.toHaveBeenCalled();
    expect(expandMock).toHaveBeenCalledTimes(1);
    expect(result.importRan).toBe(false);
    expect(result.expansionRan).toBe(true);
    expect(result.skipped).toBe("covered");
  });

  it("importer unavailable → NO import, NO throw, expansion still runs", async () => {
    importerAvailableMock.mockResolvedValue(false);
    insMsg("m1", "2026-05-01T00:00:00.000Z");
    const result = await ensureTransactionMessagesSynced({
      userId: USER,
      reason: "date-change",
      proposedStartISO: "2026-01-01T00:00:00.000Z",
    });
    expect(importMessages).not.toHaveBeenCalled();
    expect(expandMock).toHaveBeenCalledTimes(1);
    expect(result.importRan).toBe(false);
    expect(result.skipped).toBe("no_importer");
    expect(result.error).toBeUndefined();
  });

  it("does NOT record last_import_at when the import returns success:false (degrade)", async () => {
    importMessages.mockResolvedValue({ success: false, messagesImported: 0, error: "Import already in progress" });
    insMsg("m1", "2026-05-01T00:00:00.000Z");
    const result = await ensureTransactionMessagesSynced({
      userId: USER,
      reason: "date-change",
      proposedStartISO: "2026-01-01T00:00:00.000Z",
    });
    expect(importMessages).toHaveBeenCalledTimes(1);
    expect(result.importRan).toBe(false);
    // expansion still ran (and recorded), but import did NOT record.
    expect(getState(USER)?.last_import_at).toBeNull();
    expect(getState(USER)?.last_expansion_at).toBeTruthy();
  });

  it("throttles a second 'open' within the freshness window; 'date-change' bypasses", async () => {
    insMsg("m1", "2026-01-01T00:00:00.000Z"); // no gap either way

    const first = await ensureTransactionMessagesSynced({ userId: USER, reason: "open", proposedStartISO: "2026-06-01T00:00:00.000Z" });
    expect(first.skipped).toBe("covered");
    expect(expandMock).toHaveBeenCalledTimes(1);

    const second = await ensureTransactionMessagesSynced({ userId: USER, reason: "open", proposedStartISO: "2026-06-01T00:00:00.000Z" });
    expect(second.skipped).toBe("throttled");
    expect(expandMock).toHaveBeenCalledTimes(1); // no new work

    const dateChange = await ensureTransactionMessagesSynced({ userId: USER, reason: "date-change", proposedStartISO: "2026-06-01T00:00:00.000Z" });
    expect(dateChange.skipped).toBe("covered");
    expect(expandMock).toHaveBeenCalledTimes(2); // bypassed throttle → ran again
  });

  it("coalesces concurrent same-user calls onto ONE import", async () => {
    insMsg("m1", "2026-05-01T00:00:00.000Z");
    let resolveImport: (v: unknown) => void = () => {};
    importMessages.mockImplementation(
      () => new Promise((res) => { resolveImport = res; }),
    );

    const p1 = ensureTransactionMessagesSynced({ userId: USER, reason: "date-change", proposedStartISO: "2026-01-01T00:00:00.000Z" });
    const p2 = ensureTransactionMessagesSynced({ userId: USER, reason: "date-change", proposedStartISO: "2026-01-01T00:00:00.000Z" });
    // importMessages runs behind the awaited importer probe — wait until it is
    // actually invoked before resolving it (else resolveImport is still a no-op).
    await new Promise<void>((r) => {
      const check = () => (importMessages.mock.calls.length > 0 ? r() : setTimeout(check, 5));
      check();
    });
    resolveImport({ success: true, messagesImported: 5 });
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(importMessages).toHaveBeenCalledTimes(1);
    expect(r1).toBe(r2); // same coalesced result
  });

  it("SR D1: a DEEPER caller is NOT handed a narrower in-flight scan — it runs its own deeper scan", async () => {
    insMsg("m1", "2026-05-01T00:00:00.000Z"); // floor; both starts are < floor → gap

    const resolvers: Array<(v: unknown) => void> = [];
    importMessages.mockImplementation(
      () => new Promise((res) => { resolvers.push(res); }),
    );

    // Narrow scan (reaches back to 2023) goes in flight first.
    const pNarrow = ensureTransactionMessagesSynced({
      userId: USER, reason: "date-change", proposedStartISO: "2023-01-01T00:00:00.000Z",
    });
    await new Promise<void>((r) => {
      const check = () => (importMessages.mock.calls.length > 0 ? r() : setTimeout(check, 5));
      check();
    });

    // A DEEPER caller (reaches back to 2015) arrives while the narrow scan runs.
    // It must NOT coalesce onto the narrower scan — it chains after and runs its own.
    const pDeep = ensureTransactionMessagesSynced({
      userId: USER, reason: "export", proposedStartISO: "2015-01-01T00:00:00.000Z",
    });

    resolvers[0]({ success: true, messagesImported: 1 }); // let the narrow scan finish
    await pNarrow;

    await new Promise<void>((r) => {
      const check = () => (importMessages.mock.calls.length > 1 ? r() : setTimeout(check, 5));
      check();
    });
    resolvers[1]({ success: true, messagesImported: 2 });
    await pDeep;

    // TWO device scans — not one — and the deeper caller's scan reached 2015
    // (honored), never handed back the narrower 2023 scan.
    expect(importMessages).toHaveBeenCalledTimes(2);
    expect(importMessages.mock.calls[0][3]).toEqual({ auditPeriodStart: "2023-01-01T00:00:00.000Z" });
    expect(importMessages.mock.calls[1][3]).toEqual({ auditPeriodStart: "2015-01-01T00:00:00.000Z" });
  });

  it("SR D1: a SHALLOWER caller DOES coalesce onto a deeper in-flight scan (superset)", async () => {
    insMsg("m1", "2026-05-01T00:00:00.000Z");
    let resolveImport: (v: unknown) => void = () => {};
    importMessages.mockImplementation(() => new Promise((res) => { resolveImport = res; }));

    // Deep scan (2015) in flight.
    const pDeep = ensureTransactionMessagesSynced({
      userId: USER, reason: "date-change", proposedStartISO: "2015-01-01T00:00:00.000Z",
    });
    await new Promise<void>((r) => {
      const check = () => (importMessages.mock.calls.length > 0 ? r() : setTimeout(check, 5));
      check();
    });
    // Shallower caller (2020) coalesces onto the deeper in-flight scan.
    const pShallow = ensureTransactionMessagesSynced({
      userId: USER, reason: "export", proposedStartISO: "2020-01-01T00:00:00.000Z",
    });
    resolveImport({ success: true, messagesImported: 1 });
    const [rDeep, rShallow] = await Promise.all([pDeep, pShallow]);

    expect(importMessages).toHaveBeenCalledTimes(1); // ONE scan (the deep one)
    expect(rDeep).toBe(rShallow);
  });

  it("derives the required start from non-archived transactions when no proposedStart is given", async () => {
    insMsg("m1", "2026-05-01T00:00:00.000Z"); // floor
    db.prepare(
      "INSERT INTO transactions (id, user_id, started_at, status) VALUES ('t1', ?, '2026-01-01T00:00:00.000Z', 'active')",
    ).run(USER);
    db.prepare(
      "INSERT INTO transactions (id, user_id, started_at, status) VALUES ('t2', ?, '2020-01-01T00:00:00.000Z', 'archived')",
    ).run(USER); // archived — must be ignored

    await ensureTransactionMessagesSynced({ userId: USER, reason: "date-change" });
    expect(importMessages).toHaveBeenCalledTimes(1);
    // earliest NON-archived start (t1) drives auditPeriodStart, not the archived t2.
    expect(importMessages.mock.calls[0][3]).toEqual({ auditPeriodStart: "2026-01-01T00:00:00.000Z" });
  });
});
