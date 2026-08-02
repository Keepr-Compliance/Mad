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

  const mockContacts: ExtendedContact[] = [
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
  ];

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
    const mockContactsWithMessageDerived: ExtendedContact[] = [
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
    ];

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
      const onlyMessageContacts: ExtendedContact[] = [
        {
          id: "msg_only",
          user_id: "user-1",
          name: "Message Only Contact",
          source: "messages",
          is_message_derived: 1,
        },
      ];

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
});
