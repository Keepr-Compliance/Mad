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
import macOSMessagesImportService from "../services/macOSMessagesImportService";
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

  /**
   * The stored preference, and how many months back it reaches on its own.
   * `null` = unbounded ("All time").
   */
  const STORED: Array<[string, Record<string, unknown>, number | null]> = [
    ["key absent", { messageImport: { filters: { maxMessages: 50000 } } }, DEFAULT_LOOKBACK_MONTHS],
    ["explicit null (All time)", { messageImport: { filters: { lookbackMonths: null } } }, null],
    ["explicit number", { messageImport: { filters: { lookbackMonths: 6 } } }, 6],
  ];

  /** The deal rows, and how many months back the audit floor reaches. */
  const AUDIT: Array<[string, typeof mockTransactionRows, number | null]> = [
    ["no transactions", [], null],
    [
      "an old transaction pinning the audit floor",
      [{ started_at: monthsAgoISO(40), created_at: null, closed_at: null }],
      40,
    ],
    [
      "a recent transaction",
      [{ started_at: monthsAgoISO(1), created_at: null, closed_at: null }],
      1,
    ],
  ];

  for (const [prefLabel, prefs, prefMonths] of STORED) {
    for (const [auditLabel, rows, auditMonths] of AUDIT) {
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

        /*
         * BACKLOG-2749: `source` too, and this half is NEW.
         *
         * The bound above no longer proves what it used to. The label handler
         * used to compute its window with `computeEffectiveImportWindow` — a
         * second assembly that happened to agree — and this comparison was
         * what watched for the drift. The handler now reads `plan.fetchStartISO`
         * directly, so both sides of that comparison are one producer and it
         * cannot drift by construction. Good, but it also means the assertion
         * has stopped being able to fail.
         *
         * `source` is the part that is still a DERIVATION: it maps
         * `plan.overrides` onto the two-valued label the panel branches on, and
         * a wrong mapping is invisible in the cutoff. Expected from the fixture
         * parameters, not from the code: the audit period governs exactly when
         * the preference is bounded AND a deal reaches further back than it.
         */
        const auditShouldGovern =
          prefMonths !== null && auditMonths !== null && auditMonths > prefMonths;
        expect(label.source).toBe(
          auditShouldGovern ? "audit-period" : "lookback-pref"
        );
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

/**
 * BACKLOG-2749 — the estimate carries the PLAN, not just its counts.
 *
 * The one pre-import dialog states the cap and explains why the window reaches
 * further back than the user's own setting. Neither is recoverable from the
 * counts: under Cap' the admitted set is `protected ∪ (newest `cap`
 * unprotected)`, so `filteredCount` is legitimately LARGER than the cap and no
 * pair of counts can separate "the cap is 50,000 and 12,824 messages are
 * protected" from "the cap is 62,824". A dialog that guesses gets the founder's
 * live case wrong, which is what it did.
 *
 * These assert the handler's own merge — that the plan it resolved is the plan
 * it sends — against the same mocked count result, so a change to the counts
 * cannot make them pass or fail.
 */
describe("BACKLOG-2749 · the estimate response carries the resolved plan", () => {
  const counts = {
    success: true,
    count: 708400,
    filteredCount: 62824,
    windowCount: 708400,
  };

  beforeEach(() => {
    capturedPlan = undefined;
    mockTransactionRows = [];
    mockGetPreferences.mockReset();
    (
      macOSMessagesImportService.getAvailableMessageCount as jest.Mock
    ).mockResolvedValue(counts);
  });

  it("sends effectiveCap off the plan, for a preference the panel cannot resolve itself", async () => {
    // The `maxMessages` key is ABSENT — the shape written by changing only the
    // lookback. `resolveMaxMessages` reads that as "no preference" and applies
    // the 50,000 default (BACKLOG-2733); the raw stored object says nothing at
    // all. This is the case where the plan is the only source of the truth.
    mockGetPreferences.mockResolvedValue({
      messageImport: { filters: { lookbackMonths: 6 } },
    });

    const result = await handlers.get("messages:get-import-count")(
      mockEvent,
      TEST_USER_ID
    );

    expect(result.plan.effectiveCap).toBe(50000);
    expect(result.plan.fetchStartISO).not.toBeNull();
    // The counts pass through untouched — the merge adds, it does not rewrite.
    expect(result.filteredCount).toBe(62824);
    expect(result.windowCount).toBe(708400);
  });

  it("sends overrides[] when a deal stretches the window past the setting", async () => {
    mockGetPreferences.mockResolvedValue({
      messageImport: { filters: { lookbackMonths: 3, maxMessages: 50000 } },
    });
    mockTransactionRows = [
      { started_at: monthsAgoISO(40), created_at: null, closed_at: null },
    ];

    const result = await handlers.get("messages:get-import-count")(
      mockEvent,
      TEST_USER_ID
    );

    expect(result.plan.overrides).toHaveLength(1);
    expect(result.plan.overrides[0].kind).toBe("window-extended-by-deals");
  });

  it("ANTI-VACUITY: overrides[] is EMPTY when the setting already reaches back further", async () => {
    // Without this, the assertion above would be equally green for a handler
    // that emitted the override unconditionally — and the dialog would tell
    // every user a deal was widening their window.
    mockGetPreferences.mockResolvedValue({
      messageImport: { filters: { lookbackMonths: 60, maxMessages: 50000 } },
    });
    mockTransactionRows = [
      { started_at: monthsAgoISO(1), created_at: null, closed_at: null },
    ];

    const result = await handlers.get("messages:get-import-count")(
      mockEvent,
      TEST_USER_ID
    );

    expect(result.plan.overrides).toEqual([]);
  });

  it("an explicit Unlimited reaches the dialog as null, not as the default", async () => {
    // BACKLOG-2733's distinction, carried all the way to the surface that
    // renders it: `null` means the user chose Unlimited and there is no cap to
    // disclose. Collapsed to 50,000 it would open a dialog about a limit the
    // user had switched off.
    mockGetPreferences.mockResolvedValue({
      messageImport: { filters: { lookbackMonths: 6, maxMessages: null } },
    });

    const result = await handlers.get("messages:get-import-count")(
      mockEvent,
      TEST_USER_ID
    );

    expect(result.plan.effectiveCap).toBeNull();
  });
});

/**
 * BACKLOG-2749 — the dialog's recommendation is computed WITH the estimate.
 *
 * The founder: "the Change the time range button takes a sec to load". The
 * per-candidate round trips were the right mechanism in the wrong place, so
 * they moved ahead of the click. These pin that it is still an ASK — each
 * candidate range resolved through the real resolver and counted — and that it
 * only runs when the cap is actually exceeded.
 */
describe("BACKLOG-2749 · the estimate precomputes the recommended range", () => {
  /** Counts keyed by the candidate's resolved lookback, so a proportional
   *  guess cannot land on the right answer by accident. */
  const COUNTS: Record<string, number> = {
    "null": 708400,
    "24": 300000,
    "18": 180000,
    "12": 90000,
    "9": 41000,
    "6": 20000,
    "3": 9000,
  };

  beforeEach(() => {
    capturedPlan = undefined;
    mockTransactionRows = [];
    mockGetPreferences.mockReset();
    // Cleared, not just re-implemented: two tests below COUNT the calls, and
    // this mock accumulates across the whole file otherwise.
    (macOSMessagesImportService.getAvailableMessageCount as jest.Mock).mockClear();
    (
      macOSMessagesImportService.getAvailableMessageCount as jest.Mock
    ).mockImplementation(async (plan: ImportPlan) => {
      // Recover which candidate this plan is for from its own cutoff: the
      // handler resolves a REAL plan per candidate, so the fixture answers the
      // plan rather than the request.
      const months =
        plan.fetchStartISO === null
          ? "null"
          : String(
              Math.round(
                (Date.now() - new Date(plan.fetchStartISO).getTime()) /
                  (30.44 * 24 * 60 * 60 * 1000)
              )
            );
      const count = COUNTS[months] ?? COUNTS["null"];
      return { success: true, count, windowCount: count, filteredCount: count };
    });
  });

  it("CONTROL: recommends the LARGEST narrower range that fits the cap", async () => {
    // Cap 50,000. 24/18/12 months are all over it; 9 months is the first that
    // fits, and 6 and 3 fit too but are smaller. His own data lands on 9.
    mockGetPreferences.mockResolvedValue({
      messageImport: { filters: { lookbackMonths: null, maxMessages: 50000 } },
    });

    const result = await handlers.get("messages:get-import-count")(
      mockEvent,
      TEST_USER_ID
    );

    expect(result.recommendedRange).toEqual({
      lookbackMonths: 9,
      windowCount: 41000,
    });
  });

  it("ANTI-VACUITY: no recommendation when the selection already fits", async () => {
    // The cap is not exceeded, so there is nothing to recommend AND nothing to
    // compute. Without this, a handler that recommended unconditionally — and
    // paid six extra counts on every estimate — would pass the test above.
    mockGetPreferences.mockResolvedValue({
      messageImport: { filters: { lookbackMonths: null, maxMessages: 900000 } },
    });

    const result = await handlers.get("messages:get-import-count")(
      mockEvent,
      TEST_USER_ID
    );

    expect(result.recommendedRange).toBeNull();
    // One count for the estimate itself, and not one more.
    expect(
      (macOSMessagesImportService.getAvailableMessageCount as jest.Mock).mock
        .calls.length
    ).toBe(1);
  });

  it("recommends nothing when no narrower range fits", async () => {
    // Everything is over the cap. `null` is the answer, and it is what makes
    // the dialog hide the button rather than spin.
    mockGetPreferences.mockResolvedValue({
      messageImport: { filters: { lookbackMonths: null, maxMessages: 100 } },
    });

    const result = await handlers.get("messages:get-import-count")(
      mockEvent,
      TEST_USER_ID
    );

    expect(result.recommendedRange).toBeNull();
  });

  it("an explicit Unlimited recommends nothing and costs nothing", async () => {
    mockGetPreferences.mockResolvedValue({
      messageImport: { filters: { lookbackMonths: null, maxMessages: null } },
    });

    const result = await handlers.get("messages:get-import-count")(
      mockEvent,
      TEST_USER_ID
    );

    expect(result.recommendedRange).toBeNull();
    expect(
      (macOSMessagesImportService.getAvailableMessageCount as jest.Mock).mock
        .calls.length
    ).toBe(1);
  });
});
