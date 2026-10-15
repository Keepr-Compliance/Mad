/**
 * BACKLOG-3884 (SR B1): editing the deal's dates re-reads the Texts conversation list
 * with the NEW window. Before the fix the list was cleared (an endless spinner) and
 * the Edit save callback refreshed with the dates of the render it was created in.
 */
import { renderHook, act, waitFor } from "@testing-library/react";
import { useTextThreads, auditWindowMs } from "../useTextThreads";
import { textThreadSummary } from "../../../__tests__/helpers/textThreadSummary3884";

const thread = textThreadSummary({ threadId: "thr-1", phone: "+12065550101", lastSentAt: "2026-02-01T10:00:00.000Z" });
const get = () => window.api.transactions.getTextThreads as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  get().mockResolvedValue({ success: true, threads: [thread] });
});

describe("useTextThreads after a date edit (BACKLOG-3884)", () => {
  it("re-reads the list with the new window, keeps a list on screen, and a stale refresh asks the new window", async () => {
    const { result, rerender } = renderHook(
      ({ start, end }: { start: string; end: string }) => useTextThreads("txn-1", start, end),
      { initialProps: { start: "2026-03-01", end: "2026-06-30" } },
    );
    await act(async () => {
      await result.current.load();
    });
    expect(get()).toHaveBeenCalledTimes(1);
    expect(get().mock.calls[0][1]).toEqual(auditWindowMs("2026-03-01", "2026-06-30"));
    const staleRefresh = result.current.refresh;

    rerender({ start: "2026-01-01", end: "2026-06-30" });
    await waitFor(() => expect(get()).toHaveBeenCalledTimes(2));
    expect(get().mock.calls[1][1]).toEqual(auditWindowMs("2026-01-01", "2026-06-30"));
    expect(result.current.threads).not.toBeNull();
    expect(result.current.loading).toBe(false);

    // The Edit save callback holds the previous render's refresh.
    await act(async () => {
      await staleRefresh();
    });
    expect(get().mock.calls[2][1]).toEqual(auditWindowMs("2026-01-01", "2026-06-30"));
  });

  it("does not read anything on a date change before the Texts tab was opened", async () => {
    const { rerender } = renderHook(
      ({ start }: { start: string }) => useTextThreads("txn-1", start, "2026-06-30"),
      { initialProps: { start: "2026-03-01" } },
    );
    rerender({ start: "2026-01-01" });
    await new Promise((r) => setTimeout(r, 20));
    expect(get()).not.toHaveBeenCalled();
  });
});
