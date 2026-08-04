/**
 * Tests for ContactSelector.tsx
 *
 * Covers:
 * - Rendering (contacts list, empty state, loading state, error state)
 * - Search filtering by name, email, phone
 * - Selection toggle (add/remove)
 * - maxSelection enforcement
 * - Keyboard navigation (up/down/enter/space/escape)
 * - Accessibility (ARIA attributes)
 *
 * @see TASK-1720: Create ContactSelector Component for Multi-Select Contact Selection
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ContactSelector } from "./ContactSelector";
import type { ExtendedContact } from "../../types/components";

describe("ContactSelector", () => {
  const mockOnSelectionChange = jest.fn();

  // Standard test contacts
  const mockContacts: ExtendedContact[] = [
    {
      id: "contact-1",
      user_id: "user-1",
      display_name: "John Smith",
      name: "John Smith",
      email: "john@example.com",
      phone: "+1-555-0101",
      source: "manual",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: "contact-2",
      user_id: "user-1",
      display_name: "Jane Doe",
      name: "Jane Doe",
      email: "jane@company.com",
      phone: "+1-555-0102",
      source: "email",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: "contact-3",
      user_id: "user-1",
      display_name: "Bob Wilson",
      name: "Bob Wilson",
      email: "bob@realty.com",
      phone: "+1-310-555-5678",
      source: "contacts_app",
      allEmails: ["bob@realty.com", "bob.personal@gmail.com"],
      allPhones: ["+1-310-555-5678", "+1-310-555-9999"],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: "contact-4",
      user_id: "user-1",
      display_name: "Alice Brown",
      name: "Alice Brown",
      email: "alice@test.com",
      source: "manual",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Rendering", () => {
    it("should render the component with search input", () => {
      render(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      );

      expect(
        screen.getByPlaceholderText("Search contacts...")
      ).toBeInTheDocument();
    });

    it("should display all contacts", () => {
      render(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      );

      expect(screen.getByText("John Smith")).toBeInTheDocument();
      expect(screen.getByText("Jane Doe")).toBeInTheDocument();
      expect(screen.getByText("Bob Wilson")).toBeInTheDocument();
      expect(screen.getByText("Alice Brown")).toBeInTheDocument();
    });

    it("should display contact email and phone", () => {
      render(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      );

      // Check for email/phone display (they appear together separated by |)
      expect(screen.getByText(/john@example.com/)).toBeInTheDocument();
      expect(screen.getByText(/\+1-555-0101/)).toBeInTheDocument();
    });

    it("should show selection count footer", () => {
      render(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={["contact-1", "contact-2"]}
          onSelectionChange={mockOnSelectionChange}
        />
      );

      expect(screen.getByText("Selected: 2 contacts")).toBeInTheDocument();
    });

    it("should show singular 'contact' when only one selected", () => {
      render(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={["contact-1"]}
          onSelectionChange={mockOnSelectionChange}
        />
      );

      expect(screen.getByText("Selected: 1 contact")).toBeInTheDocument();
    });

    it("should use custom search placeholder", () => {
      render(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={[]}
          onSelectionChange={mockOnSelectionChange}
          searchPlaceholder="Find people..."
        />
      );

      expect(screen.getByPlaceholderText("Find people...")).toBeInTheDocument();
    });

    it("should apply custom className", () => {
      const { container } = render(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={[]}
          onSelectionChange={mockOnSelectionChange}
          className="custom-class"
        />
      );

      expect(container.firstChild).toHaveClass("custom-class");
    });
  });

  describe("Empty State", () => {
    it("should show empty state when no contacts", () => {
      render(
        <ContactSelector
          contacts={[]}
          selectedIds={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      );

      expect(screen.getByText("No contacts available")).toBeInTheDocument();
    });

    it("should show search-specific empty state when search has no matches", async () => {
      render(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      );

      const searchInput = screen.getByPlaceholderText("Search contacts...");
      fireEvent.change(searchInput, { target: { value: "nonexistent" } });

      await waitFor(() => {
        expect(
          screen.getByText('No contacts match "nonexistent"')
        ).toBeInTheDocument();
      });
    });
  });

  describe("Loading State", () => {
    it("should show loading state when isLoading is true", () => {
      render(
        <ContactSelector
          contacts={[]}
          selectedIds={[]}
          onSelectionChange={mockOnSelectionChange}
          isLoading={true}
        />
      );

      expect(screen.getByText("Loading contacts...")).toBeInTheDocument();
    });

    it("should not show contacts when loading", () => {
      render(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={[]}
          onSelectionChange={mockOnSelectionChange}
          isLoading={true}
        />
      );

      expect(screen.queryByText("John Smith")).not.toBeInTheDocument();
    });
  });

  describe("Error State", () => {
    it("should show error message when error is provided", () => {
      render(
        <ContactSelector
          contacts={[]}
          selectedIds={[]}
          onSelectionChange={mockOnSelectionChange}
          error="Failed to load contacts"
        />
      );

      expect(screen.getByText("Failed to load contacts")).toBeInTheDocument();
    });

    it("should not show error when isLoading is true", () => {
      render(
        <ContactSelector
          contacts={[]}
          selectedIds={[]}
          onSelectionChange={mockOnSelectionChange}
          isLoading={true}
          error="Failed to load contacts"
        />
      );

      expect(
        screen.queryByText("Failed to load contacts")
      ).not.toBeInTheDocument();
    });
  });

  describe("Search Filtering", () => {
    it("should filter contacts by name", async () => {
      render(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      );

      const searchInput = screen.getByPlaceholderText("Search contacts...");
      fireEvent.change(searchInput, { target: { value: "John" } });

      await waitFor(() => {
        expect(screen.getByText("John Smith")).toBeInTheDocument();
        expect(screen.queryByText("Jane Doe")).not.toBeInTheDocument();
      });
    });

    it("should filter contacts by email", async () => {
      render(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      );

      const searchInput = screen.getByPlaceholderText("Search contacts...");
      fireEvent.change(searchInput, { target: { value: "realty.com" } });

      await waitFor(() => {
        expect(screen.getByText("Bob Wilson")).toBeInTheDocument();
        expect(screen.queryByText("John Smith")).not.toBeInTheDocument();
      });
    });

    it("should filter contacts by phone", async () => {
      render(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      );

      const searchInput = screen.getByPlaceholderText("Search contacts...");
      fireEvent.change(searchInput, { target: { value: "310-555" } });

      await waitFor(() => {
        expect(screen.getByText("Bob Wilson")).toBeInTheDocument();
        expect(screen.queryByText("John Smith")).not.toBeInTheDocument();
      });
    });

    it("should be case insensitive", async () => {
      render(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      );

      const searchInput = screen.getByPlaceholderText("Search contacts...");
      fireEvent.change(searchInput, { target: { value: "JANE" } });

      await waitFor(() => {
        expect(screen.getByText("Jane Doe")).toBeInTheDocument();
      });
    });

    it("should search allEmails array", async () => {
      render(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      );

      const searchInput = screen.getByPlaceholderText("Search contacts...");
      fireEvent.change(searchInput, { target: { value: "bob.personal" } });

      await waitFor(() => {
        expect(screen.getByText("Bob Wilson")).toBeInTheDocument();
      });
    });

    it("should search allPhones array", async () => {
      render(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      );

      const searchInput = screen.getByPlaceholderText("Search contacts...");
      fireEvent.change(searchInput, { target: { value: "555-9999" } });

      await waitFor(() => {
        expect(screen.getByText("Bob Wilson")).toBeInTheDocument();
      });
    });

    it("should clear filter and show all when search cleared", async () => {
      render(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      );

      const searchInput = screen.getByPlaceholderText("Search contacts...");

      // Filter first
      fireEvent.change(searchInput, { target: { value: "John" } });
      await waitFor(() => {
        expect(screen.queryByText("Jane Doe")).not.toBeInTheDocument();
      });

      // Clear filter
      fireEvent.change(searchInput, { target: { value: "" } });
      await waitFor(() => {
        expect(screen.getByText("Jane Doe")).toBeInTheDocument();
        expect(screen.getByText("John Smith")).toBeInTheDocument();
      });
    });
  });

  describe("Selection Toggle", () => {
    it("should call onSelectionChange with added contact when clicking unselected", async () => {
      render(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      );

      const johnRow = screen.getByText("John Smith").closest('[role="option"]');
      fireEvent.click(johnRow!);

      expect(mockOnSelectionChange).toHaveBeenCalledWith(["contact-1"]);
    });

    it("should call onSelectionChange with removed contact when clicking selected", async () => {
      render(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={["contact-1", "contact-2"]}
          onSelectionChange={mockOnSelectionChange}
        />
      );

      const johnRow = screen.getByText("John Smith").closest('[role="option"]');
      fireEvent.click(johnRow!);

      expect(mockOnSelectionChange).toHaveBeenCalledWith(["contact-2"]);
    });

    it("should show selected contacts with visual indicator", () => {
      render(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={["contact-1"]}
          onSelectionChange={mockOnSelectionChange}
        />
      );

      const johnRow = screen.getByText("John Smith").closest('[role="option"]');
      expect(johnRow).toHaveClass("bg-purple-50");
    });

    it("should have aria-selected attribute on selected items", () => {
      render(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={["contact-1"]}
          onSelectionChange={mockOnSelectionChange}
        />
      );

      const johnRow = screen.getByText("John Smith").closest('[role="option"]');
      const janeRow = screen.getByText("Jane Doe").closest('[role="option"]');

      expect(johnRow).toHaveAttribute("aria-selected", "true");
      expect(janeRow).toHaveAttribute("aria-selected", "false");
    });
  });

  describe("maxSelection Enforcement", () => {
    it("should show max selection in footer", () => {
      render(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={[]}
          onSelectionChange={mockOnSelectionChange}
          maxSelection={2}
        />
      );

      expect(screen.getByText(/\(max 2\)/)).toBeInTheDocument();
    });

    it("should not add more contacts when max reached", () => {
      render(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={["contact-1", "contact-2"]}
          onSelectionChange={mockOnSelectionChange}
          maxSelection={2}
        />
      );

      // Try to select a third contact
      const bobRow = screen.getByText("Bob Wilson").closest('[role="option"]');
      fireEvent.click(bobRow!);

      // Should not have been called
      expect(mockOnSelectionChange).not.toHaveBeenCalled();
    });

    it("should still allow deselecting when at max", () => {
      render(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={["contact-1", "contact-2"]}
          onSelectionChange={mockOnSelectionChange}
          maxSelection={2}
        />
      );

      // Deselect an existing contact
      const johnRow = screen.getByText("John Smith").closest('[role="option"]');
      fireEvent.click(johnRow!);

      expect(mockOnSelectionChange).toHaveBeenCalledWith(["contact-2"]);
    });

    it("should disable unselected items when at max", () => {
      render(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={["contact-1", "contact-2"]}
          onSelectionChange={mockOnSelectionChange}
          maxSelection={2}
        />
      );

      const bobRow = screen.getByText("Bob Wilson").closest('[role="option"]');
      expect(bobRow).toHaveAttribute("aria-disabled", "true");
      expect(bobRow).toHaveClass("opacity-50");
    });
  });

  describe("Keyboard Navigation", () => {
    it("should navigate down with ArrowDown", async () => {
      render(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      );

      const searchInput = screen.getByPlaceholderText("Search contacts...");

      // Press down arrow
      fireEvent.keyDown(searchInput, { key: "ArrowDown" });

      await waitFor(() => {
        const firstItem = screen
          .getByText("John Smith")
          .closest('[role="option"]');
        expect(firstItem).toHaveClass("ring-2");
      });
    });

    it("should navigate up with ArrowUp", async () => {
      render(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      );

      const searchInput = screen.getByPlaceholderText("Search contacts...");

      // Navigate down twice, then up once
      fireEvent.keyDown(searchInput, { key: "ArrowDown" });
      fireEvent.keyDown(searchInput, { key: "ArrowDown" });
      fireEvent.keyDown(searchInput, { key: "ArrowUp" });

      await waitFor(() => {
        const firstItem = screen
          .getByText("John Smith")
          .closest('[role="option"]');
        expect(firstItem).toHaveClass("ring-2");
      });
    });

    it("should toggle selection with Enter key", async () => {
      render(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      );

      const searchInput = screen.getByPlaceholderText("Search contacts...");

      // Navigate to first item
      fireEvent.keyDown(searchInput, { key: "ArrowDown" });

      // Press Enter to select
      fireEvent.keyDown(searchInput, { key: "Enter" });

      expect(mockOnSelectionChange).toHaveBeenCalledWith(["contact-1"]);
    });

    it("should toggle selection with Space key", async () => {
      render(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      );

      const searchInput = screen.getByPlaceholderText("Search contacts...");

      // Navigate to first item
      fireEvent.keyDown(searchInput, { key: "ArrowDown" });

      // Press Space to select
      fireEvent.keyDown(searchInput, { key: " " });

      expect(mockOnSelectionChange).toHaveBeenCalledWith(["contact-1"]);
    });

    it("should clear search with Escape key", async () => {
      render(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      );

      const searchInput = screen.getByPlaceholderText("Search contacts...");

      // Type a search
      fireEvent.change(searchInput, { target: { value: "John" } });
      await waitFor(() => {
        expect(screen.queryByText("Jane Doe")).not.toBeInTheDocument();
      });

      // Press Escape
      fireEvent.keyDown(searchInput, { key: "Escape" });

      await waitFor(() => {
        expect(searchInput).toHaveValue("");
        expect(screen.getByText("Jane Doe")).toBeInTheDocument();
      });
    });

    it("should not allow selecting when at max with keyboard", async () => {
      render(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={["contact-1", "contact-2"]}
          onSelectionChange={mockOnSelectionChange}
          maxSelection={2}
        />
      );

      const searchInput = screen.getByPlaceholderText("Search contacts...");

      // Navigate to third item (Bob Wilson)
      fireEvent.keyDown(searchInput, { key: "ArrowDown" });
      fireEvent.keyDown(searchInput, { key: "ArrowDown" });
      fireEvent.keyDown(searchInput, { key: "ArrowDown" });

      // Try to select
      fireEvent.keyDown(searchInput, { key: "Enter" });

      // Should not be called
      expect(mockOnSelectionChange).not.toHaveBeenCalled();
    });

    it("should allow deselecting with keyboard when at max", async () => {
      render(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={["contact-1", "contact-2"]}
          onSelectionChange={mockOnSelectionChange}
          maxSelection={2}
        />
      );

      const searchInput = screen.getByPlaceholderText("Search contacts...");

      // Navigate to first item (John Smith - already selected)
      fireEvent.keyDown(searchInput, { key: "ArrowDown" });

      // Deselect
      fireEvent.keyDown(searchInput, { key: "Enter" });

      expect(mockOnSelectionChange).toHaveBeenCalledWith(["contact-2"]);
    });
  });

  describe("Accessibility", () => {
    it("should have listbox role on container", () => {
      render(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      );

      expect(screen.getByRole("listbox")).toBeInTheDocument();
    });

    it("should have option role on each contact", () => {
      render(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      );

      const options = screen.getAllByRole("option");
      expect(options).toHaveLength(4);
    });

    it("should have aria-multiselectable on listbox", () => {
      render(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      );

      const listbox = screen.getByRole("listbox");
      expect(listbox).toHaveAttribute("aria-multiselectable", "true");
    });

    it("should have aria-label on search input", () => {
      render(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      );

      const searchInput = screen.getByPlaceholderText("Search contacts...");
      expect(searchInput).toHaveAttribute("aria-label", "Search contacts");
    });

    it("should have aria-label on listbox", () => {
      render(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      );

      const listbox = screen.getByRole("listbox");
      expect(listbox).toHaveAttribute("aria-label", "Contacts");
    });
  });

  describe("Integration Scenarios", () => {
    it("should handle select 3 contacts workflow", async () => {
      const { rerender } = render(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      );

      // Select first contact
      let johnRow = screen.getByText("John Smith").closest('[role="option"]');
      fireEvent.click(johnRow!);
      expect(mockOnSelectionChange).toHaveBeenLastCalledWith(["contact-1"]);

      // Update with new selection and select second
      rerender(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={["contact-1"]}
          onSelectionChange={mockOnSelectionChange}
        />
      );
      const janeRow = screen.getByText("Jane Doe").closest('[role="option"]');
      fireEvent.click(janeRow!);
      expect(mockOnSelectionChange).toHaveBeenLastCalledWith([
        "contact-1",
        "contact-2",
      ]);

      // Update with new selection and select third
      rerender(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={["contact-1", "contact-2"]}
          onSelectionChange={mockOnSelectionChange}
        />
      );
      const bobRow = screen.getByText("Bob Wilson").closest('[role="option"]');
      fireEvent.click(bobRow!);
      expect(mockOnSelectionChange).toHaveBeenLastCalledWith([
        "contact-1",
        "contact-2",
        "contact-3",
      ]);

      // Verify final state shows 3 selected
      rerender(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={["contact-1", "contact-2", "contact-3"]}
          onSelectionChange={mockOnSelectionChange}
        />
      );
      expect(screen.getByText("Selected: 3 contacts")).toBeInTheDocument();
    });

    it("should handle search then select workflow", async () => {
      render(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      );

      // Search for partial name
      const searchInput = screen.getByPlaceholderText("Search contacts...");
      fireEvent.change(searchInput, { target: { value: "Bob" } });

      await waitFor(() => {
        expect(screen.getByText("Bob Wilson")).toBeInTheDocument();
        expect(screen.queryByText("John Smith")).not.toBeInTheDocument();
      });

      // Select the filtered contact
      const bobRow = screen.getByText("Bob Wilson").closest('[role="option"]');
      fireEvent.click(bobRow!);

      expect(mockOnSelectionChange).toHaveBeenCalledWith(["contact-3"]);
    });

    it("should handle clear search and see all contacts", async () => {
      render(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      );

      const searchInput = screen.getByPlaceholderText("Search contacts...");

      // Search to filter
      fireEvent.change(searchInput, { target: { value: "John" } });
      await waitFor(() => {
        expect(screen.queryByText("Jane Doe")).not.toBeInTheDocument();
      });

      // Clear search
      fireEvent.change(searchInput, { target: { value: "" } });

      // All contacts visible again
      await waitFor(() => {
        expect(screen.getByText("John Smith")).toBeInTheDocument();
        expect(screen.getByText("Jane Doe")).toBeInTheDocument();
        expect(screen.getByText("Bob Wilson")).toBeInTheDocument();
        expect(screen.getByText("Alice Brown")).toBeInTheDocument();
      });
    });
  });

  describe("Edge Cases", () => {
    it("should handle contact without email or phone", () => {
      const contactsWithMissing: ExtendedContact[] = [
        {
          id: "contact-no-info",
          user_id: "user-1",
          display_name: "No Contact Info",
          source: "manual",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ];

      render(
        <ContactSelector
          contacts={contactsWithMissing}
          selectedIds={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      );

      expect(screen.getByText("No Contact Info")).toBeInTheDocument();
    });

    it("should fall back to name field when display_name is missing", () => {
      const contactsWithLegacyName: ExtendedContact[] = [
        {
          id: "contact-legacy",
          user_id: "user-1",
          name: "Legacy Name",
          source: "manual",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ];

      render(
        <ContactSelector
          contacts={contactsWithLegacyName}
          selectedIds={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      );

      expect(screen.getByText("Legacy Name")).toBeInTheDocument();
    });

    // BACKLOG-2461: was a bare "Unknown". The record holds an email; show it.
    it("should show the email when no name fields available", () => {
      const contactsWithNoName: ExtendedContact[] = [
        {
          id: "contact-no-name",
          user_id: "user-1",
          email: "anonymous@example.com",
          source: "email",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ];

      render(
        <ContactSelector
          contacts={contactsWithNoName}
          selectedIds={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      );

      expect(screen.getByText("anonymous@example.com")).toBeInTheDocument();
    });

    it("should not crash with empty contacts array", () => {
      render(
        <ContactSelector
          contacts={[]}
          selectedIds={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      );

      expect(screen.getByText("No contacts available")).toBeInTheDocument();
    });

    it("should handle rapid toggling", async () => {
      render(
        <ContactSelector
          contacts={mockContacts}
          selectedIds={[]}
          onSelectionChange={mockOnSelectionChange}
        />
      );

      const johnRow = screen.getByText("John Smith").closest('[role="option"]');

      // Click rapidly
      fireEvent.click(johnRow!);
      fireEvent.click(johnRow!);
      fireEvent.click(johnRow!);

      // Should have been called 3 times with alternating values
      expect(mockOnSelectionChange).toHaveBeenCalledTimes(3);
    });
  });
});
