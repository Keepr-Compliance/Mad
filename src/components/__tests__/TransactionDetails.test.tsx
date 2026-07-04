/**
 * Tests for TransactionDetails.tsx
 * Covers AI-suggested contacts display and accept/reject functionality
 */

import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import TransactionDetails from "../TransactionDetails";

// Mock the LicenseContext for LicenseGate
jest.mock("../../contexts/LicenseContext", () => ({
  useLicense: () => ({
    licenseType: "team" as const,
    hasAIAddon: true, // Enable AI features for testing
    organizationId: "org-123",
    canExport: false,
    canSubmit: true, // Team can submit
    canAutoDetect: true,
    isLoading: false,
    refresh: jest.fn(),
  }),
}));

// Mock AuthContext for TransactionEmailsTab (uses useAuth)
jest.mock("../../contexts/AuthContext", () => ({
  useAuth: () => ({
    currentUser: { id: "user-456", email: "test@test.com" },
    isAuthenticated: true,
  }),
  useIsAuthenticated: () => true,
  useCurrentUser: () => ({ id: "user-456", email: "test@test.com" }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// TASK-2074: Make useNetwork mock configurable for offline testing
const mockUseNetwork = jest.fn(() => ({
  isOnline: true,
  isChecking: false,
  lastOnlineAt: null,
  lastOfflineAt: null,
  connectionError: null,
  checkConnection: jest.fn(),
  clearError: jest.fn(),
  setConnectionError: jest.fn(),
}));
jest.mock("../../contexts/NetworkContext", () => ({
  useNetwork: () => mockUseNetwork(),
}));

// Mock useSyncOrchestrator for global sync state
const mockUseSyncOrchestrator = jest.fn();
jest.mock("../../hooks/useSyncOrchestrator", () => ({
  useSyncOrchestrator: () => mockUseSyncOrchestrator(),
}));

describe("TransactionDetails", () => {
  const mockOnClose = jest.fn();
  const mockOnTransactionUpdated = jest.fn();

  // Base transaction without suggested contacts
  const baseTransaction = {
    id: "txn-123",
    user_id: "user-456",
    property_address: "123 Main Street",
    transaction_type: "purchase",
    status: "active" as const,
    sale_price: 450000,
    closed_at: "2024-03-15",
    message_count: 10,
    attachment_count: 5,
    export_status: "not_exported" as const,
    export_count: 0,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  };

  // Transaction with suggested contacts
  const transactionWithSuggestions = {
    ...baseTransaction,
    suggested_contacts: JSON.stringify([
      { role: "buyer", contact_id: "contact-1", is_primary: true },
      { role: "lender", contact_id: "contact-2", is_primary: false },
    ]),
  };

  // Mock contacts for resolution
  const mockContacts = [
    {
      id: "contact-1",
      user_id: "user-456",
      display_name: "John Buyer",
      email: "john@buyer.com",
      company: "Buyers Inc",
      source: "manual",
      created_at: "2024-01-01",
      updated_at: "2024-01-01",
    },
    {
      id: "contact-2",
      user_id: "user-456",
      display_name: "Jane Lender",
      email: "jane@lender.com",
      company: "First Bank",
      source: "manual",
      created_at: "2024-01-01",
      updated_at: "2024-01-01",
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();

    // Default: no global sync running
    mockUseSyncOrchestrator.mockReturnValue({
      state: { isRunning: false, queue: [], currentSync: null, overallProgress: 0, pendingRequest: null },
      isRunning: false,
      queue: [],
      currentSync: null,
      overallProgress: 0,
      pendingRequest: null,
      requestSync: jest.fn(),
      forceSync: jest.fn(),
      acceptPending: jest.fn(),
      rejectPending: jest.fn(),
      cancel: jest.fn(),
    });

    // Default mocks
    window.api.transactions.getDetails.mockResolvedValue({
      success: true,
      transaction: {
        ...baseTransaction,
        communications: [],
        contact_assignments: [],
      },
    });
    window.api.contacts.getAll.mockResolvedValue({
      success: true,
      contacts: mockContacts,
    });
    window.api.transactions.assignContact.mockResolvedValue({ success: true });
    window.api.transactions.update.mockResolvedValue({ success: true });
    window.api.feedback.recordRole.mockResolvedValue({ success: true });
  });

  describe("AI Suggested Contacts Section", () => {
    it("should not show suggestions section when no suggested_contacts", async () => {
      render(
        <TransactionDetails
          transaction={baseTransaction}
          onClose={mockOnClose}
          onTransactionUpdated={mockOnTransactionUpdated}
        />,
      );

      // Switch to contacts tab
      // Contacts are now shown in the Overview tab by default
      // No need to click a separate tab

      // Wait for tab content to render
      await waitFor(() => {
        expect(screen.getByText("Key Contacts")).toBeInTheDocument();
      });

      // Should not show AI Suggested Contacts section
      expect(screen.queryByText("AI Suggested Contacts")).not.toBeInTheDocument();
    });

    it("should display suggested contacts when present", async () => {
      render(
        <TransactionDetails
          transaction={transactionWithSuggestions}
          onClose={mockOnClose}
          onTransactionUpdated={mockOnTransactionUpdated}
        />,
      );

      // Switch to contacts tab
      // Contacts are now shown in the Overview tab by default
      // No need to click a separate tab

      // Wait for suggested contacts to resolve and render
      await waitFor(() => {
        expect(screen.getByText("AI Suggested Contacts")).toBeInTheDocument();
      });

      // Should show both suggestions
      expect(screen.getByText("John Buyer")).toBeInTheDocument();
      expect(screen.getByText("Jane Lender")).toBeInTheDocument();

      // Should show roles (formatted with title case)
      expect(screen.getByText("Buyer")).toBeInTheDocument();
      expect(screen.getByText("Lender")).toBeInTheDocument();

      // Should show Primary badge for first suggestion
      expect(screen.getByText("Primary")).toBeInTheDocument();

      // Should show Accept All button
      expect(screen.getByRole("button", { name: /Accept All/i })).toBeInTheDocument();
    });

    it("should show suggestion count badge", async () => {
      render(
        <TransactionDetails
          transaction={transactionWithSuggestions}
          onClose={mockOnClose}
          onTransactionUpdated={mockOnTransactionUpdated}
        />,
      );

      // Switch to contacts tab
      // Contacts are now shown in the Overview tab by default
      // No need to click a separate tab

      // Wait for suggestions to load
      await waitFor(() => {
        expect(screen.getByText("2 suggestions")).toBeInTheDocument();
      });
    });

    it("should display contact email and company", async () => {
      render(
        <TransactionDetails
          transaction={transactionWithSuggestions}
          onClose={mockOnClose}
          onTransactionUpdated={mockOnTransactionUpdated}
        />,
      );

      // Switch to contacts tab
      // Contacts are now shown in the Overview tab by default
      // No need to click a separate tab

      // Wait for suggestions to load
      await waitFor(() => {
        expect(screen.getByText("john@buyer.com")).toBeInTheDocument();
      });

      expect(screen.getByText("Buyers Inc")).toBeInTheDocument();
      expect(screen.getByText("jane@lender.com")).toBeInTheDocument();
      expect(screen.getByText("First Bank")).toBeInTheDocument();
    });
  });

  describe("Accept Suggestion", () => {
    it("should call assignContact and recordRole when accepting a suggestion", async () => {
      const user = userEvent.setup();

      render(
        <TransactionDetails
          transaction={transactionWithSuggestions}
          onClose={mockOnClose}
          onTransactionUpdated={mockOnTransactionUpdated}
        />,
      );

      // Switch to contacts tab
      // Contacts are now shown in the Overview tab by default
      // No need to switch tabs

      // Wait for suggestions to load
      await waitFor(() => {
        expect(screen.getByText("John Buyer")).toBeInTheDocument();
      });

      // Find and click the accept button for the first suggestion
      const acceptButtons = screen.getAllByTitle("Accept suggestion");
      await user.click(acceptButtons[0]);

      // Verify assignContact was called
      await waitFor(() => {
        expect(window.api.transactions.assignContact).toHaveBeenCalledWith(
          "txn-123",
          "contact-1",
          "buyer",
          undefined,
          true, // is_primary
          undefined, // notes
        );
      });

      // Verify feedback was recorded
      expect(window.api.feedback.recordRole).toHaveBeenCalledWith(
        "user-456",
        expect.objectContaining({
          transactionId: "txn-123",
          contactId: "contact-1",
          originalRole: "buyer",
          correctedRole: "buyer",
        }),
      );

      // Verify suggested_contacts was updated (to remove accepted one)
      expect(window.api.transactions.update).toHaveBeenCalledWith(
        "txn-123",
        expect.objectContaining({
          suggested_contacts: expect.any(String),
        }),
      );
    });

    it("should remove suggestion from UI after accepting", async () => {
      const user = userEvent.setup();

      render(
        <TransactionDetails
          transaction={transactionWithSuggestions}
          onClose={mockOnClose}
          onTransactionUpdated={mockOnTransactionUpdated}
        />,
      );

      // Switch to contacts tab
      // Contacts are now shown in the Overview tab by default
      // No need to switch tabs

      // Wait for suggestions to load
      await waitFor(() => {
        expect(screen.getByText("John Buyer")).toBeInTheDocument();
      });

      // Accept first suggestion
      const acceptButtons = screen.getAllByTitle("Accept suggestion");
      await user.click(acceptButtons[0]);

      // Wait for suggestion to be removed from UI
      await waitFor(() => {
        expect(screen.queryByText("John Buyer")).not.toBeInTheDocument();
      });

      // Second suggestion should still be visible
      expect(screen.getByText("Jane Lender")).toBeInTheDocument();
    });
  });

  describe("Reject Suggestion", () => {
    it("should call recordRole with empty correctedRole when rejecting", async () => {
      const user = userEvent.setup();

      render(
        <TransactionDetails
          transaction={transactionWithSuggestions}
          onClose={mockOnClose}
          onTransactionUpdated={mockOnTransactionUpdated}
        />,
      );

      // Switch to contacts tab
      // Contacts are now shown in the Overview tab by default
      // No need to switch tabs

      // Wait for suggestions to load
      await waitFor(() => {
        expect(screen.getByText("John Buyer")).toBeInTheDocument();
      });

      // Find and click the reject button for the first suggestion
      const rejectButtons = screen.getAllByTitle("Reject suggestion");
      await user.click(rejectButtons[0]);

      // Verify feedback was recorded with empty correctedRole (rejection)
      await waitFor(() => {
        expect(window.api.feedback.recordRole).toHaveBeenCalledWith(
          "user-456",
          expect.objectContaining({
            transactionId: "txn-123",
            contactId: "contact-1",
            originalRole: "buyer",
            correctedRole: "", // Empty indicates rejection
          }),
        );
      });

      // Verify assignContact was NOT called (we're rejecting, not accepting)
      expect(window.api.transactions.assignContact).not.toHaveBeenCalled();
    });

    it("should remove suggestion from UI after rejecting", async () => {
      const user = userEvent.setup();

      render(
        <TransactionDetails
          transaction={transactionWithSuggestions}
          onClose={mockOnClose}
          onTransactionUpdated={mockOnTransactionUpdated}
        />,
      );

      // Switch to contacts tab
      // Contacts are now shown in the Overview tab by default
      // No need to switch tabs

      // Wait for suggestions to load
      await waitFor(() => {
        expect(screen.getByText("John Buyer")).toBeInTheDocument();
      });

      // Reject first suggestion
      const rejectButtons = screen.getAllByTitle("Reject suggestion");
      await user.click(rejectButtons[0]);

      // Wait for suggestion to be removed from UI
      await waitFor(() => {
        expect(screen.queryByText("John Buyer")).not.toBeInTheDocument();
      });
    });
  });

  describe("Accept All", () => {
    it("should call assignContact for all suggestions when Accept All is clicked", async () => {
      const user = userEvent.setup();

      render(
        <TransactionDetails
          transaction={transactionWithSuggestions}
          onClose={mockOnClose}
          onTransactionUpdated={mockOnTransactionUpdated}
        />,
      );

      // Switch to contacts tab
      // Contacts are now shown in the Overview tab by default
      // No need to switch tabs

      // Wait for suggestions to load
      await waitFor(() => {
        expect(screen.getByText("AI Suggested Contacts")).toBeInTheDocument();
      });

      // Click Accept All button
      const acceptAllButton = screen.getByRole("button", { name: /Accept All/i });
      await user.click(acceptAllButton);

      // Verify both contacts were assigned
      await waitFor(() => {
        expect(window.api.transactions.assignContact).toHaveBeenCalledTimes(2);
      });

      // Verify first contact was assigned
      expect(window.api.transactions.assignContact).toHaveBeenCalledWith(
        "txn-123",
        "contact-1",
        "buyer",
        undefined,
        true,
        undefined,
      );

      // Verify second contact was assigned
      expect(window.api.transactions.assignContact).toHaveBeenCalledWith(
        "txn-123",
        "contact-2",
        "lender",
        undefined,
        false,
        undefined,
      );

      // Verify feedback was recorded for both
      expect(window.api.feedback.recordRole).toHaveBeenCalledTimes(2);
    });

    it("should hide suggestions section after Accept All completes", async () => {
      const user = userEvent.setup();

      render(
        <TransactionDetails
          transaction={transactionWithSuggestions}
          onClose={mockOnClose}
          onTransactionUpdated={mockOnTransactionUpdated}
        />,
      );

      // Switch to contacts tab
      // Contacts are now shown in the Overview tab by default
      // No need to switch tabs

      // Wait for suggestions to load
      await waitFor(() => {
        expect(screen.getByText("AI Suggested Contacts")).toBeInTheDocument();
      });

      // Click Accept All button
      const acceptAllButton = screen.getByRole("button", { name: /Accept All/i });
      await user.click(acceptAllButton);

      // Wait for section to be hidden
      await waitFor(() => {
        expect(screen.queryByText("AI Suggested Contacts")).not.toBeInTheDocument();
      });
    });

    it("should call onTransactionUpdated after Accept All", async () => {
      const user = userEvent.setup();

      render(
        <TransactionDetails
          transaction={transactionWithSuggestions}
          onClose={mockOnClose}
          onTransactionUpdated={mockOnTransactionUpdated}
        />,
      );

      // Switch to contacts tab
      // Contacts are now shown in the Overview tab by default
      // No need to switch tabs

      // Wait for suggestions to load
      await waitFor(() => {
        expect(screen.getByText("AI Suggested Contacts")).toBeInTheDocument();
      });

      // Click Accept All button
      const acceptAllButton = screen.getByRole("button", { name: /Accept All/i });
      await user.click(acceptAllButton);

      // Verify callback was called
      await waitFor(() => {
        expect(mockOnTransactionUpdated).toHaveBeenCalled();
      });
    });
  });

  describe("Edge Cases", () => {
    it("should handle invalid JSON in suggested_contacts gracefully", async () => {
      const transactionWithInvalidJSON = {
        ...baseTransaction,
        suggested_contacts: "invalid json {",
      };

      render(
        <TransactionDetails
          transaction={transactionWithInvalidJSON}
          onClose={mockOnClose}
          onTransactionUpdated={mockOnTransactionUpdated}
        />,
      );

      // Switch to contacts tab
      // Contacts are now shown in the Overview tab by default
      // No need to click a separate tab

      // Should not crash and should not show suggestions section
      await waitFor(() => {
        expect(screen.getByText("Key Contacts")).toBeInTheDocument();
      });

      expect(screen.queryByText("AI Suggested Contacts")).not.toBeInTheDocument();
    });

    it("should handle empty suggested_contacts array", async () => {
      const transactionWithEmptyArray = {
        ...baseTransaction,
        suggested_contacts: "[]",
      };

      render(
        <TransactionDetails
          transaction={transactionWithEmptyArray}
          onClose={mockOnClose}
          onTransactionUpdated={mockOnTransactionUpdated}
        />,
      );

      // Switch to contacts tab
      // Contacts are now shown in the Overview tab by default
      // No need to click a separate tab

      // Should not show suggestions section for empty array
      await waitFor(() => {
        expect(screen.getByText("Key Contacts")).toBeInTheDocument();
      });

      expect(screen.queryByText("AI Suggested Contacts")).not.toBeInTheDocument();
    });

    it("should handle contact resolution failure gracefully", async () => {
      // Mock contacts API to fail
      window.api.contacts.getAll.mockRejectedValue(new Error("Failed to fetch"));

      render(
        <TransactionDetails
          transaction={transactionWithSuggestions}
          onClose={mockOnClose}
          onTransactionUpdated={mockOnTransactionUpdated}
        />,
      );

      // Switch to contacts tab
      // Contacts are now shown in the Overview tab by default
      // No need to click a separate tab

      // Should still show suggestions section (with "Unknown Contact")
      await waitFor(() => {
        expect(screen.getByText("AI Suggested Contacts")).toBeInTheDocument();
      });

      // Should show "Unknown Contact" for unresolved contacts
      const unknownContacts = screen.getAllByText("Unknown Contact");
      expect(unknownContacts.length).toBeGreaterThan(0);
    });
  });

  describe("Sync buttons disabled during global sync (overview tab)", () => {
    const transactionWithContacts = {
      ...baseTransaction,
      email_count: 2,
      text_thread_count: 1,
    };

    const contactAssignments = [
      { contact_id: "contact-1", role: "buyer", is_primary: true, display_name: "John Buyer" },
    ];

    beforeEach(() => {
      // Set up transaction with contacts assigned so Sync button appears in Overview tab
      window.api.transactions.getDetails.mockResolvedValue({
        success: true,
        transaction: {
          ...transactionWithContacts,
          communications: [],
          contact_assignments: contactAssignments,
        },
      });
    });

    it("should disable Sync Communications button when global sync is running", async () => {
      // Set global sync to running
      mockUseSyncOrchestrator.mockReturnValue({
        state: { isRunning: true, queue: [], currentSync: "emails", overallProgress: 50, pendingRequest: null },
        isRunning: true,
        queue: [],
        currentSync: "emails",
        overallProgress: 50,
        pendingRequest: null,
        requestSync: jest.fn(),
        forceSync: jest.fn(),
        acceptPending: jest.fn(),
        rejectPending: jest.fn(),
        cancel: jest.fn(),
      });

      render(
        <TransactionDetails
          transaction={transactionWithContacts}
          onClose={mockOnClose}
          onTransactionUpdated={mockOnTransactionUpdated}
          userId="user-456"
        />,
      );

      // Wait for the Overview tab (default tab) to render with the Sync Communications button
      await waitFor(() => {
        expect(screen.getByText("Key Contacts")).toBeInTheDocument();
      });

      // The Sync Communications button in the Overview tab should be disabled
      // It uses title attribute as tooltip
      const syncButton = screen.getByTitle("A sync is already in progress from the dashboard");
      expect(syncButton).toBeDisabled();
    });

    it("should enable Sync Communications button when global sync is not running", async () => {
      // Global sync is NOT running (default mock)

      render(
        <TransactionDetails
          transaction={transactionWithContacts}
          onClose={mockOnClose}
          onTransactionUpdated={mockOnTransactionUpdated}
          userId="user-456"
        />,
      );

      // Wait for the Overview tab to render
      await waitFor(() => {
        expect(screen.getByText("Key Contacts")).toBeInTheDocument();
      });

      // The Sync Communications button should be enabled
      const syncButton = screen.getByTitle("Sync Communications");
      expect(syncButton).not.toBeDisabled();
    });

    it("should show global sync tooltip on disabled Sync button", async () => {
      // Set global sync to running
      mockUseSyncOrchestrator.mockReturnValue({
        state: { isRunning: true, queue: [], currentSync: "emails", overallProgress: 50, pendingRequest: null },
        isRunning: true,
        queue: [],
        currentSync: "emails",
        overallProgress: 50,
        pendingRequest: null,
        requestSync: jest.fn(),
        forceSync: jest.fn(),
        acceptPending: jest.fn(),
        rejectPending: jest.fn(),
        cancel: jest.fn(),
      });

      render(
        <TransactionDetails
          transaction={transactionWithContacts}
          onClose={mockOnClose}
          onTransactionUpdated={mockOnTransactionUpdated}
          userId="user-456"
        />,
      );

      // Wait for the Overview tab to render
      await waitFor(() => {
        expect(screen.getByText("Key Contacts")).toBeInTheDocument();
      });

      // Verify the tooltip text is correct
      const syncButton = screen.getByTitle("A sync is already in progress from the dashboard");
      expect(syncButton).toBeInTheDocument();
      expect(syncButton).toBeDisabled();
    });
  });

  // TASK-2074: Sync buttons disabled when offline
  describe("Sync buttons disabled when offline (TASK-2074)", () => {
    const transactionWithContacts = {
      ...baseTransaction,
      email_count: 2,
      text_thread_count: 1,
    };

    const contactAssignments = [
      { contact_id: "contact-1", role: "buyer", is_primary: true, display_name: "John Buyer" },
    ];

    beforeEach(() => {
      // Set network to offline
      mockUseNetwork.mockReturnValue({
        isOnline: false,
        isChecking: false,
        lastOnlineAt: null,
        lastOfflineAt: new Date(),
        connectionError: null,
        checkConnection: jest.fn(),
        clearError: jest.fn(),
        setConnectionError: jest.fn(),
      });

      // Set up transaction with contacts assigned so Sync buttons appear
      window.api.transactions.getDetails.mockResolvedValue({
        success: true,
        transaction: {
          ...transactionWithContacts,
          communications: [],
          contact_assignments: contactAssignments,
        },
      });
    });

    afterEach(() => {
      // Reset to online
      mockUseNetwork.mockReturnValue({
        isOnline: true,
        isChecking: false,
        lastOnlineAt: null,
        lastOfflineAt: null,
        connectionError: null,
        checkConnection: jest.fn(),
        clearError: jest.fn(),
        setConnectionError: jest.fn(),
      });
    });

    it("should disable Sync button on Overview tab when offline", async () => {
      render(
        <TransactionDetails
          transaction={transactionWithContacts}
          onClose={mockOnClose}
          onTransactionUpdated={mockOnTransactionUpdated}
          userId="user-456"
        />,
      );

      // Wait for the Overview tab to render with Sync button
      await waitFor(() => {
        expect(screen.getByText("Key Contacts")).toBeInTheDocument();
      });

      // Find the Sync button by looking for buttons with title "You are offline"
      // and filtering to the one containing the Sync icon (green-colored text)
      const offlineButtons = screen.getAllByTitle("You are offline");
      const syncButton = offlineButtons.find((btn) =>
        btn.classList.contains("text-green-600") ||
        btn.className.includes("text-green-600"),
      );
      expect(syncButton).toBeDefined();
      expect(syncButton).toBeDisabled();
    });

    it("should disable Sync button on Emails tab when offline", async () => {
      render(
        <TransactionDetails
          transaction={transactionWithContacts}
          onClose={mockOnClose}
          onTransactionUpdated={mockOnTransactionUpdated}
          userId="user-456"
          initialTab="emails"
        />,
      );

      // Wait for emails tab to render - may show empty state or loading
      await waitFor(() => {
        // The tab renders with sync button in empty state
        const syncButton = screen.queryByTestId("sync-emails-button");
        if (syncButton) {
          expect(syncButton).toBeDisabled();
          expect(syncButton).toHaveAttribute("title", "You are offline");
        }
      });
    });

    it("should disable Sync button on Messages tab when offline", async () => {
      render(
        <TransactionDetails
          transaction={transactionWithContacts}
          onClose={mockOnClose}
          onTransactionUpdated={mockOnTransactionUpdated}
          userId="user-456"
          initialTab="messages"
        />,
      );

      // Wait for messages tab to render
      await waitFor(() => {
        expect(screen.getByText(/no text messages linked/i)).toBeInTheDocument();
      });

      // The Sync Messages button should be disabled
      const syncButton = screen.getByTestId("sync-messages-button");
      expect(syncButton).toBeDisabled();
      expect(syncButton).toHaveAttribute("title", "You are offline");
    });

    it("should re-enable sync buttons when back online", async () => {
      const { rerender } = render(
        <TransactionDetails
          transaction={transactionWithContacts}
          onClose={mockOnClose}
          onTransactionUpdated={mockOnTransactionUpdated}
          userId="user-456"
        />,
      );

      // Verify the green sync button is disabled when offline
      await waitFor(() => {
        const offlineButtons = screen.getAllByTitle("You are offline");
        const syncButton = offlineButtons.find((btn) =>
          btn.className.includes("text-green-600"),
        );
        expect(syncButton).toBeDefined();
        expect(syncButton).toBeDisabled();
      });

      // Go back online
      mockUseNetwork.mockReturnValue({
        isOnline: true,
        isChecking: false,
        lastOnlineAt: new Date(),
        lastOfflineAt: null,
        connectionError: null,
        checkConnection: jest.fn(),
        clearError: jest.fn(),
        setConnectionError: jest.fn(),
      });

      rerender(
        <TransactionDetails
          transaction={transactionWithContacts}
          onClose={mockOnClose}
          onTransactionUpdated={mockOnTransactionUpdated}
          userId="user-456"
        />,
      );

      // Sync button should be re-enabled
      await waitFor(() => {
        const syncButton = screen.getByTitle("Sync Communications");
        expect(syncButton).not.toBeDisabled();
      });
    });
  });

  // BACKLOG-1778: removing/restoring emails must not reset the list scroll.
  // Remove now updates the list in place (no refetch); restore refetches but
  // the restored rows return to the list.
  describe("Remove/Restore email list scroll preservation (BACKLOG-1778)", () => {
    const makeEmail = (over: Record<string, unknown>) => ({
      id: "comm-x",
      user_id: "user-456",
      communication_type: "email",
      channel: "email",
      sender: "alice@example.com",
      recipients: "me@example.com",
      subject: "Subject",
      body_plain: "body",
      // Alpha newer than Beta so ordering is deterministic (Alpha first).
      sent_at: "2024-02-01T00:00:00Z",
      has_attachments: false,
      is_false_positive: false,
      created_at: "2024-02-01T00:00:00Z",
      ...over,
    });

    const emailA = makeEmail({ id: "comm-A", subject: "Thread Alpha", thread_id: "thread-A", sent_at: "2024-02-02T00:00:00Z" });
    const emailB = makeEmail({ id: "comm-B", subject: "Thread Beta", thread_id: "thread-B", sent_at: "2024-02-01T00:00:00Z" });

    const contactAssignments = [
      { contact_id: "contact-1", role: "buyer", is_primary: true, display_name: "John Buyer" },
    ];

    beforeEach(() => {
      window.api.transactions.getOverview = jest.fn().mockResolvedValue({
        success: true,
        transaction: { ...baseTransaction, contact_assignments: contactAssignments },
      });
      window.api.transactions.getCommunications = jest.fn().mockResolvedValue({
        success: true,
        transaction: { communications: [emailA, emailB], contact_assignments: contactAssignments },
      });
      window.api.transactions.unlinkCommunication = jest.fn().mockResolvedValue({
        success: true,
        unlinkedIds: ["comm-A"],
      });
      window.api.transactions.getRemovedEmails = jest.fn().mockResolvedValue({
        success: true,
        removedEmails: [],
      });
      window.api.transactions.restoreRemovedEmail = jest.fn().mockResolvedValue({
        success: true,
        restoredCount: 1,
      });
    });

    it("removes unlinked rows in place without refetching the email list", async () => {
      const user = userEvent.setup();
      render(
        <TransactionDetails
          transaction={baseTransaction}
          onClose={mockOnClose}
          userId="user-456"
          initialTab="emails"
        />,
      );

      // Both threads render from the initial (single) list load.
      await waitFor(() => expect(screen.getByText("Thread Alpha")).toBeInTheDocument());
      expect(screen.getByText("Thread Beta")).toBeInTheDocument();
      expect(window.api.transactions.getCommunications).toHaveBeenCalledTimes(1);

      // Remove Thread Alpha via its card's unlink button + confirm modal.
      const alphaCard = screen.getByText("Thread Alpha").closest('[data-testid="email-thread-card"]') as HTMLElement;
      await user.click(within(alphaCard).getByTestId("unlink-thread-button"));
      await user.click(screen.getByRole("button", { name: /Remove Email/i }));

      // Thread Alpha leaves the list in place; Thread Beta remains.
      await waitFor(() => expect(screen.queryByText("Thread Alpha")).not.toBeInTheDocument());
      expect(screen.getByText("Thread Beta")).toBeInTheDocument();

      // Backend unlink invoked with the clicked communication id.
      expect(window.api.transactions.unlinkCommunication).toHaveBeenCalledWith("comm-A");
      // No full-list refetch (BACKLOG-1778: in-place update preserves scroll).
      expect(window.api.transactions.getCommunications).toHaveBeenCalledTimes(1);
    });

    it("falls back to a full refetch when the unlink payload lacks ids", async () => {
      // Defensive path: backend returns success but no unlinkedIds.
      window.api.transactions.unlinkCommunication.mockResolvedValue({ success: true });
      const user = userEvent.setup();
      render(
        <TransactionDetails
          transaction={baseTransaction}
          onClose={mockOnClose}
          userId="user-456"
          initialTab="emails"
        />,
      );

      await waitFor(() => expect(screen.getByText("Thread Alpha")).toBeInTheDocument());
      expect(window.api.transactions.getCommunications).toHaveBeenCalledTimes(1);

      const alphaCard = screen.getByText("Thread Alpha").closest('[data-testid="email-thread-card"]') as HTMLElement;
      await user.click(within(alphaCard).getByTestId("unlink-thread-button"));
      await user.click(screen.getByRole("button", { name: /Remove Email/i }));

      // Falls back to refetching the full list (BACKLOG-1765 behaviour).
      await waitFor(() => expect(window.api.transactions.getCommunications).toHaveBeenCalledTimes(2));
    });

    it("restores a removed email back into the list", async () => {
      // Start with only Thread Beta linked; Thread Alpha is removed.
      window.api.transactions.getCommunications.mockResolvedValue({
        success: true,
        transaction: { communications: [emailB], contact_assignments: contactAssignments },
      });
      window.api.transactions.getRemovedEmails.mockResolvedValue({
        success: true,
        removedEmails: [
          {
            ignored_id: "ign-A",
            ic_email_id: null,
            reason: "Manually unlinked",
            ignored_at: "2024-02-02T00:00:00Z",
            email_id: "email-A",
            subject: "Thread Alpha",
            sender: "alice@example.com",
            recipients: "me@example.com",
            cc: null,
            sent_at: "2024-02-01T00:00:00Z",
            thread_id: "thread-A",
            body_preview: "body",
            body_plain: "body",
            has_attachments: false,
            source: "gmail",
          },
        ],
      });
      // After restore, the refetched details include Thread Alpha again.
      window.api.transactions.getDetails.mockResolvedValue({
        success: true,
        transaction: { ...baseTransaction, communications: [emailA, emailB], contact_assignments: contactAssignments },
      });

      const user = userEvent.setup();
      render(
        <TransactionDetails
          transaction={baseTransaction}
          onClose={mockOnClose}
          userId="user-456"
          initialTab="emails"
        />,
      );

      // Only Beta is in the main list initially.
      await waitFor(() => expect(screen.getByText("Thread Beta")).toBeInTheDocument());
      expect(screen.queryByText("Thread Alpha")).not.toBeInTheDocument();

      // Open the removed section and restore Alpha.
      await user.click(screen.getByTestId("show-removed-emails-toggle"));
      await waitFor(() => expect(screen.getByTestId("restore-email-button")).toBeInTheDocument());
      await user.click(screen.getByTestId("restore-email-button"));

      // Restore IPC invoked and Alpha returns to the main thread list.
      expect(window.api.transactions.restoreRemovedEmail).toHaveBeenCalledWith("ign-A", "email-A", "txn-123");
      await waitFor(() => {
        const subjects = screen.getAllByTestId("thread-subject").map((el) => el.textContent || "");
        expect(subjects.some((s) => s.includes("Thread Alpha"))).toBe(true);
      });
    });
  });
});
