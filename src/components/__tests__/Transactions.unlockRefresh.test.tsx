/**
 * BACKLOG-2090 — in-session staleness fix.
 *
 * The list + the useUnlockedTransactionIds hook stay mounted through the
 * export/unlock modal. After an unlock spends a credit, `loadTransactions()`
 * reloads the rows but the batch unlock-status Set was NEVER refetched, so a
 * just-unlocked deal kept showing a gray lock until the view remounted.
 *
 * This test drives the REAL hook (via window.api.entitlement.getUnlockedIds)
 * and asserts the fix behaviorally: after the detail modal's
 * onTransactionUpdated fires (the in-tab export/unlock path), the unlock-status
 * Set refetches and the badge for the EXACT unlocked transaction flips
 * Locked -> Unlocked. Asserted by identity (which tx id flips), not by counts.
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import Transactions from "../Transactions";
import { PlatformProvider } from "../../contexts/PlatformContext";

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
    canCreateTransaction: true,
    transactionCount: 0,
    transactionLimit: 100,
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

jest.mock("../../hooks/useSubmissionSync", () => ({
  useSubmissionSync: () => ({
    isSyncing: false,
    lastSync: null,
    syncNow: jest.fn(),
  }),
}));

// Replace the heavy detail modal with a stub that surfaces the wired
// onTransactionUpdated callback as a clickable button. Clicking it simulates a
// completed in-tab export/unlock, which is exactly the path that must refresh
// the unlock-status Set.
jest.mock("../TransactionDetails", () => ({
  __esModule: true,
  default: ({ onTransactionUpdated }: { onTransactionUpdated: () => void }) => (
    <button data-testid="simulate-unlock-export" onClick={onTransactionUpdated}>
      simulate unlock+export complete
    </button>
  ),
}));

describe("Transactions — unlock badge refetch after unlock/export (BACKLOG-2090)", () => {
  const mockUserId = "user-123";
  const mockProvider = "google";
  const UNLOCKED_TX = "txn-1";

  const mockTransactions = [
    {
      id: UNLOCKED_TX,
      user_id: mockUserId,
      property_address: "123 Main Street",
      transaction_type: "purchase",
      status: "active",
      sale_price: 450000,
      closed_at: "2024-03-15",
      total_communications_count: 25,
      email_count: 25,
      text_count: 0,
      text_thread_count: 0,
      extraction_confidence: 85,
    },
    {
      id: "txn-2",
      user_id: mockUserId,
      property_address: "456 Oak Avenue",
      transaction_type: "sale",
      // active so it isn't hidden by the default "active" status filter — we
      // need it visible to prove ONLY the unlocked deal's badge flips.
      status: "active",
      sale_price: 325000,
      closed_at: null,
      total_communications_count: 18,
      email_count: 18,
      text_count: 0,
      text_thread_count: 0,
      extraction_confidence: 92,
    },
  ];

  const renderWithProvider = (ui: React.ReactElement) =>
    render(<PlatformProvider>{ui}</PlatformProvider>);

  // Resolve the unlock badge (locked | unlocked) for a specific transaction by
  // its (unique) property address, walking up to the card container — identity
  // is asserted per-card, not by a global count.
  const badgeStateFor = (address: string): "locked" | "unlocked" | "none" => {
    const label = screen.queryByText(address);
    if (!label) return "none";
    // Walk up from the address until we reach an ancestor that also contains
    // this card's unlock badge — that ancestor is the card root, so the badge
    // we read is unambiguously THIS transaction's (identity, not a stray match).
    let el: HTMLElement | null = label;
    while (el) {
      const unlocked = el.querySelector('[data-testid="unlock-badge-unlocked"]');
      const locked = el.querySelector('[data-testid="unlock-badge-locked"]');
      if (unlocked) return "unlocked";
      if (locked) return "locked";
      el = el.parentElement;
    }
    return "none";
  };

  beforeEach(() => {
    jest.clearAllMocks();
    window.api.transactions.getAll.mockResolvedValue({
      success: true,
      transactions: mockTransactions,
    });
    window.api.transactions.getDetails.mockResolvedValue({
      success: true,
      transaction: {
        ...mockTransactions[0],
        communications: [],
        contact_assignments: [],
      },
    });
    window.api.onTransactionScanProgress.mockReturnValue(jest.fn());
  });

  it("refetches the unlock-status Set after the unlock/export path — the just-unlocked deal flips Locked -> Unlocked", async () => {
    // First fetch: nothing unlocked (txn-1 reads as locked).
    // After the unlock spends a credit, the refetch returns txn-1 unlocked.
    const getUnlockedIds = window.api.entitlement.getUnlockedIds as jest.Mock;
    getUnlockedIds
      .mockResolvedValueOnce([]) // initial mount
      .mockResolvedValue([UNLOCKED_TX]); // every refetch after the unlock

    renderWithProvider(
      <Transactions userId={mockUserId} provider={mockProvider} onClose={jest.fn()} />,
    );

    // Baseline: BOTH deals start LOCKED once the initial batch fetch resolves.
    await waitFor(() => expect(badgeStateFor("123 Main Street")).toBe("locked"));
    expect(badgeStateFor("456 Oak Avenue")).toBe("locked");
    expect(getUnlockedIds).toHaveBeenCalledTimes(1);

    // Open the (stubbed) detail modal for txn-1.
    const card = screen
      .getByText("123 Main Street")
      .closest('div[class*="cursor-pointer"]');
    expect(card).not.toBeNull();
    await userEvent.click(card as HTMLElement);

    // Fire the in-tab export/unlock-complete callback the modal is wired to.
    await userEvent.click(await screen.findByTestId("simulate-unlock-export"));

    // The fix: the unlock-status Set refetches and the badge for THIS exact
    // transaction flips Locked -> Unlocked (identity — only txn-1 was in the
    // refetched unlocked set, and only its badge flips).
    await waitFor(() => expect(badgeStateFor("123 Main Street")).toBe("unlocked"));
    expect(getUnlockedIds.mock.calls.length).toBeGreaterThanOrEqual(2);

    // The other deal was NOT in the refetched unlocked set, so its badge must
    // stay Locked — the refresh follows exact transaction identity, not counts.
    expect(badgeStateFor("456 Oak Avenue")).toBe("locked");
  });
});
