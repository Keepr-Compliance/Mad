/**
 * @jest-environment node
 *
 * BACKLOG-2791 — THE AUDIT-RANGE EXTENSION TRIGGER.
 *
 * Founder, 2026-08-23: "the review sync (and its popup) must ALSO run when the
 * user changes the audit dates in a way that extends the transaction's audit
 * range — extending the window brings new communications into scope; today
 * nothing happens until the next open. Same flow as the other triggers: sync →
 * queue → N/L/R popup with this run's delta."
 *
 * This suite pins the WIRING at the only place the user can save audit dates,
 * the `transactions:update` IPC handler. The predicate it depends on is swept
 * separately in `electron/utils/__tests__/auditWindowExtension-2791.test.ts`;
 * here the question is narrower and the one a founder walk can check:
 *
 *   extend  -> the EXISTING sweep runs, once, on this transaction
 *   narrow  -> it does NOT run                     (the control)
 *   no-op   -> it does NOT run                     (the control)
 *
 * "The EXISTING sweep" is load-bearing. The contract's trigger list is three
 * entries against ONE mechanism, so this path calls
 * `syncReviewQueueForTransaction` — the same function transaction-open and
 * contact-save call — rather than a fork of it. A fork is how the popup's L/R
 * split, the multi-deal disambiguation and the rejection suppression drift
 * apart. The reason string is asserted so the sweep can still tell its callers
 * apart in logs, and so the watermark rule (only "open" advances it) keeps
 * applying to this one.
 *
 * NARROWING IS NOT TESTED FOR ITS SEMANTICS, only for its silence. What should
 * happen to communications that fall out of a shrunken window is an open founder
 * decision, deliberately not built (Communication Lifecycle Contract, "out of
 * scope, parked"). The control below asserts only that this trigger does not
 * quietly decide it.
 *
 * CONTROLS RUN (mutation applied, suite re-run, MEASURED result):
 *  1. Drop the `if (windowExtended)` guard, so every date change syncs
 *                                                        -> RED, 1 of 5 tests.
 *     Only the NARROWING control fires, and the reason is worth recording: the
 *     same-dates control is held by the pre-existing `auditDateChanged` guard
 *     this block sits inside, not by the new one. So "saving identical dates
 *     runs no sweep" is genuinely protected — but by an OUTER condition, and
 *     this suite cannot tell the two guards apart. The predicate suite is where
 *     the no-change case is pinned against the predicate itself.
 *  2. Invert the guard to `if (!windowExtended)`          -> RED, 3 of 5 tests.
 *  3. Change the reason to "open"                         -> RED, 2 of 5 tests
 *     (and that matters: "open" advances the ingestion watermark, which would
 *     declare records scanned that this run never examined).
 */

const handlers = new Map<string, (...args: unknown[]) => unknown>();

jest.mock("electron", () => ({
  ipcMain: {
    handle: jest.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
    on: jest.fn(),
  },
  BrowserWindow: class {},
  app: { getPath: jest.fn(() => "/tmp"), getVersion: jest.fn(() => "0.0.0-test") },
}));

jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  addBreadcrumb: jest.fn(),
}));

const mockGetTransactionDetails = jest.fn();
const mockUpdateTransaction = jest.fn();

jest.mock("../../services/transactionService", () => ({
  __esModule: true,
  default: {
    getTransactionDetails: (...a: unknown[]) => mockGetTransactionDetails(...a),
    updateTransaction: (...a: unknown[]) => mockUpdateTransaction(...a),
  },
  getEarliestCommunicationDate: jest.fn(),
}));

