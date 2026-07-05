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

    it("calls onError and not onSuccess when unlink returns failure", async () => {
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

    it("clears unlinkingCommId after completion", async () => {
      const { result } = renderHook(() => useTransactionCommunications());

      await act(async () => {
        await result.current.handleUnlinkCommunication(makeComm(), jest.fn(), jest.fn());
      });

      expect(result.current.unlinkingCommId).toBeNull();
    });
  });
});
