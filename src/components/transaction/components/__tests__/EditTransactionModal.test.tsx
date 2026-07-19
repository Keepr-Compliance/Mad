/**
 * Tests for EditTransactionModal.tsx
 * Covers contact pre-population, form editing, and save functionality
 * Related: TASK-1030 - Fix Contacts Not Pre-Populating
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { EditTransactionModal } from "../EditTransactionModal";
import { PlatformProvider } from "../../../../contexts/PlatformContext";
import type { Transaction } from "../../../../../electron/types/models";

// Mock useAppStateMachine to return isDatabaseInitialized: true
jest.mock("../../../../appCore", () => ({
  ...jest.requireActual("../../../../appCore"),
  useAppStateMachine: () => ({
    isDatabaseInitialized: true,
  }),
}));

describe("EditTransactionModal", () => {
  const mockOnClose = jest.fn();
  const mockOnSuccess = jest.fn();

  // Helper to render component with PlatformProvider
  const renderWithProvider = (ui: React.ReactElement) => {
    return render(<PlatformProvider>{ui}</PlatformProvider>);
  };

  const mockTransaction: Transaction = {
    id: "txn-123",
    user_id: "user-456",
    property_address: "123 Main Street, City, ST 12345",
    property_street: "123 Main Street",
    property_city: "City",
    property_state: "ST",
    property_zip: "12345",
    transaction_type: "purchase",
    status: "active",
    message_count: 5,
    attachment_count: 2,
    export_status: "not_exported",
    export_count: 0,
    detection_source: "auto",
    detection_status: "pending",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    started_at: "2024-01-01", // Required field - when representation began
  };

  const mockContacts = [
    {
      id: "contact-1",
      name: "John Buyer",
      display_name: "John Buyer",
      email: "john@example.com",
      phone: "555-1234",
      company: "Buyer Corp",
    },
    {
      id: "contact-2",
      name: "Jane Agent",
      display_name: "Jane Agent",
      email: "jane@realty.com",
      phone: "555-5678",
      company: "Top Realty",
    },
    {
      id: "contact-3",
      name: "Bob Seller",
      display_name: "Bob Seller",
      email: "bob@example.com",
      phone: "555-9999",
      company: "Seller LLC",
    },
  ];

  const mockContactAssignments = [
    {
      id: "assign-1",
      contact_id: "contact-1",
      contact_name: "John Buyer",
      contact_email: "john@example.com",
      contact_phone: "555-1234",
      contact_company: "Buyer Corp",
      role: "client",
      specific_role: "client",
      is_primary: 1,
      notes: null,
    },
    {
      id: "assign-2",
      contact_id: "contact-2",
      contact_name: "Jane Agent",
      contact_email: "jane@realty.com",
      contact_phone: "555-5678",
      contact_company: "Top Realty",
      // For purchase transaction, user is buyer's agent, so show seller's agent
      role: "seller_agent",
      specific_role: "seller_agent",
      is_primary: 0,
      notes: "The seller's agent",
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();

    // Default mocks
    window.api.transactions.getDetails.mockResolvedValue({
      success: true,
      transaction: {
        ...mockTransaction,
        contact_assignments: mockContactAssignments,
      },
    });
    window.api.transactions.update.mockResolvedValue({
      success: true,
    });
    window.api.transactions.batchUpdateContacts.mockResolvedValue({
      success: true,
    });
    window.api.contacts.getAll.mockResolvedValue({
      success: true,
      contacts: mockContacts,
    });
    window.api.contacts.getSortedByActivity.mockResolvedValue({
      success: true,
      contacts: mockContacts,
    });
  });

  describe("Rendering", () => {
    it("should render modal with correct title", async () => {
      renderWithProvider(
        <EditTransactionModal
          transaction={mockTransaction}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      expect(screen.getByText("Edit Transaction")).toBeInTheDocument();
    });

    it("should show transaction details tab by default", async () => {
      renderWithProvider(
        <EditTransactionModal
          transaction={mockTransaction}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      expect(screen.getByText("Transaction Details")).toBeInTheDocument();
      expect(screen.getByText("Roles & Contacts")).toBeInTheDocument();
    });

    it("should pre-fill property address", async () => {
      renderWithProvider(
        <EditTransactionModal
          transaction={mockTransaction}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      const addressInput = screen.getByDisplayValue(
        "123 Main Street, City, ST 12345",
      );
      expect(addressInput).toBeInTheDocument();
    });
  });

  describe("Contact Pre-Population (TASK-1030)", () => {
    it("should call getDetails API on mount", async () => {
      renderWithProvider(
        <EditTransactionModal
          transaction={mockTransaction}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      await waitFor(() => {
        expect(window.api.transactions.getDetails).toHaveBeenCalledWith(
          mockTransaction.id,
        );
      });
    });

    it("should pre-populate contacts when switching to Contacts tab", async () => {
      renderWithProvider(
        <EditTransactionModal
          transaction={mockTransaction}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      // Wait for contacts to load
      await waitFor(() => {
        expect(window.api.transactions.getDetails).toHaveBeenCalled();
      });

      // Switch to contacts tab
      const contactsTab = screen.getByText("Roles & Contacts");
      await userEvent.click(contactsTab);

      // Wait for loading to finish
      await waitFor(() => {
        expect(screen.queryByText("Loading contacts...")).not.toBeInTheDocument();
      });

      // Verify API was called with correct arguments
      expect(window.api.transactions.getDetails).toHaveBeenCalledWith("txn-123");

      // Verify contacts are displayed (TASK-1030 fix)
      await waitFor(
        () => {
          // The client contact should be shown
          expect(screen.getByText("John Buyer")).toBeInTheDocument();
          // The seller agent contact should be shown
          expect(screen.getByText("Jane Agent")).toBeInTheDocument();
        },
        { timeout: 5000 },
      );
    });

    it("should handle empty contact_assignments gracefully", async () => {
      window.api.transactions.getDetails.mockResolvedValue({
        success: true,
        transaction: {
          ...mockTransaction,
          contact_assignments: [],
        },
      });

      renderWithProvider(
        <EditTransactionModal
          transaction={mockTransaction}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      // Switch to contacts tab
      const contactsTab = screen.getByText("Roles & Contacts");
      await userEvent.click(contactsTab);

      // Should not throw errors, modal should still render
      await waitFor(() => {
        expect(screen.getByText("Client & Agents")).toBeInTheDocument();
      });
    });

    it("should handle missing contact_assignments field", async () => {
      window.api.transactions.getDetails.mockResolvedValue({
        success: true,
        transaction: {
          ...mockTransaction,
          // contact_assignments is undefined
        },
      });

      renderWithProvider(
        <EditTransactionModal
          transaction={mockTransaction}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      // Switch to contacts tab
      const contactsTab = screen.getByText("Roles & Contacts");
      await userEvent.click(contactsTab);

      // Should not throw errors, modal should still render
      await waitFor(() => {
        expect(screen.getByText("Client & Agents")).toBeInTheDocument();
      });
    });

    it("should correctly group contacts by role", async () => {
      // Include multiple contacts for same role (client)
      const assignmentsWithMultiple = [
        {
          id: "assign-1",
          contact_id: "contact-1",
          contact_name: "John Buyer",
          contact_email: "john@example.com",
          role: "client",
          specific_role: "client",
          is_primary: 1,
        },
        {
          id: "assign-3",
          contact_id: "contact-3",
          contact_name: "Bob Seller",
          contact_email: "bob@example.com",
          role: "client",
          specific_role: "client",
          is_primary: 0,
        },
      ];

      window.api.transactions.getDetails.mockResolvedValue({
        success: true,
        transaction: {
          ...mockTransaction,
          contact_assignments: assignmentsWithMultiple,
        },
      });

      renderWithProvider(
        <EditTransactionModal
          transaction={mockTransaction}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      // Switch to contacts tab
      const contactsTab = screen.getByText("Roles & Contacts");
      await userEvent.click(contactsTab);

      // Both clients should be shown
      await waitFor(() => {
        expect(screen.getByText("John Buyer")).toBeInTheDocument();
        expect(screen.getByText("Bob Seller")).toBeInTheDocument();
      });
    });

    it("should use role field (not specific_role) for grouping when both exist", async () => {
      // Role and specific_role have different values (edge case)
      const assignmentsWithMismatch = [
        {
          id: "assign-1",
          contact_id: "contact-1",
          contact_name: "John Buyer",
          role: "client", // This should be used
          specific_role: "buyer", // This should NOT be used
          is_primary: 1,
        },
      ];

      window.api.transactions.getDetails.mockResolvedValue({
        success: true,
        transaction: {
          ...mockTransaction,
          contact_assignments: assignmentsWithMismatch,
        },
      });

      renderWithProvider(
        <EditTransactionModal
          transaction={mockTransaction}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      // Switch to contacts tab
      const contactsTab = screen.getByText("Roles & Contacts");
      await userEvent.click(contactsTab);

      // Contact should appear under Client section (using role = "client")
      await waitFor(() => {
        expect(screen.getByText("John Buyer")).toBeInTheDocument();
      });
    });

    it("should handle API errors gracefully", async () => {
      window.api.transactions.getDetails.mockResolvedValue({
        success: false,
        error: "Failed to fetch transaction details",
      });

      renderWithProvider(
        <EditTransactionModal
          transaction={mockTransaction}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      // Switch to contacts tab
      const contactsTab = screen.getByText("Roles & Contacts");
      await userEvent.click(contactsTab);

      // Modal should still render without contacts
      await waitFor(() => {
        expect(screen.getByText("Client & Agents")).toBeInTheDocument();
      });
    });
  });

  describe("Saving Changes", () => {
    it("should call update API when saving", async () => {
      renderWithProvider(
        <EditTransactionModal
          transaction={mockTransaction}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      // Click save
      const saveButton = screen.getByRole("button", { name: /save changes/i });
      await userEvent.click(saveButton);

      await waitFor(() => {
        expect(window.api.transactions.update).toHaveBeenCalledWith(
          mockTransaction.id,
          expect.any(Object),
        );
      });
    });

    it("should call onSuccess after successful save", async () => {
      renderWithProvider(
        <EditTransactionModal
          transaction={mockTransaction}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      const saveButton = screen.getByRole("button", { name: /save changes/i });
      await userEvent.click(saveButton);

      await waitFor(() => {
        expect(mockOnSuccess).toHaveBeenCalled();
      });
    });
  });

  describe("Cancel and Close", () => {
    it("should call onClose when cancel button is clicked", async () => {
      renderWithProvider(
        <EditTransactionModal
          transaction={mockTransaction}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      const cancelButton = screen.getByRole("button", { name: /cancel/i });
      await userEvent.click(cancelButton);

      expect(mockOnClose).toHaveBeenCalled();
    });
  });

  describe("Contact Save Persistence (TASK-1111)", () => {
    it("should not send unnecessary batch operations when no contacts changed", async () => {
      // Setup: Two contacts assigned initially
      const initialAssignments = [
        {
          id: "assign-1",
          contact_id: "contact-1",
          contact_name: "John Buyer",
          contact_email: "john@example.com",
          role: "client",
          specific_role: "client",
          is_primary: 1,
        },
        {
          id: "assign-2",
          contact_id: "contact-2",
          contact_name: "Jane Agent",
          contact_email: "jane@realty.com",
          role: "seller_agent",
          specific_role: "seller_agent",
          is_primary: 0,
        },
      ];

      window.api.transactions.getDetails.mockResolvedValue({
        success: true,
        transaction: {
          ...mockTransaction,
          contact_assignments: initialAssignments,
        },
      });

      renderWithProvider(
        <EditTransactionModal
          transaction={mockTransaction}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      // Wait for contacts to load
      await waitFor(() => {
        expect(window.api.transactions.getDetails).toHaveBeenCalled();
      });

      // Click save without making changes
      const saveButton = screen.getByRole("button", { name: /save changes/i });
      await userEvent.click(saveButton);

      // Verify onSuccess was called (save completed)
      await waitFor(() => {
        expect(mockOnSuccess).toHaveBeenCalled();
      });

      // Verify that batchUpdateContacts was NOT called (no changes)
      // or called with empty operations array
      if (window.api.transactions.batchUpdateContacts.mock.calls.length > 0) {
        const [, operations] =
          window.api.transactions.batchUpdateContacts.mock.calls[0];
        expect(operations.length).toBe(0);
      }
    });

    it("should preserve contacts in other roles when same contact has multiple roles", async () => {
      // Setup: Same contact assigned to two roles (edge case)
      const multiRoleAssignments = [
        {
          id: "assign-1",
          contact_id: "contact-2",
          contact_name: "Jane Agent",
          contact_email: "jane@realty.com",
          role: "seller_agent",
          specific_role: "seller_agent",
          is_primary: 0,
        },
        {
          id: "assign-2",
          contact_id: "contact-2",
          contact_name: "Jane Agent",
          contact_email: "jane@realty.com",
          role: "escrow_officer",
          specific_role: "escrow_officer",
          is_primary: 0,
        },
      ];

      window.api.transactions.getDetails.mockResolvedValue({
        success: true,
        transaction: {
          ...mockTransaction,
          contact_assignments: multiRoleAssignments,
        },
      });

      renderWithProvider(
        <EditTransactionModal
          transaction={mockTransaction}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      // Wait for contacts to load and switch to contacts tab
      await waitFor(() => {
        expect(window.api.transactions.getDetails).toHaveBeenCalled();
      });

      const contactsTab = screen.getByText("Roles & Contacts");
      await userEvent.click(contactsTab);

      // Verify Jane Agent appears twice (once for each role)
      await waitFor(() => {
        const janeElements = screen.getAllByText("Jane Agent");
        // Should have 2 instances since Jane is assigned to 2 roles
        expect(janeElements.length).toBe(2);
      });

      // Click save without making changes
      const saveButton = screen.getByRole("button", { name: /save changes/i });
      await userEvent.click(saveButton);

      // Verify save completed successfully
      await waitFor(() => {
        expect(mockOnSuccess).toHaveBeenCalled();
      });
    });

    it("should correctly handle empty contact assignments", async () => {
      // Setup: No initial contacts
      window.api.transactions.getDetails.mockResolvedValue({
        success: true,
        transaction: {
          ...mockTransaction,
          contact_assignments: [],
        },
      });

      renderWithProvider(
        <EditTransactionModal
          transaction={mockTransaction}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      // Wait for loading to finish
      await waitFor(() => {
        expect(window.api.transactions.getDetails).toHaveBeenCalled();
      });

      // Switch to contacts tab
      const contactsTab = screen.getByText("Roles & Contacts");
      await userEvent.click(contactsTab);

      // Click save
      const saveButton = screen.getByRole("button", { name: /save changes/i });
      await userEvent.click(saveButton);

      // Should call onSuccess without errors
      await waitFor(() => {
        expect(mockOnSuccess).toHaveBeenCalled();
      });
    });
  });

  describe("Export freeze (BACKLOG-2013)", () => {
    const frozenTransaction: Transaction = {
      ...mockTransaction,
      export_status: "exported",
      export_count: 1,
      first_exported_at: "2026-07-18T00:00:00.000Z",
    };

    it("shows the locked notice and disables identity inputs when exported", async () => {
      renderWithProvider(
        <EditTransactionModal
          transaction={frozenTransaction}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      // The frozen banner is shown.
      expect(
        screen.getByTestId("transaction-frozen-notice"),
      ).toBeInTheDocument();

      // Frozen ANCHOR inputs are disabled.
      const addressInput = screen.getByDisplayValue(
        "123 Main Street, City, ST 12345",
      );
      expect(addressInput).toBeDisabled();

      // Transaction type buttons are disabled.
      expect(screen.getByRole("button", { name: "Purchase" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Sale" })).toBeDisabled();

      // BACKLOG-2150: the two date inputs — the audit START date is a frozen
      // anchor (disabled), but the CLOSING (end) date stays editable. Query the
      // date inputs directly (labels aren't htmlFor-associated). The start date
      // is the required one; the closing date is not required.
      const dateInputs = document.querySelectorAll<HTMLInputElement>(
        'input[type="date"]',
      );
      expect(dateInputs.length).toBe(2);
      const startInput = Array.from(dateInputs).find((el) => el.required);
      const closingInput = Array.from(dateInputs).find((el) => !el.required);
      expect(startInput).toBeDisabled();
      expect(closingInput).not.toBeDisabled();
    });

    it("does NOT show the notice and keeps inputs editable before export", async () => {
      renderWithProvider(
        <EditTransactionModal
          transaction={mockTransaction}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      expect(
        screen.queryByTestId("transaction-frozen-notice"),
      ).not.toBeInTheDocument();

      const addressInput = screen.getByDisplayValue(
        "123 Main Street, City, ST 12345",
      );
      expect(addressInput).not.toBeDisabled();
    });

    it("omits frozen ANCHORS but keeps closed_at + financials in the save payload (BACKLOG-2150)", async () => {
      renderWithProvider(
        <EditTransactionModal
          transaction={frozenTransaction}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      await waitFor(() => {
        expect(window.api.transactions.getDetails).toHaveBeenCalled();
      });

      const saveButton = screen.getByRole("button", { name: /save changes/i });
      await userEvent.click(saveButton);

      await waitFor(() => {
        expect(window.api.transactions.update).toHaveBeenCalled();
      });

      const [, payload] = window.api.transactions.update.mock.calls[0];
      // Frozen identity ANCHORS must NOT be present (db guard would reject them).
      expect(payload).not.toHaveProperty("property_address");
      expect(payload).not.toHaveProperty("transaction_type");
      expect(payload).not.toHaveProperty("started_at");
      // BACKLOG-2150: the end date is now editable after export and IS present.
      expect(payload).toHaveProperty("closed_at");
      // Still-editable financials ARE present.
      expect(payload).toHaveProperty("sale_price");
      expect(payload).toHaveProperty("listing_price");
    });
  });
});
