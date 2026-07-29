/**
 * BACKLOG-322 Phase A (founder change #3) — the Attachments tab must reflect
 * newly attached emails/texts WITHOUT a manual reload.
 *
 * TransactionDetails wires the unified-attachments `refresh()` into the SAME
 * callbacks the Emails/Texts tabs already fire when a comm is attached
 * (`onEmailsChanged` / `onMessagesChanged`). These tests stub those tabs to fire
 * the callback and assert the unified query (`getAllAttachments`) refetches.
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import TransactionDetails from "../TransactionDetails";

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

// Stub the Emails / Texts tabs so we can fire their "changed" callbacks directly.
/* eslint-disable @typescript-eslint/no-explicit-any */
jest.mock("../transactionDetailsModule/components/TransactionEmailsTab", () => ({
  TransactionEmailsTab: (props: any) => (
    <button data-testid="fire-emails-changed" onClick={() => props.onEmailsChanged?.()}>
      emails
    </button>
  ),
}));
jest.mock("../transactionDetailsModule/components/TransactionMessagesTab", () => ({
  TransactionMessagesTab: (props: any) => (
    <button data-testid="fire-messages-changed" onClick={() => props.onMessagesChanged?.()}>
      messages
    </button>
  ),
}));
/* eslint-enable @typescript-eslint/no-explicit-any */

const getAllAttachments = window.api.transactions.getAllAttachments as jest.Mock;

const baseTransaction = {
  id: "txn-123",
  user_id: "user-456",
  property_address: "123 Main Street",
  transaction_type: "purchase",
  status: "active" as const,
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
};

describe("TransactionDetails — attachments auto-refresh (BACKLOG-322 #3)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getAllAttachments.mockResolvedValue({ success: true, data: [] });
    window.api.transactions.getDetails.mockResolvedValue({
      success: true,
      transaction: { ...baseTransaction, communications: [], contact_assignments: [] },
    });
    window.api.contacts.getAll.mockResolvedValue({ success: true, contacts: [] });
  });

  it("refetches attachments after an email is attached (onEmailsChanged)", async () => {
    render(
      <TransactionDetails transaction={baseTransaction} onClose={jest.fn()} onTransactionUpdated={jest.fn()} />,
    );

    // Mount load of the unified attachments.
    await waitFor(() => expect(getAllAttachments).toHaveBeenCalled());
    const before = getAllAttachments.mock.calls.length;

    // Open the Emails tab (renders the stub), then fire onEmailsChanged.
    await userEvent.click(screen.getByText("Emails"));
    await userEvent.click(await screen.findByTestId("fire-emails-changed"));

    await waitFor(() =>
      expect(getAllAttachments.mock.calls.length).toBeGreaterThan(before),
    );
  });

  it("refetches attachments after a text is attached (onMessagesChanged)", async () => {
    render(
      <TransactionDetails transaction={baseTransaction} onClose={jest.fn()} onTransactionUpdated={jest.fn()} />,
    );

    await waitFor(() => expect(getAllAttachments).toHaveBeenCalled());
    const before = getAllAttachments.mock.calls.length;

    await userEvent.click(screen.getByText("Texts"));
    await userEvent.click(await screen.findByTestId("fire-messages-changed"));

    await waitFor(() =>
      expect(getAllAttachments.mock.calls.length).toBeGreaterThan(before),
    );
  });
});
