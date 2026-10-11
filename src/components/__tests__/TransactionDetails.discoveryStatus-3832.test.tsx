/**
 * BACKLOG-3832 — the on-open discovery sweep runs for seconds on a deal with many
 * contacts (founder: ~10 s for ~100 contacts before "805 found"), and nothing said
 * Keepr was looking. A status row now shows while the sweep is in flight and goes
 * when it ends; the "found" popup then appears as before.
 */
import React from "react";
import { render as rtlRender, screen, waitFor, act } from "@testing-library/react";
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
    licenseType: "individual" as const,
    hasAIAddon: false,
    organizationId: null,
    canExport: true,
    canSubmit: false,
    canAutoDetect: true,
    isLoading: false,
    refresh: jest.fn(),
  }),
}));

jest.mock("../../contexts/AuthContext", () => ({
  useAuth: () => ({
    currentUser: { id: "user-456", email: "agent@example.com" },
    isAuthenticated: true,
  }),
  useIsAuthenticated: () => true,
  useCurrentUser: () => ({ id: "user-456", email: "agent@example.com" }),
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
  property_address: "742 Example Ave",
  transaction_type: "purchase",
  status: "active" as const,
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z",
} as unknown as Transaction;

/* eslint-disable @typescript-eslint/no-explicit-any */
let getReviewState: jest.Mock;
let syncReviewQueue: jest.Mock;

beforeAll(() => {
  getReviewState = jest.fn();
  syncReviewQueue = jest.fn();
  const t = window.api.transactions as any;
  t.getCommunications = jest.fn().mockResolvedValue({ success: true, transaction: { communications: [], contact_assignments: [] } });
  t.getReviewState = getReviewState;
  t.approveReviewItems = jest.fn();
  t.rejectReviewItems = jest.fn();
  t.syncReviewQueue = syncReviewQueue;
  t.onReviewQueueChanged = jest.fn().mockReturnValue(() => {});
  t.getRemovedContacts = jest.fn().mockResolvedValue({ success: true, removedContacts: [] });
  t.restoreContact = jest.fn();
});
/* eslint-enable @typescript-eslint/no-explicit-any */

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(window.api.transactions.getDetails).mockResolvedValue({
    success: true,
    transaction: { ...baseTransaction, communications: [], contact_assignments: [] },
  } as never);
  getReviewState.mockResolvedValue({ items: [], count: 0 });
  jest.mocked(window.api.contacts.getAll).mockResolvedValue({ success: true, contacts: [] } as never);
  (window.api.transactions.getAllAttachments as jest.Mock).mockResolvedValue({ success: true, data: [] });
});

describe("BACKLOG-3832 — the discovery sweep says it is running", () => {
  it("shows 'Finding messages and emails…' while the on-open sweep runs, then the found prompt", async () => {
    let finish!: (v: unknown) => void;
    syncReviewQueue.mockReturnValue(new Promise((r) => (finish = r)));

    render(<TransactionDetails transaction={baseTransaction} onClose={jest.fn()} />);

    const status = await screen.findByTestId("review-discovery-status");
    expect(status).toHaveTextContent("Finding messages and emails");
    expect(status).toHaveAttribute("role", "status");

    await act(async () => {
      finish({ added: 805, linked: 0, outstanding: 805 });
    });

    await waitFor(() => expect(screen.queryByTestId("review-discovery-status")).not.toBeInTheDocument());
    expect(await screen.findByText(/805 total communications found/)).toBeInTheDocument();
  });

  it("a sweep that fails also ends the status row (no endless indicator)", async () => {
    syncReviewQueue.mockRejectedValue(new Error("boom"));
    render(<TransactionDetails transaction={baseTransaction} onClose={jest.fn()} />);
    await waitFor(() => expect(syncReviewQueue).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId("review-discovery-status")).not.toBeInTheDocument());
  });
});
