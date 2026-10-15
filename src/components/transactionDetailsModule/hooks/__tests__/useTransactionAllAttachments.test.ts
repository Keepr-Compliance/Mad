/**
 * BACKLOG-322 Phase A — tests for useTransactionAllAttachments.
 *
 * Proves the mount-load AND the refetch mechanism (refresh()) the Attachments
 * tab relies on to reflect newly-attached comms without a manual reload.
 */
import { renderHook, waitFor, act } from "@testing-library/react";
import { useTransactionAllAttachments } from "../useTransactionAllAttachments";

const getAllAttachments = window.api.transactions
  .getAllAttachments as jest.Mock;

describe("useTransactionAllAttachments", () => {
  beforeEach(() => {
    getAllAttachments.mockReset();
    getAllAttachments.mockResolvedValue({ success: true, data: [] });
  });

  it("loads attachments once on mount, scoped to the transaction", async () => {
    const { result } = renderHook(() => useTransactionAllAttachments("txn-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(getAllAttachments).toHaveBeenCalledTimes(1);
    expect(getAllAttachments).toHaveBeenCalledWith("txn-1", undefined, undefined);
  });

  it("refresh() refetches from the IPC (the auto-refresh-after-attach hook point)", async () => {
    const { result } = renderHook(() => useTransactionAllAttachments("txn-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getAllAttachments).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.refresh();
    });

    expect(getAllAttachments).toHaveBeenCalledTimes(2);
  });

  it("exposes the returned rows and count", async () => {
    getAllAttachments.mockResolvedValue({
      success: true,
      data: [
        { id: "a1", filename: "a.pdf", mime_type: "application/pdf", file_size_bytes: 1, storage_path: "/x", created_at: null, source: "email", source_date: null, direction: null, context_subject: "S", context_sender: null, email_id: "E1", message_id: null },
        { id: "a2", filename: "b.jpg", mime_type: "image/jpeg", file_size_bytes: 2, storage_path: null, created_at: null, source: "text", source_date: null, direction: null, context_subject: null, context_sender: "+1", email_id: null, message_id: "M1" },
      ],
    });
    const { result } = renderHook(() => useTransactionAllAttachments("txn-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.count).toBe(2);
    expect(result.current.attachments.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(result.current.error).toBeNull();
  });

  it("surfaces an error when the IPC reports failure", async () => {
    getAllAttachments.mockResolvedValue({ success: false, error: "boom" });
    const { result } = renderHook(() => useTransactionAllAttachments("txn-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe("boom");
    expect(result.current.attachments).toEqual([]);
  });

  it("does not call the IPC when there is no transaction id", async () => {
    const { result } = renderHook(() => useTransactionAllAttachments(""));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getAllAttachments).not.toHaveBeenCalled();
  });

  /**
   * BACKLOG-3730 — in-window membership comes from main (the submit's window),
   * never from the renderer comparing dates. The fixture is chosen so a
   * renderer-side date compare gets BOTH rows wrong: "late" is dated after the
   * closing day's UTC midnight yet main (local-midnight closing day) keeps it;
   * "early" is dated inside the naive range yet main left it out.
   */
  describe("transaction date window (BACKLOG-3730)", () => {
    const row = (id: string, source_date: string) => ({
      id, filename: `${id}.pdf`, mime_type: "application/pdf", file_size_bytes: 1, storage_path: "/x",
      created_at: null, source: "email", source_date, direction: null, context_subject: null,
      context_sender: null, email_id: "E", message_id: null,
    });
    const LATE = row("late", "2026-07-30T03:00:00.000Z");
    const EARLY = row("early", "2026-03-01T00:00:00.000Z");

    it("W1: fetches the window with the RAW dates and takes membership from main's answer", async () => {
      getAllAttachments.mockImplementation((_id: string, start?: string) =>
        Promise.resolve({ success: true, data: start ? [LATE] : [LATE, EARLY] }),
      );
      const { result } = renderHook(() =>
        useTransactionAllAttachments("txn-1", undefined, undefined, {
          startedAt: "2026-01-01",
          closedAt: "2026-07-29",
        }),
      );
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(getAllAttachments).toHaveBeenCalledWith("txn-1", undefined, undefined);
      expect(getAllAttachments).toHaveBeenCalledWith("txn-1", "2026-01-01", "2026-07-29");
      expect(result.current.attachments.map((a) => a.id)).toEqual(["late", "early"]);
      expect([...(result.current.inWindowIds ?? [])]).toEqual(["late"]);
    });

    it("W2: no dates → one fetch, inWindowIds null (nothing to scope to)", async () => {
      const { result } = renderHook(() =>
        useTransactionAllAttachments("txn-1", undefined, undefined, { startedAt: null, closedAt: null }),
      );
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(getAllAttachments).toHaveBeenCalledTimes(1);
      expect(result.current.inWindowIds).toBeNull();
    });

    it("W3: refresh() refetches both lists", async () => {
      const { result } = renderHook(() =>
        useTransactionAllAttachments("txn-1", undefined, undefined, { startedAt: "2026-01-01", closedAt: null }),
      );
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(getAllAttachments).toHaveBeenCalledTimes(2);
      await act(async () => {
        await result.current.refresh();
      });
      expect(getAllAttachments).toHaveBeenCalledTimes(4);
    });
  });
});

describe("useTransactionAllAttachments — enabled (BACKLOG-3884)", () => {
  beforeEach(() => {
    getAllAttachments.mockReset();
    getAllAttachments.mockResolvedValue({ success: true, data: [] });
  });

  it("fetches nothing while disabled, refresh() is a no-op, and enabling loads", async () => {
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useTransactionAllAttachments("txn-1", undefined, undefined, { enabled }),
      { initialProps: { enabled: false } },
    );
    await act(async () => {
      await result.current.refresh();
    });
    expect(getAllAttachments).toHaveBeenCalledTimes(0);

    rerender({ enabled: true });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getAllAttachments).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.refresh();
    });
    expect(getAllAttachments).toHaveBeenCalledTimes(2);
  });
});
