/**
 * BACKLOG-1898 T5: `initialTransactionId` seam — opening a transaction by id
 * from the Contacts detail card.
 *
 * Covers the three behaviours of the auto-open-by-id effect:
 *  1. resolves + opens the transaction once the list has loaded (overview tab),
 *  2. unknown id is a no-op (no detail opens),
 *  3. per-id latch: after the user closes the detail, a `transactions` refetch
 *     does NOT re-open it (the reopen-on-refetch bug SR flagged).
 *
 * TransactionDetails is mocked to a stub that exposes the opened id AND a close
 * button so we can drive the close→refetch sequence deterministically.
 */
import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
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

// Stub TransactionDetails: expose the opened id + a close button.
interface CapturedDetailsProps {
  transaction?: { id?: string };
  initialTab?: string;
  onClose?: () => void;
}
jest.mock("../TransactionDetails", () => ({
  __esModule: true,
  default: (props: CapturedDetailsProps) => (
    <div
      data-testid="txn-details-mock"
      data-txn-id={props.transaction?.id}
      data-initial-tab={props.initialTab}
    >
      <button data-testid="txn-details-close" onClick={props.onClose}>
        close
      </button>
    </div>
  ),
}));

const USER_ID = "user-123";

// BACKLOG-2414: a deliberately partial `Transaction` row — only the fields the
// list/overview render from. The counter columns (`message_count`,
// `attachment_count`, `export_status`, `export_count`, ...) are required on the
// type but absent here, and supplying them would change what the component
// renders, so the fixture stays as-is and only the type is asserted.
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
  // BACKLOG-2414: `jest.mocked` supplies the mock typing the real signature does
  // not carry. Both `?.` are kept, so the guard behaves exactly as before.
  jest.mocked(window.api.onTransactionScanProgress)?.mockReturnValue?.(jest.fn());
});

describe("TransactionList — open by id from Contacts (BACKLOG-1898 T5)", () => {
  it("resolves and opens the transaction on the overview tab once loaded", async () => {
    render(
      <TransactionList
        userId={USER_ID}
        provider="google"
        onClose={jest.fn()}
        initialTransactionId="txn-1"
      />,
    );

    const details = await screen.findByTestId("txn-details-mock");
    expect(details).toHaveAttribute("data-txn-id", "txn-1");
    expect(details).toHaveAttribute("data-initial-tab", "overview");
  });

  it("is a no-op when the id does not match any loaded transaction", async () => {
    render(
      <TransactionList
        userId={USER_ID}
        provider="google"
        onClose={jest.fn()}
        initialTransactionId="txn-does-not-exist"
      />,
    );

    // Let the initial load settle, then confirm no detail opened.
    await waitFor(() =>
      expect(window.api.transactions.getAll).toHaveBeenCalled(),
    );
    expect(screen.queryByTestId("txn-details-mock")).not.toBeInTheDocument();
  });

  it("does not re-open the detail after the user closes it while the id is still pending (per-id latch)", async () => {
    // Same id passed on every render (parent hasn't cleared it yet — mirrors
    // AppModals keeping pendingTransactionId until the Transactions view closes).
    const { rerender } = render(
      <TransactionList
        userId={USER_ID}
        provider="google"
        onClose={jest.fn()}
        initialTransactionId="txn-1"
      />,
    );

    // Auto-opened by id.
    await screen.findByTestId("txn-details-mock");

    // User closes the detail.
    fireEvent.click(screen.getByTestId("txn-details-close"));
    await waitFor(() =>
      expect(screen.queryByTestId("txn-details-mock")).not.toBeInTheDocument(),
    );

    // Any subsequent re-render with the SAME still-pending id must NOT re-open
    // the detail — the latch remembers txn-1 was already handled. (A real
    // transactions refetch produces the same effect input; this re-render is the
    // deterministic stand-in for it.)
    await act(async () => {
      rerender(
        <TransactionList
          userId={USER_ID}
          provider="google"
          onClose={jest.fn()}
          initialTransactionId="txn-1"
        />,
      );
      await Promise.resolve();
    });

    expect(screen.queryByTestId("txn-details-mock")).not.toBeInTheDocument();
  });

  it("re-opens once the parent clears then re-sets the id (latch resets on clear)", async () => {
    const { rerender } = render(
      <TransactionList
        userId={USER_ID}
        provider="google"
        onClose={jest.fn()}
        initialTransactionId="txn-1"
      />,
    );
    await screen.findByTestId("txn-details-mock");

    // Close the detail.
    fireEvent.click(screen.getByTestId("txn-details-close"));
    await waitFor(() =>
      expect(screen.queryByTestId("txn-details-mock")).not.toBeInTheDocument(),
    );

    // Parent clears the id (Transactions view closed) — resets the latch.
    await act(async () => {
      rerender(
        <TransactionList
          userId={USER_ID}
          provider="google"
          onClose={jest.fn()}
          initialTransactionId={null}
        />,
      );
      await Promise.resolve();
    });
    expect(screen.queryByTestId("txn-details-mock")).not.toBeInTheDocument();

    // Same id requested again (user clicks the same transaction later) — re-opens.
    await act(async () => {
      rerender(
        <TransactionList
          userId={USER_ID}
          provider="google"
          onClose={jest.fn()}
          initialTransactionId="txn-1"
        />,
      );
      await Promise.resolve();
    });
    expect(await screen.findByTestId("txn-details-mock")).toHaveAttribute(
      "data-txn-id",
      "txn-1",
    );
  });
});
