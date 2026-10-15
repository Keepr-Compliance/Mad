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
import { render as rtlRender, screen, waitFor } from "@testing-library/react";
import { NotificationProvider } from "../../contexts/NotificationContext";

/**
 * BACKLOG-2447: these components now raise toasts through `useNotification`,
 * which requires the app-level NotificationProvider that `App.tsx` supplies in
 * production. Passing it as RTL's `wrapper` (rather than wrapping each element)
 * means `rerender` keeps the provider too.
 */
const render = (
  ui: Parameters<typeof rtlRender>[0],
  options?: Parameters<typeof rtlRender>[1],
) => rtlRender(ui, { wrapper: NotificationProvider, ...options });
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import TransactionDetails from "../TransactionDetails";
import type { Transaction } from "../../types";

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

// Partial fixture: this suite only exercises the attachments refresh, so the
// remaining REQUIRED Transaction columns (message_count, attachment_count,
// export_status, export_count) are omitted.
const baseTransaction = {
  id: "txn-123",
  user_id: "user-456",
  property_address: "123 Main Street",
  transaction_type: "purchase",
  status: "active" as const,
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
} as unknown as Transaction;

describe("TransactionDetails — attachments auto-refresh (BACKLOG-322 #3)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getAllAttachments.mockResolvedValue({ success: true, data: [] });
    jest.mocked(window.api.transactions.getDetails).mockResolvedValue({
      success: true,
      transaction: { ...baseTransaction, communications: [], contact_assignments: [] },
    });
    jest.mocked(window.api.contacts.getAll).mockResolvedValue({ success: true, contacts: [] });
  });

  it("refetches attachments after an email is attached (onEmailsChanged)", async () => {
    render(
      <TransactionDetails transaction={baseTransaction} onClose={jest.fn()} onTransactionUpdated={jest.fn()} initialTab="attachments" />,
    );

    // Attachments tab shown first (BACKLOG-3884: the unified attachments load
    // only once a tab that shows them is opened).
    await waitFor(() => expect(getAllAttachments).toHaveBeenCalled());
    const before = getAllAttachments.mock.calls.length;

    // Open the Emails tab (renders the stub), then fire onEmailsChanged.
    await userEvent.click(await screen.findByText("Emails"));
    await userEvent.click(await screen.findByTestId("fire-emails-changed"));

    await waitFor(() =>
      expect(getAllAttachments.mock.calls.length).toBeGreaterThan(before),
    );
  });

  it("refetches attachments after a text is attached (onMessagesChanged)", async () => {
    render(
      <TransactionDetails transaction={baseTransaction} onClose={jest.fn()} onTransactionUpdated={jest.fn()} initialTab="attachments" />,
    );

    await waitFor(() => expect(getAllAttachments).toHaveBeenCalled());
    const before = getAllAttachments.mock.calls.length;

    await userEvent.click(await screen.findByText("Texts"));
    await userEvent.click(await screen.findByTestId("fire-messages-changed"));

    await waitFor(() =>
      expect(getAllAttachments.mock.calls.length).toBeGreaterThan(before),
    );
  });

  // BACKLOG-3730: the Attachments tab asks main for the transaction's own
  // window, passing the row's raw dates (main reads them with auditPeriodFromRow).
  it("asks for the in-window set with the transaction's raw start/closing dates", async () => {
    const dated = { ...baseTransaction, started_at: "2026-01-01", closed_at: "2026-07-29" } as unknown as Transaction;
    render(<TransactionDetails transaction={dated} onClose={jest.fn()} onTransactionUpdated={jest.fn()} initialTab="attachments" />);

    await waitFor(() =>
      expect(getAllAttachments).toHaveBeenCalledWith("txn-123", "2026-01-01", "2026-07-29"),
    );
    expect(getAllAttachments).toHaveBeenCalledWith("txn-123", undefined, undefined);
  });
});

/**
 * BACKLOG-3884: opening a transaction ran the unified attachments reader twice
 * on main (~0.8 s of synchronous SQL on a 105k-linked-text deal) although only
 * the Attachments and Checklist tabs show the result. It now loads the first
 * time one of those tabs is shown — and when it does, it returns everything.
 */
describe("TransactionDetails — attachments load only when a tab shows them (BACKLOG-3884)", () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({
    id: `att-${i}`,
    filename: `file-${i}.pdf`,
    mime_type: "application/pdf",
    file_size_bytes: 100,
    storage_path: null,
    created_at: null,
    source: i % 2 ? "text" : "email",
    source_date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T10:00:00Z`,
    direction: "inbound",
    context_subject: null,
    context_sender: null,
    email_id: i % 2 ? null : `e-${i}`,
    message_id: i % 2 ? `m-${i}` : null,
  }));

  beforeEach(() => {
    jest.clearAllMocks();
    getAllAttachments.mockResolvedValue({ success: true, data: rows });
    jest.mocked(window.api.transactions.getDetails).mockResolvedValue({
      success: true,
      transaction: { ...baseTransaction, communications: [], contact_assignments: [] },
    });
    jest.mocked(window.api.contacts.getAll).mockResolvedValue({ success: true, contacts: [] });
  });

  it("opening on Overview does not read attachments; opening the Attachments tab reads and shows ALL of them", async () => {
    render(<TransactionDetails transaction={baseTransaction} onClose={jest.fn()} onTransactionUpdated={jest.fn()} />);
    await waitFor(() => expect(window.api.transactions.getDetails as jest.Mock).toHaveBeenCalled());
    // An attach on another tab before Attachments was ever shown: nothing to refresh.
    await userEvent.click(await screen.findByText("Emails"));
    await userEvent.click(await screen.findByTestId("fire-emails-changed"));
    expect(getAllAttachments).toHaveBeenCalledTimes(0);

    await userEvent.click(await screen.findByText("Attachments"));
    await waitFor(() => expect(getAllAttachments).toHaveBeenCalledWith("txn-123", undefined, undefined));
    for (const r of rows) {
      expect(await screen.findByText(r.filename)).toBeInTheDocument();
    }
  });

  it("opening the Checklist tab reads attachments (its link picker needs them)", async () => {
    render(
      <TransactionDetails transaction={baseTransaction} onClose={jest.fn()} onTransactionUpdated={jest.fn()} initialTab="checklist" />,
    );
    await waitFor(() => expect(getAllAttachments).toHaveBeenCalledWith("txn-123", undefined, undefined));
  });
});
