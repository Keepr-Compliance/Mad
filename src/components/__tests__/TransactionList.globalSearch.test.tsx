/**
 * BACKLOG-1876: list-mount coverage for the global search box.
 *
 * Verifies the transaction LIST page mounts the global LinkedContentSearch and
 * that clicking a hit opens the owning transaction on the correct tab with the
 * BACKLOG-1869 viewer highlight seeded. TransactionDetails is mocked to a prop
 * capture stub so we can assert `initialTab` / `initialHighlight` deterministically.
 */
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import TransactionList from "../TransactionList";

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

// Mock TransactionDetails to capture the props seeded when a hit is clicked.
interface CapturedDetailsProps {
  transaction?: { id?: string };
  initialTab?: string;
  initialHighlight?: unknown;
}
jest.mock("../TransactionDetails", () => ({
  __esModule: true,
  default: (props: CapturedDetailsProps) => (
    <div
      data-testid="txn-details-mock"
      data-txn-id={props.transaction?.id}
      data-initial-tab={props.initialTab}
      data-initial-highlight={JSON.stringify(props.initialHighlight ?? null)}
    />
  ),
}));

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
};

const ATTR = { transactionId: "txn-1", propertyAddress: "1 Main Street" };

function globalResultsWith(overrides: Record<string, unknown>) {
  return {
    success: true,
    results: {
      transactions: { items: [], total: 0 },
      contacts: { items: [], total: 0 },
      emails: { items: [], total: 0 },
      texts: { items: [], total: 0 },
      unattached: { items: [], total: 0 },
      ...overrides,
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsAllowed.mockReturnValue(true);
  window.api.transactions.getAll.mockResolvedValue({
    success: true,
    transactions: [txn],
  });
  window.api.onTransactionScanProgress?.mockReturnValue?.(jest.fn());
});

async function renderAndSearch(query: string) {
  render(
    <TransactionList userId={USER_ID} provider="google" onClose={jest.fn()} />,
  );
  // Wait for the initial load to settle (list rendered).
  await waitFor(() => expect(window.api.transactions.getAll).toHaveBeenCalled());
  fireEvent.change(screen.getByTestId("linked-search-input"), {
    target: { value: query },
  });
}

describe("TransactionList — global search mount (BACKLOG-1876)", () => {
  it("mounts the global search box and searches by user id", async () => {
    window.api.transactions.searchGlobalContent.mockResolvedValue(
      globalResultsWith({}),
    );
    await renderAndSearch("main");

    await waitFor(() =>
      expect(window.api.transactions.searchGlobalContent).toHaveBeenCalledWith(
        USER_ID,
        "main",
      ),
    );
  });

  it("opens the owning transaction on the Emails tab with the highlight seeded when an email hit is clicked", async () => {
    window.api.transactions.searchGlobalContent.mockResolvedValue(
      globalResultsWith({
        emails: {
          items: [
            {
              id: "e1",
              subject: "Closing docs",
              sender: "agent@x.com",
              sentAt: null,
              snippet: "hi",
              attribution: ATTR,
            },
          ],
          total: 1,
        },
      }),
    );
    await renderAndSearch("closing");

    const emailHit = await screen.findByTestId("email-result");
    fireEvent.click(emailHit);

    const details = await screen.findByTestId("txn-details-mock");
    expect(details).toHaveAttribute("data-txn-id", "txn-1");
    expect(details).toHaveAttribute("data-initial-tab", "emails");
    expect(details).toHaveAttribute(
      "data-initial-highlight",
      JSON.stringify({ type: "email", emailId: "e1" }),
    );
  });

  it("opens a transaction hit on the overview tab with no highlight", async () => {
    window.api.transactions.searchGlobalContent.mockResolvedValue(
      globalResultsWith({
        transactions: { items: [{ id: "txn-1", propertyAddress: "1 Main Street" }], total: 1 },
      }),
    );
    await renderAndSearch("main");

    const txnHit = await screen.findByTestId("transaction-result");
    fireEvent.click(txnHit);

    const details = await screen.findByTestId("txn-details-mock");
    expect(details).toHaveAttribute("data-txn-id", "txn-1");
    expect(details).toHaveAttribute("data-initial-tab", "overview");
    expect(details).toHaveAttribute("data-initial-highlight", "null");
  });
});
