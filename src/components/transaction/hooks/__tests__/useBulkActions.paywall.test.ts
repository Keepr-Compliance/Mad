/**
 * Unit tests for useBulkActions.handleBulkExport paywall handling (BACKLOG-2075).
 *
 * A locked transaction in the bulk loop must be counted SEPARATELY from generic
 * failures (never storm the user with per-tx unlock modals): export the unlocked
 * ones and report "N locked — unlock to include".
 */

import { renderHook, act } from "@testing-library/react";
import { useBulkActions } from "../useBulkActions";

const exportEnhancedMock = window.api.transactions.exportEnhanced as jest.Mock;

const makeCallbacks = () => ({
  onComplete: jest.fn().mockResolvedValue(undefined),
  showError: jest.fn(),
  exitSelectionMode: jest.fn(),
  closeBulkDeleteModal: jest.fn(),
  closeBulkExportModal: jest.fn(),
});

const PAYWALL = "PAYWALL_LOCKED: This transaction is locked. Unlock it to export.";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("handleBulkExport — locked transactions counted separately", () => {
  it("exports unlocked, reports locked count in the success message (not as a failure)", async () => {
    // tx-a unlocked (success), tx-b locked, tx-c locked.
    exportEnhancedMock.mockImplementation((id: string) =>
      Promise.resolve(
        id === "tx-a"
          ? { success: true, path: "/out/a" }
          : { success: false, error: PAYWALL },
      ),
    );
    const cb = makeCallbacks();
    const { result } = renderHook(() =>
      useBulkActions(new Set(["tx-a", "tx-b", "tx-c"]), 3, cb),
    );

    await act(async () => {
      await result.current.handleBulkExport("pdf");
    });

    // Success message includes the exported count AND the locked note — NOT "failed".
    const successCalls = (result.current as unknown as { bulkActionSuccess: string | null });
    // The message was set via showSuccessWithAutoClear (internal state).
    expect(result.current.bulkActionSuccess).toContain("Successfully exported 1 transaction");
    expect(result.current.bulkActionSuccess).toContain("2 locked — unlock to include");
    expect(result.current.bulkActionSuccess).not.toContain("failed");
    expect(cb.onComplete).toHaveBeenCalled();
    void successCalls;
  });

  it("all selected locked ⇒ shows a locked-specific error, not a generic failure", async () => {
    exportEnhancedMock.mockResolvedValue({ success: false, error: PAYWALL });
    const cb = makeCallbacks();
    const { result } = renderHook(() =>
      useBulkActions(new Set(["tx-b", "tx-c"]), 2, cb),
    );

    await act(async () => {
      await result.current.handleBulkExport("pdf");
    });

    expect(cb.showError).toHaveBeenCalledWith(
      expect.stringContaining("locked — unlock"),
    );
    // Not the generic message.
    expect(cb.showError).not.toHaveBeenCalledWith("Failed to export transactions");
  });

  it("separates a genuine failure from a locked one", async () => {
    exportEnhancedMock.mockImplementation((id: string) =>
      Promise.resolve(
        id === "tx-a"
          ? { success: true, path: "/out/a" }
          : id === "tx-b"
            ? { success: false, error: PAYWALL }
            : { success: false, error: "Disk full" },
      ),
    );
    const cb = makeCallbacks();
    const { result } = renderHook(() =>
      useBulkActions(new Set(["tx-a", "tx-b", "tx-c"]), 3, cb),
    );

    await act(async () => {
      await result.current.handleBulkExport("pdf");
    });

    expect(result.current.bulkActionSuccess).toContain("Successfully exported 1 transaction");
    expect(result.current.bulkActionSuccess).toContain("1 locked — unlock to include");
    expect(result.current.bulkActionSuccess).toContain("1 failed");
  });
});
