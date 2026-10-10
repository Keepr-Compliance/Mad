/**
 * BACKLOG-3884 — overlapping refreshes of the Attachments/Checklist list never run
 * reads in parallel, and the last refresh is always followed by a read.
 *
 * The reader runs synchronously on main; three refreshes close together queued
 * three reads behind each other. Now a refresh during a read marks one trailing
 * read: N overlapping refreshes -> 1 extra read, started only after the current
 * one finished (so a write made before the refresh is read).
 */
import { renderHook, waitFor, act } from "@testing-library/react";
import { useTransactionAllAttachments } from "../useTransactionAllAttachments";

const getAllAttachments = window.api.transactions.getAllAttachments as jest.Mock;

type Deferred = { resolve: (v: unknown) => void };

describe("useTransactionAllAttachments — overlapping refreshes (BACKLOG-3884)", () => {
  let pending: Deferred[];
  let inFlight: number;
  let maxInFlight: number;

  beforeEach(() => {
    pending = [];
    inFlight = 0;
    maxInFlight = 0;
    getAllAttachments.mockReset();
    getAllAttachments.mockImplementation(
      () =>
        new Promise((resolve) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          pending.push({
            resolve: (v) => {
              inFlight--;
              resolve(v);
            },
          });
        }),
    );
  });

  const finishAll = async (data: unknown[] = []): Promise<void> => {
    await act(async () => {
      while (pending.length) pending.shift()!.resolve({ success: true, data });
      await Promise.resolve();
    });
  };

  it("three refreshes during a read -> exactly one trailing read, never two at once", async () => {
    const { result } = renderHook(() => useTransactionAllAttachments("txn-1"));
    expect(getAllAttachments).toHaveBeenCalledTimes(1);

    let refreshes: Promise<void>[] = [];
    act(() => {
      refreshes = [result.current.refresh(), result.current.refresh(), result.current.refresh()];
    });
    // nothing new starts while the first read is in flight
    expect(getAllAttachments).toHaveBeenCalledTimes(1);

    await finishAll();
    await waitFor(() => expect(getAllAttachments).toHaveBeenCalledTimes(2));
    await finishAll([{ id: "a-new" }]);
    await act(async () => {
      await Promise.all(refreshes);
    });

    expect(getAllAttachments).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);
    expect(result.current.attachments.map((a) => a.id)).toEqual(["a-new"]);
    expect(result.current.loading).toBe(false);
  });

  it("a refresh after the read finished starts a new read (no stale reuse)", async () => {
    const { result } = renderHook(() => useTransactionAllAttachments("txn-1"));
    await finishAll();
    await waitFor(() => expect(result.current.loading).toBe(false));

    let refresh: Promise<void> = Promise.resolve();
    act(() => {
      refresh = result.current.refresh();
    });
    expect(getAllAttachments).toHaveBeenCalledTimes(2);
    await finishAll();
    await act(async () => {
      await refresh;
    });
    expect(getAllAttachments).toHaveBeenCalledTimes(2);
  });
});
