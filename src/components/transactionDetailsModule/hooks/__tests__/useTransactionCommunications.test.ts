/**
 * Tests for useTransactionCommunications hook (BACKLOG-1765)
 * Verifies that onSuccess is called after a successful unlink so the caller
 * can trigger a full refetch (which removes thread siblings from the UI).
 */

import { renderHook, act } from "@testing-library/react";
import { useTransactionCommunications } from "../useTransactionCommunications";
import type { Communication } from "../../types";

// Minimal Communication shape needed for the hook
const makeComm = (overrides: Partial<Communication> = {}): Communication =>
  ({
    id: "comm-123",
    user_id: "user-1",
    channel: "email",
    subject: "Test email",
    sent_at: "2024-01-01T00:00:00Z",
    has_attachments: false,
    is_false_positive: false,
    communication_id: "comm-123",
    ...overrides,
  } as Communication);

beforeAll(() => {
  // unlinkCommunication is not in the shared test setup; add it here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window.api.transactions as any).unlinkCommunication = jest.fn();
});

beforeEach(() => {
  jest.clearAllMocks();
  // Default: unlinkCommunication resolves successfully
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ((window.api.transactions as any).unlinkCommunication as jest.Mock).mockResolvedValue({
    success: true,
  });
});

describe("useTransactionCommunications", () => {
  describe("handleUnlinkCommunication", () => {
    it("calls onSuccess after a successful unlink (BACKLOG-1765)", async () => {
      const { result } = renderHook(() => useTransactionCommunications());
      const onSuccess = jest.fn();
      const onError = jest.fn();

      await act(async () => {
        await result.current.handleUnlinkCommunication(makeComm(), onSuccess, onError);
      });

      expect(onSuccess).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();
    });

    it("calls onError with the generic message for an unknown/transient failure", async () => {
      // A non-freeze failure (e.g. a DB error) should keep the generic retry
      // message — retrying such a failure may legitimately succeed.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ((window.api.transactions as any).unlinkCommunication as jest.Mock).mockResolvedValue({
        success: false,
        error: "Database error",
      });

      const { result } = renderHook(() => useTransactionCommunications());
      const onSuccess = jest.fn();
      const onError = jest.fn();

      await act(async () => {
        await result.current.handleUnlinkCommunication(makeComm(), onSuccess, onError);
      });

      expect(onSuccess).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith("Failed to unlink email. Please try again.");
    });

    // BACKLOG-2013 (founder QA): unlinking an email from a frozen (exported)
    // transaction is correctly blocked by the freeze policy. The UI must show
    // the freeze EXPLANATION, not the generic "Please try again." — a retry can
    // never succeed. The freeze message reaches the renderer as result.error
    // (failed IPC result) or, defensively, as a thrown Error.
    const FREEZE_MESSAGE =
      "Transaction is frozen after export — linked communications and parties are add-only and cannot be removed. An admin unfreeze is required.";

    it("surfaces the freeze explanation when the unlink result reports a freeze block", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ((window.api.transactions as any).unlinkCommunication as jest.Mock).mockResolvedValue({
        success: false,
        error: FREEZE_MESSAGE,
      });

      const { result } = renderHook(() => useTransactionCommunications());
      const onSuccess = jest.fn();
      const onError = jest.fn();

      await act(async () => {
        await result.current.handleUnlinkCommunication(makeComm(), onSuccess, onError);
      });

      expect(onSuccess).not.toHaveBeenCalled();
      // Identity assertion on the message content, not just "onError was called".
      expect(onError).toHaveBeenCalledWith(FREEZE_MESSAGE);
      expect(onError).not.toHaveBeenCalledWith(
        "Failed to unlink email. Please try again.",
      );
    });

    it("surfaces the freeze explanation when the unlink call throws a freeze error", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ((window.api.transactions as any).unlinkCommunication as jest.Mock).mockRejectedValue(
        new Error(FREEZE_MESSAGE),
      );

      const { result } = renderHook(() => useTransactionCommunications());
      const onSuccess = jest.fn();
      const onError = jest.fn();

      await act(async () => {
        await result.current.handleUnlinkCommunication(makeComm(), onSuccess, onError);
      });

      expect(onSuccess).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(FREEZE_MESSAGE);
    });

    it("clears unlinkingCommId after completion", async () => {
      const { result } = renderHook(() => useTransactionCommunications());

      await act(async () => {
        await result.current.handleUnlinkCommunication(makeComm(), jest.fn(), jest.fn());
      });

      expect(result.current.unlinkingCommId).toBeNull();
    });
  });
});
