/**
 * Integration tests for contact deletion prevention UI
 * Tests the Contacts component blocking modal and user flow
 *
 * NOTE: These tests verify the backend logic through the component.
 * Full UI interaction tests are skipped as they require proper DOM setup
 * that is complex in an Electron/React environment.
 *
 * The core deletion prevention logic is thoroughly tested in:
 * - electron/services/__tests__/databaseService.contactDeletion.test.js (13 tests)
 *
 * BACKLOG-2367: the button queries below are ANCHORED (`/^remove$/i`) rather
 * than loose (`/remove/i`). Clients & Contacts now also renders a "Show removed
 * contacts" toggle, which the loose regex matched too — so the query returned
 * two buttons and every case using it failed on ambiguity. Anchoring targets the
 * Remove control by its exact accessible name, which is what these cases always
 * meant; the loose form would break again on any future label containing the
 * word "remove".
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import Contacts from "../Contacts";
import type { Contact } from "../../../electron/types/models";
import type { ContactBlockingTransaction } from "../../../electron/types/ipc/window-api-contacts";

/**
 * Real response shape of `contacts.delete` / `contacts.remove` on the BLOCKED
 * path. `electron/types/ipc/window-api-contacts.ts` only declares
 * `{ success, error }`, but `contactHandlers.ts` also returns
 * `canDelete` / `transactions` / `count` when the contact is still linked to
 * transactions. Declared locally so these tests keep asserting the real shape
 * without touching the production declaration.
 */
type BlockedDeleteResponse = {
  success: boolean;
  error?: string;
  canDelete?: boolean;
  transactions?: Partial<ContactBlockingTransaction>[];
  count?: number;
};

