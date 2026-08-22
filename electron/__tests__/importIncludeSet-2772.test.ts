/**
 * @jest-environment node
 *
 * BACKLOG-2772 — every import entry point routes through the ONE resolver.
 *
 * `importPlan.test.ts` pins what the resolver DECIDES. This suite pins that the
 * entry points actually ASK it, rather than deciding for themselves:
 *
 *   1. `messages:import-macos`, forceReimport = false — the Import button
 *   2. `messages:import-macos`, forceReimport = true  — Force Re-import
 *   3. `messages:get-import-count`                    — the estimate
 *   4. `ensureTransactionMessagesSynced`              — a deal created, or its
 *                                                       start date moved earlier
 *
 * Background sync is entry point 1 reached from `useAutoRefresh`: it goes
 * through the same orchestrator queue item and the same IPC channel, so it is
 * covered by (1) rather than being a fifth assembly. That is itself worth
 * stating — before this change the trigger was NOT such a case, which is how it
 * came to run uncapped.
 *
 * ## The control this file exists for
 *
 * Before the refactor each entry point built its own
 * `{window, cap, attachments, auditPeriodStart}`. Mutating one copy left the
 * others green — which is exactly how BACKLOG-2561 shipped an import that
 * disagreed with the label directly above it, and how the trigger ran for
 * months with no cap and no attachment preference at all.
 *
 * Mutating the resolver's window rule must now red the window assertion of
 * EVERY entry point, together. `mutates together` below is that assertion made
 * explicit: all four plans are compared to ONE expected value, so there is no
 * per-entry-point expectation left to update independently.
 *
 * The import service is mocked, so what these tests observe is the PLAN each
 * entry point hands it — which is the decision under test. The database and the
 * resolver are REAL: a mocked resolver would make the suite a test of the mock.
 */

import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";
import type { IpcMainInvokeEvent } from "electron";
import {
  createIpcHandlerRegistry,
  type IpcHandlerRegistry,
} from "../../tests/support/ipcHandlerRegistry";
import type { ImportPlan } from "../services/importPlan";

const mockIpcHandle = jest.fn();
const mockIpcOn = jest.fn();

jest.mock("electron", () => ({
  ipcMain: { handle: mockIpcHandle, on: mockIpcOn },
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: jest.fn(() => "/tmp/test-userData") },
}));

jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock("../services/logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});

let db: DatabaseType;

jest.mock("../services/databaseService", () => ({
  __esModule: true,
  default: {
    getRawDatabase: () => db,
    getUserById: jest.fn(async () => ({ id: "user-2772" })),
    backfillContactCommunicationDates: jest.fn(async () => 0),
    backfillPhoneLastMessageTable: jest.fn(async () => 0),
  },
}));

const mockGetPreferences = jest.fn();
jest.mock("../services/supabaseService", () => ({
  __esModule: true,
  default: { getPreferences: (...a: unknown[]) => mockGetPreferences(...a) },
}));

const mockImportMessages = jest.fn();
const mockGetAvailableMessageCount = jest.fn();
jest.mock("../services/macOSMessagesImportService", () => ({
  __esModule: true,
  default: {
    importMessages: (...a: unknown[]) => mockImportMessages(...a),
    getAvailableMessageCount: (...a: unknown[]) => mockGetAvailableMessageCount(...a),
    requestCancellation: jest.fn(),
    getImportStatus: jest.fn(),
  },
}));

jest.mock("../services/autoLinkService", () => ({
  __esModule: true,
  autoLinkNewMessagesForUser: jest.fn().mockResolvedValue(undefined),
  expandAttachedThreadsForUser: jest.fn().mockResolvedValue({ messagesLinked: 0, errors: 0 }),
}));

jest.mock("../services/db/externalContactDbService", () => ({
  __esModule: true,
  updateLastMessageAtFromLookupTable: jest.fn(() => 0),
}));

jest.mock("../services/auditCoverageService", () => {
  const actual = jest.requireActual<typeof import("../services/auditCoverageService")>(
    "../services/auditCoverageService",
  );
  return {
    __esModule: true,
    ...actual,
    isMessagesImporterAvailable: jest.fn().mockResolvedValue(true),
  };
});

import { setDb } from "../services/db/core/dbConnection";
import { registerMessageImportHandlers } from "../handlers/messageImportHandlers";
import {
  ensureTransactionMessagesSynced,
  __resetMessagesSyncStateForTests,
} from "../services/messagesSyncTrigger";

const USER = "user-2772";

/**
 * The founder's shape, transcribed: a deal whose audit period reaches back
 * further than the user's own "Import messages from" selection.
 *
 * This is the state that makes every rule in the item observable at once — the
 * window is stretched (so `overrides` is non-empty), the deal's period is
 * protected from the cap, and the stored 3-month preference is what is being
 * stretched past.
 */
const DEAL_START = "2024-03-01T00:00:00.000Z";
const STORED_FILTERS = { lookbackMonths: 3, maxMessages: 50000, skipAttachments: false };

function makeDb(): DatabaseType {
  const d = new Database(":memory:") as DatabaseType;
  d.exec(`
    CREATE TABLE users_local (id TEXT PRIMARY KEY);
    CREATE TABLE transactions (
      id TEXT PRIMARY KEY, user_id TEXT, started_at DATETIME, created_at DATETIME,
      closed_at DATETIME, status TEXT
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, user_id TEXT, channel TEXT, sent_at DATETIME,
      duplicate_of TEXT, associated_message_type INTEGER
    );
    CREATE TABLE message_import_state (
      user_id TEXT PRIMARY KEY, last_import_at DATETIME, last_expansion_at DATETIME,
      deepest_import_start DATETIME, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  d.prepare("INSERT INTO users_local (id) VALUES (?)").run(USER);
  return d;
}

/** An open (unclosed) deal — the audit period that stretches the window. */
function insertDeal(status = "active", startedAt = DEAL_START): void {
  db.prepare(
    `INSERT INTO transactions (id, user_id, started_at, created_at, closed_at, status)
     VALUES (?, ?, ?, ?, NULL, ?)`,
  ).run(`txn-${Math.random()}`, USER, startedAt, startedAt, status);
}

let handlers: IpcHandlerRegistry;
const event = {} as IpcMainInvokeEvent;

/**
 * Registered ONCE, deliberately.
 *
 * `registerMessageImportHandlers` guards itself with a module-level
 * `handlersRegistered` flag — a second call logs "already registered" and
 * returns without registering anything. Calling it per-test therefore captured
 * the handlers for the FIRST test and left the registry empty for every one
 * after it. That is production behaviour worth keeping (duplicate IPC handlers
 * would be a real bug), so the suite registers once and re-points the database
 * and the mocks per test instead.
 */
beforeAll(() => {
  handlers = createIpcHandlerRegistry();
  mockIpcHandle.mockImplementation((channel: string, handler: unknown) => {
    handlers.set(channel, handler as never);
  });
  registerMessageImportHandlers(null as never);
});

beforeEach(() => {
  mockImportMessages.mockClear();
  mockGetAvailableMessageCount.mockClear();
  mockGetPreferences.mockClear();
  db = makeDb();
  setDb(db);
  __resetMessagesSyncStateForTests();

  mockGetPreferences.mockResolvedValue({ messageImport: { filters: STORED_FILTERS } });
  mockImportMessages.mockResolvedValue({
    success: true,
    messagesImported: 0,
    messagesSkipped: 0,
    attachmentsImported: 0,
    attachmentsUpdated: 0,
    attachmentsSkipped: 0,
    duration: 1,
  });
  mockGetAvailableMessageCount.mockResolvedValue({ success: true, count: 0 });
});

afterEach(() => db.close());

/** The plan the Import / Force Re-import handler handed the service. */
const importedPlan = (): ImportPlan => mockImportMessages.mock.calls[0][2] as ImportPlan;
/** The plan the estimate handler handed the service. */
const estimatedPlan = (): ImportPlan =>
  mockGetAvailableMessageCount.mock.calls[0][0] as ImportPlan;

async function runImportButton(force = false): Promise<ImportPlan> {
  await handlers.get("messages:import-macos")(event, USER, force);
  return importedPlan();
}

async function runEstimate(): Promise<ImportPlan> {
  await handlers.get("messages:get-import-count")(event, USER, { lookbackMonths: 3 });
  return estimatedPlan();
}

async function runTrigger(): Promise<ImportPlan> {
  // A message floor must exist and sit ABOVE the deal start, or the trigger has
  // no gap to close and never imports. Transcribed from the trigger's own gap
  // rule (`requiredStart < floorBefore`), not guessed.
  db.prepare(
    "INSERT INTO messages (id, user_id, channel, sent_at) VALUES (?, ?, 'imessage', ?)",
  ).run("m1", USER, "2026-05-01T00:00:00.000Z");
  await ensureTransactionMessagesSynced({ userId: USER, reason: "date-change" });
  return importedPlan();
}

describe("BACKLOG-2772: every import entry point resolves its fetch once", () => {
  describe("the window rule, asserted at every entry point", () => {
    it("Import button: the deal's audit period stretches the stored 3-month window", async () => {
      insertDeal();
      const plan = await runImportButton(false);

      expect(plan.fetchStartISO).toBe(DEAL_START);
      expect(plan.mode).toBe("delta");
      expect(plan.overrides).toEqual([
        {
          kind: "window-extended-by-deals",
          requestedStartISO: expect.any(String),
          effectiveStartISO: DEAL_START,
        },
      ]);
    });

    it("Force Re-import: the SAME window, differing only in mode (D2')", async () => {
      insertDeal();
      const plan = await runImportButton(true);

      expect(plan.fetchStartISO).toBe(DEAL_START);
      expect(plan.mode).toBe("reprocess");
    });

    it("the estimate: the SAME window the button will run", async () => {
      insertDeal();
      const plan = await runEstimate();

      expect(plan.fetchStartISO).toBe(DEAL_START);
    });

    it("the transaction trigger: the SAME window", async () => {
      insertDeal();
      const plan = await runTrigger();

      expect(plan.fetchStartISO).toBe(DEAL_START);
    });

    it("CONTROL: all four entry points agree, compared to ONE expected value", async () => {
      // THE one-definition proof. There is a single expectation here, so there
      // is no per-entry-point expected value that could be updated on its own —
      // mutate the resolver's window rule and all four of these red together.
      //
      // Before the refactor this test could not have been written: the button
      // read preferences plus a transactions query, the estimate read whatever
      // the renderer had sent, and the trigger passed a bare
      // `{ auditPeriodStart }` with no lookback, no cap and no attachment
      // preference at all.
      insertDeal();

      const button = await runImportButton(false);
      mockImportMessages.mockClear();
      const force = await runImportButton(true);
      mockImportMessages.mockClear();
      const estimate = await runEstimate();
      const trigger = await runTrigger();

      for (const plan of [button, force, estimate, trigger]) {
        expect(plan.fetchStartISO).toBe(DEAL_START);
        expect(plan.effectiveCap).toBe(50000);
        expect(plan.fetchAttachments).toBe(true);
        expect(plan.protectedSpans).toEqual([
          { startNano: expect.any(Number), endNano: null },
        ]);
      }
    });
  });

  describe("the cap reaches every entry point (BACKLOG-2733, and the trigger's missing cap)", () => {
    it("an explicit Unlimited survives to every entry point as null", async () => {
      // `null ?? 50000` is 50000, which is how "Unlimited" became a 50K cap on
      // the handler path. The resolver distinguishes an absent key from an
      // explicit null, and every entry point reads that one answer.
      mockGetPreferences.mockResolvedValue({
        messageImport: { filters: { lookbackMonths: null, maxMessages: null } },
      });
      insertDeal();

      const button = await runImportButton(false);
      mockImportMessages.mockClear();
      const estimate = await runEstimate();
      const trigger = await runTrigger();

      for (const plan of [button, estimate, trigger]) {
        expect(plan.effectiveCap).toBeNull();
      }
    });

    it("ANTI-VACUITY: a stored numeric cap reaches every entry point unchanged", async () => {
      // Without this, the assertions above would be equally green for a
      // resolver that had stopped reading the preference at all.
      mockGetPreferences.mockResolvedValue({
        messageImport: { filters: { lookbackMonths: 3, maxMessages: 1234 } },
      });
      insertDeal();

      const button = await runImportButton(false);
      mockImportMessages.mockClear();
      const estimate = await runEstimate();
      const trigger = await runTrigger();

      for (const plan of [button, estimate, trigger]) {
        expect(plan.effectiveCap).toBe(1234);
      }
    });

    it("the trigger carries the attachment preference it used to ignore entirely", async () => {
      mockGetPreferences.mockResolvedValue({
        messageImport: { filters: { lookbackMonths: 3, skipAttachments: true } },
      });
      insertDeal();

      const plan = await runTrigger();

      // The old call site passed `{ auditPeriodStart }` and nothing else, so a
      // deal being created copied attachments regardless of this setting — on
      // the founder's machine, 61.3 GB against 59.1 GB free.
      expect(plan.fetchAttachments).toBe(false);
    });
  });

  describe("which deals count is decided in ONE place", () => {
    it("a REJECTED deal neither stretches the window nor protects anything", async () => {
      // BACKLOG-2308's filter, now read by exactly one query. A rejected deal is
      // dead: no audit obligation, no protection from the cap.
      insertDeal("rejected", "2020-01-01T00:00:00.000Z");

      const plan = await runImportButton(false);

      expect(plan.fetchStartISO).not.toBe("2020-01-01T00:00:00.000Z");
      expect(plan.protectedSpans).toEqual([]);
      expect(plan.overrides).toEqual([]);
    });

    it.each(["pending", "active", "closed"])(
      "a %s deal DOES stretch the window and protect its period",
      async (status) => {
        // "Treat closed as live" is the standing definition, reaffirmed by the
        // founder when Cap' was settled: a closed deal's export must stay
        // reproducible, so its history is protected exactly like a live one's.
        insertDeal(status);

        const plan = await runImportButton(false);

        expect(plan.fetchStartISO).toBe(DEAL_START);
        expect(plan.protectedSpans).toHaveLength(1);
      },
    );
  });

  describe("SHIPPED wire defaults for what the payload omits", () => {
    /*
     * The lesson from PR #2335's third commit: that PR shipped three defaults
     * nobody had pinned, and flipping all of them left 161 tests across 8 suites
     * green. This channel has one such default — the estimate's `selection` is
     * optional, and omitting it must fall back to the STORED preference rather
     * than to a hard-coded window. Every other test in this file passes a
     * selection, so without this the fallback is unasserted.
     */
    it("the estimate with NO selection resolves the stored preference", async () => {
      mockGetPreferences.mockResolvedValue({
        messageImport: { filters: { lookbackMonths: null, maxMessages: 4321 } },
      });

      await handlers.get("messages:get-import-count")(event, USER);

      const plan = estimatedPlan();
      // Stored "All time" governs: unbounded, and the stored cap intact.
      expect(plan.fetchStartISO).toBeNull();
      expect(plan.effectiveCap).toBe(4321);
    });

    it("ANTI-VACUITY: an explicit selection still overrides the stored preference", async () => {
      // Without this, the assertion above would be equally green for a handler
      // that ignored the wire entirely and always read stored prefs.
      mockGetPreferences.mockResolvedValue({
        messageImport: { filters: { lookbackMonths: null, maxMessages: 4321 } },
      });

      await handlers.get("messages:get-import-count")(event, USER, { lookbackMonths: 3 });

      const plan = estimatedPlan();
      // The panel's unsaved 3-month choice bounds the window; the stored cap,
      // which the selection says nothing about, survives the merge.
      expect(plan.fetchStartISO).not.toBeNull();
      expect(plan.effectiveCap).toBe(4321);
    });
  });

  describe("with no deals at all, every entry point honours the selection exactly", () => {
    it("no stretch, no protection, no overrides", async () => {
      const button = await runImportButton(false);
      mockImportMessages.mockClear();
      const estimate = await runEstimate();

      for (const plan of [button, estimate]) {
        expect(plan.protectedSpans).toEqual([]);
        expect(plan.overrides).toEqual([]);
        // Three months back from now, not the deal start and not unbounded.
        expect(plan.fetchStartISO).not.toBeNull();
        expect(plan.fetchStartISO).not.toBe(DEAL_START);
      }
    });
  });
});
