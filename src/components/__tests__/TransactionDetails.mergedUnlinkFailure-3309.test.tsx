/**
 * BACKLOG-3309 — a merged email card that spans several backend threads is
 * removed with one `unlinkCommunication` call per thread. Since 3309 a thread
 * that fails is rolled back whole and returns `success: false`; before, the
 * extra constituents' failures were dropped and the toast read as a full
 * success. The toast now says how many conversations could not be removed.
 *
 * Mocks transcribed from TransactionDetails.cardCountersNotified-2838.test.tsx;
 * the emails-tab stub fires a card with three backend threads.
 */
import React from "react";
import { render as rtlRender, screen, waitFor } from "@testing-library/react";
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

/**
 * The tabs are stubbed to expose their completion callbacks as buttons — the
 * same technique TransactionDetails.attachmentsRefresh.test.tsx uses. What is
 * under test is TransactionDetails' reaction, not the tabs' own rendering.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
jest.mock("../transactionDetailsModule/components/TransactionEmailsTab", () => ({
  TransactionEmailsTab: (props: any) => (
    <div>
      <button data-testid="fire-emails-changed" onClick={() => props.onEmailsChanged?.()}>
        attach email
      </button>
      <button
        data-testid="fire-show-unlink-thread"
        onClick={() =>
          props.onShowUnlinkThread?.({
            id: "merged-card",
            emails: [
              { id: "email-1", communication_id: "comm-1", thread_id: "t-1" },
              { id: "email-2", communication_id: "comm-2", thread_id: "t-2" },
              { id: "email-3", communication_id: "comm-3", thread_id: "t-3" },
            ],
          })
        }
      >
        unlink thread
      </button>
      <button data-testid="fire-restore-complete" onClick={() => props.onRestoreComplete?.()}>
        restore email
      </button>
    </div>
  ),
}));
jest.mock("../transactionDetailsModule/components/TransactionMessagesTab", () => ({
  TransactionMessagesTab: (props: any) => (
    <div>
      <button data-testid="fire-messages-changed" onClick={() => props.onMessagesChanged?.()}>
        attach text
      </button>
      <button
        data-testid="fire-messages-restore-complete"
        onClick={() => props.onRestoreComplete?.()}
      >
        restore text
      </button>
    </div>
  ),
}));
/* eslint-enable @typescript-eslint/no-explicit-any */

const baseTransaction = {
  id: "txn-123",
  user_id: "user-456",
  property_address: "123 Main Street",
  transaction_type: "purchase",
  status: "active" as const,
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  // Partial fixture: this suite exercises only the notification wire, so the
  // remaining required columns are omitted.
} as unknown as Transaction;

describe("BACKLOG-3309 merged-card unlink reports the conversations it could not remove", () => {
  let unlinkCommunication: jest.Mock;
  const txApi = () =>
    (window.api as unknown as { transactions: Record<string, jest.Mock> }).transactions;

  beforeEach(() => {
    jest.clearAllMocks();
    unlinkCommunication = jest.fn();
    txApi().unlinkCommunication = unlinkCommunication;
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

  async function removeMergedCard(): Promise<void> {
    render(<TransactionDetails transaction={baseTransaction} onClose={jest.fn()} />);
    await waitFor(() => expect(window.api.transactions.getDetails).toHaveBeenCalled());
    await userEvent.click(await screen.findByText("Emails"));
    await userEvent.click(await screen.findByTestId("fire-show-unlink-thread"));
    await userEvent.click(await screen.findByTestId("unlink-email-confirm-button"));
    await waitFor(() => expect(unlinkCommunication).toHaveBeenCalledTimes(3));
  }

  it("one of the extra threads fails: the toast counts what moved AND names the failure", async () => {
    unlinkCommunication.mockImplementation(async (cid: string) =>
      cid === "comm-2"
        ? { success: false, error: "SQLITE_BUSY: database is locked" }
        : { success: true, unlinkedIds: [cid] },
    );
    await removeMergedCard();
    expect(
      await screen.findByText("2 emails removed — 1 conversation couldn't be removed"),
    ).toBeInTheDocument();
    // The internal error text never reaches the user.
    expect(screen.queryByText(/SQLITE_BUSY/)).not.toBeInTheDocument();
  });

  it("every thread succeeds: no failure note", async () => {
    unlinkCommunication.mockImplementation(async (cid: string) => ({
      success: true,
      unlinkedIds: [cid],
    }));
    await removeMergedCard();
    expect(await screen.findByText("3 emails removed")).toBeInTheDocument();
    expect(screen.queryByText(/couldn't be removed/)).not.toBeInTheDocument();
  });
});