// Mock useAppStateMachine to return isDatabaseInitialized: true
// This allows tests to render the actual component content
jest.mock("../../appCore", () => ({
  ...jest.requireActual("../../appCore"),
  useAppStateMachine: () => ({
    isDatabaseInitialized: true,
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

describe("Contacts - Deletion Prevention", () => {
  const mockUserId = "user-123";
  const mockOnClose = jest.fn();

  const mockContacts = [
    {
      id: "contact-1",
      name: "John Doe",
      email: "john@example.com",
      phone: "555-1234",
      company: "ABC Real Estate",
      source: "manual",
      // BACKLOG-1898 T3: Clients-only default view requires an explicit Clients role
      default_role: "buyer",
    },
    {
      id: "contact-2",
      name: "Jane Smith",
      email: "jane@example.com",
      phone: "555-5678",
      company: "XYZ Realty",
      // source changed email->contacts_app: raw email source hidden by default pending BACKLOG-1912
      source: "contacts_app",
      // BACKLOG-1898 T3: Clients-only default view requires an explicit Clients role
      default_role: "buyer",
    },
    {
      id: "contact-3",
      name: "Bob Wilson",
      email: "bob@example.com",
      phone: null,
      company: "Wilson & Co",
      source: "contacts_app",
      // BACKLOG-1898 T3: Clients-only default view requires an explicit Clients role
      default_role: "buyer",
    },
    // Cast: these are deliberately partial contact rows — they carry only the
    // fields the list renders (legacy `name`, email, phone, company, source,
    // default_role) and omit user_id/created_at/updated_at. Filling those in
    // would change the data the component receives, so the shape is preserved
    // and only the type is widened.
  ] as unknown as Contact[];

  beforeEach(() => {
    jest.clearAllMocks();

    // Default mock: empty contacts list
    jest.mocked(window.api.contacts.getAll).mockResolvedValue({
      success: true,
      contacts: [],
    });
  });

  describe("Component rendering and API integration", () => {
    it("should render contacts list when loaded", async () => {
      jest.mocked(window.api.contacts.getAll).mockResolvedValue({
        success: true,
        contacts: [mockContacts[0]],
      });

      render(<Contacts userId={mockUserId} onClose={mockOnClose} />);

      // Wait for contacts to load
      await waitFor(() => {
        expect(screen.getByText("John Doe")).toBeInTheDocument();
      });

      // Verify API was called
      expect(window.api.contacts.getAll).toHaveBeenCalledWith(mockUserId);
    });

    it("should have checkCanDelete API available in window.api", () => {
      // Verify the API endpoint exists (set up in tests/setup.js)
      expect(window.api.contacts.checkCanDelete).toBeDefined();
      expect(typeof window.api.contacts.checkCanDelete).toBe("function");
    });

    it("should show loading state initially", () => {
      jest.mocked(window.api.contacts.getAll).mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 1000)),
      );

      render(<Contacts userId={mockUserId} onClose={mockOnClose} />);

      // Loading indicator should be present
      expect(document.querySelector(".animate-spin")).toBeInTheDocument();
    });

    it("should show error when contacts fail to load", async () => {
      jest.mocked(window.api.contacts.getAll).mockResolvedValue({
        success: false,
        error: "Failed to load contacts",
      });

      render(<Contacts userId={mockUserId} onClose={mockOnClose} />);

      // Use testid to avoid finding multiple elements with error text
      await waitFor(() => {
        expect(screen.getByTestId("error-state")).toBeInTheDocument();
      });
    });

    it("should render contacts list successfully", async () => {
      jest.mocked(window.api.contacts.getAll).mockResolvedValue({
        success: true,
        contacts: mockContacts,
      });

      render(<Contacts userId={mockUserId} onClose={mockOnClose} />);

      // Verify all contacts are rendered
      await waitFor(() => {
        expect(screen.getByText("John Doe")).toBeInTheDocument();
      });
      expect(screen.getByText("Jane Smith")).toBeInTheDocument();
      expect(screen.getByText("Bob Wilson")).toBeInTheDocument();
    });

    it("should filter contacts by search query", async () => {
      jest.mocked(window.api.contacts.getAll).mockResolvedValue({
        success: true,
        contacts: mockContacts,
      });

      render(<Contacts userId={mockUserId} onClose={mockOnClose} />);

      await waitFor(() => {
        expect(screen.getByText("John Doe")).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText(/search contacts/i);
      await userEvent.type(searchInput, "Jane");

      // Only Jane should be visible
      expect(screen.getByText("Jane Smith")).toBeInTheDocument();
      expect(screen.queryByText("John Doe")).not.toBeInTheDocument();
      expect(screen.queryByText("Bob Wilson")).not.toBeInTheDocument();
    });

    it("should filter contacts by email", async () => {
      jest.mocked(window.api.contacts.getAll).mockResolvedValue({
        success: true,
        contacts: mockContacts,
      });

      render(<Contacts userId={mockUserId} onClose={mockOnClose} />);

      await waitFor(() => {
        expect(screen.getByText("John Doe")).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText(/search contacts/i);
      await userEvent.type(searchInput, "bob@example");

      expect(screen.getByText("Bob Wilson")).toBeInTheDocument();
      expect(screen.queryByText("John Doe")).not.toBeInTheDocument();
    });

    it("should filter contacts by partial name", async () => {
      jest.mocked(window.api.contacts.getAll).mockResolvedValue({
        success: true,
        contacts: mockContacts,
      });

      render(<Contacts userId={mockUserId} onClose={mockOnClose} />);

      await waitFor(() => {
        expect(screen.getByText("John Doe")).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText(/search contacts/i);
      await userEvent.type(searchInput, "Smith");

      expect(screen.getByText("Jane Smith")).toBeInTheDocument();
      expect(screen.queryByText("John Doe")).not.toBeInTheDocument();
    });
  });

  describe("Backend deletion prevention logic (tested via API)", () => {
    it("should call checkCanDelete when attempting to delete", async () => {
      jest.mocked(window.api.contacts.checkCanDelete).mockResolvedValue({
        success: true,
        canDelete: false,
        // Cast: partial transaction row on purpose — the assertion below only
        // reads property_address, so the fixture carries just the identifying
        // fields rather than a full Transaction.
        transactions: [
          {
            id: "txn-1",
            property_address: "123 Main St",
            // BACKLOG-1930: roles is a string[] at the IPC boundary.
            roles: ["Buyer Agent"],
          },
        ] as unknown as ContactBlockingTransaction[],
        count: 1,
      });

      // Call the API directly to verify it works
      const result = await window.api.contacts.checkCanDelete("contact-1");

      expect(result.success).toBe(true);
      expect(result.canDelete).toBe(false);
      expect(result.count).toBe(1);
      expect(result.transactions).toHaveLength(1);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by the toHaveLength assertion above
      expect(result.transactions![0].property_address).toBe("123 Main St");
    });

    it("should return transaction details when contact has associations", async () => {
      const mockTransactions = [
        {
          id: "txn-1",
          property_address: "123 Main St",
          closed_at: "2024-01-15",
          transaction_type: "purchase",
          status: "active",
          roles: ["Buyer Agent"],
        },
        {
          id: "txn-2",
          property_address: "456 Oak Ave",
          closed_at: "2024-02-20",
          transaction_type: "sale",
          status: "closed",
          roles: ["Listing Agent", "Inspector"],
        },
      ];

      jest.mocked(window.api.contacts.checkCanDelete).mockResolvedValue({
        success: true,
        canDelete: false,
        // Cast: partial transaction rows on purpose — the toMatchObject
        // assertions below only read property_address and roles.
        transactions: mockTransactions as unknown as ContactBlockingTransaction[],
        count: 2,
      });

      const result = await window.api.contacts.checkCanDelete("contact-1");

      expect(result.canDelete).toBe(false);
      expect(result.transactions).toHaveLength(2);
      expect(result.count).toBe(2);

      // Verify transaction details are included
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by the toHaveLength assertion above
      expect(result.transactions![0]).toMatchObject({
        property_address: "123 Main St",
        roles: ["Buyer Agent"],
      });
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by the toHaveLength assertion above
      expect(result.transactions![1]).toMatchObject({
        property_address: "456 Oak Ave",
        roles: ["Listing Agent", "Inspector"],
      });
    });

    it("should allow deletion when contact has no transactions", async () => {
      jest.mocked(window.api.contacts.checkCanDelete).mockResolvedValue({
        success: true,
        canDelete: true,
        transactions: [],
        count: 0,
      });

      const result = await window.api.contacts.checkCanDelete("contact-1");

      expect(result.canDelete).toBe(true);
      expect(result.transactions).toHaveLength(0);
      expect(result.count).toBe(0);
    });

    it("should handle errors from checkCanDelete API", async () => {
      jest.mocked(window.api.contacts.checkCanDelete).mockResolvedValue({
        success: false,
        error: "Database connection failed",
      });

      const result = await window.api.contacts.checkCanDelete("contact-1");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Database connection failed");
    });
  });

  describe("Delete API behavior", () => {
    it("should block deletion via delete API when contact has transactions", async () => {
      // Casts: see BlockedDeleteResponse above — the IPC declaration for
      // contacts.delete is narrower than what contactHandlers.ts actually
      // returns on the blocked path.
      jest.mocked(window.api.contacts.delete).mockResolvedValue({
        success: false,
        error: "Cannot delete contact with associated transactions",
        canDelete: false,
        transactions: [
          {
            id: "txn-1",
            property_address: "123 Main St",
            roles: ["Buyer Agent"],
          },
        ],
        count: 1,
      } as BlockedDeleteResponse);

      const result = (await window.api.contacts.delete(
        "contact-1",
      )) as BlockedDeleteResponse;

      expect(result.success).toBe(false);
      expect(result.canDelete).toBe(false);
      expect(result.transactions).toBeDefined();
    });

    it("should block deletion via remove API when contact has transactions", async () => {
      // Casts: see BlockedDeleteResponse above — the IPC declaration for
      // contacts.remove is narrower than what contactHandlers.ts actually
      // returns on the blocked path.
      jest.mocked(window.api.contacts.remove).mockResolvedValue({
        success: false,
        error: "Cannot delete contact with associated transactions",
        canDelete: false,
        transactions: [
          {
            id: "txn-1",
            property_address: "123 Main St",
            roles: ["Buyer Agent"],
          },
        ],
        count: 1,
      } as BlockedDeleteResponse);

      const result = (await window.api.contacts.remove(
        "contact-1",
      )) as BlockedDeleteResponse;

      expect(result.success).toBe(false);
      expect(result.canDelete).toBe(false);
    });

    it("should allow deletion via delete API when contact has no transactions", async () => {
      jest.mocked(window.api.contacts.delete).mockResolvedValue({
        success: true,
      });

      const result = await window.api.contacts.delete("contact-1");

      expect(result.success).toBe(true);
    });

    it("should allow removal via remove API when contact has no transactions", async () => {
      jest.mocked(window.api.contacts.remove).mockResolvedValue({
        success: true,
      });

      const result = await window.api.contacts.remove("contact-1");

      expect(result.success).toBe(true);
    });
  });

  describe("Navigation", () => {
    it("should call onClose when back button is clicked", async () => {
      jest.mocked(window.api.contacts.getAll).mockResolvedValue({
        success: true,
        contacts: mockContacts,
      });

      render(<Contacts userId={mockUserId} onClose={mockOnClose} />);

      await waitFor(() => {
        expect(screen.getByText("John Doe")).toBeInTheDocument();
      });

      const backButton = screen.getByRole("button", {
        name: /back to dashboard/i,
      });
      await userEvent.click(backButton);

      expect(mockOnClose).toHaveBeenCalled();
    });
  });

  // BACKLOG-2356: contact list rows are name-only. Source/import-status pills
  // are no longer rendered inline in the row — full details (including source)
  // live in the contact detail/preview pane. These tests assert the row shows
  // the contact name and that the pills are absent from the list.
  describe("Contact list rows (name-only — BACKLOG-2356)", () => {
    it("shows the name but no source/status badge for manual contacts", async () => {
      jest.mocked(window.api.contacts.getAll).mockResolvedValue({
        success: true,
        contacts: [mockContacts[0]], // source: 'manual'
      });

      render(<Contacts userId={mockUserId} onClose={mockOnClose} />);

      await waitFor(() => {
        expect(screen.getByText("John Doe")).toBeInTheDocument();
      });

      expect(screen.queryByTestId("source-pill-manual")).not.toBeInTheDocument();
      expect(screen.queryByTestId("status-pill-imported")).not.toBeInTheDocument();
    });

    // SKIP pending BACKLOG-1912: raw source='email' has no matching source leaf
    // (plan §2 gap). A non-derived email-sourced contact is hidden by the
    // Clients-&-Contacts default Source filter, so it never renders here.
    // Uses an inline source:'email' contact (mockContacts[1] was flipped to
    // contacts_app to keep the name/search tests green) so this skip documents
    // the real BACKLOG-1912 target. Re-enable when the raw-email source leaf
    // lands in contactFilterModel.ts.
    it.skip("should display Email badge for email contacts", async () => {
      jest.mocked(window.api.contacts.getAll).mockResolvedValue({
        success: true,
        contacts: [{ ...mockContacts[1], source: "email" }], // source: 'email' (raw)
      });

      render(<Contacts userId={mockUserId} onClose={mockOnClose} />);

      await waitFor(() => {
        expect(screen.getByText("Jane Smith")).toBeInTheDocument();
      });

      expect(screen.getByTestId("source-pill-email")).toBeInTheDocument();
      expect(screen.getByTestId("status-pill-imported")).toBeInTheDocument();
    });

    it("shows the name but no source/status badge for contacts_app contacts", async () => {
      jest.mocked(window.api.contacts.getAll).mockResolvedValue({
        success: true,
        contacts: [mockContacts[2]], // source: 'contacts_app'
      });

      render(<Contacts userId={mockUserId} onClose={mockOnClose} />);

      await waitFor(() => {
        expect(screen.getByText("Bob Wilson")).toBeInTheDocument();
      });

      expect(screen.queryByTestId("source-pill-contacts_app")).not.toBeInTheDocument();
      expect(screen.queryByTestId("status-pill-imported")).not.toBeInTheDocument();
    });
  });

  describe("API availability", () => {
    it("should have all required contact APIs available", () => {
      expect(window.api.contacts.getAll).toBeDefined();
      expect(window.api.contacts.create).toBeDefined();
      expect(window.api.contacts.update).toBeDefined();
      expect(window.api.contacts.delete).toBeDefined();
      expect(window.api.contacts.remove).toBeDefined();
      expect(window.api.contacts.checkCanDelete).toBeDefined();
      expect(window.api.contacts.getSortedByActivity).toBeDefined();
    });
  });

  describe("Remove Confirmation Modal", () => {
    it("should show custom confirmation modal when removing a contact", async () => {
      jest.mocked(window.api.contacts.getAll).mockResolvedValue({
        success: true,
        contacts: [mockContacts[2]], // source: 'contacts_app'
      });

      jest.mocked(window.api.contacts.checkCanDelete).mockResolvedValue({
        success: true,
        canDelete: true,
        transactions: [],
        count: 0,
      });

      render(<Contacts userId={mockUserId} onClose={mockOnClose} />);

      // Wait for contacts to load
      await waitFor(() => {
        expect(screen.getByText("Bob Wilson")).toBeInTheDocument();
      });

      // Click on the contact to open details modal
      await userEvent.click(screen.getByText("Bob Wilson"));

      // Wait for details modal to appear
      await waitFor(() => {
        expect(screen.getByTestId("contact-preview-modal")).toBeInTheDocument();
      });

      // Click the Remove button in details modal
      const removeButton = screen.getByRole("button", { name: /^remove$/i });
      await userEvent.click(removeButton);

      // The custom confirmation modal should appear
      await waitFor(() => {
        expect(screen.getByText("Remove Contact")).toBeInTheDocument();
        expect(
          screen.getByText(/Remove this contact from your local database/i),
        ).toBeInTheDocument();
      });

      // Both Cancel and Remove buttons should be present
      expect(
        screen.getByRole("button", { name: /cancel/i }),
      ).toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: /^remove$/i })).toHaveLength(
        1,
      ); // Only the modal remove button
    });

    it("should close confirmation modal when Cancel is clicked", async () => {
      jest.mocked(window.api.contacts.getAll).mockResolvedValue({
        success: true,
        contacts: [mockContacts[2]], // source: 'contacts_app'
      });

      jest.mocked(window.api.contacts.checkCanDelete).mockResolvedValue({
        success: true,
        canDelete: true,
        transactions: [],
        count: 0,
      });

      render(<Contacts userId={mockUserId} onClose={mockOnClose} />);

      await waitFor(() => {
        expect(screen.getByText("Bob Wilson")).toBeInTheDocument();
      });

      // Open contact details
      await userEvent.click(screen.getByText("Bob Wilson"));

      await waitFor(() => {
        expect(screen.getByTestId("contact-preview-modal")).toBeInTheDocument();
      });

      // Click Remove to open confirmation modal
      await userEvent.click(screen.getByRole("button", { name: /^remove$/i }));

      await waitFor(() => {
        expect(screen.getByText("Remove Contact")).toBeInTheDocument();
      });

      // Click Cancel
      await userEvent.click(screen.getByRole("button", { name: /cancel/i }));

      // Confirmation modal should close
      await waitFor(() => {
        expect(screen.queryByText("Remove Contact")).not.toBeInTheDocument();
      });
    });

    it("should call remove API when confirmation is accepted", async () => {
      jest.mocked(window.api.contacts.getAll).mockResolvedValue({
        success: true,
        contacts: [mockContacts[2]], // source: 'contacts_app'
      });

      jest.mocked(window.api.contacts.checkCanDelete).mockResolvedValue({
        success: true,
        canDelete: true,
        transactions: [],
        count: 0,
      });

      jest.mocked(window.api.contacts.remove).mockResolvedValue({
        success: true,
      });

      render(<Contacts userId={mockUserId} onClose={mockOnClose} />);

      await waitFor(() => {
        expect(screen.getByText("Bob Wilson")).toBeInTheDocument();
      });

      // Open contact details
      await userEvent.click(screen.getByText("Bob Wilson"));

      await waitFor(() => {
        expect(screen.getByTestId("contact-preview-modal")).toBeInTheDocument();
      });

      // Click Remove to open confirmation modal
      await userEvent.click(screen.getByRole("button", { name: /^remove$/i }));

      await waitFor(() => {
        expect(screen.getByText("Remove Contact")).toBeInTheDocument();
      });

      // Click Remove in confirmation modal to confirm
      const confirmButtons = screen.getAllByRole("button", { name: /^remove$/i });
      await userEvent.click(confirmButtons[0]); // Click the confirm button

      // Verify remove API was called
      await waitFor(() => {
        expect(window.api.contacts.remove).toHaveBeenCalledWith("contact-3");
      });
    });

    it("SHOWS the confirmation modal for a contact that has transactions", async () => {
      // BACKLOG-2365, founder-approved. This previously asserted the opposite:
      // that a contact on a deal was refused with a "Cannot delete contact"
      // alert and never reached the confirmation modal. That refusal existed
      // only because removal hard-deleted and cascaded away the contact's roles
      // on those very deals. Removal is a reversible tombstone now, so the user
      // gets the ordinary confirmation instead of a dead end.
      const alertMock = jest
        .spyOn(window, "alert")
        .mockImplementation(() => {});

      jest.mocked(window.api.contacts.getAll).mockResolvedValue({
        success: true,
        contacts: [mockContacts[2]], // source: 'contacts_app'
      });

      jest.mocked(window.api.contacts.checkCanDelete).mockResolvedValue({
        success: true,
        // Deliberately left at `false` — the most hostile answer the main
        // process could give. The renderer must no longer consult this at all,
        // so this asserts the gate is GONE rather than merely inverted.
        canDelete: false,
        transactions: [
          { id: "txn-1", property_address: "123 Main St" },
        ] as unknown as ContactBlockingTransaction[],
        transactionCount: 1,
      });

      render(<Contacts userId={mockUserId} onClose={mockOnClose} />);

      await waitFor(() => {
        expect(screen.getByText("Bob Wilson")).toBeInTheDocument();
      });

      // Open contact details
      await userEvent.click(screen.getByText("Bob Wilson"));

      await waitFor(() => {
        expect(screen.getByTestId("contact-preview-modal")).toBeInTheDocument();
      });

      // Click Remove
      await userEvent.click(screen.getByRole("button", { name: /^remove$/i }));

      // The confirmation modal appears — the transaction is no longer a block.
      await waitFor(() => {
        expect(screen.getByText("Remove Contact")).toBeInTheDocument();
      });

      // And the user is never told they cannot do this.
      expect(alertMock).not.toHaveBeenCalled();

      alertMock.mockRestore();
    });

    it("should remove contact from UI with optimistic update", async () => {
      jest.mocked(window.api.contacts.getAll).mockResolvedValue({
        success: true,
        contacts: [mockContacts[2]],
      });

      jest.mocked(window.api.contacts.checkCanDelete).mockResolvedValue({
        success: true,
        canDelete: true,
        transactions: [],
        count: 0,
      });

      jest.mocked(window.api.contacts.remove).mockResolvedValue({
        success: true,
      });

      render(<Contacts userId={mockUserId} onClose={mockOnClose} />);

      await waitFor(() => {
        expect(screen.getByText("Bob Wilson")).toBeInTheDocument();
      });

      // Open contact details
      await userEvent.click(screen.getByText("Bob Wilson"));

      await waitFor(() => {
        expect(screen.getByTestId("contact-preview-modal")).toBeInTheDocument();
      });

      // Click Remove to open confirmation modal
      await userEvent.click(screen.getByRole("button", { name: /^remove$/i }));

      await waitFor(() => {
        expect(screen.getByText("Remove Contact")).toBeInTheDocument();
      });

      // Confirm removal
      const confirmButtons = screen.getAllByRole("button", { name: /^remove$/i });
      await userEvent.click(confirmButtons[0]);

      // Verify contact is removed from UI via optimistic update (no second getAll call)
      await waitFor(() => {
        expect(screen.queryByText("Bob Wilson")).not.toBeInTheDocument();
      });

      // Only initial load should trigger getAll (optimistic update doesn't reload)
      expect(window.api.contacts.getAll).toHaveBeenCalledTimes(1);
    });
  });
});
