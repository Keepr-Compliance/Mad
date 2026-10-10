/**
 * BACKLOG-3884 — the open path logs counts, sizes and durations to main.log,
 * never ids or content.
 */
import { renderHook, act, waitFor } from "@testing-library/react";
import logger from "../../../../utils/logger";
import { useTransactionDetails } from "../useTransactionDetails";
import type { Transaction } from "@/types";

const tx = { id: "txn-secret-1", user_id: "user-1" } as unknown as Transaction;

describe("useTransactionDetails open-path timing", () => {
  let info: jest.SpyInstance;
  beforeEach(() => {
    info = jest.spyOn(logger, "info").mockImplementation(() => undefined);
    const api = window.api.transactions as unknown as Record<string, jest.Mock>;
    api.getOverview = jest.fn().mockResolvedValue({
      success: true,
      transaction: { contact_assignments: [{ id: "ca-1" }, { id: "ca-2" }] },
    });
    api.getCommunications = jest.fn().mockResolvedValue({
      success: true,
      transaction: {
        communications: Array.from({ length: 300 }, (_, i) => ({
          id: `msg-secret-${i}`,
          channel: "sms",
          body_text: "private body text",
        })),
        contact_assignments: [],
      },
    });
  });
  afterEach(() => info.mockRestore());

  it("logs overview and communications lines with counts and sizes only", async () => {
    const { result } = renderHook(() => useTransactionDetails(tx));
    await waitFor(() =>
      expect(info.mock.calls.some(([l]) => /^\[TxnOpen\] overview received ms=\d+ contacts=2$/.test(l))).toBe(true),
    );
    await act(async () => {
      await result.current.loadCommunications("text");
    });
    const line = info.mock.calls.map(([l]) => l as string).find((l) => l.includes("communications fetched"));
    expect(line).toMatch(/^\[TxnOpen\] communications fetched channel=text ms=\d+ rows=300 approxBytes=\d+$/);
    const bytes = Number(/approxBytes=(\d+)/.exec(line!)![1]);
    expect(bytes).toBeGreaterThan(300 * 40);
    const all = info.mock.calls.map(([l]) => String(l)).join("\n");
    expect(all).not.toContain("secret");
    expect(all).not.toContain("private body");
  });
});
