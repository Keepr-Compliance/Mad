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
  reason: "open" | "background" | "contact-change";
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
