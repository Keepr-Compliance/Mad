/**
 * BACKLOG-3965 PR-2: TransactionDetails records the open of a deal — once per
 * open, on the open itself, never while pending review — and a failing record
 * never stops the deal from opening.
 *
 * Harness and mocks transcribed from TransactionDetails.openTransaction-4065.test.tsx.
 *
 * Wrong builds caught: the write removed; written on every render or twice per
 * open (StrictMode); moved into the tab effect; recorded for a pending-review
 * deal; keyed on [] so a different deal in the same mount is never recorded;
 * an unguarded bridge call that breaks the mount when it rejects (probe P1).
 */
import React from "react";
import { render as rtlRender, waitFor, fireEvent, screen } from "@testing-library/react";
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

// pii-allow-uuid: invented, not from any live row
const TXN_ID = "00000000-0000-4000-8000-000000003965";
// pii-allow-uuid: invented, not from any live row
const OTHER_ID = "00000000-0000-4000-8000-000000003966";
const ADDRESS = "742 Evergreen Terrace, Springfield, IL 62704";

function deal(id: string): Transaction {
  return {
    id,
    user_id: "user-456",
    property_address: ADDRESS,
    transaction_type: "purchase",
    status: "active" as const,
    detection_status: "confirmed" as const,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    // Partial fixture: this suite exercises mount, re-render and tab change only.
  } as unknown as Transaction;
}

const recordOpen = () => jest.mocked(window.api.transactions.recordOpen);

describe("BACKLOG-3965 TransactionDetails records the open", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    recordOpen().mockResolvedValue({ success: true, recorded: true });
    jest.mocked(window.api.transactions.getAllAttachments).mockResolvedValue({ success: true, data: [] });
    jest.mocked(window.api.transactions.getDetails).mockImplementation(async (id: string) => ({
      success: true,
      transaction: { ...deal(id), communications: [], contact_assignments: [] },
    }));
    jest.mocked(window.api.contacts.getAll).mockResolvedValue({ success: true, contacts: [] });
  });

  it("records once, with the deal id, when the deal opens", async () => {
    render(<TransactionDetails transaction={deal(TXN_ID)} onClose={jest.fn()} />);
    await waitFor(() => expect(window.api.transactions.getDetails).toHaveBeenCalled());
    expect(recordOpen()).toHaveBeenCalledTimes(1);
    expect(recordOpen()).toHaveBeenCalledWith(TXN_ID);
  });

  it("records once under StrictMode (the effect runs twice; the write does not)", async () => {
    render(
      <React.StrictMode>
        <TransactionDetails transaction={deal(TXN_ID)} onClose={jest.fn()} />
      </React.StrictMode>,
    );
    await waitFor(() => expect(window.api.transactions.getDetails).toHaveBeenCalled());
    expect(recordOpen()).toHaveBeenCalledTimes(1);
  });

  it("a re-render with the same deal and a tab change write nothing more", async () => {
    const { rerender } = render(<TransactionDetails transaction={deal(TXN_ID)} onClose={jest.fn()} />);
    await waitFor(() => expect(window.api.transactions.getDetails).toHaveBeenCalled());
    rerender(<TransactionDetails transaction={deal(TXN_ID)} onClose={jest.fn()} />);
    fireEvent.click(screen.getByTestId("tab-attachments"));
    await waitFor(() => expect(window.api.transactions.getAllAttachments).toHaveBeenCalled());
    expect(recordOpen()).toHaveBeenCalledTimes(1);
  });

  it("a different deal in the same mount is recorded too", async () => {
    const { rerender } = render(<TransactionDetails transaction={deal(TXN_ID)} onClose={jest.fn()} />);
    await waitFor(() => expect(recordOpen()).toHaveBeenCalledTimes(1));
    rerender(<TransactionDetails transaction={deal(OTHER_ID)} onClose={jest.fn()} />);
    await waitFor(() => expect(recordOpen()).toHaveBeenCalledTimes(2));
    expect(recordOpen()).toHaveBeenLastCalledWith(OTHER_ID);
  });

  it("a deal pending review is not recorded", async () => {
    render(<TransactionDetails transaction={deal(TXN_ID)} onClose={jest.fn()} isPendingReview />);
    await waitFor(() => expect(window.api.transactions.getDetails).toHaveBeenCalled());
    expect(recordOpen()).not.toHaveBeenCalled();
  });

  it("C12: the record rejecting leaves the deal open and shows no error", async () => {
    recordOpen().mockRejectedValue(new Error("ipc channel closed"));
    const onShowError = jest.fn();
    render(<TransactionDetails transaction={deal(TXN_ID)} onClose={jest.fn()} onShowError={onShowError} />);
    await waitFor(() => expect(recordOpen()).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(window.api.transactions.getDetails).toHaveBeenCalled());
    expect(screen.getAllByText(ADDRESS).length).toBeGreaterThan(0);
    expect(screen.getByTestId("tab-attachments")).toBeInTheDocument();
    expect(onShowError).not.toHaveBeenCalled();
  });
});
