/**
 * BACKLOG-4065: an open TransactionDetails registers its transaction id (id
 * only) for the support ticket, and removes it when closed.
 *
 * Harness and mocks transcribed from TransactionDetails.deleteRefused-3339.test.tsx.
 */
import React from "react";
import { render as rtlRender, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { NotificationProvider } from "../../contexts/NotificationContext";
import TransactionDetails from "../TransactionDetails";
import type { Transaction } from "../../types";
import {
  getOpenTransactionId,
  resetOpenTransactionRegistryForTests,
} from "../../utils/openTransactionRegistry";

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
const TXN_ID = "00000000-0000-4000-8000-000000000001";
const ADDRESS = "742 Evergreen Terrace, Springfield, IL 62704";

const baseTransaction = {
  id: TXN_ID,
  user_id: "user-456",
  property_address: ADDRESS,
  transaction_type: "purchase",
  status: "active" as const,
  detection_status: "rejected" as const,
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  // Partial fixture: this suite exercises only mount/unmount.
} as unknown as Transaction;

describe("BACKLOG-4065 TransactionDetails registers the open transaction id", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetOpenTransactionRegistryForTests();
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

  it("C2 + C7: mounted -> the id (never the address); unmounted -> null", async () => {
    expect(getOpenTransactionId()).toBeNull();
    const { unmount } = render(
      <TransactionDetails transaction={baseTransaction} onClose={jest.fn()} />,
    );
    await waitFor(() => expect(window.api.transactions.getDetails).toHaveBeenCalled());

    const value = getOpenTransactionId();
    expect(value).toBe(TXN_ID);
    expect(String(value)).not.toContain("Evergreen");

    unmount();
    expect(getOpenTransactionId()).toBeNull();
  });
});
