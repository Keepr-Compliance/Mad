/**
 * BACKLOG-3952 — which errors are waited out, and the db-ready gate during the
 * wait.
 */
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  addBreadcrumb: jest.fn(),
}));

import { isRetryableDbWriteError, dbErrorCode, retryDelayMs } from "../dbWriteRetry";
import { initializationBroadcaster } from "../../initializationBroadcaster";

/** Same shape as the real driver's SqliteError: own keys message, stack, code. */
function sqliteError(code: string): Error {
  const e = new Error("x") as Error & { code: string };
  e.name = "SqliteError";
  e.code = code;
  return e;
}

describe("C8: isRetryableDbWriteError — swept, not sampled", () => {
  const RETRY = [
    "SQLITE_READONLY",
    "SQLITE_READONLY_DIRECTORY",
    "SQLITE_READONLY_RECOVERY",
    "SQLITE_READONLY_CANTLOCK",
    "SQLITE_READONLY_ROLLBACK",
    "SQLITE_READONLY_DBMOVED",
    "SQLITE_READONLY_CANTINIT",
    "SQLITE_BUSY",
    "SQLITE_LOCKED",
  ];
  const NO_RETRY = [
    "SQLITE_CORRUPT",
    "SQLITE_FULL",
    "SQLITE_CONSTRAINT",
    "SQLITE_IOERR",
    "SQLITE_IOERR_WRITE",
    "SQLITE_CANTOPEN",
    "SQLITE_ERROR",
    "SQLITE_NOTADB",
    "SQLITE_BUSY_SNAPSHOT",
    "SQLITE_LOCKED_SHAREDCACHE",
    "EPERM",
    "EBUSY",
    "DB_NOT_WRITABLE",
  ];

  it.each(RETRY)("%s is waited out", (code) => {
    expect(isRetryableDbWriteError(sqliteError(code))).toBe(true);
  });

  it.each(NO_RETRY)("%s is NOT waited out", (code) => {
    expect(isRetryableDbWriteError(sqliteError(code))).toBe(false);
  });

  it("matches on code only, never message text", () => {
    expect(isRetryableDbWriteError(new Error("attempt to write a readonly database"))).toBe(false);
    expect(isRetryableDbWriteError(null)).toBe(false);
    expect(isRetryableDbWriteError("SQLITE_READONLY")).toBe(false);
    expect(isRetryableDbWriteError({ code: 5 })).toBe(false);
  });

  it("dbErrorCode reports the code or 'none'", () => {
    expect(dbErrorCode(sqliteError("SQLITE_READONLY"))).toBe("SQLITE_READONLY");
    expect(dbErrorCode(new Error("plain"))).toBe("none");
    expect(dbErrorCode(undefined)).toBe("none");
  });

  it("delays grow then hold at the last step", () => {
    expect([1, 2, 3, 4, 5, 6, 30].map(retryDelayMs)).toEqual([
      500, 1_000, 2_000, 4_000, 5_000, 5_000, 5_000,
    ]);
  });
});

describe("C10: db-ready waiters keep waiting during db-waiting (SR R1)", () => {
  it("whenDbReady() stays pending at db-waiting and resolves at db-ready", async () => {
    initializationBroadcaster.broadcast({ stage: "starting" });
    initializationBroadcaster.broadcast({ stage: "db-waiting" });

    let result: unknown = "pending";
    const p = initializationBroadcaster.whenDbReady(60_000).then((r) => {
      result = r;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(result).toBe("pending");

    initializationBroadcaster.broadcast({ stage: "db-ready" });
    await p;
    expect(result).toEqual({ ready: true, timedOut: false });
  });
});
