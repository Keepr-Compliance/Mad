/**
 * BACKLOG-3339 slice 1 — single-deal delete from the detail view.
 *
 * Since 3339 the delete handler can refuse a delete (its audit record could
 * not be saved) and reports that as `{ success: false, error }`; it does not
 * throw. The renderer service used to drop that result and the view closed as
 * if the deal were gone. And a second click on the confirm button while the
 * first delete is in flight would reach a deal that is already gone, so the
 * user saw "This deal no longer exists." after a successful delete.
 *
 * Harness and mocks transcribed from
 * TransactionDetails.mergedUnlinkFailure-3309.test.tsx. The header shows its
 * Delete button for a rejected detection (TransactionHeader RejectedActions).
 */
import React from "react";
import { render as rtlRender, screen, waitFor, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { NotificationProvider } from "../../contexts/NotificationContext";
import TransactionDetails from "../TransactionDetails";
import type { Transaction } from "../../types";

const render = (
  ui: Parameters<typeof rtlRender>[0],
  options?: Parameters<typeof rtlRender>[1],
) => rtlRender(ui, { wrapper: NotificationProvider, ...options });

jest.mock("../../contexts/LicenseContext", () => ({
  useLicense: () => ({
    licenseType: "team" as const,
    hasAIAddon: true,
    organizationId: "org-123",
    canExport: false,
    canSubmit: true,
    canAutoDetect: true,
    isLoading: false,
    refresh: jest.fn(),
  }),
}));

jest.mock("../../contexts/AuthContext", () => ({
  useAuth: () => ({
    currentUser: { id: "user-456", email: "test@test.com" },
    isAuthenticated: true,
  }),
  useIsAuthenticated: () => true,
  useCurrentUser: () => ({ id: "user-456", email: "test@test.com" }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock("../../contexts/NetworkContext", () => ({
  useNetwork: () => ({
    isOnline: true,
    isChecking: false,
    lastOnlineAt: null,
    lastOfflineAt: null,
    connectionError: null,
    checkConnection: jest.fn(),
    clearError: jest.fn(),
    setConnectionError: jest.fn(),
  }),
}));

jest.mock("../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: () => ({ isRunning: false }),
}));

const baseTransaction = {
  id: "txn-123",
  user_id: "user-456",
  property_address: "123 Main Street",
  transaction_type: "purchase",
  status: "active" as const,
  detection_status: "rejected" as const,
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  // Partial fixture: this suite exercises only the delete path.
} as unknown as Transaction;

describe("BACKLOG-3339 single-deal delete", () => {
  const deleteMock = () => jest.mocked(window.api.transactions.delete);

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(window.api.transactions.getAllAttachments).mockResolvedValue({
      success: true,
      data: [],
    });
    jest.mocked(window.api.transactions.getDetails).mockResolvedValue({
      success: true,
      transaction: { ...baseTransaction, communications: [], contact_assignments: [] },
    });
    jest.mocked(window.api.contacts.getAll).mockResolvedValue({ success: true, contacts: [] });
  });

  async function openConfirm(onClose: jest.Mock): Promise<HTMLElement> {
    render(<TransactionDetails transaction={baseTransaction} onClose={onClose} />);
    await waitFor(() => expect(window.api.transactions.getDetails).toHaveBeenCalled());
    // The header and the details tab each have a Delete button; both open
    // the same confirm.
    const [deleteButton] = await screen.findAllByRole("button", { name: "Delete" });
    await userEvent.click(deleteButton);
    return screen.findByTestId("delete-transaction-confirm");
  }

  it("a refused delete keeps the view open, closes the confirm and shows the error", async () => {
    deleteMock().mockResolvedValue({ success: false, error: "X refused delete" });
    const onClose = jest.fn();
    await userEvent.click(await openConfirm(onClose));

    expect(await screen.findByText("X refused delete")).toBeInTheDocument();
    expect(deleteMock()).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("delete-transaction-confirm")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a successful delete closes the view", async () => {
    deleteMock().mockResolvedValue({ success: true });
    const onClose = jest.fn();
    await userEvent.click(await openConfirm(onClose));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("two clicks on confirm before the first delete returns send one delete", async () => {
    let resolveDelete: (v: { success: boolean }) => void = () => {};
    deleteMock().mockImplementation(
      () => new Promise((resolve) => { resolveDelete = resolve; }),
    );
    const onClose = jest.fn();
    const confirm = await openConfirm(onClose);

    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await userEvent.click(confirm);
    expect(deleteMock()).toHaveBeenCalledTimes(1);

    await act(async () => { resolveDelete({ success: true }); });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(deleteMock()).toHaveBeenCalledTimes(1);
  });
});
