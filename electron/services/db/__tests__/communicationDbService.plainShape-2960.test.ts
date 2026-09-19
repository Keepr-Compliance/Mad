/**
 * @jest-environment node
 *
 * BACKLOG-2960 — THE WRAPPER SHAPE: PLAIN, NOT `async`. All seven exports.
 *
 * ===========================================================================
 * WHY THIS SUITE EXISTS
 * ===========================================================================
 * The conversion's load-bearing rule is that a seam wrapper is a plain function
 * annotated `Promise<T>` and never an `async` function. Nothing in the repo held
 * that rule for this file. SR turned all seven of these exports into
 * `export async function` on PR #2555's tree and measured the result: `tsc`
 * silent, project eslint silent, the sync-twin guard 5/5, all 83 tests green.
 * A rule the header states and no instrument holds is a comment, not a rule.
 *
 * What is at stake is recorded as a test NAME rather than a promise in prose:
 * an `async` wrapper's throw arrives after the frame that could have rolled a
 * `better-sqlite3` transaction back, so the transaction commits over the error.
 * That behaviour is asserted for a real transaction elsewhere in the train
 * (SR reviews of PRs #2544 §2, #2545 §5.3, #2546 §3, on the real driver). What
 * THIS suite holds is the property those measurements depend on: that a failure
 * inside one of these seven unwinds BEFORE the promise is constructed.
 *
 * ===========================================================================
 * HOW THE FAILURE IS PRODUCED — no mock, no fake handle
 * ===========================================================================
 * These wrappers take no driver handle; they read the module-level conduit
 * (`dbGet`/`dbAll`/`dbRun` from `core/dbConnection`). So the throw has to come
 * from the conduit, and the cheapest honest way to get one is to leave the
 * connection unset: `ensureDb()` raises `DatabaseError` synchronously the moment
 * any conduit call is made. This file therefore never calls `setDb`, mocks
 * nothing but `logService`, and exercises the real conduit code path.
 *
 * `confirmEmailLinksByEmailIds` is called with a NON-EMPTY id list on purpose:
 * it returns `Promise.resolve(0)` for an empty list before it reaches `dbRun`,
 * and an empty list would assert on a path that never touches the driver.
 *
 * A returned promise is settled and its rejection swallowed, so an `async`
 * wrapper produces an assertion diff here rather than an unhandled rejection
 * that takes the jest worker down and prints no `Tests:` line at all.
 */

jest.mock("../../logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

import {
  confirmEmailLinksByEmailIds,
  getIgnoredEmailIdsForTransaction,
  getIgnoredThreadIdsForTransaction,
  getIgnoredCommunicationIdsForTransaction,
  countTextThreadsForTransaction,
  updateTransactionThreadCount,
  backfillAllTransactionThreadCounts,
} from "../communicationDbService";

/** The message `ensureDb()` raises when no handle has been published. */
const NOT_INITIALIZED = "Database is not initialized. Call initialize() first.";

const TXN = "txn-2960";

/**
 * Call `fn` and report, as plain values, whether it threw before returning.
 *
 * Properties, not matchers: `.rejects.toThrow(...)` and `toThrow(SqliteError)`
 * fail identically on a driver error under jest's `isError` gate (BACKLOG-3152),
 * and a bare `expect(...).toThrow()` leaves the rejection unhandled.
 */
const calledSynchronously = (
  fn: () => unknown,
): { threw: boolean; message: string | null } => {
  try {
    const value = fn();
    void Promise.resolve(value).catch(() => undefined);
    return { threw: false, message: null };
  } catch (e) {
    return { threw: true, message: e instanceof Error ? e.message : String(e) };
  }
};

/** Every promise-returning export of the seam, with arguments that reach the driver. */
const wrappers: Array<[string, () => unknown]> = [
  ["confirmEmailLinksByEmailIds", () => confirmEmailLinksByEmailIds(["email-2960"], TXN)],
  ["getIgnoredEmailIdsForTransaction", () => getIgnoredEmailIdsForTransaction(TXN)],
  ["getIgnoredThreadIdsForTransaction", () => getIgnoredThreadIdsForTransaction(TXN)],
  ["getIgnoredCommunicationIdsForTransaction", () => getIgnoredCommunicationIdsForTransaction(TXN)],
  ["countTextThreadsForTransaction", () => countTextThreadsForTransaction(TXN)],
  ["updateTransactionThreadCount", () => updateTransactionThreadCount(TXN)],
  ["backfillAllTransactionThreadCounts", () => backfillAllTransactionThreadCounts()],
];

describe("the wrapper shape: PLAIN, not async — all seven exports (BACKLOG-2960)", () => {
  it("the pinned set is exactly these seven names — editing the list is a red", () => {
    // WHAT THIS DOES AND DOES NOT DO. It compares the list above to a literal,
    // so deleting, renaming or reordering a pin reds here. It does NOT read the
    // module: it cannot see an eighth export, and an export added later is
    // unpinned until someone adds a case. SR demonstrated exactly that — a new
    // seam export born `async` left tsc, eslint, the twin guard and this suite
    // all green. Real enumeration from the module's exports would close it and
    // is deliberately not attempted here.
    expect(wrappers.map(([name]) => name).sort()).toEqual(
      [
        "backfillAllTransactionThreadCounts",
        "confirmEmailLinksByEmailIds",
        "countTextThreadsForTransaction",
        "getIgnoredCommunicationIdsForTransaction",
        "getIgnoredEmailIdsForTransaction",
        "getIgnoredThreadIdsForTransaction",
        "updateTransactionThreadCount",
      ],
    );
  });

  it.each(wrappers)(
    "%s: a driver failure unwinds BEFORE the promise is constructed",
    (_name, call) => {
      expect(calledSynchronously(call)).toEqual({
        threw: true,
        message: NOT_INITIALIZED,
      });
    },
  );
});