jest.mock("../../services/auditService", () => ({
  __esModule: true,
  default: { log: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock("../../services/emailSyncService", () => ({ __esModule: true, default: {} }));
jest.mock("../../services/databaseService", () => ({ __esModule: true, default: {} }));

jest.mock("../../services/transactionSyncTrigger", () => ({
  triggerTransactionSyncInBackground: jest.fn(),
  isAutoSyncInFlight: jest.fn(() => false),
}));

jest.mock("../../services/messagesSyncTrigger", () => ({
  ensureTransactionMessagesSynced: jest.fn(),
  triggerMessagesSyncInBackground: jest.fn(),
}));

jest.mock("../../services/auditCoverageService", () => ({
  getAuditCoverage: jest.fn(),
  checkExportCompleteness: jest.fn(),
}));

/** THE sweep — the one every other trigger calls. Not a fork. */
const mockSyncReviewQueue = jest.fn().mockResolvedValue({ added: 0, linked: 0, outstanding: 0 });
jest.mock("../../services/reviewStateService", () => ({
  syncReviewQueueForTransaction: (...a: unknown[]) => mockSyncReviewQueue(...a),
}));

import { registerTransactionCrudHandlers } from "../transactionCrudHandlers";

const TXN = "11111111-1111-4111-8111-111111111111";

/** The stored deal before the edit: Mar 1 → Oct 1. */
const EXISTING = {
  id: TXN,
  user_id: "user-1",
  started_at: "2026-03-01T00:00:00.000Z",
  created_at: "2026-01-01T00:00:00.000Z",
  closed_at: "2026-10-01T00:00:00.000Z",
};

/** Invoke `transactions:update` the way the renderer does, then let the
 *  fire-and-forget trigger's microtasks run. */
async function saveDates(updates: Record<string, unknown>): Promise<void> {
  const handler = handlers.get("transactions:update");
  if (!handler) throw new Error("transactions:update was never registered");
  await handler({} as unknown, TXN, updates);
  // The sweep is deliberately NOT awaited by the handler (it broadcasts its own
  // delta), so drain the microtask queue before asserting.
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

describe("BACKLOG-2791 — audit-range extension runs the review sweep", () => {
  beforeEach(() => {
    handlers.clear();
    jest.clearAllMocks();
    mockGetTransactionDetails.mockResolvedValue(EXISTING);
    mockUpdateTransaction.mockResolvedValue(undefined);
    mockSyncReviewQueue.mockResolvedValue({ added: 0, linked: 0, outstanding: 0 });
    registerTransactionCrudHandlers(null);
  });

  it("extending the END date runs the sweep, once, on this transaction", async () => {
    await saveDates({ closed_at: "2026-12-01T00:00:00.000Z" });

    expect(mockSyncReviewQueue).toHaveBeenCalledTimes(1);
    expect(mockSyncReviewQueue).toHaveBeenCalledWith({
      transactionId: TXN,
      reason: "date-extended",
    });
  });

  it("extending the START date backwards also runs it", async () => {
    await saveDates({ started_at: "2026-01-15T00:00:00.000Z" });

    expect(mockSyncReviewQueue).toHaveBeenCalledTimes(1);
    expect(mockSyncReviewQueue.mock.calls[0][0]).toMatchObject({ reason: "date-extended" });
  });

  it("CONTROL — NARROWING does not run it, and decides nothing about the window it lost", async () => {
    await saveDates({ closed_at: "2026-06-01T00:00:00.000Z" });
    expect(mockSyncReviewQueue).not.toHaveBeenCalled();
  });

  it("CONTROL — saving the SAME dates does not run it", async () => {
    await saveDates({
      started_at: EXISTING.started_at,
      closed_at: EXISTING.closed_at,
    });
    expect(mockSyncReviewQueue).not.toHaveBeenCalled();
  });

  it("a sweep that throws does not fail the save the user asked for", async () => {
    mockSyncReviewQueue.mockRejectedValue(new Error("db is busy"));

    const handler = handlers.get("transactions:update");
    const result = (await handler?.({} as unknown, TXN, {
      closed_at: "2026-12-01T00:00:00.000Z",
    })) as { success: boolean };

    await new Promise((resolve) => setImmediate(resolve));
    expect(result.success).toBe(true);
    expect(mockUpdateTransaction).toHaveBeenCalled();
  });
});
