/**
 * Tests for TransactionList.tsx
 * Covers pending review UI and badge display
 *
 * Note: Approve/Reject actions are now in TransactionDetails modal, not on cards
 */

import React from "react";
import { render as rtlRender, screen, waitFor, within } from "@testing-library/react";
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
import TransactionList from "../TransactionList";
import type { Transaction } from "../../types";

// Mock useAppStateMachine to return isDatabaseInitialized: true
// This allows tests to render the actual component content
jest.mock("../../appCore", () => ({
  ...jest.requireActual("../../appCore"),
  useAppStateMachine: () => ({
    isDatabaseInitialized: true,
  }),
}));

// Mock the LicenseContext for LicenseGate
jest.mock("../../contexts/LicenseContext", () => ({
  useLicense: () => ({
    licenseType: "individual" as const,
    hasAIAddon: true, // Enable AI features for testing
    organizationId: null,
    canExport: true,
    canSubmit: false,
    canAutoDetect: true,
    isLoading: false,
    refresh: jest.fn(),
  }),
}));

// TASK-2159: Mock useFeatureGate (LicenseGate now uses this internally)
const mockIsAllowed = jest.fn();
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

describe("TransactionList", () => {
  const mockUserId = "user-123";
  const mockProvider = "google";
  const mockOnClose = jest.fn();

  // Transaction with pending detection status (AI-detected, awaiting review)
  // Partial fixtures: the list only reads the fields set here, so the
  // remaining REQUIRED Transaction columns (message_count,
  // attachment_count, export_status, export_count) are omitted.
  const pendingTransaction = {
    id: "txn-pending",
    user_id: mockUserId,
    property_address: "123 Pending Street",
    transaction_type: "purchase",
    status: "active",
    sale_price: 450000,
    closed_at: "2024-03-15",
    total_communications_count: 25,
    extraction_confidence: 85,
    detection_source: "auto",
    detection_status: "pending",
    detection_confidence: 0.85,
  } as unknown as Transaction;

  // Transaction with confirmed detection status
  // See note above.
  const confirmedTransaction = {
    id: "txn-confirmed",
    user_id: mockUserId,
    property_address: "456 Confirmed Avenue",
    transaction_type: "sale",
    status: "active",
    sale_price: 325000,
    closed_at: "2024-01-20",
    total_communications_count: 18,
    extraction_confidence: 92,
    detection_source: "auto",
    detection_status: "confirmed",
    detection_confidence: 0.92,
  } as unknown as Transaction;

  // Manual transaction (no detection status)
  // See note above.
  const manualTransaction = {
    id: "txn-manual",
    user_id: mockUserId,
    property_address: "789 Manual Road",
    transaction_type: "purchase",
    status: "active",
    sale_price: 550000,
    closed_at: null,
    total_communications_count: 12,
    extraction_confidence: 78,
    detection_source: "manual",
  } as unknown as Transaction;

  beforeEach(() => {
    jest.clearAllMocks();

    // Allow all features by default
    mockIsAllowed.mockReturnValue(true);

    // Default mock: return transactions with different detection statuses
    jest.mocked(window.api.transactions.getAll).mockResolvedValue({
      success: true,
      transactions: [pendingTransaction, confirmedTransaction, manualTransaction],
    });
    jest.mocked(window.api.transactions.update).mockResolvedValue({ success: true });
    jest.mocked(window.api.transactions.getDetails).mockResolvedValue({
      success: true,
      transaction: {
        ...pendingTransaction,
        communications: [],
        contact_assignments: [],
      },
    });
    jest.mocked(window.api.feedback.recordTransaction).mockResolvedValue({ success: true });
    jest.mocked(window.api.onTransactionScanProgress).mockReturnValue(jest.fn());
  });

  describe("Pending Review UI", () => {
    it("should show pending status badge on pending transactions", async () => {
      render(
        <TransactionList
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
        />,
      );

      // Wait for transactions to load
      await waitFor(() => {
        expect(screen.getByText("123 Pending Street")).toBeInTheDocument();
      });

      // Mobile card view shows "Pending" status badge for pending transactions
      expect(screen.getByText("Pending")).toBeInTheDocument();
    });

    it("should open TransactionDetails in pending review mode when clicking pending transaction card", async () => {
      const user = userEvent.setup();

      render(
        <TransactionList
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
        />,
      );

      // Wait for transactions to load
      await waitFor(() => {
        expect(screen.getAllByText("123 Pending Street").length).toBeGreaterThan(0);
      });

      // Click the pending transaction card to open in review mode
      const pendingCards = screen.getAllByText("123 Pending Street");
      await user.click(pendingCards[0]);

      // TransactionDetails modal should open with approve/reject buttons
      await waitFor(() => {
        expect(screen.getAllByText("Review Transaction").length).toBeGreaterThan(0);
      });

      // Should show Approve and Reject buttons in the modal header
      const approveButtons = screen.getAllByRole("button", { name: /approve/i });
      const rejectButtons = screen.getAllByRole("button", { name: /reject/i });
      expect(approveButtons.length).toBeGreaterThan(0);
      expect(rejectButtons.length).toBeGreaterThan(0);
    });

    it("should open TransactionDetails modal when clicking on pending transaction", async () => {
      const user = userEvent.setup();

      render(
        <TransactionList
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
        />,
      );

      // Wait for transactions to load
      await waitFor(() => {
        expect(screen.getAllByText("123 Pending Street").length).toBeGreaterThan(0);
      });

      // Click on the pending transaction card
      const pendingCards = screen.getAllByText("123 Pending Street");
      await user.click(pendingCards[0]);

      // TransactionDetails modal should open
      await waitFor(() => {
        expect(screen.getAllByText("Review Transaction").length).toBeGreaterThan(0);
      });

      // Verify getDetails was called
      expect(window.api.transactions.getDetails).toHaveBeenCalledWith("txn-pending");
    });
  });

  describe("Detection Status Badges", () => {
    it("should show Pending Review badge for pending transactions", async () => {
      render(
        <TransactionList
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
        />,
      );

      await waitFor(() => {
        expect(screen.getAllByText("123 Pending Street").length).toBeGreaterThan(0);
      });

      // Pending transaction should have Pending status badge
      const pendingElements = screen.getAllByText("Pending");
      expect(pendingElements.length).toBeGreaterThan(0);
    });

    it("should show Manual badge for manually entered transactions", async () => {
      render(
        <TransactionList
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
        />,
      );

      await waitFor(() => {
        expect(screen.getAllByText("789 Manual Road").length).toBeGreaterThan(0);
      });

      // Manual transaction should have Manual badge
      const manualBadges = screen.getAllByText("Manual");
      expect(manualBadges.length).toBeGreaterThan(0);
    });

    it("should NOT show Manual badge for auto-detected transactions", async () => {
      render(
        <TransactionList
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
        />,
      );

      await waitFor(() => {
        expect(screen.getAllByText("123 Pending Street").length).toBeGreaterThan(0);
      });

      // Get the pending transaction card from the desktop view (auto-detected)
      // TASK-1440: Use the desktop card (inside StatusWrapper with .bg-white)
      const pendingCards = screen.getAllByText("123 Pending Street");
      const desktopCard = pendingCards[pendingCards.length - 1].closest<HTMLElement>(".bg-white");

      // Auto-detected transactions should NOT have Manual badge
      expect(within(desktopCard!).queryByText("Manual")).not.toBeInTheDocument();
    });
  });

  describe("Filter Tabs", () => {
    it("should show all filter tabs", async () => {
      render(
        <TransactionList
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
        />,
      );

      await waitFor(() => {
        expect(screen.getAllByText("123 Pending Street").length).toBeGreaterThan(0);
      });

      // All filter tabs should be present (responsive UI renders both mobile + desktop variants)
      expect(screen.getAllByRole("button", { name: /^all/i }).length).toBeGreaterThan(0);
      expect(screen.getAllByRole("button", { name: /pending/i }).length).toBeGreaterThan(0);
      expect(screen.getAllByRole("button", { name: /^active/i }).length).toBeGreaterThan(0);
      expect(screen.getAllByRole("button", { name: /closed/i }).length).toBeGreaterThan(0);
      expect(screen.getAllByRole("button", { name: /rejected/i }).length).toBeGreaterThan(0);
    });

    it("should filter transactions when filter tab is clicked", async () => {
      const user = userEvent.setup();

      render(
        <TransactionList
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
        />,
      );

      // Wait for transactions to load
      await waitFor(() => {
        expect(screen.getAllByText("123 Pending Street").length).toBeGreaterThan(0);
      });

      // Click Active filter (use last match — desktop tab)
      const activeFilters = screen.getAllByRole("button", { name: /^active/i });
      await user.click(activeFilters[activeFilters.length - 1]);

      // Should show active transactions (confirmed and manual are both "active" status)
      await waitFor(() => {
        expect(screen.getAllByText("456 Confirmed Avenue").length).toBeGreaterThan(0);
        expect(screen.getAllByText("789 Manual Road").length).toBeGreaterThan(0);
      });

      // Pending transaction should NOT be visible (it's filtered out)
      expect(screen.queryByText("123 Pending Street")).not.toBeInTheDocument();
    });
  });
});
