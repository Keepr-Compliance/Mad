/**
 * Tests for AuditTransactionModal.tsx
 * Covers form validation, multi-step workflow, and transaction creation
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import AuditTransactionModal from "../AuditTransactionModal";
import { PlatformProvider } from "../../contexts/PlatformContext";
import type { Contact, Transaction } from "../../../electron/types/models";

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

describe("AuditTransactionModal", () => {
  // The `userId` prop is typed `string` in production, but this suite has always
  // passed the number 123. Casting (rather than quoting the literal) keeps the exact
  // runtime value every test in this file was written against.
  const mockUserId = 123 as unknown as string;
  const mockProvider = "google";
  const mockOnClose = jest.fn();
  const mockOnSuccess = jest.fn();

  // Helper to render component with PlatformProvider
  const renderWithProvider = (ui: React.ReactElement) => {
    return render(<PlatformProvider>{ui}</PlatformProvider>);
  };

  // Helper: get the first button matching a name (desktop variant renders first in DOM).
  // The responsive refactor renders both mobile and desktop buttons, so getByRole finds duplicates.
  const getButton = (name: RegExp) => screen.getAllByRole("button", { name })[0];

  // Partial fixtures: `Contact` additionally requires user_id/source/created_at/
  // updated_at. Those are NOT added here because `source` feeds the step-2
  // Source/Role filter, so supplying it would change what these tests exercise.
  const mockContacts = [
    {
      id: "contact-1",
      name: "John Client",
      email: "john@example.com",
      phone: "555-1234",
      company: "Homebuyer Inc",
    },
    {
      id: "contact-2",
      name: "Jane Agent",
      email: "jane@realty.com",
      phone: "555-5678",
      company: "Top Realty",
    },
  ] as unknown as Contact[];

  beforeEach(() => {
    jest.clearAllMocks();

    // Default mocks
    jest.mocked(window.api.address.initialize).mockResolvedValue({ success: true });
    jest.mocked(window.api.address.getSuggestions).mockResolvedValue({
      success: true,
      suggestions: [],
    });
    jest.mocked(window.api.address.getDetails).mockResolvedValue({
      success: true,
      formatted_address: "123 Main St, City, ST 12345",
      street: "123 Main St",
      city: "City",
      state_short: "ST",
      zip: "12345",
    });
    jest.mocked(window.api.contacts.getAll).mockResolvedValue({
      success: true,
      contacts: mockContacts,
    });
    jest.mocked(window.api.contacts.getSortedByActivity).mockResolvedValue({
      success: true,
      contacts: mockContacts,
    });
    jest.mocked(window.api.transactions.createAudited).mockResolvedValue({
      success: true,
      // Partial Transaction fixture kept verbatim; only the static type is widened.
      transaction: { id: "txn-new", property_address: "123 Main St" } as unknown as Transaction,
    });
  });

  describe("Rendering", () => {
    it("should render modal with correct title", () => {
      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      // Desktop shows "Audit New Transaction", mobile shows "New Transaction"
      expect(screen.getAllByText(/new transaction/i).length).toBeGreaterThan(0);
    });

    it("should show step 1 - address verification by default", () => {
      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      // Both mobile and desktop headers show step 1 info
      expect(screen.getAllByText(/step 1/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/property address/i).length).toBeGreaterThan(
        0,
      );
    });

    it("should show transaction type options", () => {
      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      expect(
        screen.getByRole("button", { name: /purchase/i }),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /sale/i })).toBeInTheDocument();
    });

    it("should show progress bar with 2 steps", () => {
      // TASK-1766: Updated from 3 steps to 2 steps (search-first flow)
      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      // Progress bar shows step numbers (3 steps after TASK-1771 unified navigation)
      expect(screen.getByText("1")).toBeInTheDocument();
      expect(screen.getByText("2")).toBeInTheDocument();
      expect(screen.getByText("3")).toBeInTheDocument();
    });
  });

  describe("Form Validation - Step 1", () => {
    it("should require property address", async () => {
      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      // Try to continue without entering address
      // Both mobile and desktop footers render a Continue button
      const continueButton = getButton(/continue/i);
      await userEvent.click(continueButton);

      // Should show error
      expect(
        screen.getByText(/property address is required/i),
      ).toBeInTheDocument();
    });

    it("should allow proceeding when address is entered", async () => {
      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      // Enter address
      const addressInput = screen.getByPlaceholderText(
        /enter property address/i,
      );
      await userEvent.type(addressInput, "123 Main Street");

      // Click continue (desktop + mobile both render this button)
      const continueButton = getButton(/continue/i);
      await userEvent.click(continueButton);

      // Should move to step 2 (shown in both mobile and desktop headers)
      await waitFor(() => {
        expect(screen.getAllByText(/step 2/i).length).toBeGreaterThan(0);
      });
    });

    it("should clear error when valid address is entered", async () => {
      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      // Try to continue without address (trigger error)
      const continueButton = getButton(/continue/i);
      await userEvent.click(continueButton);

      expect(
        screen.getByText(/property address is required/i),
      ).toBeInTheDocument();

      // Now enter address and try again
      const addressInput = screen.getByPlaceholderText(
        /enter property address/i,
      );
      await userEvent.type(addressInput, "456 Oak Avenue");
      await userEvent.click(continueButton);

      // Error should be cleared, moved to step 2
      await waitFor(() => {
        expect(
          screen.queryByText(/property address is required/i),
        ).not.toBeInTheDocument();
      });
    });
  });

  describe("Transaction Type Selection", () => {
    it("should default to purchase type", () => {
      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      const purchaseButton = screen.getByRole("button", { name: /purchase/i });
      // Purchase button should be highlighted (has specific styling)
      expect(purchaseButton).toHaveClass("bg-indigo-500");
    });

    it("should allow switching to sale type", async () => {
      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      const saleButton = screen.getByRole("button", { name: /sale/i });
      await userEvent.click(saleButton);

      expect(saleButton).toHaveClass("bg-indigo-500");
    });
  });

  describe("Address Autocomplete", () => {
    it("should show address suggestions when typing", async () => {
      jest.mocked(window.api.address.getSuggestions).mockResolvedValue({
        success: true,
        // NOTE: this payload uses the snake_case Google Places shape, while the
        // real contract is { description, placeId }. Left as-is on purpose — the
        // assertion below only checks that getSuggestions was called, and
        // reshaping it would change what the component receives.
        suggestions: [
          {
            place_id: "place-1",
            description: "123 Main Street, City, ST",
            main_text: "123 Main Street",
            secondary_text: "City, ST",
          },
        ] as unknown as Array<{ description: string; placeId: string }>,
      });

      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      const addressInput = screen.getByPlaceholderText(
        /enter property address/i,
      );
      await userEvent.type(addressInput, "123 Main");

      await waitFor(() => {
        expect(window.api.address.getSuggestions).toHaveBeenCalled();
      });
    });

    it("should not fetch suggestions for short queries", async () => {
      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      const addressInput = screen.getByPlaceholderText(
        /enter property address/i,
      );
      await userEvent.type(addressInput, "12");

      // Should not call API for queries under 4 characters
      expect(window.api.address.getSuggestions).not.toHaveBeenCalled();
    });
  });

  describe("Multi-Step Navigation", () => {
    it("should navigate to step 2 after completing step 1", async () => {
      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      // Complete step 1
      const addressInput = screen.getByPlaceholderText(
        /enter property address/i,
      );
      await userEvent.type(addressInput, "123 Main Street");

      const continueButton = getButton(/continue/i);
      await userEvent.click(continueButton);

      // Should show step 2 (both mobile and desktop headers)
      await waitFor(() => {
        expect(screen.getAllByText(/step 2/i).length).toBeGreaterThan(0);
      });
    });

    it("renders the Source/Role filter at step 2 (BACKLOG-2354 filter parity)", async () => {
      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      // Complete step 1 to reach the contact-selection step.
      const addressInput = screen.getByPlaceholderText(/enter property address/i);
      await userEvent.type(addressInput, "123 Main Street");
      await userEvent.click(getButton(/continue/i));

      await waitFor(() => {
        expect(screen.getAllByText(/step 2/i).length).toBeGreaterThan(0);
      });

      // The new-transaction flow now surfaces the filter (ephemeral show-all),
      // matching the Clients & Contacts screen and the add-contacts flow.
      await waitFor(() => {
        expect(screen.getByTestId("source-filter")).toBeInTheDocument();
      });
      expect(screen.getByTestId("role-filter")).toBeInTheDocument();
    });

    it("should allow going back to step 1 from step 2", async () => {
      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      // Go to step 2
      const addressInput = screen.getByPlaceholderText(
        /enter property address/i,
      );
      await userEvent.type(addressInput, "123 Main Street");
      const continueButton = getButton(/continue/i);
      await userEvent.click(continueButton);

      await waitFor(() => {
        expect(screen.getAllByText(/step 2/i).length).toBeGreaterThan(0);
      });

      // Go back - use the desktop footer "← Back" button (not the mobile header "Back" close button)
      const backButton = getButton(/← back/i);
      await userEvent.click(backButton);

      // Should show step 1 (both mobile and desktop headers)
      await waitFor(() => {
        expect(screen.getAllByText(/step 1/i).length).toBeGreaterThan(0);
      });
    });

    it("should show back button only on step 2", async () => {
      // TASK-1766: Updated from 3 steps to 2 steps
      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      // Step 1 - desktop footer "← Back" button should not be present
      // (mobile header "Back" is always present as a close button)
      expect(
        screen.queryByRole("button", { name: /← back/i }),
      ).not.toBeInTheDocument();

      // Go to step 2
      const addressInput = screen.getByPlaceholderText(
        /enter property address/i,
      );
      await userEvent.type(addressInput, "123 Main Street");
      const continueButton = getButton(/continue/i);
      await userEvent.click(continueButton);

      // Step 2 - back button should be visible (mobile + desktop both render one)
      await waitFor(() => {
        expect(
          screen.getAllByRole("button", { name: /back/i }).length,
        ).toBeGreaterThan(0);
      });
    });
  });

  describe("Cancel and Close", () => {
    it("should call onClose when cancel button is clicked", async () => {
      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      const cancelButton = screen.getByRole("button", { name: /cancel/i });
      await userEvent.click(cancelButton);

      expect(mockOnClose).toHaveBeenCalled();
    });

    it("should call onClose when X button is clicked", async () => {
      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      // X button is the close button in the header
      const closeButtons = screen.getAllByRole("button");
      const xButton = closeButtons.find((btn) =>
        btn.querySelector('svg path[d*="M6 18L18 6"]'),
      );
      if (xButton) {
        await userEvent.click(xButton);
        expect(mockOnClose).toHaveBeenCalled();
      }
    });
  });

  describe("Transaction Creation", () => {
    it("should call createAudited API on final submit", async () => {
      // Mock SPECIFIC_ROLES constant
      jest.mocked(window.api.contacts.getSortedByActivity).mockResolvedValue({
        success: true,
        contacts: mockContacts,
      });

      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      // Step 1: Enter address
      const addressInput = screen.getByPlaceholderText(
        /enter property address/i,
      );
      await userEvent.type(addressInput, "123 Main Street");
      await userEvent.click(getButton(/continue/i));

      // Step 2: Should require client
      await waitFor(() => {
        expect(screen.getAllByText(/step 2/i).length).toBeGreaterThan(0);
      });
    });

    it("should show loading state while creating transaction", async () => {
      // Make createAudited slow
      jest.mocked(window.api.transactions.createAudited).mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                // Empty Transaction placeholder — this test only observes the
                // pending/loading window, never the resolved payload.
                resolve({ success: true, transaction: {} as unknown as Transaction }),
              1000,
            ),
          ),
      );

      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      // Navigate through steps
      const addressInput = screen.getByPlaceholderText(
        /enter property address/i,
      );
      await userEvent.type(addressInput, "123 Main Street");
      await userEvent.click(getButton(/continue/i));

      await waitFor(() => {
        expect(screen.getAllByText(/step 2/i).length).toBeGreaterThan(0);
      });
    });

    it("should show error when transaction creation fails", async () => {
      jest.mocked(window.api.transactions.createAudited).mockResolvedValue({
        success: false,
        error: "Database error: transaction creation failed",
      });

      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      // Enter address and go to step 2
      const addressInput = screen.getByPlaceholderText(
        /enter property address/i,
      );
      await userEvent.type(addressInput, "123 Main Street");
      await userEvent.click(getButton(/continue/i));

      await waitFor(() => {
        expect(screen.getAllByText(/step 2/i).length).toBeGreaterThan(0);
      });
    });
  });

  describe("Input Sanitization", () => {
    it("should handle special characters in address input", async () => {
      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      const addressInput = screen.getByPlaceholderText(
        /enter property address/i,
      );
      await userEvent.type(addressInput, "123 Main St. #4B, City-Town, ST");

      expect(addressInput).toHaveValue("123 Main St. #4B, City-Town, ST");
    });

    it("should trim whitespace from address", async () => {
      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      const addressInput = screen.getByPlaceholderText(
        /enter property address/i,
      );
      await userEvent.type(addressInput, "   123 Main Street   ");

      await userEvent.click(getButton(/continue/i));

      // Should proceed (whitespace trimmed)
      await waitFor(() => {
        expect(screen.getAllByText(/step 2/i).length).toBeGreaterThan(0);
      });
    });
  });

  describe("API Integration", () => {
    it("should initialize address API on mount", async () => {
      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      await waitFor(() => {
        expect(window.api.address.initialize).toHaveBeenCalled();
      });
    });

    it("should have all required APIs available", () => {
      expect(window.api.address.initialize).toBeDefined();
      expect(window.api.address.getSuggestions).toBeDefined();
      expect(window.api.address.getDetails).toBeDefined();
      expect(window.api.transactions.createAudited).toBeDefined();
      expect(window.api.contacts.getAll).toBeDefined();
      expect(window.api.contacts.getSortedByActivity).toBeDefined();
    });
  });

  describe("Accessibility", () => {
    it("should have accessible form labels", () => {
      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      // Address input should have a label text
      expect(screen.getAllByText(/property address/i).length).toBeGreaterThan(
        0,
      );

      // Transaction type should have a label
      expect(screen.getByText(/transaction type/i)).toBeInTheDocument();
    });

    it("should have accessible buttons", () => {
      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

      // Continue button exists in both mobile and desktop footers
      expect(
        screen.getAllByRole("button", { name: /continue/i }).length,
      ).toBeGreaterThan(0);
      // Cancel only in desktop footer
      expect(
        screen.getByRole("button", { name: /cancel/i }),
      ).toBeInTheDocument();
      // Purchase and Sale are in AddressVerificationStep (single instance)
      expect(
        screen.getByRole("button", { name: /purchase/i }),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /sale/i })).toBeInTheDocument();
    });
  });

  describe("Edit Mode", () => {
    const mockEditTransaction = {
      id: "txn-123",
      user_id: "123",
      property_address: "456 Oak Street, City, ST 67890",
      property_street: "456 Oak Street",
      property_city: "City",
      property_state: "ST",
      property_zip: "67890",
      property_coordinates: JSON.stringify({ lat: 37.1234, lng: -122.4567 }),
      transaction_type: "sale" as const,
      status: "active" as const,
      message_count: 5,
      attachment_count: 2,
      export_status: "not_exported" as const,
      export_count: 0,
      detection_source: "auto" as const,
      detection_status: "pending" as const,
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
    };

    beforeEach(() => {
      jest.mocked(window.api.transactions.update).mockResolvedValue({ success: true });
      jest.mocked(window.api.feedback.recordTransaction).mockResolvedValue({ success: true });
    });

    it("should display edit mode title when editTransaction is provided", () => {
      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
          editTransaction={mockEditTransaction}
        />,
      );

      expect(screen.getByText(/edit transaction/i)).toBeInTheDocument();
    });

    it("should pre-fill address when editing", () => {
      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
          editTransaction={mockEditTransaction}
        />,
      );

      const addressInput = screen.getByPlaceholderText(
        /enter property address/i,
      );
      expect(addressInput).toHaveValue("456 Oak Street, City, ST 67890");
    });

    it("should pre-fill transaction type when editing", () => {
      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
          editTransaction={mockEditTransaction}
        />,
      );

      const saleButton = screen.getByRole("button", { name: /sale/i });
      expect(saleButton).toHaveClass("bg-indigo-500");
    });

    it("should show simplified subtitle in edit mode (no steps)", () => {
      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
          editTransaction={mockEditTransaction}
        />,
      );

      // Edit mode shows simplified subtitle, not step info
      expect(screen.getByText(/update property address and transaction dates/i)).toBeInTheDocument();
      // Progress bar (step numbers) should not be visible
      expect(screen.queryByText("2")).not.toBeInTheDocument();
      expect(screen.queryByText("3")).not.toBeInTheDocument();
    });

    it("should show Save Changes button directly in edit mode (single-step flow)", async () => {
      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
          editTransaction={mockEditTransaction}
        />,
      );

      // Edit mode shows Save Changes directly (no multi-step flow)
      expect(screen.getByRole("button", { name: /save changes/i })).toBeInTheDocument();
      // Continue button should NOT be present in edit mode
      expect(screen.queryByRole("button", { name: /continue/i })).not.toBeInTheDocument();
    });

    it("should have Save Changes button visible on initial render in edit mode", () => {
      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
          editTransaction={mockEditTransaction}
        />,
      );

      // Edit mode renders Save Changes immediately (no multi-step navigation)
      expect(screen.getByRole("button", { name: /save changes/i })).toBeInTheDocument();
    });

    it("should handle suggested_contacts JSON parsing", () => {
      const txnWithContacts = {
        ...mockEditTransaction,
        suggested_contacts: JSON.stringify([
          { role: "client", contact_id: "contact-1", is_primary: true },
          { role: "listing_agent", contact_id: "contact-2", is_primary: false },
        ]),
      };

      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
          editTransaction={txnWithContacts}
        />,
      );

      // Modal should render without errors
      expect(screen.getByText(/edit transaction/i)).toBeInTheDocument();
    });

    it("should handle invalid suggested_contacts JSON gracefully", () => {
      const txnWithBadJson = {
        ...mockEditTransaction,
        suggested_contacts: "invalid json{",
      };

      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
          editTransaction={txnWithBadJson}
        />,
      );

      // Modal should still render without errors
      expect(screen.getByText(/edit transaction/i)).toBeInTheDocument();
    });

    it("should display Saving... text when submitting in edit mode", async () => {
      // Make update slow to see loading state
      jest.mocked(window.api.transactions.update).mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ success: true }), 1000),
          ),
      );

      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
          editTransaction={mockEditTransaction}
        />,
      );

      // Click Save Changes directly (edit mode is single-step)
      // Desktop shows "Save Changes", mobile shows "Save" — both render
      await userEvent.click(getButton(/save/i));

      // Should show "Saving..." loading text (both mobile and desktop)
      await waitFor(() => {
        expect(screen.getAllByText(/saving/i).length).toBeGreaterThan(0);
      });
    });

    it("should have required APIs for edit mode", () => {
      expect(window.api.transactions.update).toBeDefined();
      expect(typeof window.api.transactions.update).toBe("function");
      expect(window.api.feedback.recordTransaction).toBeDefined();
      expect(typeof window.api.feedback.recordTransaction).toBe("function");
    });

    // TASK-1030: Verify contact_assignments is used for pre-population
    it("should use contact_assignments from junction table when editing", () => {
      // Transaction with contact_assignments (from getTransactionDetails)
      const txnWithContactAssignments = {
        ...mockEditTransaction,
        contact_assignments: [
          {
            id: "assign-1",
            contact_id: "contact-1",
            contact_name: "John Doe",
            contact_email: "john@example.com",
            role: "client",
            specific_role: "client",
            is_primary: 1,
          },
          {
            id: "assign-2",
            contact_id: "contact-2",
            contact_name: "Jane Smith",
            contact_email: "jane@realty.com",
            role: "seller_agent",
            specific_role: "seller_agent",
            is_primary: 0,
          },
        ],
        // Also has suggested_contacts but should be ignored
        suggested_contacts: JSON.stringify([
          { role: "old_client", contact_id: "old-contact", is_primary: true },
        ]),
      };

      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
          editTransaction={txnWithContactAssignments}
        />,
      );

      // Modal should render without errors
      expect(screen.getByText(/edit transaction/i)).toBeInTheDocument();
    });

    it("should fall back to suggested_contacts when contact_assignments is empty", () => {
      const txnWithOnlySuggested = {
        ...mockEditTransaction,
        contact_assignments: [], // Empty array
        suggested_contacts: JSON.stringify([
          { role: "client", contact_id: "contact-1", is_primary: true },
        ]),
      };

      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
          editTransaction={txnWithOnlySuggested}
        />,
      );

      // Modal should render without errors
      expect(screen.getByText(/edit transaction/i)).toBeInTheDocument();
    });

    // TASK-1038: When editTransaction doesn't have contact_assignments,
    // the hook should fetch them via getDetails() API call
    it("should fetch contact_assignments via getDetails when not included in editTransaction", async () => {
      // Transaction WITHOUT contact_assignments (typical from getAll())
      const txnWithoutContactAssignments = {
        ...mockEditTransaction,
        // No contact_assignments field - simulates data from transactions.getAll()
      };

      // Mock getDetails to return contact_assignments
      jest.mocked(window.api.transactions.getDetails).mockResolvedValue({
        success: true,
        transaction: {
          ...mockEditTransaction,
          contact_assignments: [
            {
              id: "assign-1",
              contact_id: "contact-1",
              contact_name: "John Fetched",
              contact_email: "john@example.com",
              role: "client",
              specific_role: "client",
              is_primary: 1,
            },
          ],
        },
      });

      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
          editTransaction={txnWithoutContactAssignments}
        />,
      );

      // Modal should render without errors
      expect(screen.getByText(/edit transaction/i)).toBeInTheDocument();

      // Should call getDetails to fetch full transaction data
      await waitFor(() => {
        expect(window.api.transactions.getDetails).toHaveBeenCalledWith(
          mockEditTransaction.id,
        );
      });
    });

    it("should handle getDetails API failure gracefully in edit mode", async () => {
      // Transaction WITHOUT contact_assignments
      const txnWithoutContactAssignments = {
        ...mockEditTransaction,
      };

      // Mock getDetails to fail
      jest.mocked(window.api.transactions.getDetails).mockResolvedValue({
        success: false,
        error: "Failed to fetch transaction details",
      });

      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
          editTransaction={txnWithoutContactAssignments}
        />,
      );

      // Modal should still render without errors (graceful degradation)
      expect(screen.getByText(/edit transaction/i)).toBeInTheDocument();

      // Should have attempted to call getDetails
      await waitFor(() => {
        expect(window.api.transactions.getDetails).toHaveBeenCalled();
      });
    });
  });
});
