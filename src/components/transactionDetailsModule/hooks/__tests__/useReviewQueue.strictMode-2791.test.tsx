/**
 * BACKLOG-2791 — the popup must survive StrictMode's double-open, and a
 * main-process sync must reach the screen.
 *
 * StrictMode is ON (src/main.tsx), so the on-open effect fires TWICE per mount.
 * The FIRST sweep queues what it found and advances the watermark; the SECOND
 * correctly reports added=0, because nothing is new any more — that is the
 * service behaving properly, and the SR's service-level control pins it
 * (reviewStateService.strictMode-2791).
 *
 * The bug was in the renderer: `lastAdded` took the LATEST value, so the second
 * invocation reset it to 0 before paint and the popup never rendered. Dev-only —
 * which is exactly where the founder QAs, so test-plan step 1 ("popup announces
 * N") would have read as a failure on a feature that works.
 */
import React from "react";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useReviewQueue } from "../useReviewQueue";

type QueueChangedHandler = (data: {
  transactionId: string;
  added: number;
  outstanding: number;
  reason: "open" | "background" | "contact-change";
}) => void;

let queueChangedHandler: QueueChangedHandler | null = null;

const getReviewState = jest.fn();
const syncReviewQueue = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  queueChangedHandler = null;
  getReviewState.mockResolvedValue({ items: [], count: 0 });
  (window as unknown as { api: unknown }).api = {
    transactions: {
      getReviewState,
      syncReviewQueue,
      approveReviewItems: jest.fn(),
      rejectReviewItems: jest.fn(),
      onReviewQueueChanged: (cb: QueueChangedHandler) => {
        queueChangedHandler = cb;
        return () => {
          queueChangedHandler = null;
        };
      },
    },
  };
});

/** Mounts under StrictMode, so every effect really does double-invoke. */
function renderUnderStrictMode(transactionId: string) {
  return renderHook(() => useReviewQueue(transactionId), {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <React.StrictMode>{children}</React.StrictMode>
    ),
  });
}

describe("useReviewQueue under StrictMode", () => {
  it("keeps the announced count when the second open sync reports 0", async () => {
    // Exactly what the service does on a double open: the first run queues 2,
    // the second finds nothing new.
    syncReviewQueue
      .mockResolvedValueOnce({ added: 2, outstanding: 2 })
      .mockResolvedValueOnce({ added: 0, outstanding: 2 });

    const { result } = renderUnderStrictMode("tx-1");

    await act(async () => {
      await result.current.runSync("open");
      await result.current.runSync("open");
    });

    // The popup renders on lastAdded > 0. Taking the LATEST value made this 0.
    expect(result.current.lastAdded).toBe(2);
  });

  it("dismissal still clears it, so the popup does not come back", async () => {
    syncReviewQueue.mockResolvedValue({ added: 3, outstanding: 3 });
    const { result } = renderUnderStrictMode("tx-1");

    await act(async () => {
      await result.current.runSync("open");
    });
    expect(result.current.lastAdded).toBe(3);

    act(() => result.current.clearLastAdded());
    expect(result.current.lastAdded).toBe(0);

    // A later sweep that finds nothing must not resurrect the announcement.
    await act(async () => {
      await result.current.runSync("open");
    });
    syncReviewQueue.mockResolvedValue({ added: 0, outstanding: 3 });
    await act(async () => {
      await result.current.runSync("open");
    });
    expect(result.current.lastAdded).toBe(3);
  });

  it("a MAIN-PROCESS sync reaches the screen — the T2 contact-save path", async () => {
    // Before the broadcast existed, correcting a party's email queued items in
    // the database and the UI showed nothing until the next open.
    getReviewState.mockResolvedValue({ items: [], count: 4 });
    const { result } = renderUnderStrictMode("tx-1");

    await waitFor(() => expect(queueChangedHandler).not.toBeNull());

    await act(async () => {
      queueChangedHandler!({
        transactionId: "tx-1",
        added: 4,
        outstanding: 4,
        reason: "contact-change",
      });
    });

    await waitFor(() => {
      expect(result.current.lastAdded).toBe(4);
      expect(result.current.count).toBe(4);
    });
  });

  it("REJECTS on a cold read failure, so the Complete gate cannot read it as an empty queue", async () => {
    // The gate completes when count is 0. Swallowing the very first failure and
    // returning the initial EMPTY state told it "nothing to review" while the
    // database queue was full — the gate failing open on the one path it exists
    // to guard.
    getReviewState.mockRejectedValue(new Error("IPC down"));
    const { result } = renderUnderStrictMode("tx-1");

    await expect(result.current.refresh()).rejects.toThrow("IPC down");
  });

  it("falls back to the last GOOD state once one exists, rather than nagging", async () => {
    getReviewState.mockResolvedValueOnce({ items: [{ id: "pending:a" }], count: 1 });
    const { result } = renderUnderStrictMode("tx-1");

    await act(async () => {
      await result.current.refresh();
    });

    getReviewState.mockRejectedValue(new Error("transient"));
    await act(async () => {
      const next = await result.current.refresh();
      // Known-good state, NOT empty — a transient blip must not blank the queue
      // the user is looking at, and must not report it as reviewed.
      expect(next.count).toBe(1);
    });
  });

  it("ignores an event for a DIFFERENT transaction", async () => {
    const { result } = renderUnderStrictMode("tx-1");
    await waitFor(() => expect(queueChangedHandler).not.toBeNull());

    await act(async () => {
      queueChangedHandler!({
        transactionId: "tx-OTHER",
        added: 9,
        outstanding: 9,
        reason: "contact-change",
      });
    });

    expect(result.current.lastAdded).toBe(0);
    expect(result.current.count).toBe(0);
  });
});
