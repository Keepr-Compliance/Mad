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
});
