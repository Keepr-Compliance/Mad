/**
 * BACKLOG-2561 — the import and its label, driven through the REAL handlers.
 *
 * `importHelpers.allTime-2561.test.ts` pins the helpers. This suite pins the two
 * handlers that read the stored preference, because the bug lived in THEM: both
 * resolved `messageImport.filters.lookbackMonths` with `??`, and "All time" is
 * stored as an explicit `null`, so `null ?? 3` rewrote the user's choice into a
 * 3-month window before either the import or the label ever saw it.
 *
 * What is real here: `registerMessageImportHandlers` and the handler bodies it
 * registers, `resolveLookbackMonths`, `computeImportCutoffNano`, and
 * `computeEffectiveImportWindow`. The filters the import handler builds are
 * CAPTURED off the mocked `macOSMessagesImportService.importMessages` — the same
 * object the real service would have received — and then run through the real
 * cutoff computation.
 *
 * The one link that cannot execute under jest is SQLite applying the date
 * predicate (`sqlite3` is mapped to a stub in jest.config.js), so the corpus is
 * filtered in JS with the same strict `>` the production SQL uses. That mirror is
 * held in place by `the production date filter has not changed shape` below,
 * which reads the service source and fails if the clause is edited — a mirror
 * nobody re-checks is how a parity test drifts and stays green.
 */

import fs from "fs";
import path from "path";

import {
  createIpcHandlerRegistry,
  type IpcHandlerRegistry,
  type RegisteredIpcHandler,
} from "../../tests/support/ipcHandlerRegistry";
import type { IpcMainInvokeEvent } from "electron";
import type { ImportPlan } from "../services/importPlan";

const mockIpcHandle = jest.fn();
jest.mock("electron", () => ({
  ipcMain: { handle: mockIpcHandle, on: jest.fn() },
  BrowserWindow: jest.fn(),
}));

jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  addBreadcrumb: jest.fn(),
}));

