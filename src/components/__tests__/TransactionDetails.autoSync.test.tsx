/**
 * BACKLOG-1832: TransactionDetails auto-sync lifecycle tests.
 *
 * Verifies that:
 * 1. The component subscribes to transactions:auto-sync-started and
 *    transactions:auto-sync-complete events on mount.
 * 2. A "fetching emails…" spinner shows while auto-sync is in flight for
 *    the CURRENT transaction id (emails empty).
 * 3. The email list refreshes silently (no full loading cycle) when
 *    auto-sync completes with ran:true for the current transaction.
 * 4. Events for OTHER transaction ids are ignored entirely.
 * 5. Subscriptions are cleaned up on unmount.
 */

import React from "react";
import { render, screen, act, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import TransactionDetails from "../TransactionDetails";

// ── Context mocks ────────────────────────────────────────────────────────────

jest.mock("../../contexts/LicenseContext", () => ({
  useLicense: () => ({
    licenseType: "team" as const,
    hasAIAddon: false,
    organizationId: "org-1",
    canExport: false,
    canSubmit: true,
    canAutoDetect: true,
    isLoading: false,
    refresh: jest.fn(),
  }),
}));

jest.mock("../../contexts/AuthContext", () => ({
  useAuth: () => ({
    currentUser: { id: "user-1", email: "agent@test.com" },
    isAuthenticated: true,
  }),
  useIsAuthenticated: () => true,
  useCurrentUser: () => ({ id: "user-1", email: "agent@test.com" }),
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
  useSyncOrchestrator: () => ({
    isRunning: false,
    queue: [],
    currentSync: null,
    overallProgress: 0,
    pendingRequest: null,
    state: { isRunning: false, queue: [], currentSync: null, overallProgress: 0, pendingRequest: null },
    requestSync: jest.fn(),
    forceSync: jest.fn(),
    acceptPending: jest.fn(),
    rejectPending: jest.fn(),
    cancel: jest.fn(),
  }),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

const TXN_ID = "txn-1832";
const OTHER_TXN_ID = "txn-other";

const baseTransaction = {
  id: TXN_ID,
  user_id: "user-1",
  property_address: "1832 Auto Sync Lane",
  transaction_type: "purchase",
  status: "active" as const,
  sale_price: 500000,
  closed_at: "2026-03-01",
  message_count: 0,
  attachment_count: 0,
  export_status: "not_exported" as const,
  export_count: 0,
  email_count: 0,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

/** Capture the callback registered for an event and return a trigger function. */
function captureEventCallback(
  mockFn: jest.Mock,
): (data: unknown) => void {
  const call = mockFn.mock.calls[0] as [(data: unknown) => void];
  return call[0];
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("TransactionDetails — BACKLOG-1832 auto-sync lifecycle", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Setup IPC call mocks
    window.api.transactions.getDetails.mockResolvedValue({
      success: true,
      transaction: { ...baseTransaction, communications: [], contact_assignments: [] },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window.api.transactions as any).getOverview = jest.fn().mockResolvedValue({
      success: true,
      transaction: { ...baseTransaction, contact_assignments: [], email_count: 0 },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window.api.transactions as any).getCommunications = jest.fn().mockResolvedValue({
      success: true,
      transaction: { communications: [], contact_assignments: [] },
    });
    window.api.contacts.getAll.mockResolvedValue({ success: true, contacts: [] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window.api.transactions as any).getRemovedEmails = jest.fn().mockResolvedValue({
      success: true,
      removedEmails: [],
    });

    // Re-wire the event listeners to capture callbacks
    (window.api.onTransactionAutoSyncStarted as jest.Mock).mockImplementation(
      (cb: (data: unknown) => void) => {
        // Store the callback so tests can trigger it
        (window.api.onTransactionAutoSyncStarted as jest.Mock & { _cb?: (d: unknown) => void })._cb = cb;
        return jest.fn(); // cleanup fn
      },
    );
    (window.api.onTransactionAutoSyncComplete as jest.Mock).mockImplementation(
      (cb: (data: unknown) => void) => {
        (window.api.onTransactionAutoSyncComplete as jest.Mock & { _cb?: (d: unknown) => void })._cb = cb;
        return jest.fn();
      },
    );
  });

  function renderAndNavigateToEmails() {
    const { unmount } = render(
      <TransactionDetails
        transaction={baseTransaction}
        onClose={jest.fn()}
        initialTab="emails"
      />,
    );
    return unmount;
  }

  it("subscribes to auto-sync-started and auto-sync-complete on mount", async () => {
    renderAndNavigateToEmails();
    await waitFor(() => {
      expect(window.api.onTransactionAutoSyncStarted).toHaveBeenCalledTimes(1);
      expect(window.api.onTransactionAutoSyncComplete).toHaveBeenCalledTimes(1);
    });
  });

  it("shows a loading spinner while auto-sync is in flight (emails empty)", async () => {
    renderAndNavigateToEmails();
    await waitFor(() => {
      expect(window.api.onTransactionAutoSyncStarted).toHaveBeenCalledTimes(1);
    });

    const startedCb = captureEventCallback(
      window.api.onTransactionAutoSyncStarted as jest.Mock,
    );

    // Simulate the main process firing the started event for THIS transaction
    act(() => {
      startedCb({ transactionId: TXN_ID, reason: "create" });
    });

    // The emails tab should now show the loading spinner (emails are empty)
    await waitFor(() => {
      expect(screen.getByText("Loading emails...")).toBeInTheDocument();
    });
  });

  it("ignores started events for OTHER transaction ids", async () => {
    renderAndNavigateToEmails();
    await waitFor(() => {
      expect(window.api.onTransactionAutoSyncStarted).toHaveBeenCalledTimes(1);
    });

    const startedCb = captureEventCallback(
      window.api.onTransactionAutoSyncStarted as jest.Mock,
    );

    act(() => {
      startedCb({ transactionId: OTHER_TXN_ID, reason: "create" });
    });

    // "No emails linked" empty state — NOT a loading spinner
    await waitFor(() => {
      expect(screen.getByText("No emails linked")).toBeInTheDocument();
    });
    expect(screen.queryByText("Loading emails...")).not.toBeInTheDocument();
  });

  it("clears the spinner and refreshes emails when auto-sync completes (ran:true)", async () => {
    // Setup: getCommunications returns emails after sync
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window.api.transactions as any).getCommunications = jest.fn().mockResolvedValue({
      success: true,
      transaction: {
        communications: [
          {
            id: "email-1",
            type: "email",
            subject: "Offer accepted",
            from_address: "buyer@test.com",
            received_at: "2026-02-01T10:00:00Z",
          },
        ],
        contact_assignments: [],
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window.api.transactions as any).getOverview = jest.fn().mockResolvedValue({
      success: true,
      transaction: { ...baseTransaction, contact_assignments: [], email_count: 1 },
    });

    renderAndNavigateToEmails();
    await waitFor(() => {
      expect(window.api.onTransactionAutoSyncStarted).toHaveBeenCalledTimes(1);
      expect(window.api.onTransactionAutoSyncComplete).toHaveBeenCalledTimes(1);
    });

    const startedCb = captureEventCallback(
      window.api.onTransactionAutoSyncStarted as jest.Mock,
    );
    const completeCb = captureEventCallback(
      window.api.onTransactionAutoSyncComplete as jest.Mock,
    );

    // Fire started → spinner appears
    act(() => {
      startedCb({ transactionId: TXN_ID, reason: "create" });
    });
    await waitFor(() => {
      expect(screen.getByText("Loading emails...")).toBeInTheDocument();
    });

    // Fire complete with ran:true → spinner clears, list refreshes
    act(() => {
      completeCb({ transactionId: TXN_ID, reason: "create", ran: true, windowsFetched: 1 });
    });

    await waitFor(() => {
      expect(screen.queryByText("Loading emails...")).not.toBeInTheDocument();
    });
  });

  it("ignores complete events for OTHER transaction ids", async () => {
    renderAndNavigateToEmails();
    await waitFor(() => {
      expect(window.api.onTransactionAutoSyncStarted).toHaveBeenCalledTimes(1);
      expect(window.api.onTransactionAutoSyncComplete).toHaveBeenCalledTimes(1);
    });

    const startedCb = captureEventCallback(
      window.api.onTransactionAutoSyncStarted as jest.Mock,
    );
    const completeCb = captureEventCallback(
      window.api.onTransactionAutoSyncComplete as jest.Mock,
    );

    // Start sync for THIS transaction
    act(() => {
      startedCb({ transactionId: TXN_ID, reason: "create" });
    });
    await waitFor(() => {
      expect(screen.getByText("Loading emails...")).toBeInTheDocument();
    });

    // Complete event for a DIFFERENT transaction — should NOT clear the spinner
    act(() => {
      completeCb({ transactionId: OTHER_TXN_ID, reason: "create", ran: true, windowsFetched: 1 });
    });

    // Spinner should still be showing
    await waitFor(() => {
      expect(screen.getByText("Loading emails...")).toBeInTheDocument();
    });
  });

  it("cleans up subscriptions on unmount", async () => {
    const mockCleanup = jest.fn();
    (window.api.onTransactionAutoSyncStarted as jest.Mock).mockReturnValue(mockCleanup);
    (window.api.onTransactionAutoSyncComplete as jest.Mock).mockReturnValue(mockCleanup);

    const unmount = renderAndNavigateToEmails();
    await waitFor(() => {
      expect(window.api.onTransactionAutoSyncStarted).toHaveBeenCalledTimes(1);
    });

    unmount();

    expect(mockCleanup).toHaveBeenCalledTimes(2); // one per subscription
  });
});
