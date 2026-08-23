/**
 * BACKLOG-2838 Half B — manual ATTACH and UNLINK have to tell the list.
 *
 * Half A subscribed the transaction list to the two broadcasts that already
 * exist (`review:queue-changed`, `transactions:auto-sync-complete`), which
 * covers approve, reject, restore, the on-open sweep and background syncs.
 *
 * Manual attach and unlink broadcast NOTHING — they are plain IPC writes — so
 * Half A alone left exactly those two paths stale, and they are the actions a
 * user takes while looking straight at the card. TransactionDetails now calls
 * the EXISTING `onTransactionUpdated` wire on each of them; the list side of
 * that wire (refetch → the card's number changes in place, no remount) is
 * pinned by Transactions-2838-counter-staleness.test.tsx.
 *
 * THE SEAM, stated rather than hidden. These tests assert that the modal fires
 * the callback; the other suite asserts that firing it updates the rendered
 * number. The one line joining them is `onTransactionUpdated={...}` at
 * TransactionList.tsx:478 / Transactions.tsx. Driving a real unlink through a
 * real list, a real modal and a real tab is a mock swamp for one prop, so the
 * chain is covered as a composition and the join is named here.
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
            id: "thread-1",
            emails: [{ id: "email-1", communication_id: "comm-1" }],
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

describe("BACKLOG-2838 Half B: attach and unlink tell the list its counters moved", () => {
  let onTransactionUpdated: jest.Mock;
  let unlinkCommunication: jest.Mock;

  /**
   * `unlinkCommunication` is not part of the shared window.api mock, so it is
   * defined here rather than in tests/setup.js — no other suite's behaviour
   * changes as a result.
   */
  const txApi = () =>
    (window.api as unknown as { transactions: Record<string, jest.Mock> }).transactions;

  beforeEach(() => {
    jest.clearAllMocks();
    onTransactionUpdated = jest.fn();
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

  const mount = () =>
    render(
      <TransactionDetails
        transaction={baseTransaction}
        onClose={jest.fn()}
        onTransactionUpdated={onTransactionUpdated}
      />,
    );

  /**
   * The mount itself must not notify — otherwise every test below passes for
   * the wrong reason, and the list would refetch on every deal opened.
   */
  const settleMount = async (): Promise<void> => {
    await waitFor(() =>
      expect(window.api.transactions.getAllAttachments).toHaveBeenCalled(),
    );
    expect(onTransactionUpdated).not.toHaveBeenCalled();
  };

  it("notifies after an email is ATTACHED", async () => {
    mount();
    await settleMount();

    await userEvent.click(screen.getByText("Emails"));
    await userEvent.click(await screen.findByTestId("fire-emails-changed"));

    await waitFor(() => expect(onTransactionUpdated).toHaveBeenCalled());
  });

  it("notifies after an email thread is UNLINKED", async () => {
    unlinkCommunication.mockResolvedValue({ success: true, unlinkedIds: ["comm-1"] });
    mount();
    await settleMount();

    await userEvent.click(screen.getByText("Emails"));
    // Open the confirmation the tab raises, then confirm it — the unlink runs
    // through the real handler, not a stub of it.
    await userEvent.click(await screen.findByTestId("fire-show-unlink-thread"));
    await userEvent.click(await screen.findByTestId("unlink-email-confirm-button"));

    await waitFor(() => expect(unlinkCommunication).toHaveBeenCalled());
    await waitFor(() => expect(onTransactionUpdated).toHaveBeenCalled());
  });

  it("does NOT notify when the unlink FAILS", async () => {
    // The counters did not move, so the list must not be told they did. This is
    // what separates "wired to the action" from "wired to the outcome".
    unlinkCommunication.mockResolvedValue({ success: false, error: "db locked" });
    mount();
    await settleMount();

    await userEvent.click(screen.getByText("Emails"));
    await userEvent.click(await screen.findByTestId("fire-show-unlink-thread"));
    await userEvent.click(await screen.findByTestId("unlink-email-confirm-button"));

    await waitFor(() => expect(unlinkCommunication).toHaveBeenCalled());
    expect(onTransactionUpdated).not.toHaveBeenCalled();
  });

  it("notifies after a text is attached or unlinked", async () => {
    mount();
    await settleMount();

    await userEvent.click(screen.getByText("Texts"));
    await userEvent.click(await screen.findByTestId("fire-messages-changed"));

    await waitFor(() => expect(onTransactionUpdated).toHaveBeenCalled());
  });

  it("notifies after a removed email is RESTORED", async () => {
    mount();
    await settleMount();

    await userEvent.click(screen.getByText("Emails"));
    await userEvent.click(await screen.findByTestId("fire-restore-complete"));

    await waitFor(() => expect(onTransactionUpdated).toHaveBeenCalled());
  });

  /**
   * The fifth completion point, and the one that had no control.
   *
   * SR review deleted `onTransactionUpdated?.()` from
   * handleRefreshMessagesSilently and NOTHING went red across all nine
   * TransactionDetails suites — so the PR's claim of five pinned points was
   * true of four. A restored conversation returns to the text thread count
   * exactly as a restored email returns to the email count; the two paths are
   * mirrored in the source and are now mirrored in their controls.
   */
  it("notifies after a removed CONVERSATION is restored (the text mirror)", async () => {
    mount();
    await settleMount();

    await userEvent.click(screen.getByText("Texts"));
    await userEvent.click(await screen.findByTestId("fire-messages-restore-complete"));

    await waitFor(() => expect(onTransactionUpdated).toHaveBeenCalled());
  });
});
