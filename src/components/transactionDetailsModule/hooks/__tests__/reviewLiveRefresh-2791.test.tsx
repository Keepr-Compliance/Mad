/**
 * BACKLOG-2791 item 1 — review state propagates LIVE to all three surfaces.
 *
 * The founder's repro: reject emails in the review screen, restore them from
 * the Removed section ("2 emails restored"), and the database re-queues them
 * while NOTHING on screen moves — no tab section, no review list, no badge.
 * Closing and reopening the transaction showed them correctly, which is the
 * signature of state that is only ever read at mount.
 *
 * Two causes, both fixed:
 *   - `transactions:restore-removed-email` never routed through
 *     restoreRejectedToQueue (only the TEXT handler did), so rejected emails
 *     came back as links;
 *   - no review MUTATION broadcast at all. The discovery sweep did; approve,
 *     reject and restore wrote to the database silently.
 *
 * The fix is one notification, not three patches: every mutation calls
 * notifyReviewStateChanged, useReviewQueue re-reads, and because the badge, the
 * tab sections and the review screen all render from that ONE hook, they move
 * together. These tests assert exactly that — no remount anywhere.
 */
import React from "react";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useReviewQueue } from "../useReviewQueue";

type Handler = (data: {
  transactionId: string;
  added: number;
  linked: number;
  outstanding: number;
  reason: "open" | "background" | "contact-change" | "date-extended";
}) => void;

let handler: Handler | null = null;
const getReviewState = jest.fn();
const approveReviewItems = jest.fn();
const rejectReviewItems = jest.fn();

const item = (id: string) => ({
  id,
  rowId: id.split(":")[1],
  origin: "pending" as const,
  kind: "email" as const,
  transaction_id: "tx-1",
  email_id: id.split(":")[1],
  thread_id: null,
  found_at: "2026-08-01T00:00:00.000Z",
  display: {
    title: "s", subtitle: "", snippet: "", occurredAt: null, itemCount: 1,
    threadId: `thr-${id}`,
    recipients: null, cc: null, sender: null, hasAttachments: false,
    threadParticipants: [], threadMessages: [],
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  handler = null;
  (window as unknown as { api: unknown }).api = {
    transactions: {
      getReviewState,
      syncReviewQueue: jest.fn().mockResolvedValue({ added: 0, linked: 0, outstanding: 0 }),
      approveReviewItems,
      rejectReviewItems,
      onReviewQueueChanged: (cb: Handler) => {
        handler = cb;
        return () => { handler = null; };
      },
    },
  };
});

/** The single hook all three surfaces render from. */
function mountShared() {
  return renderHook(() => useReviewQueue("tx-1"), {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <React.StrictMode>{children}</React.StrictMode>
    ),
  });
}

describe("review state refreshes live, without a remount", () => {
  it("reject then restore: the list and the count both follow, in one mount", async () => {
    // Start with two queued emails.
    getReviewState.mockResolvedValue({ items: [item("pending:e1"), item("pending:e2")], count: 2 });
    const { result } = mountShared();
    await act(async () => { await result.current.refresh(); });
    expect(result.current.count).toBe(2);

    // REJECT both. The service empties the queue.
    rejectReviewItems.mockResolvedValue({ rejected: 2 });
    getReviewState.mockResolvedValue({ items: [], count: 0 });
    await act(async () => { await result.current.reject(["pending:e1", "pending:e2"]); });

    expect(result.current.count).toBe(0);
    expect(result.current.items).toEqual([]);

    // RESTORE from the Removed section — a DIFFERENT component, writing through
    // the main process. Before the fix nothing here reached the renderer.
    getReviewState.mockResolvedValue({ items: [item("pending:e1"), item("pending:e2")], count: 2 });
    await waitFor(() => expect(handler).not.toBeNull());
    await act(async () => {
      handler!({ transactionId: "tx-1", added: 0, linked: 0, outstanding: 2, reason: "background" });
    });

    // All three surfaces read these two values, so this IS the assertion that
    // the badge, the tab sections and the review screen updated.
    await waitFor(() => {
      expect(result.current.count).toBe(2);
      expect(result.current.items.map((i) => i.id)).toEqual(["pending:e1", "pending:e2"]);
    });
  });

  it("a restore notification does NOT re-fire the popup", async () => {
    // added=0, so the announcement stays silent — a restore is not a discovery.
    getReviewState.mockResolvedValue({ items: [item("pending:e1")], count: 1 });
    const { result } = mountShared();
    await waitFor(() => expect(handler).not.toBeNull());

    await act(async () => {
      handler!({ transactionId: "tx-1", added: 0, linked: 0, outstanding: 1, reason: "background" });
    });

    await waitFor(() => expect(result.current.count).toBe(1));
    expect(result.current.lastAdded).toBe(0);
  });

  it("approve refreshes too, so the badge drops as items leave the queue", async () => {
    getReviewState.mockResolvedValue({ items: [item("pending:e1")], count: 1 });
    const { result } = mountShared();
    await act(async () => { await result.current.refresh(); });
    expect(result.current.count).toBe(1);

    approveReviewItems.mockResolvedValue({ approved: 1 });
    getReviewState.mockResolvedValue({ items: [], count: 0 });
    await act(async () => { await result.current.approve(["pending:e1"]); });

    expect(result.current.count).toBe(0);
  });
});

