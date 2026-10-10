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

/**
 * SR review of #2941 (BACKLOG-3884): two plausible wrong versions passed the
 * cases above — a trailing marker never cleared (a refresh during the trailing
 * read is lost), and a fetch reference never updated (a deal switch during a read
 * ends on the old deal's rows).
 */
describe("useTransactionAllAttachments — trailing read and deal switch (BACKLOG-3884)", () => {
  type P = { args: unknown[]; resolve: (v: unknown) => void };
  let pending: P[];

  beforeEach(() => {
    pending = [];
    getAllAttachments.mockReset();
    getAllAttachments.mockImplementation(
      (...args: unknown[]) => new Promise((resolve) => pending.push({ args, resolve })),
    );
  });

  const finish = async (fn: (p: P) => unknown[]): Promise<void> => {
    await act(async () => {
      while (pending.length) {
        const p = pending.shift()!;
        p.resolve({ success: true, data: fn(p) });
      }
      await Promise.resolve();
    });
  };

  it("a deal switch during a read ends on the new deal's rows", async () => {
    const { result, rerender } = renderHook(({ id }) => useTransactionAllAttachments(id), {
      initialProps: { id: "tx-A" },
    });
    rerender({ id: "tx-B" });
    for (let i = 0; i < 4; i++) await finish((p) => [{ id: `a-${p.args[0]}` }]);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.attachments.map((a) => a.id)).toEqual(["a-tx-B"]);
    expect(getAllAttachments.mock.calls.map((c) => c[0])).toEqual(["tx-A", "tx-B"]);
  });

  it("a refresh during the TRAILING read gets its own trailing read", async () => {
    let n = 0;
    const { result } = renderHook(() => useTransactionAllAttachments("tx-A"));
    act(() => {
      void result.current.refresh();
    });
    await finish(() => [{ id: `r${n++}` }]);
    await waitFor(() => expect(getAllAttachments).toHaveBeenCalledTimes(2));
    let last: Promise<void> = Promise.resolve();
    act(() => {
      last = result.current.refresh();
    });
    await finish(() => [{ id: `r${n++}` }]);
    await waitFor(() => expect(getAllAttachments).toHaveBeenCalledTimes(3));
    await finish(() => [{ id: `r${n++}` }]);
    await act(async () => {
      await last;
    });
    expect(result.current.attachments.map((a) => a.id)).toEqual(["r2"]);
  });
});
