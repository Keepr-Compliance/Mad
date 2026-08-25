/**
 * Tests for StartNewAuditModal.tsx
 * Tests the redesigned "Start New Audit" flow that emphasizes
 * AI-detected transactions over manual creation
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import StartNewAuditModal from "../StartNewAuditModal";

// Mock the NetworkContext (TASK-2056)
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

// Mock the AuthContext
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

// Mock the LicenseContext for LicenseGate
jest.mock("../../contexts/LicenseContext", () => ({
  useLicense: () => ({
    licenseType: "individual" as const,
    hasAIAddon: true, // Enable AI features for testing
    organizationId: null,
    canExport: true,
    canSubmit: false,
    canAutoDetect: true,
    canCreateTransaction: true, // Enable transaction creation for testing
    transactionCount: 0,
    transactionLimit: 10,
    isLoading: false,
    refresh: jest.fn(),
  }),
}));

// TASK-2160: Mock useFeatureGate (used directly by StartNewAuditModal and LicenseGate)
jest.mock("../../hooks/useFeatureGate", () => ({
  useFeatureGate: () => ({
    isAllowed: () => true, // All features allowed for testing
    features: {},
    loading: false,
    hasInitialized: true,
    refresh: jest.fn(),
  }),
}));

describe("StartNewAuditModal", () => {
  const mockOnSelectPendingTransaction = jest.fn();
  const mockOnViewActiveTransactions = jest.fn();
  const mockOnCreateManually = jest.fn();
  const mockOnClose = jest.fn();

  const mockPendingTransactions = [
    {
      id: "txn-1",
      user_id: "test-user-123",
      property_address: "123 Main St, San Francisco, CA 94102",
      transaction_type: "purchase" as const,
      status: "pending" as const,
      detection_status: "pending" as const,
      detection_confidence: 0.85,
      listing_price: 750000,
      message_count: 5,
      attachment_count: 2,
      export_status: "not_exported" as const,
      export_count: 0,
      created_at: "2025-01-09T10:00:00Z",
      updated_at: "2025-01-09T10:00:00Z",
    },
    {
      id: "txn-2",
      user_id: "test-user-123",
      property_address: "456 Oak Ave, Los Angeles, CA 90001",
      transaction_type: "sale" as const,
      status: "pending" as const,
      detection_status: "pending" as const,
      detection_confidence: 0.72,
      listing_price: 1200000,
      message_count: 8,
      attachment_count: 3,
      export_status: "not_exported" as const,
      export_count: 0,
      created_at: "2025-01-08T14:00:00Z",
      updated_at: "2025-01-08T14:00:00Z",
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();

    // Default mock - returns pending transactions
    jest.mocked(window.api.transactions.getAll).mockResolvedValue({
      success: true,
      transactions: mockPendingTransactions,
    });
  });

  const renderModal = () => {
    return render(
      <StartNewAuditModal
        onSelectPendingTransaction={mockOnSelectPendingTransaction}
        onViewActiveTransactions={mockOnViewActiveTransactions}
        onCreateManually={mockOnCreateManually}
        onClose={mockOnClose}
      />
    );
  };

  describe("Rendering", () => {
    it("should render the modal with correct title", async () => {
      renderModal();

      expect(screen.getByText("Start New Audit")).toBeInTheDocument();
      expect(
        screen.getByText(/review ai-detected transactions or create one manually/i)
      ).toBeInTheDocument();
    });

    it("should show AI-Detected Transactions section", async () => {
      renderModal();

      expect(screen.getByText("AI-Detected Transactions")).toBeInTheDocument();
    });

    it("should show loading state while fetching transactions", () => {
      // Mock a delayed response
      jest.mocked(window.api.transactions.getAll).mockReturnValue(new Promise(() => {}));

      renderModal();

      // Should show loading spinner (we can check for the spin animation class)
      const spinners = document.querySelectorAll(".animate-spin");
      expect(spinners.length).toBeGreaterThan(0);
    });

    it("should display pending transactions count badge", async () => {
      renderModal();

      await waitFor(() => {
        expect(screen.getByText("2 pending")).toBeInTheDocument();
      });
    });

    it("should render View Active Transactions button", async () => {
      renderModal();

      await waitFor(() => {
        expect(
          screen.getByTestId("view-active-transactions-button")
        ).toBeInTheDocument();
        expect(screen.getByText("View Active Transactions")).toBeInTheDocument();
      });
    });

    it("should render Add Manually button", async () => {
      renderModal();

      await waitFor(() => {
        expect(screen.getByTestId("create-manually-button")).toBeInTheDocument();
        expect(screen.getByText("Add Manually")).toBeInTheDocument();
      });
    });
  });

  describe("Pending Transactions List", () => {
    it("should display all pending transactions", async () => {
      renderModal();

      await waitFor(() => {
        expect(screen.getByText("123 Main St, San Francisco, CA 94102")).toBeInTheDocument();
        expect(screen.getByText("456 Oak Ave, Los Angeles, CA 90001")).toBeInTheDocument();
      });
    });

    it("should show transaction type for each pending transaction", async () => {
      renderModal();

      await waitFor(() => {
        // BACKLOG-2805: this asserted the RAW ENUM ("purchase" / "sale"),
        // which is the defect written down as an expectation — the row
        // printed the stored value and let CSS `capitalize` make it look
        // like a label. It now asserts the founder-ruled display strings.
        expect(screen.getByText("Listing")).toBeInTheDocument();
        expect(screen.getByText("Sale")).toBeInTheDocument();
      });
    });

    it("should display confidence score for transactions", async () => {
      renderModal();

      await waitFor(() => {
        expect(screen.getByText("85% confidence")).toBeInTheDocument();
        expect(screen.getByText("72% confidence")).toBeInTheDocument();
      });
    });

    it("should show formatted listing price", async () => {
      renderModal();

      await waitFor(() => {
        expect(screen.getByText("$750,000")).toBeInTheDocument();
        expect(screen.getByText("$1,200,000")).toBeInTheDocument();
      });
    });
  });

  describe("Empty State", () => {
    it("should show empty state when no pending transactions", async () => {
      jest.mocked(window.api.transactions.getAll).mockResolvedValue({
        success: true,
        transactions: [],
      });

      renderModal();

      await waitFor(() => {
        expect(screen.getByText("All Caught Up")).toBeInTheDocument();
        expect(
          screen.getByText(/no pending transactions to review/i)
        ).toBeInTheDocument();
      });
    });

    it("should NOT show pending count badge when empty", async () => {
      jest.mocked(window.api.transactions.getAll).mockResolvedValue({
        success: true,
        transactions: [],
      });

      renderModal();

      await waitFor(() => {
        expect(screen.queryByText(/pending$/)).not.toBeInTheDocument();
      });
    });
  });

  describe("Error Handling", () => {
    it("should display error message when fetch fails", async () => {
      jest.mocked(window.api.transactions.getAll).mockResolvedValue({
        success: false,
        error: "Failed to fetch transactions",
      });

      renderModal();

      await waitFor(() => {
        expect(
          screen.getByText("Failed to fetch transactions")
        ).toBeInTheDocument();
      });
    });

    it("should display error for network failures", async () => {
      jest.mocked(window.api.transactions.getAll).mockRejectedValue(
        new Error("Network error")
      );

      renderModal();

      await waitFor(() => {
        expect(screen.getByText("Network error")).toBeInTheDocument();
      });
    });
  });

  describe("User Interactions", () => {
    it("should call onClose when close button is clicked", async () => {
      const user = userEvent.setup();
      renderModal();

      const closeButton = screen.getByRole("button", { name: /close modal/i });
      await user.click(closeButton);

      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });

    it("should call onSelectPendingTransaction when clicking a pending transaction", async () => {
      const user = userEvent.setup();
      renderModal();

      await waitFor(() => {
        expect(screen.getByTestId("pending-transaction-txn-1")).toBeInTheDocument();
      });

      await user.click(screen.getByTestId("pending-transaction-txn-1"));

      expect(mockOnSelectPendingTransaction).toHaveBeenCalledTimes(1);
      expect(mockOnSelectPendingTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "txn-1",
          property_address: "123 Main St, San Francisco, CA 94102",
        })
      );
    });

    it("should call onViewActiveTransactions when clicking View Active Transactions", async () => {
      const user = userEvent.setup();
      renderModal();

      await waitFor(() => {
        expect(
          screen.getByTestId("view-active-transactions-button")
        ).toBeInTheDocument();
      });

      await user.click(screen.getByTestId("view-active-transactions-button"));

      expect(mockOnViewActiveTransactions).toHaveBeenCalledTimes(1);
    });

    it("should call onCreateManually when clicking Add Manually", async () => {
      const user = userEvent.setup();
      renderModal();

      await waitFor(() => {
        expect(screen.getByTestId("create-manually-button")).toBeInTheDocument();
      });

      await user.click(screen.getByTestId("create-manually-button"));

      expect(mockOnCreateManually).toHaveBeenCalledTimes(1);
    });
  });

  describe("Visual Hierarchy", () => {
    it("should render pending transactions section before secondary actions", async () => {
      renderModal();

      await waitFor(() => {
        const modal = screen.getByTestId("start-new-audit-modal");
        const modalText = modal.textContent || "";

        // AI-Detected Transactions should appear before View Active Transactions and Add Manually
        const aiDetectedIndex = modalText.indexOf("AI-Detected Transactions");
        const viewActiveIndex = modalText.indexOf("View Active Transactions");
        const addManuallyIndex = modalText.indexOf("Add Manually");

        expect(aiDetectedIndex).toBeLessThan(viewActiveIndex);
        expect(aiDetectedIndex).toBeLessThan(addManuallyIndex);
      });
    });

    it("should have Other Options divider between sections", async () => {
      renderModal();

      await waitFor(() => {
        expect(screen.getByText("Other Options")).toBeInTheDocument();
      });
    });
  });

  describe("Accessibility", () => {
    it("should have accessible close button", async () => {
      renderModal();

      expect(
        screen.getByRole("button", { name: /close modal/i })
      ).toBeInTheDocument();
    });

    it("should render pending transactions as buttons for accessibility", async () => {
      renderModal();

      await waitFor(() => {
        const pendingTransaction = screen.getByTestId("pending-transaction-txn-1");
        expect(pendingTransaction.tagName).toBe("BUTTON");
      });
    });
  });
});