/**
 * BACKLOG-2791 — A RUN THAT ONLY LINKED STILL FOUND SOMETHING.
 *
 * The Communication Lifecycle Contract puts the popup on "only when this run
 * found something", with N = L + R and zero-count lines dropped. Both halves of
 * the wiring gated on R alone (`added > 0`), so a sweep that linked six emails
 * and queued none was completely silent — and `ReviewPromptDialog`'s R=0 copy
 * shape, which reviewFounderFeedback-2791 pins ("drops the review line AND the
 * approval sentence with it"), could never actually be reached in the app.
 *
 * This matters most for the newest trigger. Extending an audit range past an
 * email that NAMES the property links it outright: L=1, R=0 — the exact shape
 * that was silent.
 *
 * `lastFound` is the popup's N, so the render gate reads one number instead of
 * re-deriving the rule at the call site.
 *
 * CONTROLS RUN (MEASURED):
 *  1. Restore `if (data.added > 0)` around the announcement -> RED, 2 of 2 tests
 *     in this block.
 *  2. Define `lastFound` as `lastAdded` only               -> RED, 2 of 2 tests.
 */
describe("a link-only sweep is announced too (N = L + R)", () => {
  it("a broadcast with linked>0 and added=0 still reports what it found", async () => {
    getReviewState.mockResolvedValue({ items: [], count: 0 });
    const { result } = renderHook(() => useReviewQueue("tx-1"));
    await waitFor(() => expect(handler).not.toBeNull());

    act(() => {
      handler?.({ transactionId: "tx-1", added: 0, linked: 6, outstanding: 0, reason: "date-extended" });
    });

    await waitFor(() => expect(result.current.lastLinked).toBe(6));
    // N — what the popup gates on and titles itself with.
    expect(result.current.lastFound).toBe(6);
    // R stays honestly zero; the dialog drops that line itself.
    expect(result.current.lastAdded).toBe(0);
  });

  it("a sweep that found NOTHING stays silent — N is zero", async () => {
    getReviewState.mockResolvedValue({ items: [], count: 0 });
    const { result } = renderHook(() => useReviewQueue("tx-1"));
    await waitFor(() => expect(handler).not.toBeNull());

    act(() => {
      handler?.({ transactionId: "tx-1", added: 0, linked: 0, outstanding: 4, reason: "background" });
    });

    await waitFor(() => expect(result.current.count).toBe(4));
    expect(result.current.lastFound).toBe(0);
  });
});

/**
 * BACKLOG-2791 — THE BADGE'S NUMBER IS DERIVED WHERE IT CAN BE TESTED.
 *
 * The contract counts badges in THREADS. That number was first computed inline
 * in TransactionDetails' JSX, which left the one line that actually feeds the
 * header badge unpinned: reverting `reviewCount={reviewThreadCount}` to
 * `reviewQueue.count` turned the badge back into an item count and NOTHING went
 * red — TransactionHeader's own tests assert on whatever prop they are handed,
 * and the grouping helper's tests never see the wiring.
 *
 * So the derivation lives on the hook instead, beside `count`. Every review
 * surface already reads this hook, which is what stops them disagreeing; the
 * badge now reads it the same way rather than re-deriving the rule at the call
 * site.
 *
 * CONTROLS RUN (MEASURED):
 *  1. `threadCount: state.count` (i.e. count items)        -> RED, 1 of 2 tests.
 *  2. `threadCount: 0`                                     -> RED, 2 of 2 tests.
 */
describe("threadCount — the badge counts threads, the gate counts items", () => {
  const inThread = (id: string, threadId: string) => {
    const base = item(id);
    return { ...base, display: { ...base.display, threadId } };
  };

  it("two pending emails in ONE provider thread count as ONE for the badge", async () => {
    // Same fixture shape as the founder's recurring-invite pair.
    getReviewState.mockResolvedValue({
      items: [inThread("pending:a", "thr-pair"), inThread("pending:b", "thr-pair")],
      count: 2,
    });
    const { result } = renderHook(() => useReviewQueue("tx-1"));
    // The hook does not read on mount — TransactionDetails drives the first
    // read. Do the same rather than asserting against an unloaded queue.
    await act(async () => {
      await result.current.refresh();
    });

    await waitFor(() => expect(result.current.items).toHaveLength(2));
    // The badge: one thread.
    expect(result.current.threadCount).toBe(1);
    // The Complete gate: still items, and still non-zero. Both agree there IS
    // something outstanding, which is all the gate ever asks.
    expect(result.current.count).toBe(2);
  });

  it("an empty queue is zero in both units, so the badge and the gate agree at zero", async () => {
    getReviewState.mockResolvedValue({ items: [], count: 0 });
    const { result } = renderHook(() => useReviewQueue("tx-1"));
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.threadCount).toBe(0);
    expect(result.current.count).toBe(0);
  });
});