jest.mock("../services/logService", () => {
  const m = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

/** Rows the audit-period floor is computed from. Swapped per test. */
let mockTransactionRows: Array<{
  started_at: string | null;
  created_at: string | null;
  closed_at: string | null;
}> = [];

/*
 * BACKLOG-2772: the audit-period rows now reach the plan through `dbAll`, the
 * shared accessor, rather than through `getRawDatabase().prepare` in the
 * handler. The handler no longer runs a transactions query at all — the ONE
 * assembler does (`importPlanInputs.readNonRejectedTransactions`), and the
 * trigger reads the same function, so the two can no longer disagree about
 * which deals carry an audit obligation.
 */
jest.mock("../services/db/core/dbConnection", () => ({
  __esModule: true,
  dbAll: (sql: string) =>
    sql.includes("FROM transactions") ? mockTransactionRows : [],
  setDb: jest.fn(),
}));

/** The single user row the handler falls back to when validating the user id. */
const mockPrepare = jest.fn((sql: string) => {
  if (sql.includes("FROM transactions")) {
    return { all: () => mockTransactionRows, get: () => undefined };
  }
  return { all: () => [], get: () => ({ id: TEST_USER_ID }) };
});

jest.mock("../services/databaseService", () => ({
  __esModule: true,
  default: {
    isInitialized: jest.fn(() => true),
    getUserById: jest.fn().mockResolvedValue({ id: "11111111-2222-4333-8444-555555555555" }),
    getRawDatabase: jest.fn(() => ({ prepare: mockPrepare })),
    backfillContactCommunicationDates: jest.fn().mockResolvedValue(0),
    backfillPhoneLastMessageTable: jest.fn().mockResolvedValue(0),
  },
}));

const mockGetPreferences = jest.fn();
jest.mock("../services/supabaseService", () => ({
  __esModule: true,
  default: { getPreferences: (...args: unknown[]) => mockGetPreferences(...args) },
}));

/** Captures the PLAN the import handler hands the service (BACKLOG-2772). */
let capturedPlan: ImportPlan | undefined;
const mockImportMessages = jest.fn(
  async (_userId: string, _onProgress: unknown, plan: ImportPlan) => {
    capturedPlan = plan;
    return {
      success: true,
      messagesImported: 0,
      messagesSkipped: 0,
      attachmentsImported: 0,
      attachmentsUpdated: 0,
      attachmentsSkipped: 0,
      duration: 1,
    };
  }
);

jest.mock("../services/macOSMessagesImportService", () => ({
  __esModule: true,
  default: {
    importMessages: (...args: unknown[]) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockImportMessages as any)(...args),
    getAvailableMessageCount: jest.fn(),
  },
}));

jest.mock("../services/db/externalContactDbService", () => ({
  updateLastMessageAtFromLookupTable: jest.fn(() => 0),
}));

jest.mock("../services/autoLinkService", () => ({
  autoLinkNewMessagesForUser: jest.fn().mockResolvedValue(undefined),
  expandAttachedThreadsForUser: jest.fn().mockResolvedValue(undefined),
}));

// Imported after the mocks so the handler module binds to them.
import { registerMessageImportHandlers } from "../handlers/messageImportHandlers";
import {
  computeImportCutoffNano,
  DEFAULT_LOOKBACK_MONTHS,
} from "../services/macOSMessagesImportService/importHelpers";
import { MAC_EPOCH } from "../constants";

const TEST_USER_ID = "11111111-2222-4333-8444-555555555555";
const NANOS_PER_MS = 1_000_000;

/** ISO instant → Apple-epoch nanoseconds, the production storage unit. */
function isoToNano(iso: string): number {
  return (new Date(iso).getTime() - MAC_EPOCH) * NANOS_PER_MS;
}

/**
 * Corpus dates are anchored to the REAL "now", because these handlers call
 * `computeImportCutoffNano()` without an injectable clock. Absolute dates would
 * silently change meaning as the calendar moves — a first draft used them and
 * put a "24 months ago" message 27 months in the past. Offsets are whole months
 * and far from every cutoff under test, so the millisecond of drift between this
 * module loading and the handler running cannot reach a boundary.
 */
function monthsAgoISO(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString();
}

/**
 * A corpus in which EVERY message is older than the 3-month default window.
 * Under the bug this set imports empty; that emptiness is the whole defect.
 */
const OLD_ONLY_CORPUS = [
  { id: "msg-90-months-ago", date: isoToNano(monthsAgoISO(90)) },
  { id: "msg-47-months-ago", date: isoToNano(monthsAgoISO(47)) },
  { id: "msg-20-months-ago", date: isoToNano(monthsAgoISO(20)) },
  { id: "msg-5-months-ago", date: isoToNano(monthsAgoISO(5)) },
];
const ALL_CORPUS_IDS = OLD_ONLY_CORPUS.map((m) => m.id);

/**
 * The production date filter, applied to the corpus. Strict `>` and a null
 * cutoff meaning "no filter at all" both come from the service source, which the
 * guard test below re-reads on every run.
 */
/**
 * The corpus this plan would import.
 *
 * BACKLOG-2772: reads `plan.cutoffNano` instead of re-running
 * `computeImportCutoffNano` over the captured filters. The test used to
 * re-derive the very rule it was testing, so a resolver that computed the
 * cutoff differently from the test's copy would still have looked correct here.
 * The plan carries the one answer; this reads it.
 */
function importedIdsFor(plan: ImportPlan | undefined): string[] {
  const cutoff = plan?.cutoffNano ?? null;
  return OLD_ONLY_CORPUS.filter((m) => cutoff === null || m.date > cutoff).map((m) => m.id);
}

/**
 * ONE registry for the whole file. `registerMessageImportHandlers` short-circuits
 * on a module-level `handlersRegistered` flag, so it can only ever run once per
 * module instance — a per-describe registration silently registers nothing.
 */
const handlers: IpcHandlerRegistry = createIpcHandlerRegistry();
const mockEvent = {} as IpcMainInvokeEvent;

beforeAll(() => {
  mockIpcHandle.mockImplementation((channel: string, handler: RegisteredIpcHandler) => {
    handlers.set(channel, handler);
  });
  registerMessageImportHandlers({
    isDestroyed: () => true,
    webContents: { send: jest.fn() },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
});

describe("BACKLOG-2561 · messages:import-macos honours an explicit All time", () => {
  beforeEach(() => {
    capturedPlan = undefined;
    mockTransactionRows = [];
    mockGetPreferences.mockReset();
  });

  it("imports the ENTIRE old-only corpus when the user picked All time", async () => {
    mockGetPreferences.mockResolvedValue({
      messageImport: { filters: { lookbackMonths: null, maxMessages: 50000 } },
    });

    await handlers.get("messages:import-macos")(mockEvent, TEST_USER_ID, false);

    // An explicit All time is unbounded: no cutoff at all.
    expect(capturedPlan?.cutoffNano).toBeNull();
    expect(capturedPlan?.fetchStartISO).toBeNull();
    // Identity, not count: the exact set, in order.
    expect(importedIdsFor(capturedPlan)).toEqual(ALL_CORPUS_IDS);
  });

  it("still imports the whole corpus for All time when transactions pin an audit floor", async () => {
    mockGetPreferences.mockResolvedValue({
      messageImport: { filters: { lookbackMonths: null, maxMessages: 50000 } },
    });
    // A transaction whose audit period starts long AFTER the oldest messages, so
    // an All-time import that let the floor bound it would drop them.
    mockTransactionRows = [
      { started_at: monthsAgoISO(60), created_at: null, closed_at: null },
    ];

    await handlers.get("messages:import-macos")(mockEvent, TEST_USER_ID, false);

    // The deal IS seen — it produces a protected span — and still cannot bound
    // an explicit All time. That is the BACKLOG-2561 short-circuit, asserted
    // through the plan rather than through an intermediate field.
    expect(capturedPlan?.protectedSpans).toHaveLength(1);
    expect(capturedPlan?.cutoffNano).toBeNull();
    expect(importedIdsFor(capturedPlan)).toEqual(ALL_CORPUS_IDS);
  });

  it("imports NOTHING from this corpus when no preference is stored (3-month default)", async () => {
    mockGetPreferences.mockResolvedValue({});

    await handlers.get("messages:import-macos")(mockEvent, TEST_USER_ID, false);

    expect(capturedPlan?.cutoffNano).not.toBeNull();
    expect(importedIdsFor(capturedPlan)).toEqual([]);
  });

  it("defaults to 3 months when filters exist but the lookbackMonths KEY is absent", async () => {
    // The shape the app actually writes when only the cap has been changed.
    mockGetPreferences.mockResolvedValue({
      messageImport: { filters: { maxMessages: 50000 } },
    });

    await handlers.get("messages:import-macos")(mockEvent, TEST_USER_ID, false);

    expect(capturedPlan?.cutoffNano).not.toBeNull();
    expect(importedIdsFor(capturedPlan)).toEqual([]);
  });

  it("passes an explicit number straight through", async () => {
    mockGetPreferences.mockResolvedValue({
      messageImport: { filters: { lookbackMonths: 24, maxMessages: 50000 } },
    });

    await handlers.get("messages:import-macos")(mockEvent, TEST_USER_ID, false);

    expect(capturedPlan?.cutoffNano).not.toBeNull();
    // A 24-month window reaches the 20- and 5-month messages, not the older two.
    expect(importedIdsFor(capturedPlan)).toEqual([
      "msg-20-months-ago",
      "msg-5-months-ago",
    ]);
  });

  it("still lets an older audit period widen a 3-month preference (BACKLOG-2276)", async () => {
    mockGetPreferences.mockResolvedValue({
      messageImport: { filters: { lookbackMonths: 3, maxMessages: 50000 } },
    });
    mockTransactionRows = [
      { started_at: monthsAgoISO(60), created_at: null, closed_at: null },
    ];

    await handlers.get("messages:import-macos")(mockEvent, TEST_USER_ID, false);

    // The 3-month preference is the FLOOR the audit period widens past.
    expect(capturedPlan?.cutoffNano).not.toBeNull();
    // The floor reaches 60 months back, past the 3-month preference, and rescues
    // everything newer than it — but NOT the 90-month message, which is outside
    // the audit period. That asymmetry is what makes this a floor and not a reset.
    expect(importedIdsFor(capturedPlan)).toEqual([
      "msg-47-months-ago",
      "msg-20-months-ago",
      "msg-5-months-ago",
    ]);
  });
});

/**
 * Control 5 at the handler level: the two handlers must resolve the SAME stored
 * preference to the SAME lower bound. This is the pairing that broke — a label
 * that faithfully mirrors a wrong import reads as correct.
 */
describe("BACKLOG-2561 · the label handler and the import handler agree", () => {
  beforeEach(() => {
    capturedPlan = undefined;
    mockTransactionRows = [];
    mockGetPreferences.mockReset();
  });

  const STORED: Array<[string, Record<string, unknown>]> = [
    ["key absent", { messageImport: { filters: { maxMessages: 50000 } } }],
    ["explicit null (All time)", { messageImport: { filters: { lookbackMonths: null } } }],
    ["explicit number", { messageImport: { filters: { lookbackMonths: 6 } } }],
  ];

  const AUDIT: Array<[string, typeof mockTransactionRows]> = [
    ["no transactions", []],
    [
      "an old transaction pinning the audit floor",
      [{ started_at: monthsAgoISO(40), created_at: null, closed_at: null }],
    ],
    [
      "a recent transaction",
      [{ started_at: monthsAgoISO(1), created_at: null, closed_at: null }],
    ],
  ];

  for (const [prefLabel, prefs] of STORED) {
    for (const [auditLabel, rows] of AUDIT) {
      it(`${prefLabel} × ${auditLabel}`, async () => {
        mockGetPreferences.mockResolvedValue(prefs);
        mockTransactionRows = rows;

        await handlers.get("messages:import-macos")(mockEvent, TEST_USER_ID, false);
        // BACKLOG-2772: the bound is READ off the plan the handler produced,
        // not recomputed here. Recomputing it made this comparison a test of
        // two copies of the same expression agreeing with each other.
        const importBoundISO = capturedPlan?.fetchStartISO ?? null;

        const label = await handlers.get("messages:get-effective-import-window")(
          mockEvent,
          TEST_USER_ID
        );

        // Same instant, or both unbounded. Compared to the SECOND to absorb the
        // sub-second drift between the two handlers' separate `new Date()` calls.
        if (importBoundISO === null || label.effectiveCutoffISO === null) {
          expect(label.effectiveCutoffISO).toBe(importBoundISO);
        } else {
          expect(label.effectiveCutoffISO.slice(0, 19)).toBe(importBoundISO.slice(0, 19));
        }
      });
    }
  }
});

/**
 * Anti-drift guard for the JS mirror of the SQL predicate used above.
 *
 * If someone changes the import's date filter — the operator, the column, or the
 * "no cutoff means no clause" rule — this test fails and says so, instead of the
 * ID-set assertions quietly testing a predicate production no longer uses.
 */
describe("BACKLOG-2561 · the production date filter has not changed shape", () => {
  const servicePath = path.join(
    __dirname,
    "../services/macOSMessagesImportService/importHelpers.ts"
  );
  const source = fs.readFileSync(servicePath, "utf8");

  /*
   * BACKLOG-2772 moved what this guard reads, and the move is why the guard is
   * now stronger.
   *
   * The clause used to be built inline in `doImport`, with the estimate
   * spelling its own near-copy (`AND date > ...`, no table prefix). Two
   * spellings meant this guard had to check two places and could only ever
   * confirm they both still existed — not that they agreed. `buildMessageWindowSql`
   * is now the single producer for BOTH, so one assertion covers the run and
   * the preview, and a drift between them has become impossible rather than
   * watched for.
   */
  it("still filters with a strict `>` against message.date", () => {
    expect(source).toContain("`AND message.date > ${plan.cutoffNano}`");
  });

  it("still emits NO clause when the cutoff is null", () => {
    expect(source).toContain("plan.cutoffNano !== null");
    expect(source).toContain(': ""');
  });

  it("the preview shares that one clause rather than spelling its own", () => {
    // The old third assertion checked the estimate's separate `AND date > ...`
    // literal. There is no separate literal now; what replaces it is the
    // absence of one — the estimate destructures the same compiled object.
    const serviceSource = fs.readFileSync(
      path.join(
        __dirname,
        "../services/macOSMessagesImportService/macOSMessagesImportService.ts"
      ),
      "utf8"
    );
    expect(serviceSource).not.toContain("AND date > ${");
    // Both consumers take their clause from the shared builder.
    expect(serviceSource.match(/buildMessageWindowSql\(plan\)/g)).toHaveLength(2);
  });
});
