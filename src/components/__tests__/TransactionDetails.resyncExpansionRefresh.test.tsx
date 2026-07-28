/**
 * BACKLOG-2293 (SR review fix) — the in-transaction "Sync Messages" (re-sync)
 * action must refresh the message list AND toast the linked count even when the
 * per-contact auto-link linked 0 threads but attached-thread expansion linked
 * N > 0 (auto-link's date floor excludes older backfill).
 *
 * The OLD renderer gated `refreshMessages()` and the toast on
 * `totalMessagesLinked > 0`, so the expansion-only case fell through to
 * "No new messages found" and never refreshed — the just-linked messages did
 * not render until the user navigated away and back (indistinguishable from the
 * original bug). These tests must FAIL on that old gate.
 *
 * refreshMessages() → refreshAttachments() → window.api.transactions.getAllAttachments,
 * so a refetch of getAllAttachments after the sync click proves the refresh ran.
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

// Stub the Texts tab so we can fire its onSyncMessages (the "Sync Messages" action)
// directly without depending on the tab's internal markup.
/* eslint-disable @typescript-eslint/no-explicit-any */
jest.mock("../transactionDetailsModule/components/TransactionMessagesTab", () => ({
  TransactionMessagesTab: (props: any) => (
    <button data-testid="fire-sync-messages" onClick={() => props.onSyncMessages?.()}>
      sync
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

describe("TransactionDetails — re-sync refreshes on expansion-only link (BACKLOG-2293)", () => {
  let resyncAutoLink: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    getAllAttachments.mockResolvedValue({ success: true, data: [] });
    window.api.transactions.getDetails.mockResolvedValue({
      success: true,
      transaction: { ...baseTransaction, communications: [], contact_assignments: [] },
    });
    window.api.contacts.getAll.mockResolvedValue({ success: true, contacts: [] });

    // The scenario that broke: auto-link linked 0 threads, expansion linked 3.
    resyncAutoLink = jest.fn().mockResolvedValue({
      success: true,
      totalEmailsLinked: 0,
      totalMessagesLinked: 0,
      totalAlreadyLinked: 0,
      totalErrors: 0,
      attachedExpansionLinked: 3,
    });
    (window.api.transactions as unknown as { resyncAutoLink: jest.Mock }).resyncAutoLink =
      resyncAutoLink;
  });

  it("refreshes messages AND toasts the count when only expansion linked (fails on the old gate)", async () => {
    const showSuccess = jest.fn();
    render(
      <TransactionDetails
        transaction={baseTransaction}
        onClose={jest.fn()}
        onTransactionUpdated={jest.fn()}
        onShowSuccess={showSuccess}
      />,
    );

    await waitFor(() => expect(getAllAttachments).toHaveBeenCalled());
    const before = getAllAttachments.mock.calls.length;

    // Open the Texts tab (renders the stub), then fire the Sync Messages action.
    await userEvent.click(screen.getByText("Texts"));
    await userEvent.click(await screen.findByTestId("fire-sync-messages"));

    await waitFor(() => expect(resyncAutoLink).toHaveBeenCalledWith("txn-123"));

    // (1) Refresh ran even though totalMessagesLinked === 0 — the old gate skipped this.
    await waitFor(() =>
      expect(getAllAttachments.mock.calls.length).toBeGreaterThan(before),
    );

    // (2) Toast reflects the expansion count — the old gate said "No new messages found".
    await waitFor(() => expect(showSuccess).toHaveBeenCalledWith("3 messages linked"));
    expect(showSuccess).not.toHaveBeenCalledWith("No new messages found for assigned contacts");
  });
});
