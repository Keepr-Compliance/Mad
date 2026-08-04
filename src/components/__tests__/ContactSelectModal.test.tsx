/**
 * Tests for ContactSelectModal.tsx
 *
 * BACKLOG-2389: the picker is now a two-pane "Available | Added" layout.
 * Selection happens by clicking a contact's row / [+ Add] affordance in the
 * Available pane (which MOVES it to the Added pane), and de-selection happens by
 * clicking the ✕ on its chip in the Added pane (which RETURNS it to Available).
 *
 * Test hooks:
 *   - Available row (add):   data-testid="add-contact-<id>"      (a <button>)
 *   - Added chip:            data-testid="added-contact-<id>"
 *   - Added chip remove (✕): data-testid="remove-contact-<id>"   (a <button>)
 *   - Footer confirm:        data-testid="confirm-add-button"
 */

import React from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import ContactSelectModal from "../ContactSelectModal";
import type { ExtendedContact } from "../../types/components";

describe("ContactSelectModal", () => {
  const mockOnSelect = jest.fn();
  const mockOnClose = jest.fn();

  // Partial ExtendedContact rows: `created_at` / `updated_at` are required on the
  // base Contact model but are never read or asserted by the picker, so they are
  // asserted away rather than invented.
  const mockContacts = [
    {
      id: "contact-1",
      user_id: "user-1",
      name: "John Smith",
      email: "john@example.com",
      company: "Smith Corp",
      source: "email",
    },
    {
      id: "contact-2",
      user_id: "user-1",
      name: "Jane Doe",
      email: "jane@example.com",
      company: "Doe LLC",
      source: "email",
    },
    {
      id: "contact-3",
      user_id: "user-1",
      name: "Bob Johnson",
      email: "bob@realty.com",
      company: "Realty Partners",
      source: "email",
      address_mention_count: 5,
      last_communication_at: "2024-01-15T10:00:00Z",
    },
  ] as ExtendedContact[];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Rendering", () => {
    it("should render modal with correct title for single select", () => {
      render(
        <ContactSelectModal
          contacts={mockContacts}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      expect(screen.getByText("Select Contact")).toBeInTheDocument();
    });

    it("should render modal with correct title for multi-select", () => {
      render(
        <ContactSelectModal
          contacts={mockContacts}
          multiple={true}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      expect(screen.getByText("Select Contacts")).toBeInTheDocument();
    });

    it("should render the Available and Added pane headings", () => {
      render(
        <ContactSelectModal
          contacts={mockContacts}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      expect(screen.getByText("Available")).toBeInTheDocument();
      // Added pane header shows the running count
      expect(screen.getByText("Added (0)")).toBeInTheDocument();
    });

    it("should display all contacts as available rows", () => {
      render(
        <ContactSelectModal
          contacts={mockContacts}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      expect(screen.getByText("John Smith")).toBeInTheDocument();
      expect(screen.getByText("Jane Doe")).toBeInTheDocument();
      expect(screen.getByText("Bob Johnson")).toBeInTheDocument();
      // Every unselected contact exposes an add affordance
      expect(screen.getByTestId("add-contact-contact-1")).toBeInTheDocument();
      expect(screen.getByTestId("add-contact-contact-2")).toBeInTheDocument();
      expect(screen.getByTestId("add-contact-contact-3")).toBeInTheDocument();
    });

    it("should NOT display contact emails (only name and company shown)", () => {
      render(
        <ContactSelectModal
          contacts={mockContacts}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      // Emails should not be displayed in the list (TASK-1127: reduce visual clutter)
      expect(screen.queryByText("john@example.com")).not.toBeInTheDocument();
      expect(screen.queryByText("jane@example.com")).not.toBeInTheDocument();
    });

    it("should display contact companies", () => {
      render(
        <ContactSelectModal
          contacts={mockContacts}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      expect(screen.getByText("Smith Corp")).toBeInTheDocument();
      expect(screen.getByText("Doe LLC")).toBeInTheDocument();
    });

    it("should show empty state when no contacts available", () => {
      render(
        <ContactSelectModal
          contacts={[]}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      expect(screen.getByText("No contacts available")).toBeInTheDocument();
    });

    it("should show property address badge when propertyAddress is provided", () => {
      render(
        <ContactSelectModal
          contacts={mockContacts}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
          propertyAddress="123 Main St"
        />
      );

      // Bob Johnson has address_mention_count of 5
      expect(screen.getByText("5 related emails")).toBeInTheDocument();
    });
  });

  describe("Two-pane add / remove interaction", () => {
    it("should move a contact from Available to Added when its row is clicked", async () => {
      render(
        <ContactSelectModal
          contacts={mockContacts}
          multiple={true}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      // Initially John is in the Available pane, not the Added pane
      expect(screen.getByTestId("add-contact-contact-1")).toBeInTheDocument();
      expect(screen.queryByTestId("added-contact-contact-1")).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId("add-contact-contact-1"));

      await waitFor(() => {
        // John is now a chip in the Added pane...
        expect(screen.getByTestId("added-contact-contact-1")).toBeInTheDocument();
        // ...and no longer available to add
        expect(screen.queryByTestId("add-contact-contact-1")).not.toBeInTheDocument();
      });
      expect(screen.getByText("Added (1)")).toBeInTheDocument();
    });

    it("should return a contact to Available when its ✕ is clicked", async () => {
      render(
        <ContactSelectModal
          contacts={mockContacts}
          multiple={true}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      // Add John
      fireEvent.click(screen.getByTestId("add-contact-contact-1"));
      await waitFor(() => {
        expect(screen.getByTestId("added-contact-contact-1")).toBeInTheDocument();
      });

      // Remove John via the chip's ✕
      fireEvent.click(screen.getByTestId("remove-contact-contact-1"));

      await waitFor(() => {
        // Chip gone, row back in Available
        expect(screen.queryByTestId("added-contact-contact-1")).not.toBeInTheDocument();
        expect(screen.getByTestId("add-contact-contact-1")).toBeInTheDocument();
      });
      expect(screen.getByText("Added (0)")).toBeInTheDocument();
      expect(screen.getByText("Choose from your contacts")).toBeInTheDocument();
    });

    it("should show empty Added-pane placeholder before anything is added", () => {
      render(
        <ContactSelectModal
          contacts={mockContacts}
          multiple={true}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      expect(screen.getByText("No contacts added yet")).toBeInTheDocument();
    });
  });

  describe("Contact Selection - Single Mode", () => {
    it("should select a contact when its row is clicked", async () => {
      render(
        <ContactSelectModal
          contacts={mockContacts}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      fireEvent.click(screen.getByTestId("add-contact-contact-1"));

      // Should show 1 selected in header
      await waitFor(() => {
        expect(screen.getByText("1 selected")).toBeInTheDocument();
      });
    });

    it("should replace selection when adding another contact in single mode", async () => {
      render(
        <ContactSelectModal
          contacts={mockContacts}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
          multiple={false}
        />
      );

      // Add John first
      fireEvent.click(screen.getByTestId("add-contact-contact-1"));
      await waitFor(() => {
        expect(screen.getByTestId("added-contact-contact-1")).toBeInTheDocument();
        expect(screen.getByText("1 selected")).toBeInTheDocument();
      });

      // Then add Jane — single-select should REPLACE John
      fireEvent.click(screen.getByTestId("add-contact-contact-2"));

      await waitFor(() => {
        // Jane is now the only chip
        expect(screen.getByTestId("added-contact-contact-2")).toBeInTheDocument();
        // John was returned to Available
        expect(screen.queryByTestId("added-contact-contact-1")).not.toBeInTheDocument();
        expect(screen.getByTestId("add-contact-contact-1")).toBeInTheDocument();
      });
      // Still only 1 selected
      expect(screen.getByText("1 selected")).toBeInTheDocument();
    });

    it("should call onSelect with selected contact when Add is clicked", async () => {
      render(
        <ContactSelectModal
          contacts={mockContacts}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      // Select John
      fireEvent.click(screen.getByTestId("add-contact-contact-1"));

      await waitFor(() => {
        expect(screen.getByText("1 selected")).toBeInTheDocument();
      });

      // Click footer Add button
      fireEvent.click(screen.getByTestId("confirm-add-button"));

      expect(mockOnSelect).toHaveBeenCalledWith([mockContacts[0]]);
    });
  });

  describe("Contact Selection - Multi-Select Mode", () => {
    it("should allow selecting multiple contacts", async () => {
      render(
        <ContactSelectModal
          contacts={mockContacts}
          multiple={true}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      fireEvent.click(screen.getByTestId("add-contact-contact-1"));
      await waitFor(() => {
        expect(screen.getByText("1 selected")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId("add-contact-contact-2"));
      await waitFor(() => {
        expect(screen.getByText("2 selected")).toBeInTheDocument();
      });

      // Both should be chips in the Added pane
      expect(screen.getByTestId("added-contact-contact-1")).toBeInTheDocument();
      expect(screen.getByTestId("added-contact-contact-2")).toBeInTheDocument();
    });

    it("should remove a contact when its ✕ is clicked in multi-select mode", async () => {
      render(
        <ContactSelectModal
          contacts={mockContacts}
          multiple={true}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      // Add John
      fireEvent.click(screen.getByTestId("add-contact-contact-1"));
      await waitFor(() => {
        expect(screen.getByText("1 selected")).toBeInTheDocument();
      });

      // Remove John
      fireEvent.click(screen.getByTestId("remove-contact-contact-1"));
      await waitFor(() => {
        expect(screen.getByText("Choose from your contacts")).toBeInTheDocument();
      });
    });

    it("should call onSelect with all selected contacts when Add is clicked", async () => {
      render(
        <ContactSelectModal
          contacts={mockContacts}
          multiple={true}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      fireEvent.click(screen.getByTestId("add-contact-contact-1"));
      await waitFor(() => {
        expect(screen.getByText("1 selected")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId("add-contact-contact-2"));
      await waitFor(() => {
        expect(screen.getByText("2 selected")).toBeInTheDocument();
      });

      // Click footer Add button
      fireEvent.click(screen.getByTestId("confirm-add-button"));

      expect(mockOnSelect).toHaveBeenCalledWith([mockContacts[0], mockContacts[1]]);
    });
  });

  describe("Initial Selection", () => {
    it("should pre-select contacts when initialSelectedIds is provided", () => {
      render(
        <ContactSelectModal
          contacts={mockContacts}
          multiple={true}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
          initialSelectedIds={["contact-1", "contact-2"]}
        />
      );

      // Should show 2 selected
      expect(screen.getByText("2 selected")).toBeInTheDocument();
      // Both appear as chips in the Added pane
      expect(screen.getByTestId("added-contact-contact-1")).toBeInTheDocument();
      expect(screen.getByTestId("added-contact-contact-2")).toBeInTheDocument();
    });

    it("should render pre-selected contacts in the Added pane, not Available", () => {
      render(
        <ContactSelectModal
          contacts={mockContacts}
          multiple={true}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
          initialSelectedIds={["contact-1"]}
        />
      );

      // John is a chip in Added...
      expect(screen.getByTestId("added-contact-contact-1")).toBeInTheDocument();
      // ...and no longer an addable row in Available
      expect(screen.queryByTestId("add-contact-contact-1")).not.toBeInTheDocument();
    });

    it("should enable Add button when initialSelectedIds has values", () => {
      render(
        <ContactSelectModal
          contacts={mockContacts}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
          initialSelectedIds={["contact-1"]}
        />
      );

      expect(screen.getByTestId("confirm-add-button")).not.toBeDisabled();
    });

    it("should update selection state when initialSelectedIds changes", async () => {
      const { rerender } = render(
        <ContactSelectModal
          contacts={mockContacts}
          multiple={true}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
          initialSelectedIds={["contact-1"]}
        />
      );

      expect(screen.getByText("1 selected")).toBeInTheDocument();

      // Rerender with different initial selection
      rerender(
        <ContactSelectModal
          contacts={mockContacts}
          multiple={true}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
          initialSelectedIds={["contact-2", "contact-3"]}
        />
      );

      await waitFor(() => {
        expect(screen.getByText("2 selected")).toBeInTheDocument();
      });
      expect(screen.getByTestId("added-contact-contact-2")).toBeInTheDocument();
      expect(screen.getByTestId("added-contact-contact-3")).toBeInTheDocument();
    });

    it("should handle empty initialSelectedIds gracefully", () => {
      render(
        <ContactSelectModal
          contacts={mockContacts}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
          initialSelectedIds={[]}
        />
      );

      expect(screen.getByText("Choose from your contacts")).toBeInTheDocument();
    });

    it("should ignore invalid contact IDs in initialSelectedIds", () => {
      render(
        <ContactSelectModal
          contacts={mockContacts}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
          initialSelectedIds={["non-existent-id"]}
        />
      );

      // Add button should be disabled since no valid contacts are selected
      expect(screen.getByTestId("confirm-add-button")).toBeDisabled();
    });
  });

  describe("Search Filtering", () => {
    it("should filter contacts by name", async () => {
      render(
        <ContactSelectModal
          contacts={mockContacts}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      const searchInput = screen.getByPlaceholderText(/search contacts/i);
      fireEvent.change(searchInput, { target: { value: "John" } });

      await waitFor(() => {
        expect(screen.getByText("John Smith")).toBeInTheDocument();
        expect(screen.queryByText("Jane Doe")).not.toBeInTheDocument();
      });
    });

    it("should filter contacts by email", async () => {
      render(
        <ContactSelectModal
          contacts={mockContacts}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      const searchInput = screen.getByPlaceholderText(/search contacts/i);
      fireEvent.change(searchInput, { target: { value: "realty.com" } });

      await waitFor(() => {
        expect(screen.getByText("Bob Johnson")).toBeInTheDocument();
        expect(screen.queryByText("John Smith")).not.toBeInTheDocument();
      });
    });

    it("should filter contacts by company", async () => {
      render(
        <ContactSelectModal
          contacts={mockContacts}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      const searchInput = screen.getByPlaceholderText(/search contacts/i);
      fireEvent.change(searchInput, { target: { value: "Smith Corp" } });

      await waitFor(() => {
        expect(screen.getByText("John Smith")).toBeInTheDocument();
        expect(screen.queryByText("Jane Doe")).not.toBeInTheDocument();
      });
    });

    it("should show no results message when search has no matches", async () => {
      render(
        <ContactSelectModal
          contacts={mockContacts}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      const searchInput = screen.getByPlaceholderText(/search contacts/i);
      fireEvent.change(searchInput, { target: { value: "nonexistent" } });

      await waitFor(() => {
        expect(screen.getByText("No matching contacts found")).toBeInTheDocument();
      });
    });

    it("should be case insensitive", async () => {
      render(
        <ContactSelectModal
          contacts={mockContacts}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      const searchInput = screen.getByPlaceholderText(/search contacts/i);
      fireEvent.change(searchInput, { target: { value: "JOHN" } });

      await waitFor(() => {
        expect(screen.getByText("John Smith")).toBeInTheDocument();
      });
    });

    it("should keep already-added contacts in the Added pane while searching", async () => {
      render(
        <ContactSelectModal
          contacts={mockContacts}
          multiple={true}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      // Add John, then search for someone else
      fireEvent.click(screen.getByTestId("add-contact-contact-1"));
      await waitFor(() => {
        expect(screen.getByTestId("added-contact-contact-1")).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText(/search contacts/i);
      fireEvent.change(searchInput, { target: { value: "Jane" } });

      await waitFor(() => {
        // Available list is filtered to Jane
        expect(screen.getByTestId("add-contact-contact-2")).toBeInTheDocument();
      });
      // John's chip remains in the Added pane regardless of the search filter
      expect(screen.getByTestId("added-contact-contact-1")).toBeInTheDocument();
    });
  });

  describe("Exclude IDs", () => {
    it("should exclude contacts with excludeIds", () => {
      render(
        <ContactSelectModal
          contacts={mockContacts}
          excludeIds={["contact-1"]}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      expect(screen.queryByText("John Smith")).not.toBeInTheDocument();
      expect(screen.getByText("Jane Doe")).toBeInTheDocument();
    });

    it("should show empty state when all contacts are excluded", () => {
      render(
        <ContactSelectModal
          contacts={mockContacts}
          excludeIds={["contact-1", "contact-2", "contact-3"]}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      expect(screen.getByText("No contacts available")).toBeInTheDocument();
    });
  });

  describe("Cancel and Close", () => {
    it("should call onClose when Cancel is clicked", () => {
      render(
        <ContactSelectModal
          contacts={mockContacts}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      const cancelButton = screen.getByRole("button", { name: /cancel/i });
      fireEvent.click(cancelButton);

      expect(mockOnClose).toHaveBeenCalled();
    });

    it("should call onClose when X button is clicked", () => {
      render(
        <ContactSelectModal
          contacts={mockContacts}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      // Find header X close button by its SVG path (no contacts are added, so the
      // Added-pane chip ✕ buttons — which share this path — are not rendered).
      const closeButtons = screen.getAllByRole("button");
      const xButton = closeButtons.find((btn) =>
        btn.querySelector('svg path[d="M6 18L18 6M6 6l12 12"]')
      );

      expect(xButton).toBeDefined();
      fireEvent.click(xButton!);
      expect(mockOnClose).toHaveBeenCalled();
    });
  });

  describe("Add Button State", () => {
    it("should disable Add button when no contact is selected", () => {
      render(
        <ContactSelectModal
          contacts={mockContacts}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      expect(screen.getByTestId("confirm-add-button")).toBeDisabled();
    });

    it("should enable Add button when a contact is selected", async () => {
      render(
        <ContactSelectModal
          contacts={mockContacts}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      fireEvent.click(screen.getByTestId("add-contact-contact-1"));

      await waitFor(() => {
        expect(screen.getByTestId("confirm-add-button")).not.toBeDisabled();
      });
    });

    it("should show selection count in Add button", async () => {
      render(
        <ContactSelectModal
          contacts={mockContacts}
          multiple={true}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      fireEvent.click(screen.getByTestId("add-contact-contact-1"));
      await waitFor(() => {
        expect(screen.getByText("1 selected")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId("add-contact-contact-2"));

      await waitFor(() => {
        expect(screen.getByTestId("confirm-add-button")).toHaveTextContent(/add \(2\)/i);
      });
    });
  });

  describe("Accessibility", () => {
    it("should have accessible search input", () => {
      render(
        <ContactSelectModal
          contacts={mockContacts}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      const searchInput = screen.getByPlaceholderText(/search contacts/i);
      expect(searchInput).toBeInTheDocument();
    });

    it("should auto-focus search input", () => {
      render(
        <ContactSelectModal
          contacts={mockContacts}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      const searchInput = screen.getByPlaceholderText(/search contacts/i);
      expect(searchInput).toHaveFocus();
    });

    it("should expose accessible add rows and a labelled footer button", () => {
      render(
        <ContactSelectModal
          contacts={mockContacts}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      // Each available contact row has an accessible "Add <name>" label
      expect(
        screen.getByRole("button", { name: "Add John Smith" })
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
      expect(screen.getByTestId("confirm-add-button")).toBeInTheDocument();
    });
  });

  describe("Message Contacts Toggle (TASK-1131)", () => {
    // Contacts with message-derived flag
    // As above, plus `email: null` on Diana: `Contact.email` is declared
    // `string | undefined`, but a contact with no email arrives from the DB as
    // NULL and this suite depends on that exact value.
    const mockContactsWithMessageDerived = [
      {
        id: "imported-1",
        user_id: "user-1",
        name: "Alice Imported",
        email: "alice@example.com",
        source: "contacts_app",
        is_message_derived: 0, // Not message-derived (imported)
      },
      {
        id: "imported-2",
        user_id: "user-1",
        name: "Bob Imported",
        email: "bob@example.com",
        source: "email",
        is_message_derived: false, // Also not message-derived (boolean form)
      },
      {
        id: "msg_charlie",
        user_id: "user-1",
        name: "Charlie FromMessage",
        email: "charlie@example.com",
        source: "messages",
        is_message_derived: 1, // Message-derived (number form)
      },
      {
        id: "msg_diana",
        user_id: "user-1",
        name: "Diana FromMessage",
        email: null,
        source: "messages",
        is_message_derived: true, // Message-derived (boolean form)
      },
    ] as unknown as ExtendedContact[];

    beforeEach(() => {
      // Clear localStorage before each test
      localStorage.removeItem("contactModal.showMessageContacts");
    });

    it("should render the toggle checkbox", () => {
      render(
        <ContactSelectModal
          contacts={mockContactsWithMessageDerived}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      expect(screen.getByText("Include message contacts")).toBeInTheDocument();
      expect(screen.getByRole("checkbox")).toBeInTheDocument();
    });

    it("should hide message-derived contacts by default (toggle OFF)", () => {
      render(
        <ContactSelectModal
          contacts={mockContactsWithMessageDerived}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      // Imported contacts should be visible
      expect(screen.getByText("Alice Imported")).toBeInTheDocument();
      expect(screen.getByText("Bob Imported")).toBeInTheDocument();

      // Message-derived contacts should be hidden
      expect(screen.queryByText("Charlie FromMessage")).not.toBeInTheDocument();
      expect(screen.queryByText("Diana FromMessage")).not.toBeInTheDocument();
    });

    it("should show message-derived contacts when toggle is ON", async () => {
      render(
        <ContactSelectModal
          contacts={mockContactsWithMessageDerived}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      // Click the toggle
      const toggle = screen.getByRole("checkbox");
      fireEvent.click(toggle);

      // Now all contacts should be visible
      await waitFor(() => {
        expect(screen.getByText("Alice Imported")).toBeInTheDocument();
        expect(screen.getByText("Bob Imported")).toBeInTheDocument();
        expect(screen.getByText("Charlie FromMessage")).toBeInTheDocument();
        expect(screen.getByText("Diana FromMessage")).toBeInTheDocument();
      });
    });

    it("should toggle OFF again to hide message-derived contacts", async () => {
      render(
        <ContactSelectModal
          contacts={mockContactsWithMessageDerived}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      const toggle = screen.getByRole("checkbox");

      // Turn ON
      fireEvent.click(toggle);
      await waitFor(() => {
        expect(screen.getByText("Charlie FromMessage")).toBeInTheDocument();
      });

      // Turn OFF
      fireEvent.click(toggle);
      await waitFor(() => {
        expect(screen.queryByText("Charlie FromMessage")).not.toBeInTheDocument();
      });
    });

    it("should persist toggle state in localStorage", async () => {
      const { unmount } = render(
        <ContactSelectModal
          contacts={mockContactsWithMessageDerived}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      // Enable toggle
      const toggle = screen.getByRole("checkbox");
      fireEvent.click(toggle);

      // Wait for state update and localStorage write
      await waitFor(() => {
        expect(localStorage.getItem("contactModal.showMessageContacts")).toBe("true");
      });

      // Unmount
      unmount();

      // Render fresh instance - should read from localStorage
      render(
        <ContactSelectModal
          contacts={mockContactsWithMessageDerived}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      // Toggle should still be checked and message contacts visible
      await waitFor(() => {
        const newToggle = screen.getByRole("checkbox");
        expect(newToggle).toBeChecked();
        expect(screen.getByText("Charlie FromMessage")).toBeInTheDocument();
      });
    });

    it("should work with search filtering when toggle is ON", async () => {
      render(
        <ContactSelectModal
          contacts={mockContactsWithMessageDerived}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      // Enable toggle first
      const toggle = screen.getByRole("checkbox");
      fireEvent.click(toggle);

      // Search for message-derived contact
      const searchInput = screen.getByPlaceholderText(/search contacts/i);
      fireEvent.change(searchInput, { target: { value: "Charlie" } });

      await waitFor(() => {
        expect(screen.getByText("Charlie FromMessage")).toBeInTheDocument();
        expect(screen.queryByText("Alice Imported")).not.toBeInTheDocument();
      });
    });

    it("should show empty state when all contacts are message-derived and toggle is OFF", () => {
      const onlyMessageContacts = [
        {
          id: "msg_only",
          user_id: "user-1",
          name: "Message Only Contact",
          source: "messages",
          is_message_derived: 1,
        },
      ] as ExtendedContact[];

      render(
        <ContactSelectModal
          contacts={onlyMessageContacts}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
        />
      );

      // With only message-derived contacts and toggle OFF, should show empty state
      expect(screen.getByText("No contacts available")).toBeInTheDocument();
    });
  });

  // =========================================================================
  // BACKLOG-2467 — phone search on the TRANSACTION picker
  // =========================================================================
  /**
   * This is the picker `EditTransactionModal` opens to attach a buyer or seller
   * to a deal under audit. Its filter had no phone field AT ALL, so a phone
   * number found nobody in any format — and the consequence is not a mildly
   * annoying search box: the party is either duplicated or silently left off the
   * transaction.
   *
   * Every assertion below is an EXACT ID SET, not a count and not a single
   * getByText. A count of 1 is satisfied by the WRONG contact; "Maria is
   * present" is satisfied by a filter that matched everybody.
   */
  describe("Phone search (BACKLOG-2467)", () => {
    /** The exact set of contacts rendered in the Available pane, sorted. */
    const visibleAvailableIds = (): string[] =>
      screen
        .queryAllByTestId(/^add-contact-/)
        .map((el) =>
          (el.getAttribute("data-testid") as string).replace("add-contact-", ""),
        )
        .sort();

    const phoneContacts = [
      {
        // Stored E.164; the UI PRINTS this as "+1 (415) 806-4356".
        id: "ph-primary",
        user_id: "user-1",
        name: "Maria Delgado",
        email: "maria@example.com",
        phone: "+14158064356",
        source: "contacts_app",
      },
      {
        // The number you would reach this person on is their SECOND one. The
        // pre-2467 SQL join was pinned to is_primary = 1 and the client filter
        // had no phone field at all, so this contact was unreachable by phone.
        id: "ph-secondary",
        user_id: "user-1",
        name: "Ray Okafor",
        email: "ray@example.com",
        phone: "+12125550100",
        allPhones: ["+12125550100", "+16505551212"],
        source: "contacts_app",
      },
      {
        id: "ph-none",
        user_id: "user-1",
        name: "Nina Patel",
        email: "nina@example.com",
        company: "Patel Realty",
        source: "contacts_app",
      },
      {
        // Name lives ONLY in display_name — the old three-field filter read
        // `name` and so could not find this contact by name either.
        //
        // The email deliberately shares NO substring with the name. It was
        // `quentin@example.com`, which meant the query "Quentin" matched the
        // EMAIL: the test passed under the pre-fix three-field matcher and so
        // proved nothing (SR, PR #2205). With this fixture it goes red under
        // that matcher — verified, not assumed.
        id: "ph-displayname-only",
        user_id: "user-1",
        display_name: "Quentin Brooks",
        email: "qb.listings@example.com",
        source: "contacts_app",
      },
      {
        // The guard on the letter rule: digits inside a COMPANY name must stay
        // on the text path and must not turn "415 Realty" into a phone query.
        id: "ph-415-realty",
        user_id: "user-1",
        name: "Tom Alvarez",
        email: "tom@415realty.example.com",
        company: "415 Realty",
        source: "contacts_app",
      },
    ] as ExtendedContact[];

    const renderPicker = (contacts: ExtendedContact[] = phoneContacts) =>
      render(
        <ContactSelectModal
          contacts={contacts}
          onSelect={mockOnSelect}
          onClose={mockOnClose}
          multiple
        />,
      );

    const typeQuery = (value: string) => {
      fireEvent.change(screen.getByPlaceholderText(/search contacts/i), {
        target: { value },
      });
    };

    // The three shapes a real person types the SAME number in. The first is
    // exactly what `formatPhoneNumber` prints on screen — before this fix the
    // list could not find a string it was itself displaying.
    it.each([
      ["as displayed (formatted, +1)", "+1 (415) 806-4356"],
      ["as dashes without a country code", "415-806-4356"],
      ["as bare digits", "4158064356"],
    ])("finds a contact by phone %s", async (_desc, query) => {
      renderPicker();
      typeQuery(query);

      await waitFor(() => {
        expect(visibleAvailableIds()).toEqual(["ph-primary"]);
      });
    });

    it("finds a contact whose match is on a SECONDARY number", async () => {
      renderPicker();
      typeQuery("(650) 555-1212");

      await waitFor(() => {
        expect(visibleAvailableIds()).toEqual(["ph-secondary"]);
      });
    });

    it("still finds that contact by its PRIMARY number", async () => {
      renderPicker();
      typeQuery("212-555-0100");

      await waitFor(() => {
        expect(visibleAvailableIds()).toEqual(["ph-secondary"]);
      });
    });

    it("does not treat a company name containing digits as a phone query", async () => {
      renderPicker();
      typeQuery("415 Realty");

      await waitFor(() => {
        // NOT ph-primary, whose number contains 415.
        expect(visibleAvailableIds()).toEqual(["ph-415-realty"]);
      });
    });

    it("finds a contact whose name lives only in display_name", async () => {
      renderPicker();
      typeQuery("Quentin");

      await waitFor(() => {
        expect(visibleAvailableIds()).toEqual(["ph-displayname-only"]);
      });
    });

    // ---------------------------------------------------------------------
    // Controls: the text paths this change must leave exactly as they were.
    // ---------------------------------------------------------------------
    describe("name / email / company search is unchanged", () => {
      it.each([
        // "John" matches John Smith AND Bob JOHNson — a substring match, and it
        // was one before. Asserting the pair is what would catch a narrowing.
        ["John", ["contact-1", "contact-3"]],
        ["realty.com", ["contact-3"]],
        ["Smith Corp", ["contact-1"]],
        ["Jane", ["contact-2"]],
        ["nonexistent", []],
      ])("query %p yields exactly %p", async (query, expected) => {
        render(
          <ContactSelectModal
            contacts={mockContacts}
            onSelect={mockOnSelect}
            onClose={mockOnClose}
            multiple
          />,
        );
        typeQuery(query as string);

        await waitFor(() => {
          expect(visibleAvailableIds()).toEqual(expected);
        });
      });
    });

    // ---------------------------------------------------------------------
    // The main-process search result is UNIONED with the local matches, not
    // substituted for them. Before 2467 a 2+-character query REPLACED the
    // client list with the SQL result, so a phone query showed whatever the
    // primary-phone-only SQL returned — usually nothing.
    // ---------------------------------------------------------------------
    describe("main-process search results", () => {
      const contactsApi = () =>
        (window as unknown as {
          api: { contacts: Record<string, unknown> };
        }).api.contacts;

      let previousSearchContacts: unknown;

      beforeEach(() => {
        previousSearchContacts = contactsApi().searchContacts;
      });

      afterEach(() => {
        contactsApi().searchContacts = previousSearchContacts;
        // The message-contacts toggle persists to localStorage and the component
        // reads it at mount, so leaving it on would silently change what a later
        // test renders.
        localStorage.removeItem("contactModal.showMessageContacts");
      });

      it("unions DB results with local phone matches instead of replacing them", async () => {
        const searchContacts = jest.fn().mockResolvedValue({
          success: true,
          contacts: [
            {
              // A contact beyond the ~200 rows the `contacts` prop carries —
              // the entire reason the DB search exists.
              id: "db-only",
              user_id: "user-1",
              name: "Beyond Two Hundred",
              email: "beyond@example.com",
              phone: "+14158064356",
              source: "contacts_app",
            },
          ],
        });
        contactsApi().searchContacts = searchContacts;

        render(
          <ContactSelectModal
            contacts={phoneContacts}
            onSelect={mockOnSelect}
            onClose={mockOnClose}
            userId="user-1"
            multiple
          />,
        );
        typeQuery("415-806-4356");

        await waitFor(() => {
          expect(searchContacts).toHaveBeenCalledWith("user-1", "415-806-4356");
        });

        await waitFor(() => {
          // BOTH: the local phone match AND the DB-only row.
          expect(visibleAvailableIds()).toEqual(["db-only", "ph-primary"]);
        });
      });

      /**
       * The obligation the union takes on.
       *
       * Substituting one list for the other could never show a contact twice.
       * Unioning them can — and the same contact WILL come back on both paths,
       * because the `contacts` prop and the SQL search read the same table.
       * `assembleDedupedContacts` is what makes that safe, and these cases pin it
       * by exact identity SET: a row count of 1 is also satisfied by the wrong
       * contact, and "Maria is present" is satisfied by Maria twice.
       *
       * ## Every case here carries a CANARY row, and that is load-bearing
       *
       * The DB search is debounced 300ms. `waitFor` resolves the instant its
       * callback stops throwing, so a bare "expect exactly Maria" is satisfied by
       * the FIRST render — the local-only list, before `searchResults` has landed.
       * Such a test passes whether or not the union dedups, which was measured,
       * not assumed: with `assembleDedupedContacts` swapped for a plain concat it
       * stayed green.
       *
       * `db-canary` exists in no local row, so the expected set can only be
       * reached AFTER the DB result is applied. Waiting for it is what forces the
       * assertion to observe the union state at all.
       *
       * ## Every fixture below is the shape the PRODUCER actually emits
       *
       * The first version of these tests gave the message-derived row a
       * `source: "contacts_app"`, a real `@` email and a `+1…` phone.
       * `searchContactsForSelection`'s message half cannot emit that (SR, PR
       * #2205): it hard-codes `'messages' as source` and `1 as
       * is_message_derived`, its WHERE excludes `%@%` so `email` is ALWAYS NULL,
       * and the CASE puts the raw sender handle into `phone` — a NAME on that
       * path, since `+…` and digit-leading handles are excluded too.
       *
       * With the real shape the union DID show Maria twice. The fabricated
       * fixture was the only reason it looked safe. See MESSAGE_HALF_MARIA.
       */
      const DB_CANARY = {
        id: "db-canary",
        user_id: "user-1",
        name: "Wendy Canary",
        email: "canary@example.com",
        phone: "+13035550188",
        source: "contacts_app",
        is_message_derived: 0,
      };

      it("shows a contact ONCE when the DB returns the row already held locally", async () => {
        contactsApi().searchContacts = jest.fn().mockResolvedValue({
          success: true,
          contacts: [
            {
              // The IMPORTED half's projection: `c.source`, `ce_primary.email`,
              // `cp_primary.phone_e164`, `0 as is_message_derived`, and the
              // contact's real id — so same person, same id.
              id: "ph-primary",
              user_id: "user-1",
              display_name: "Maria Delgado",
              name: "Maria Delgado",
              email: "maria@example.com",
              phone: "+14158064356",
              company: null,
              source: "contacts_app",
              is_imported: 1,
              is_message_derived: 0,
            },
            DB_CANARY,
          ],
        });

        render(
          <ContactSelectModal
            contacts={phoneContacts}
            onSelect={mockOnSelect}
            onClose={mockOnClose}
            userId="user-1"
            multiple
          />,
        );
        typeQuery("415-806-4356");

        await waitFor(() => {
          expect(visibleAvailableIds()).toEqual(["db-canary", "ph-primary"]);
        });
      });

      /**
       * The MESSAGE half's projection, transcribed from the SQL rather than
       * imagined:
       *
       *   'msg_' || LOWER(json_extract(participants,'$.from'))  as id
       *   json_extract(participants,'$.from')                   as display_name, name
       *   CASE WHEN … LIKE '%@%'     THEN … ELSE NULL END       as email
       *   CASE WHEN … NOT LIKE '%@%' THEN … ELSE NULL END       as phone
       *   'messages' as source · 1 as is_message_derived
       *
       * and its WHERE excludes `%@%`, `+%`, `GLOB '[0-9]*'` and `urn:%`. So the
       * handle is a NAME, `email` is NULL, and that name is what lands in
       * `phone` — where `normalizePhone` reduces it to `""`. The row therefore
       * claims NO identity token at all, which is exactly why the old
       * "name is an identity only for token-less KEEPERS" rule let it through:
       * the kept local Maria has an email.
       */
      const MESSAGE_HALF_MARIA = {
        id: "msg_maria delgado",
        user_id: "user-1",
        display_name: "Maria Delgado",
        name: "Maria Delgado",
        email: null,
        phone: "Maria Delgado",
        company: null,
        title: null,
        source: "messages",
        is_imported: 0,
        is_message_derived: 1,
      };

      it("shows a contact ONCE when the MESSAGE half returns the same person under a synthesised id", async () => {
        contactsApi().searchContacts = jest.fn().mockResolvedValue({
          success: true,
          contacts: [MESSAGE_HALF_MARIA, DB_CANARY],
        });

        render(
          <ContactSelectModal
            contacts={phoneContacts}
            onSelect={mockOnSelect}
            onClose={mockOnClose}
            userId="user-1"
            multiple
          />,
        );

        // The toggle is what makes this observable at all: message-derived rows
        // are filtered out AFTER the union, so with it off the duplicate is
        // hidden rather than absent. Driving the real control, not a mock.
        fireEvent.click(screen.getByRole("checkbox"));

        // A NAME query, because a name is the only thing this row carries.
        typeQuery("Maria");

        await waitFor(() => {
          // Maria once, under the LOCAL id — the one `handleConfirm` resolves
          // against. Before BACKLOG-2467's claim-side widening this rendered
          // ["db-canary", "msg_maria delgado", "ph-primary"].
          expect(visibleAvailableIds()).toEqual(["db-canary", "ph-primary"]);
        });
      });
    });
  });
});
