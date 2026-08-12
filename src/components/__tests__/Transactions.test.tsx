/**
 * Tests for Transactions.tsx
 * Covers transaction listing, CRUD operations, filtering, and export
 *
 * Updated for responsive UI refactor: TransactionMobileCard is now the
 * only card component (no desktop TransactionCard/TransactionStatusWrapper).
 * TransactionsToolbar has collapsible search, renamed buttons, and FeatureGate.
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
import Transactions from "../Transactions";
import type { Message, Transaction } from "../../../electron/types/models";
import { PlatformProvider } from "../../contexts/PlatformContext";

// Mock useNetwork to prevent "useNetwork must be used within a NetworkProvider" error
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
    canCreateTransaction: true,
    transactionCount: 0,
    transactionLimit: 100,
    isLoading: false,
    refresh: jest.fn(),
  }),
}));

// Mock useFeatureGate so FeatureGate renders scan button (ai_addon -> ai_detection allowed)
jest.mock("../../hooks/useFeatureGate", () => ({
  useFeatureGate: () => ({
    isAllowed: () => true, // Allow all features in tests
    features: {},
    loading: false,
    hasInitialized: true,
    refresh: jest.fn(),
  }),
}));

// Mock useSubmissionSync (used by Transactions component for cloud status sync)
jest.mock("../../hooks/useSubmissionSync", () => ({
  useSubmissionSync: () => ({
    isSyncing: false,
    lastSync: null,
    syncNow: jest.fn(),
  }),
}));

describe("Transactions", () => {
  // Helper to render component with PlatformProvider
  const renderWithProvider = (ui: React.ReactElement) => {
    return render(<PlatformProvider>{ui}</PlatformProvider>);
  };
  const mockUserId = "user-123";
  const mockProvider = "google";
  const mockOnClose = jest.fn();

  const mockTransactions = [
    {
      id: "txn-1",
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
      status: "closed",
      sale_price: 325000,
      closed_at: "2024-01-20",
      total_communications_count: 18,
      email_count: 18,
      text_count: 0,
      text_thread_count: 0,
      extraction_confidence: 92,
    },
    {
      id: "txn-3",
      user_id: mockUserId,
      property_address: "789 Pine Road",
      transaction_type: "purchase",
      status: "active",
      sale_price: 550000,
      closed_at: null,
      total_communications_count: 12,
      email_count: 12,
      text_count: 0,
      text_thread_count: 0,
      extraction_confidence: 78,
    },
    // Cast: these are deliberately partial transaction rows carrying only the
    // fields the list renders (they use the legacy total_communications_count /
    // extraction_confidence aliases and a null closed_at, and omit
    // message_count / attachment_count / export_status / export_count /
    // created_at / updated_at). Filling those in would change the data the
    // component receives, so only the type is widened.
  ] as unknown as Transaction[];

  beforeEach(() => {
    jest.clearAllMocks();

    // Default mock: return transactions
    jest.mocked(window.api.transactions.getAll).mockResolvedValue({
      success: true,
      transactions: mockTransactions,
    });
    jest.mocked(window.api.onTransactionScanProgress).mockReturnValue(jest.fn());
  });

  describe("Transaction Listing", () => {
    it("should render transactions list when loaded", async () => {
      renderWithProvider(
        <Transactions
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
        />,
      );

      // Wait for transactions to load
      await waitFor(() => {
        expect(screen.getByText("123 Main Street")).toBeInTheDocument();
      });

      // Verify API was called
      expect(window.api.transactions.getAll).toHaveBeenCalledWith(mockUserId);

      // All active transactions should be visible (default filter is 'active')
      expect(screen.getByText("123 Main Street")).toBeInTheDocument();
      expect(screen.getByText("789 Pine Road")).toBeInTheDocument();
    });

    it("should show loading state initially", () => {
      // Delay the API response
      jest.mocked(window.api.transactions.getAll).mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 1000)),
      );

      renderWithProvider(
        <Transactions
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
        />,
      );

      expect(screen.getByText(/loading transactions/i)).toBeInTheDocument();
    });

    it("should show empty state when no transactions", async () => {
      jest.mocked(window.api.transactions.getAll).mockResolvedValue({
        success: true,
        transactions: [],
      });

      renderWithProvider(
        <Transactions
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText(/no transactions yet/i)).toBeInTheDocument();
      });
    });

    it("should show error when API fails", async () => {
      jest.mocked(window.api.transactions.getAll).mockResolvedValue({
        success: false,
        error: "Database connection failed",
      });

      renderWithProvider(
        <Transactions
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
        />,
      );

      await waitFor(() => {
        expect(
          screen.getByText(/database connection failed/i),
        ).toBeInTheDocument();
      });
    });

    it("should display transaction count in header", async () => {
      renderWithProvider(
        <Transactions
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText(/3 properties found/i)).toBeInTheDocument();
      });
    });
  });

  describe("Transaction Filtering", () => {
    it("should filter by active status by default", async () => {
      renderWithProvider(
        <Transactions
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("123 Main Street")).toBeInTheDocument();
      });

      // Active transactions visible
      expect(screen.getByText("123 Main Street")).toBeInTheDocument();
      expect(screen.getByText("789 Pine Road")).toBeInTheDocument();

      // Closed transaction not visible
      expect(screen.queryByText("456 Oak Avenue")).not.toBeInTheDocument();
    });

    it("should filter by closed status when clicked", async () => {
      renderWithProvider(
        <Transactions
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("123 Main Street")).toBeInTheDocument();
      });

      // Click closed filter
      const closedButton = screen.getByRole("button", { name: /closed/i });
      await userEvent.click(closedButton);

      // Closed transaction visible
      await waitFor(() => {
        expect(screen.getByText("456 Oak Avenue")).toBeInTheDocument();
      });

      // Active transactions not visible
      expect(screen.queryByText("123 Main Street")).not.toBeInTheDocument();
      expect(screen.queryByText("789 Pine Road")).not.toBeInTheDocument();
    });

    it("should show all transactions when all filter is clicked", async () => {
      renderWithProvider(
        <Transactions
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("123 Main Street")).toBeInTheDocument();
      });

      // Click "All" filter tab (accessible name is "All 3" — text + count span)
      const allButton = screen.getByRole("button", { name: /^all\s/i });
      await userEvent.click(allButton);

      // All transactions visible
      await waitFor(() => {
        expect(screen.getByText("123 Main Street")).toBeInTheDocument();
        expect(screen.getByText("456 Oak Avenue")).toBeInTheDocument();
        expect(screen.getByText("789 Pine Road")).toBeInTheDocument();
      });
    });

    it("should filter by search query", async () => {
      renderWithProvider(
        <Transactions
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("123 Main Street")).toBeInTheDocument();
      });

      // Search is collapsible — click search icon button to expand
      const searchToggle = screen.getByRole("button", { name: /search transactions/i });
      await userEvent.click(searchToggle);

      // Type in the now-visible search input
      const searchInput = screen.getByPlaceholderText(/search by address/i);
      await userEvent.type(searchInput, "Main");

      // BACKLOG-1106: Wait for 300ms debounce to apply filter
      await waitFor(() => {
        // Only matching transaction visible
        expect(screen.getByText("123 Main Street")).toBeInTheDocument();
        expect(screen.queryByText("789 Pine Road")).not.toBeInTheDocument();
      });
    });

    it("should show no matching transactions message", async () => {
      renderWithProvider(
        <Transactions
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("123 Main Street")).toBeInTheDocument();
      });

      // Search is collapsible — click search icon button to expand
      const searchToggle = screen.getByRole("button", { name: /search transactions/i });
      await userEvent.click(searchToggle);

      // Type non-matching search
      const searchInput = screen.getByPlaceholderText(/search by address/i);
      await userEvent.type(searchInput, "nonexistent");

      await waitFor(() => {
        expect(
          screen.getByText(/no matching transactions/i),
        ).toBeInTheDocument();
      });
    });
  });

  describe("Transaction Display", () => {
    it("should display transaction type correctly", async () => {
      renderWithProvider(
        <Transactions
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("123 Main Street")).toBeInTheDocument();
      });

      // Mobile card shows transaction type (e.g. "Purchase")
      expect(screen.getAllByText("Purchase").length).toBeGreaterThan(0);
    });

    it("should display email count on mobile card", async () => {
      renderWithProvider(
        <Transactions
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("123 Main Street")).toBeInTheDocument();
      });

      // Mobile card shows email count as a bare number (e.g. "25")
      expect(screen.getByText("25")).toBeInTheDocument();
    });
  });

  describe("New Transaction", () => {
    it("should open audit transaction modal when new transaction button is clicked", async () => {
      jest.mocked(window.api.contacts.getAll).mockResolvedValue({
        success: true,
        contacts: [],
      });

      renderWithProvider(
        <Transactions
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("123 Main Street")).toBeInTheDocument();
      });

      // Toolbar button text is "New" (not "New Transaction")
      const newTransactionButton = screen.getByRole("button", {
        name: /^new$/i,
      });
      await userEvent.click(newTransactionButton);

      // Audit modal should open
      await waitFor(() => {
        expect(screen.getByText(/audit new transaction/i)).toBeInTheDocument();
      });
    });
  });

  describe("Email Scan", () => {
    it("should start scan when scan button is clicked", async () => {
      jest.mocked(window.api.transactions.scan).mockResolvedValue({
        success: true,
        transactionsFound: 5,
        emailsScanned: 100,
      });

      renderWithProvider(
        <Transactions
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("123 Main Street")).toBeInTheDocument();
      });

      // Toolbar button text is "Scan" (not "Auto Detect")
      const scanButton = screen.getByRole("button", { name: /^scan$/i });
      await userEvent.click(scanButton);

      // Scan calls scan without provider (auto-detects connected providers)
      expect(window.api.transactions.scan).toHaveBeenCalledWith(mockUserId, {});
    });

    it("should show stop button while scanning", async () => {
      jest.mocked(window.api.transactions.scan).mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 1000)),
      );

      renderWithProvider(
        <Transactions
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("123 Main Street")).toBeInTheDocument();
      });

      const scanButton = screen.getByRole("button", { name: /^scan$/i });
      await userEvent.click(scanButton);

      // Button changes to "Stop" while scanning
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /^stop$/i })).toBeInTheDocument();
      });
    });

    it("should show scan results on completion", async () => {
      jest.mocked(window.api.transactions.scan).mockResolvedValue({
        success: true,
        transactionsFound: 5,
        emailsScanned: 100,
      });

      renderWithProvider(
        <Transactions
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("123 Main Street")).toBeInTheDocument();
      });

      const scanButton = screen.getByRole("button", { name: /^scan$/i });
      await userEvent.click(scanButton);

      await waitFor(() => {
        expect(screen.getByText(/found 5 transactions/i)).toBeInTheDocument();
      });
    });

    it("should show error when scan fails", async () => {
      jest.mocked(window.api.transactions.scan).mockResolvedValue({
        success: false,
        error: "Email API connection failed",
      });

      renderWithProvider(
        <Transactions
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("123 Main Street")).toBeInTheDocument();
      });

      const scanButton = screen.getByRole("button", { name: /^scan$/i });
      await userEvent.click(scanButton);

      await waitFor(() => {
        expect(
          screen.getByText(/email api connection failed/i),
        ).toBeInTheDocument();
      });
    });
  });

  describe("Bulk Actions", () => {
    it("should show edit mode button for bulk selection", async () => {
      renderWithProvider(
        <Transactions
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("123 Main Street")).toBeInTheDocument();
      });

      // Mobile UI has an "Edit" button in the toolbar for entering selection mode
      // (per-card export buttons are no longer displayed on mobile cards)
      const editButton = screen.getByRole("button", { name: /^edit$/i });
      expect(editButton).toBeInTheDocument();
    });
  });

  describe("Navigation", () => {
    it("should call onClose when back button is clicked", async () => {
      renderWithProvider(
        <Transactions
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("123 Main Street")).toBeInTheDocument();
      });

      // Back button has both "Back to Dashboard" (desktop) and "Back" (mobile)
      // rendered in the same <button>. Its accessible name includes both texts.
      const backButton = screen.getByRole("button", {
        name: /back/i,
      });
      await userEvent.click(backButton);

      expect(mockOnClose).toHaveBeenCalled();
    });

    it("should open transaction details when clicking on a transaction", async () => {
      jest.mocked(window.api.transactions.getDetails).mockResolvedValue({
        success: true,
        transaction: {
          ...mockTransactions[0],
          communications: [],
          contact_assignments: [],
        },
      });

      renderWithProvider(
        <Transactions
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("123 Main Street")).toBeInTheDocument();
      });

      // Click on the transaction card (cursor-pointer div wrapping the card)
      const transactionCard = screen.getByText("123 Main Street")
        .closest('div[class*="cursor-pointer"]');
      if (transactionCard) {
        await userEvent.click(transactionCard);
      }

      // Transaction details modal should open
      await waitFor(() => {
        expect(
          screen.getAllByText(/transaction details/i).length,
        ).toBeGreaterThan(0);
      });
    });
  });

  describe("Transaction Details Modal", () => {
    const mockTransactionWithDetails = {
      ...mockTransactions[0],
      // Cast: legacy communication row shape (sender / body_plain) that predates
      // the Message model's participants / body_text fields; preserved as-is
      // because the modal assertions read it in this form.
      communications: [
        {
          id: "comm-1",
          subject: "RE: Property Offer",
          sender: "agent@example.com",
          sent_at: "2024-03-10",
          body_plain: "Thank you for your offer on the property...",
        },
      ] as unknown as Message[],
      contact_assignments: [
        {
          id: "assign-1",
          contact_id: "contact-1",
          contact_name: "John Agent",
          contact_email: "john@realty.com",
          role: "buyer_agent",
          specific_role: "Buyer Agent",
          is_primary: 1,
        },
      ],
    };

    beforeEach(() => {
      jest.mocked(window.api.transactions.getDetails).mockResolvedValue({
        success: true,
        transaction: mockTransactionWithDetails,
      });
    });

    it("should open transaction details modal on card click", async () => {
      renderWithProvider(
        <Transactions
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("123 Main Street")).toBeInTheDocument();
      });

      // Click on the transaction card to open details
      const transactionCard = screen.getByText("123 Main Street")
        .closest('div[class*="cursor-pointer"]');
      if (transactionCard) {
        await userEvent.click(transactionCard);
      }

      // Transaction details modal should open
      await waitFor(() => {
        expect(
          screen.getAllByText(/transaction details/i).length,
        ).toBeGreaterThan(0);
      });
    });
  });

  describe("Delete Transaction", () => {
    // TODO: Fix test - delete button selector changed or feature removed
    it.skip("should have delete button in transaction details", async () => {
      jest.mocked(window.api.transactions.getDetails).mockResolvedValue({
        success: true,
        transaction: {
          ...mockTransactions[0],
          communications: [],
          contact_assignments: [],
        },
      });

      renderWithProvider(
        <Transactions
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("123 Main Street")).toBeInTheDocument();
      });

      // Click on the transaction card
      const transactionCard = screen.getByText("123 Main Street")
        .closest('div[class*="cursor-pointer"]');
      if (transactionCard) {
        await userEvent.click(transactionCard);
      }

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /delete/i }),
        ).toBeInTheDocument();
      });
    });
  });

  describe("API Integration", () => {
    it("should have getAll API available", () => {
      expect(window.api.transactions.getAll).toBeDefined();
      expect(typeof window.api.transactions.getAll).toBe("function");
    });

    it("should have scan API available", () => {
      expect(window.api.transactions.scan).toBeDefined();
      expect(typeof window.api.transactions.scan).toBe("function");
    });

    it("should have delete API available", () => {
      expect(window.api.transactions.delete).toBeDefined();
      expect(typeof window.api.transactions.delete).toBe("function");
    });

    it("should have update API available", () => {
      expect(window.api.transactions.update).toBeDefined();
      expect(typeof window.api.transactions.update).toBe("function");
    });
  });
});
