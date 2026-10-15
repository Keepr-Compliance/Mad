/**
 * BACKLOG-3828 — bulk export (transactions list) tells the user exported files
 * aren't encrypted, with a "Learn more" dialog holding the full approved text.
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { renderHook, act } from "@testing-library/react";
import { BulkExportNotice } from "../BulkExportNotice";
import { useBulkActions } from "../../transaction/hooks/useBulkActions";

const TITLE = "Exported files aren't encrypted";
const BODY =
  "Your audit was saved as regular files so you can open it. Keepr's encryption protects your data inside Keepr only — it doesn't apply to exported files. We recommend keeping your records in Keepr rather than storing exported copies on this computer. You're responsible for how exported files are stored, shared and deleted.";

describe("BulkExportNotice", () => {
  it("shows the short line, and the full text only after Learn more", () => {
    render(<BulkExportNotice onDismiss={jest.fn()} />);
    expect(screen.getByText(TITLE)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /learn more/i }));
    expect(screen.getByRole("dialog")).toHaveTextContent(BODY);
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Dismiss calls onDismiss", () => {
    const onDismiss = jest.fn();
    render(<BulkExportNotice onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("useBulkActions.bulkExportNotice", () => {
  const exportEnhancedMock = window.api.transactions.exportEnhanced as jest.Mock;
  const getReviewStateMock = window.api.transactions.getReviewState as jest.Mock;
  const callbacks = () => ({
    onComplete: jest.fn().mockResolvedValue(undefined),
    showError: jest.fn(),
    exitSelectionMode: jest.fn(),
    closeBulkDeleteModal: jest.fn(),
    closeBulkExportModal: jest.fn(),
    labelForTransaction: (id: string) => id,
  });
  beforeEach(() => {
    jest.clearAllMocks();
    getReviewStateMock.mockResolvedValue({ items: [], count: 0 });
  });

  it("is set after a successful bulk export and cleared by dismiss", async () => {
    exportEnhancedMock.mockResolvedValue({ success: true, path: "/out/x" });
    const { result } = renderHook(() => useBulkActions(new Set(["a", "b"]), 2, callbacks()));
    expect(result.current.bulkExportNotice).toBe(false);
    await act(async () => {
      await result.current.handleBulkExport("pdf");
    });
    expect(result.current.bulkExportNotice).toBe(true);
    act(() => result.current.dismissBulkExportNotice());
    expect(result.current.bulkExportNotice).toBe(false);
  });

  it("is not set when every export fails", async () => {
    exportEnhancedMock.mockResolvedValue({ success: false, error: "disk full" });
    const cb = callbacks();
    const { result } = renderHook(() => useBulkActions(new Set(["a"]), 1, cb));
    await act(async () => {
      await result.current.handleBulkExport("pdf");
    });
    expect(result.current.bulkExportNotice).toBe(false);
    expect(cb.showError).toHaveBeenCalled();
  });
});
