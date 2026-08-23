/**
 * BACKLOG-2805 (support ticket 112) — the pending-audit list names the type
 * the same way the rest of the app does.
 *
 * ===========================================================================
 * WHY A TEXT SWEEP MISSED THIS SITE
 * ===========================================================================
 * This row never contained the word "Purchase". It printed the RAW ENUM and
 * leaned on CSS `text-transform: capitalize` to make `purchase` LOOK like a
 * label. So a grep for the display string found the other six renderer sites
 * and was blind to this one, and the modal would have gone on reading
 * "Purchase" after everything else had moved to "Listing/Purchase".
 *
 * It is the same defect shape as the .txt export, which printed
 * "Transaction Type: purchase" for the same reason. Found in SR review of
 * PR #2352.
 *
 * The assertion is on TEXT CONTENT, which is what jsdom gives us — the CSS
 * transform is not applied here, so asserting the raw enum is absent is a
 * real check rather than a cosmetic one.
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import StartNewAuditModal from "../StartNewAuditModal";

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

jest.mock("../../contexts/AuthContext", () => {
  const originalModule = jest.requireActual("../../contexts/AuthContext");
  return {
    ...originalModule,
    useAuth: () => ({
      currentUser: { id: "test-user-123" },
      isAuthenticated: true,
    }),
  };
});

jest.mock("../../contexts/LicenseContext", () => ({
  useLicense: () => ({
    licenseType: "individual" as const,
    hasAIAddon: true,
    organizationId: null,
    canExport: true,
    canSubmit: false,
    canAutoDetect: true,
    canCreateTransaction: true,
    transactionCount: 0,
    transactionLimit: 10,
    isLoading: false,
    refresh: jest.fn(),
  }),
}));

jest.mock("../../hooks/useFeatureGate", () => ({
  useFeatureGate: () => ({
    isAllowed: () => true,
    features: {},
    loading: false,
    hasInitialized: true,
    refresh: jest.fn(),
  }),
}));

/** Field shape follows the existing StartNewAuditModal suite's fixtures. */
function pendingTransaction(id: string, transactionType: string) {
  return {
    id,
    user_id: "test-user-123",
    property_address: `${id} Example Street`,
    transaction_type: transactionType,
    status: "pending" as const,
    detection_status: "pending" as const,
    detection_confidence: 0.85,
    listing_price: 750000,
    message_count: 5,
    attachment_count: 2,
    export_status: "not_exported" as const,
    export_count: 0,
    created_at: "2026-01-09T10:00:00Z",
    updated_at: "2026-01-09T10:00:00Z",
  };
}

function renderModal(transactions: ReturnType<typeof pendingTransaction>[]) {
  jest.mocked(window.api.transactions.getAll).mockResolvedValue({
    success: true,
    transactions,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  return render(
    <StartNewAuditModal
      onSelectPendingTransaction={jest.fn()}
      onViewActiveTransactions={jest.fn()}
      onCreateManually={jest.fn()}
      onClose={jest.fn()}
    />,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("BACKLOG-2805: pending-audit row transaction type", () => {
  it('renders "Listing/Purchase" for a purchase row', async () => {
    renderModal([pendingTransaction("txn-a", "purchase")]);

    const row = await screen.findByTestId("pending-transaction-txn-a");
    expect(row).toHaveTextContent("Listing/Purchase");
  });

  it("never renders the raw enum for a purchase row", async () => {
    renderModal([pendingTransaction("txn-a", "purchase")]);

    const row = await screen.findByTestId("pending-transaction-txn-a");
    // The original defect in one assertion: the row said `purchase` and only
    // LOOKED like a label because of a CSS transform.
    expect(row.textContent).not.toContain("purchase");
  });

  it('still renders "Sale" for a sale row', async () => {
    renderModal([pendingTransaction("txn-b", "sale")]);

    const row = await screen.findByTestId("pending-transaction-txn-b");
    expect(row).toHaveTextContent("Sale");
    expect(row.textContent).not.toContain("sale");
    expect(row.textContent).not.toContain("Listing/Purchase");
  });

  it("names each row correctly in a mixed list — identity, not count", async () => {
    renderModal([
      pendingTransaction("txn-a", "purchase"),
      pendingTransaction("txn-b", "sale"),
    ]);

    await waitFor(() =>
      expect(screen.getByTestId("pending-transaction-txn-a")).toBeInTheDocument(),
    );

    expect(screen.getByTestId("pending-transaction-txn-a")).toHaveTextContent(
      "Listing/Purchase",
    );
    expect(screen.getByTestId("pending-transaction-txn-b")).toHaveTextContent(
      "Sale",
    );
  });

  it("still shows an unmapped type rather than blanking the row", async () => {
    // The fallback path, which is why the `capitalize` class stays. A lookup
    // with no fallback would render nothing here and silently drop the field.
    renderModal([pendingTransaction("txn-c", "other")]);

    const row = await screen.findByTestId("pending-transaction-txn-c");
    expect(row).toHaveTextContent("other");
  });
});
