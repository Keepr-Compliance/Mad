/**
 * BACKLOG-3965 PR-2 — recordOpen never throws and never rejects.
 *
 * TransactionDetails calls it on mount; an unguarded bridge call there reddened
 * 189 of 243 tests (plan probe P1). Every failure shape below must resolve.
 */
import * as Sentry from "@sentry/electron/renderer";
import logger from "../../utils/logger";
import { transactionOpenService } from "../transactionOpenService";

const TXN_ID = "txn-3965";
const api = () => window.api.transactions as unknown as Record<string, unknown>;

describe("transactionOpenService.recordOpen", () => {
  let original: unknown;
  beforeEach(() => {
    jest.clearAllMocks();
    original = api().recordOpen;
    jest.spyOn(logger, "error").mockImplementation(() => {});
    jest.spyOn(logger, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    api().recordOpen = original;
    jest.restoreAllMocks();
  });

  it("calls the bridge once with the deal id", async () => {
    const recordOpen = jest.fn().mockResolvedValue({ success: true, recorded: true });
    api().recordOpen = recordOpen;
    await expect(transactionOpenService.recordOpen(TXN_ID)).resolves.toBeUndefined();
    expect(recordOpen).toHaveBeenCalledTimes(1);
    expect(recordOpen).toHaveBeenCalledWith(TXN_ID);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("bridge missing -> resolves quietly", async () => {
    api().recordOpen = undefined;
    await expect(transactionOpenService.recordOpen(TXN_ID)).resolves.toBeUndefined();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("bridge rejects -> resolves; the message is logged and the error reported to Sentry", async () => {
    const boom = new Error("ipc channel closed");
    api().recordOpen = jest.fn().mockRejectedValue(boom);
    await expect(transactionOpenService.recordOpen(TXN_ID)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), "ipc channel closed");
    expect(Sentry.captureException).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({ extra: expect.objectContaining({ operation: "record-open", error_message: "ipc channel closed" }) }),
    );
  });

  it("bridge throws synchronously -> resolves", async () => {
    api().recordOpen = jest.fn(() => {
      throw new Error("sync throw");
    });
    await expect(transactionOpenService.recordOpen(TXN_ID)).resolves.toBeUndefined();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it("main answers success:false -> resolves, logged as a warning, not reported twice", async () => {
    api().recordOpen = jest.fn().mockResolvedValue({ success: false, error: "refused" });
    await expect(transactionOpenService.recordOpen(TXN_ID)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), "refused");
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("reporting itself throws -> still resolves", async () => {
    api().recordOpen = jest.fn().mockRejectedValue(new Error("x"));
    jest.mocked(Sentry.captureException).mockImplementationOnce(() => {
      throw new Error("sentry down");
    });
    await expect(transactionOpenService.recordOpen(TXN_ID)).resolves.toBeUndefined();
  });
});

describe("transactionOpenService.getRecentlyOpened", () => {
  it("returns the rows on success and an error on failure, never an invented empty list", async () => {
    const rows = [{ transactionId: "t", propertyAddress: "1 Road", status: "active", openedAt: "x", requiredDone: 0, requiredTotal: 0 }];
    jest.mocked(window.api.transactions.getRecentlyOpened).mockResolvedValueOnce({ success: true, transactions: rows });
    await expect(transactionOpenService.getRecentlyOpened("u", 5)).resolves.toEqual({ success: true, data: rows });
    jest.mocked(window.api.transactions.getRecentlyOpened).mockResolvedValueOnce({ success: false, error: "nope" });
    await expect(transactionOpenService.getRecentlyOpened("u")).resolves.toEqual({ success: false, error: "nope" });
    jest.mocked(window.api.transactions.getRecentlyOpened).mockRejectedValueOnce(new Error("gone"));
    const r = await transactionOpenService.getRecentlyOpened("u");
    expect(r.success).toBe(false);
    expect(r.data).toBeUndefined();
  });
});
