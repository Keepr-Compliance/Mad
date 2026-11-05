/**
 * BACKLOG-2890: TransactionDetails passes the Messages-held flag and its two
 * actions through to the Texts tab. The tab is stubbed to expose what it got.
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

/* eslint-disable @typescript-eslint/no-explicit-any */
jest.mock("../transactionDetailsModule/components/TransactionMessagesTab", () => ({
  TransactionMessagesTab: (props: any) => (
    <div data-testid="messages-tab-stub" data-held={String(props.messagesSyncHeld)}>
      <button data-testid="stub-retry" onClick={() => props.onRetryMessagesRead?.()} />
      <button data-testid="stub-choose" onClick={() => props.onChooseMessagesSource?.()} />
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
} as unknown as Transaction;

describe("TransactionDetails passes the Messages-held state to the Texts tab (BACKLOG-2890)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(window.api.transactions.getAllAttachments).mockResolvedValue({ success: true, data: [] });
    jest.mocked(window.api.transactions.getDetails).mockResolvedValue({
      success: true,
      transaction: { ...baseTransaction, communications: [], contact_assignments: [] },
    });
    jest.mocked(window.api.contacts.getAll).mockResolvedValue({ success: true, contacts: [] });
  });

  it("passes messagesSyncHeld, Retry and Choose source through", async () => {
    const onRetryMessagesRead = jest.fn();
    const onChooseMessagesSource = jest.fn();
    render(
      <TransactionDetails
        transaction={baseTransaction}
        onClose={jest.fn()}
        onTransactionUpdated={jest.fn()}
        initialTab="messages"
        messagesSyncHeld
        onRetryMessagesRead={onRetryMessagesRead}
        onChooseMessagesSource={onChooseMessagesSource}
      />,
    );
    const tab = await screen.findByTestId("messages-tab-stub");
    expect(tab).toHaveAttribute("data-held", "true");
    await userEvent.click(screen.getByTestId("stub-retry"));
    await userEvent.click(screen.getByTestId("stub-choose"));
    expect(onRetryMessagesRead).toHaveBeenCalledTimes(1);
    expect(onChooseMessagesSource).toHaveBeenCalledTimes(1);
  });

  it("defaults to not held", async () => {
    render(
      <TransactionDetails transaction={baseTransaction} onClose={jest.fn()} onTransactionUpdated={jest.fn()} initialTab="messages" />,
    );
    expect(await screen.findByTestId("messages-tab-stub")).toHaveAttribute("data-held", "false");
  });
});
