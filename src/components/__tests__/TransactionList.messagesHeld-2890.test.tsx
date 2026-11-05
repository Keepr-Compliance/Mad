/**
 * BACKLOG-2890: TransactionList passes the Messages-held flag and its two
 * actions through to TransactionDetails. TransactionDetails is stubbed to
 * expose what it got. Harness copied from TransactionList.contactOpen.test.tsx.
 */
import React from "react";
import { render as rtlRender, screen, fireEvent, waitFor, act } from "@testing-library/react";
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
import "@testing-library/jest-dom";
import TransactionList from "../TransactionList";
import type { Transaction } from "../../../electron/types/models";

jest.mock("../../appCore", () => ({
  ...jest.requireActual("../../appCore"),
  useAppStateMachine: () => ({ isDatabaseInitialized: true }),
}));

jest.mock("../../contexts/LicenseContext", () => ({
  useLicense: () => ({
    licenseType: "individual" as const,
    hasAIAddon: true,
    organizationId: null,
    canExport: true,
    canSubmit: false,
    canAutoDetect: true,
    isLoading: false,
    refresh: jest.fn(),
  }),
}));

const mockIsAllowed = jest.fn().mockReturnValue(true);
jest.mock("@/hooks/useFeatureGate", () => ({
  useFeatureGate: () => ({
    isAllowed: mockIsAllowed,
    features: {},
    loading: false,
    hasInitialized: true,
    refresh: jest.fn(),
  }),
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

/* eslint-disable @typescript-eslint/no-explicit-any */
jest.mock("../TransactionDetails", () => ({
  __esModule: true,
  default: (props: any) => (
    <div data-testid="txn-details-mock" data-held={String(props.messagesSyncHeld)}>
      <button data-testid="stub-retry" onClick={() => props.onRetryMessagesRead?.()} />
      <button data-testid="stub-choose" onClick={() => props.onChooseMessagesSource?.()} />
    </div>
  ),
}));
/* eslint-enable @typescript-eslint/no-explicit-any */

const USER_ID = "user-123";
const txn = {
  id: "txn-1",
  user_id: USER_ID,
  property_address: "1 Main Street",
  transaction_type: "purchase",
  status: "active",
  detection_source: "manual",
  detection_status: "confirmed",
  total_communications_count: 5,
  closed_at: null,
} as unknown as Transaction;

beforeEach(() => {
  jest.clearAllMocks();
  mockIsAllowed.mockReturnValue(true);
  jest.mocked(window.api.transactions.getAll).mockResolvedValue({
    success: true,
    transactions: [txn],
  });
  jest.mocked(window.api.onTransactionScanProgress)?.mockReturnValue?.(jest.fn());
});

describe("TransactionList passes the Messages-held state to TransactionDetails (BACKLOG-2890)", () => {
  it("passes messagesSyncHeld, Retry and Choose source through", async () => {
    const onRetryMessagesRead = jest.fn();
    const onChooseMessagesSource = jest.fn();
    render(
      <TransactionList
        userId={USER_ID}
        provider="google"
        onClose={jest.fn()}
        initialTransactionId="txn-1"
        messagesSyncHeld
        onRetryMessagesRead={onRetryMessagesRead}
        onChooseMessagesSource={onChooseMessagesSource}
      />,
    );
    const details = await screen.findByTestId("txn-details-mock");
    expect(details).toHaveAttribute("data-held", "true");
    fireEvent.click(screen.getByTestId("stub-retry"));
    fireEvent.click(screen.getByTestId("stub-choose"));
    expect(onRetryMessagesRead).toHaveBeenCalledTimes(1);
    expect(onChooseMessagesSource).toHaveBeenCalledTimes(1);
  });
});
