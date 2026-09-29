/**
 * Tests for AuditTransactionModal.tsx
 * Covers form validation, multi-step workflow, and transaction creation
 */

import React from "react";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import AuditTransactionModal from "../AuditTransactionModal";
import { FLOATING_ACTION_BAR_CONTENT_PADDING } from "../common/FloatingActionBar";
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

// BACKLOG-3613: the step-1 "Continue" goes through handleGatedNext, which asks
// the coverage hook before advancing. It is mocked here so a test can control
// that answer; null means "no gap, proceed", which is what every older test in
// this file already got from the unconfigured window.api mock.
const mockCheckCoverage = jest.fn();
jest.mock("../../hooks/useAuditCoverageCheck", () => ({
  useAuditCoverageCheck: () => ({
    checkCoverage: mockCheckCoverage,
    checkExportCompleteness: jest.fn().mockResolvedValue(null),
    runMessagesImport: jest
      .fn()
      .mockResolvedValue({ ran: false, importRan: false, floorISO: null }),
    importing: false,
    progress: null,
    indeterminate: false,
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
    mockCheckCoverage.mockResolvedValue(null);

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

      // BACKLOG-2850: keyed on the TESTID, not on the label text. These three
      // queries used `/purchase/i` and matched the old "Listing/Purchase"
      // incidentally; "Listing" contains no "purchase", so they stopped
      // resolving the moment the founder's label changed — and because this
      // file never contains the string "Listing", no sweep for the old label
      // surfaces it. The testid is the stable handle (it is also the e2e
      // selector) and it is what identifies the RIGHT button independently of
      // whatever the button is currently called.
      expect(screen.getByTestId("create-audit-type-purchase")).toBeInTheDocument();
      expect(screen.getByTestId("create-audit-type-sale")).toBeInTheDocument();
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

      // BACKLOG-2850: testid, not label text — see the note above.
      const purchaseButton = screen.getByTestId("create-audit-type-purchase");
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
      // BACKLOG-3614: one floating group, so exactly one Cancel at every width
      expect(
        screen.getByRole("button", { name: /cancel/i }),
      ).toBeInTheDocument();
      // Purchase and Sale are in AddressVerificationStep (single instance)
      // BACKLOG-2850: keyed on the TESTID, not on the label text. These three
      // queries used `/purchase/i` and matched the old "Listing/Purchase"
      // incidentally; "Listing" contains no "purchase", so they stopped
      // resolving the moment the founder's label changed — and because this
      // file never contains the string "Listing", no sweep for the old label
      // surfaces it. The testid is the stable handle (it is also the e2e
      // selector) and it is what identifies the RIGHT button independently of
      // whatever the button is currently called.
      expect(screen.getByTestId("create-audit-type-purchase")).toBeInTheDocument();
      expect(screen.getByTestId("create-audit-type-sale")).toBeInTheDocument();
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

  describe("End Date — create vs edit (BACKLOG-3613)", () => {
    const renderCreate = () =>
      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
        />,
      );

    // Walks the create wizard to the createAudited call: address, Continue,
    // pick a contact, Continue (the first contact defaults to Client), Create.
    // The file-level fixtures carry no source, so step 2's Source filter hides
    // them. A manual contact is listed under the Manual leaf.
    const manualContact = {
      id: "contact-manual-3613",
      user_id: "123",
      name: "Casey Manual",
      display_name: "Casey Manual",
      email: "casey@example.com",
      source: "manual",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
    } as unknown as Contact;

    const createThroughTheWizard = async (listingPriceText?: string) => {
      jest.mocked(window.api.contacts.getAll).mockResolvedValue({
        success: true,
        contacts: [manualContact],
      });
      jest.mocked(window.api.contacts.getSortedByActivity).mockResolvedValue({
        success: true,
        contacts: [manualContact],
      });
      renderCreate();
      await userEvent.type(
        screen.getByPlaceholderText(/enter property address/i),
        "123 Main Street",
      );
      if (listingPriceText !== undefined) {
        await userEvent.type(
          screen.getByTestId("create-audit-listing-price-input"),
          listingPriceText,
        );
      }
      await userEvent.click(getButton(/continue/i));
      await waitFor(() => {
        expect(screen.getByTestId("contact-assignment-step-2")).toBeInTheDocument();
      });
      await userEvent.click(await screen.findByText("Casey Manual"));
      await waitFor(() => {
        expect(screen.getByTestId("added-count")).toHaveTextContent("1");
      });
      await userEvent.click(getButton(/continue/i));
      await waitFor(() => {
        expect(screen.getByTestId("contact-assignment-step-3")).toBeInTheDocument();
      });
      await userEvent.click(getButton(/create transaction/i));
      await waitFor(() => {
        expect(window.api.transactions.createAudited).toHaveBeenCalledTimes(1);
      });
      return jest.mocked(window.api.transactions.createAudited).mock.calls[0][1] as Record<
        string,
        unknown
      >;
    };

    it("C1: a new deal is created with no end date (ongoing)", async () => {
      const payload = await createThroughTheWizard();
      expect(payload.property_address).toBe("123 Main Street");
      expect(payload.started_at).toEqual(expect.any(String));
      // Undefined — never a date (and not an explicit null either). Until
      // BACKLOG-3613 this was today.
      expect(payload.closed_at).toBeUndefined();
    });

    it("C2: a start date after today still reaches step 2 — no error about a hidden end date", async () => {
      renderCreate();
      expect(screen.queryByTestId("create-audit-end-date-input")).toBeNull();

      const future = new Date();
      future.setFullYear(future.getFullYear() + 1);
      const futureISO = future.toISOString().split("T")[0];

      await userEvent.type(
        screen.getByPlaceholderText(/enter property address/i),
        "123 Main Street",
      );
      fireEvent.change(screen.getByTestId("create-audit-start-date-input"), {
        target: { value: futureISO },
      });
      await userEvent.click(getButton(/continue/i));

      await waitFor(() => {
        expect(screen.getByTestId("contact-assignment-step-2")).toBeInTheDocument();
      });
      // The gated path ran (the start date passed basic validation) ...
      expect(mockCheckCoverage).toHaveBeenCalledWith(futureISO);
      // ... and nothing complained about an end date the user cannot see.
      expect(screen.queryByText(/End date must be after start date/i)).toBeNull();
    });

    it("C3: Edit Transaction Details still shows End Date, prefilled, and saves it", async () => {
      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
          editTransaction={{
            id: "txn-edit-3613",
            user_id: "123",
            property_address: "456 Oak Street, City, ST 67890",
            property_street: "456 Oak Street",
            property_city: "City",
            property_state: "ST",
            property_zip: "67890",
            transaction_type: "sale",
            status: "active",
            started_at: "2024-01-01",
            closed_at: "2024-03-01",
            created_at: "2024-01-01T00:00:00Z",
            updated_at: "2024-01-01T00:00:00Z",
          } as unknown as Transaction}
        />,
      );
      jest.mocked(window.api.transactions.update).mockResolvedValue({ success: true });

      const end = await screen.findByTestId("create-audit-end-date-input");
      await waitFor(() => expect(end).toHaveValue("2024-03-01"));

      fireEvent.change(end, { target: { value: "2024-04-15" } });
      await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

      await waitFor(() => {
        expect(window.api.transactions.update).toHaveBeenCalledWith(
          "txn-edit-3613",
          expect.objectContaining({ closed_at: "2024-04-15" }),
        );
      });
    });

    // ---- BACKLOG-3614: optional Listing Price on step 1 ----

    it("L1: a Listing Price typed as $525,000 is sent on create as 525000", async () => {
      const payload = await createThroughTheWizard("$525,000");
      expect(payload.listing_price).toBe(525000);
      // the raw text never leaves the renderer
      expect(payload).not.toHaveProperty("listing_price_text");
    });

    it("L2: a blank Listing Price still creates the transaction, with no listing price sent", async () => {
      const payload = await createThroughTheWizard();
      expect(window.api.transactions.createAudited).toHaveBeenCalledTimes(1);
      expect(payload).not.toHaveProperty("listing_price");
      expect(payload).not.toHaveProperty("listing_price_text");
    });

    it("L3: letters typed into the Listing Price are dropped, so step 1 still continues", async () => {
      renderCreate();
      await userEvent.type(
        screen.getByPlaceholderText(/enter property address/i),
        "123 Main Street",
      );
      const input = screen.getByTestId("create-audit-listing-price-input");
      await userEvent.type(input, "abc");
      // Live formatting (BACKLOG-3614 QA) keeps only digits and one dot, so a
      // non-amount can no longer be typed; the step-1 check stays as a guard.
      expect(input).toHaveValue("");
      await userEvent.click(getButton(/continue/i));
      expect(screen.queryByText("Listing Price must be a valid amount")).toBeNull();
    });

    it("L5: typing 1000000 shows 1,000,000 and sends the plain number 1000000", async () => {
      const payload = await createThroughTheWizard("1000000");
      expect(payload.listing_price).toBe(1000000);
      expect(typeof payload.listing_price).toBe("number");
      expect(payload).not.toHaveProperty("listing_price_text");
    });

    it("L6: the Listing Price field shows commas while typing on step 1", async () => {
      renderCreate();
      const input = screen.getByTestId("create-audit-listing-price-input");
      await userEvent.type(input, "100");
      expect(input).toHaveValue("100");
      await userEvent.type(input, "0");
      expect(input).toHaveValue("1,000");
      await userEvent.type(input, "000");
      expect(input).toHaveValue("1,000,000");
    });

    it("L4: Edit Transaction Details prefills the Listing Price and saves a change", async () => {
      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
          editTransaction={{
            id: "txn-edit-3614",
            user_id: "123",
            property_address: "456 Oak Street, City, ST 67890",
            transaction_type: "sale",
            status: "active",
            started_at: "2024-01-01",
            listing_price: 412500,
            created_at: "2024-01-01T00:00:00Z",
            updated_at: "2024-01-01T00:00:00Z",
          } as unknown as Transaction}
        />,
      );
      jest.mocked(window.api.transactions.update).mockResolvedValue({ success: true });

      const input = screen.getByTestId("create-audit-listing-price-input");
      await waitFor(() => expect(input).toHaveValue("412,500"));

      await userEvent.clear(input);
      await userEvent.type(input, "399,950");
      await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

      await waitFor(() => {
        expect(window.api.transactions.update).toHaveBeenCalledWith(
          "txn-edit-3614",
          expect.objectContaining({ listing_price: 399950 }),
        );
      });
    });
  });

  // BACKLOG-3614: Cancel / Back / primary float over the content at every width,
  // on every step of New Transaction and on Edit Transaction. jsdom applies no
  // CSS, so "floating" is asserted at class level: the group is `absolute`
  // inside a `relative` panel, and is not an in-flow flex-shrink-0 footer.
  describe("Floating action group (BACKLOG-3614)", () => {
    const manualContact = {
      id: "contact-manual-3614",
      user_id: "123",
      name: "Casey Manual",
      display_name: "Casey Manual",
      email: "casey@example.com",
      source: "manual",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
    } as unknown as Contact;

    const editTransaction = {
      id: "txn-3614",
      user_id: "123",
      property_address: "456 Oak Street, City, ST 67890",
      transaction_type: "sale" as const,
      status: "active" as const,
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
    } as unknown as Transaction;

    const renderModal = (edit = false) =>
      renderWithProvider(
        <AuditTransactionModal
          userId={mockUserId}
          provider={mockProvider}
          onClose={mockOnClose}
          onSuccess={mockOnSuccess}
          {...(edit ? { editTransaction } : {})}
        />,
      );

    const goToStep = async (target: 1 | 2 | 3) => {
      jest.mocked(window.api.contacts.getAll).mockResolvedValue({
        success: true,
        contacts: [manualContact],
      });
      jest.mocked(window.api.contacts.getSortedByActivity).mockResolvedValue({
        success: true,
        contacts: [manualContact],
      });
      renderModal();
      if (target === 1) return;
      await userEvent.type(
        screen.getByPlaceholderText(/enter property address/i),
        "123 Main Street",
      );
      await userEvent.click(screen.getByTestId("create-audit-submit"));
      await waitFor(() => {
        expect(screen.getByTestId("contact-assignment-step-2")).toBeInTheDocument();
      });
      if (target === 2) return;
      await userEvent.click(await screen.findByText("Casey Manual"));
      await waitFor(() => {
        expect(screen.getByTestId("added-count")).toHaveTextContent("1");
      });
      await userEvent.click(screen.getByTestId("create-audit-submit"));
      await waitFor(() => {
        expect(screen.getByTestId("contact-assignment-step-3")).toBeInTheDocument();
      });
    };

    const expectFloatingGroup = (expected: {
      back: boolean;
      primary: RegExp;
    }) => {
      const bar = screen.getByTestId("audit-floating-actions");
      // Floating: absolutely positioned at the bottom-right of the panel...
      expect(bar.className).toEqual(expect.stringContaining("absolute"));
      expect(bar.className).toEqual(expect.stringContaining("bottom-4"));
      expect(bar.className).not.toEqual(expect.stringContaining("flex-shrink-0"));
      // ...and not hidden at any width (no sm:hidden / hidden sm:flex split).
      expect(bar.className).not.toMatch(/(^|\s)(sm:)?hidden(\s|$)/);
      // ...inside a panel that is its containing block.
      expect(bar.parentElement?.className).toEqual(expect.stringContaining("relative"));

      // Exactly one set of buttons, all inside the group.
      const inBar = (name: RegExp) =>
        Array.from(bar.querySelectorAll("button")).filter((b) =>
          name.test(b.textContent ?? ""),
        );
      expect(inBar(/^cancel$/i)).toHaveLength(1);
      expect(inBar(/back/i)).toHaveLength(expected.back ? 1 : 0);
      expect(inBar(expected.primary)).toHaveLength(1);
      expect(screen.getAllByTestId("create-audit-submit")).toHaveLength(1);
      expect(bar).toContainElement(screen.getByTestId("create-audit-submit"));

      // Content keeps its last row clear of the group.
      expect(screen.getByTestId("audit-modal-content").className).toEqual(
        expect.stringContaining(FLOATING_ACTION_BAR_CONTENT_PADDING),
      );
    };

    it("F1: step 1 — Cancel + Continue float, no Back, content padded", async () => {
      await goToStep(1);
      expectFloatingGroup({ back: false, primary: /continue/i });
    });

    it("F2: step 2 — Cancel + Back + Continue float, content padded", async () => {
      await goToStep(2);
      expectFloatingGroup({ back: true, primary: /continue/i });
    });

    it("F3: step 3 — Cancel + Back + Create Transaction float, content padded", async () => {
      await goToStep(3);
      expectFloatingGroup({ back: true, primary: /create transaction/i });
    });

    it("F4: Edit Transaction — Cancel + Save Changes float, content padded", () => {
      renderModal(true);
      expectFloatingGroup({ back: false, primary: /save changes/i });
    });

    it.each([1, 2, 3] as const)("F5: Cancel closes the modal on step %i", async (target) => {
      await goToStep(target);
      await userEvent.click(
        within(screen.getByTestId("audit-floating-actions")).getByRole("button", {
          name: /^cancel$/i,
        }),
      );
      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });

    it("F6: Cancel closes the modal in Edit Transaction", async () => {
      renderModal(true);
      await userEvent.click(
        within(screen.getByTestId("audit-floating-actions")).getByRole("button", {
          name: /^cancel$/i,
        }),
      );
      expect(mockOnClose).toHaveBeenCalledTimes(1);
    });

    it("F7: Back on the floating group returns from step 2 to step 1", async () => {
      await goToStep(2);
      await userEvent.click(screen.getByTestId("create-audit-back"));
      await waitFor(() => {
        expect(screen.queryByTestId("contact-assignment-step-2")).toBeNull();
      });
      expect(screen.getByPlaceholderText(/enter property address/i)).toBeInTheDocument();
    });
  });
});
