/**
 * BACKLOG-3965 PR-2 — the record-open / get-recently-opened channels.
 *
 * The db layer is mocked; its SQL runs on the real driver in
 * transactionOpenDbService-3965.test.ts. This file pins validation, the bound
 * arguments, and that a failing write is logged + reported to Sentry and
 * answered { success: false } (never thrown back at the renderer).
 */
const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
jest.mock("electron", () => ({
  ipcMain: {
    handle: jest.fn((channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
      handlers[channel] = fn;
    }),
  },
}));
jest.mock("@sentry/electron/main", () => ({ captureException: jest.fn() }));
jest.mock("../../services/logService", () => {
  const m = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});
jest.mock("../../services/db/transactionOpenDbService", () => ({
  recordTransactionOpen: jest.fn(),
  getRecentlyOpenedTransactions: jest.fn(),
}));

import * as Sentry from "@sentry/electron/main";
import logService from "../../services/logService";
import {
  getRecentlyOpenedTransactions,
  recordTransactionOpen,
} from "../../services/db/transactionOpenDbService";
import { RECENTLY_OPENED_DEFAULT_LIMIT, registerTransactionOpenHandlers } from "../transactionOpenHandlers";

// pii-allow-uuid: invented, not from any live row
const TXN_ID = "00000000-0000-4000-8000-000000003965";
// pii-allow-uuid: invented, not from any live row
const USER_ID = "00000000-0000-4000-8000-000000000396";
const event = {} as unknown;

beforeAll(() => registerTransactionOpenHandlers());
beforeEach(() => jest.clearAllMocks());

describe("transactions:record-open", () => {
  it("writes the deal id with an ISO UTC time and answers recorded", async () => {
    jest.mocked(recordTransactionOpen).mockReturnValue(true);
    await expect(handlers["transactions:record-open"](event, TXN_ID)).resolves.toEqual({ success: true, recorded: true });
    expect(recordTransactionOpen).toHaveBeenCalledTimes(1);
    const [id, at] = jest.mocked(recordTransactionOpen).mock.calls[0];
    expect(id).toBe(TXN_ID);
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("refuses a bad id without writing", async () => {
    const result = (await handlers["transactions:record-open"](event, "")) as { success: boolean };
    expect(result.success).toBe(false);
    expect(recordTransactionOpen).not.toHaveBeenCalled();
  });

  it("a failing write is logged, reported to Sentry, and answered success:false", async () => {
    const boom = new Error("SQLITE_READONLY: attempt to write a readonly database");
    jest.mocked(recordTransactionOpen).mockImplementation(() => {
      throw boom;
    });
    await expect(handlers["transactions:record-open"](event, TXN_ID)).resolves.toEqual({
      success: false,
      error: boom.message,
    });
    expect(Sentry.captureException).toHaveBeenCalledWith(boom);
    expect(logService.error).toHaveBeenCalledWith(expect.stringContaining(boom.message), "TransactionOpen", expect.anything());
  });
});

describe("transactions:get-recently-opened", () => {
  it("binds the user and the default limit of 5", async () => {
    jest.mocked(getRecentlyOpenedTransactions).mockReturnValue([]);
    await expect(handlers["transactions:get-recently-opened"](event, USER_ID)).resolves.toEqual({
      success: true,
      transactions: [],
    });
    expect(RECENTLY_OPENED_DEFAULT_LIMIT).toBe(5);
    expect(getRecentlyOpenedTransactions).toHaveBeenCalledWith(USER_ID, 5);
  });

  it("passes a given limit and refuses a bad one", async () => {
    jest.mocked(getRecentlyOpenedTransactions).mockReturnValue([]);
    await handlers["transactions:get-recently-opened"](event, USER_ID, 3);
    expect(getRecentlyOpenedTransactions).toHaveBeenCalledWith(USER_ID, 3);
    for (const bad of [0, -1, 2.5, "5"]) {
      const result = (await handlers["transactions:get-recently-opened"](event, USER_ID, bad)) as { success: boolean };
      expect(result.success).toBe(false);
    }
    expect(getRecentlyOpenedTransactions).toHaveBeenCalledTimes(1);
  });

  it("refuses a missing user", async () => {
    const result = (await handlers["transactions:get-recently-opened"](event, undefined)) as { success: boolean };
    expect(result.success).toBe(false);
    expect(getRecentlyOpenedTransactions).not.toHaveBeenCalled();
  });
});
