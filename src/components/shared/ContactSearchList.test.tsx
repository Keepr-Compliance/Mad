/**
 * ContactSearchList Component Tests
 *
 * @see TASK-1763: ContactSearchList Component
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ContactSearchList,
  ContactSearchListProps,
} from "./ContactSearchList";
import type { ExtendedContact } from "../../types/components";

// Mock ContactRow to simplify tests and verify props passed correctly
jest.mock("./ContactRow", () => ({
  ContactRow: ({
    contact,
    isSelected,
    isAdding,
    showCheckbox,
    showImportButton,
    onSelect,
    onImport,
    className,
  }: {
    contact: ExtendedContact;
    isSelected: boolean;
    isAdding?: boolean;
    showCheckbox: boolean;
    showImportButton: boolean;
    onSelect: () => void;
    onImport?: () => void;
    className?: string;
  }) => (
    <div
      data-testid={`contact-row-${contact.id}`}
      data-selected={isSelected}
      data-show-checkbox={showCheckbox}
      data-show-import-button={showImportButton}
      data-is-external={contact.is_message_derived}
      className={`${className || ""} ${isAdding ? "opacity-50" : ""}`.trim()}
      onClick={onSelect}
      role="option"
      aria-selected={isSelected}
    >
      <span data-testid={`contact-name-${contact.id}`}>
        {contact.display_name || contact.name}
      </span>
      <span data-testid={`contact-email-${contact.id}`}>{contact.email}</span>
      {showImportButton && (
        <button
          data-testid={`import-button-${contact.id}`}
          onClick={(e) => {
            e.stopPropagation();
            onImport?.();
          }}
        >
          + Import
        </button>
      )}
    </div>
  ),
}));

// Test data factories
const createImportedContact = (
  overrides: Partial<ExtendedContact> = {}
): ExtendedContact => ({
  id: `imported-${Math.random().toString(36).substring(7)}`,
  name: "John Smith",
  display_name: "John Smith",
  email: "john@example.com",
  phone: "555-1234",
  company: "Acme Corp",
  user_id: "user-1",
  source: "email",
  ...overrides,
});

const createExternalContact = (
  overrides: Partial<ExtendedContact> = {}
): ExtendedContact => ({
  id: `external-${Math.random().toString(36).substring(7)}`,
  name: "Jane Doe",
  display_name: "Jane Doe",
  email: "jane@external.com",
  phone: "555-5678",
  company: "External Inc",
  source: "inferred",
  user_id: "user-1",
  is_message_derived: true, // Marks as external
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides,
});

// Default props factory
const createDefaultProps = (
  overrides: Partial<ContactSearchListProps> = {}
): ContactSearchListProps => ({
  contacts: [],
  selectedIds: [],
  onSelectionChange: jest.fn(),
  ...overrides,
});

describe("ContactSearchList", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("rendering", () => {
    it("renders search input", () => {
      render(<ContactSearchList {...createDefaultProps()} />);

      expect(screen.getByTestId("contact-search-input")).toBeInTheDocument();
      expect(
        screen.getByPlaceholderText("Search contacts...")
      ).toBeInTheDocument();
    });

    it("renders custom search placeholder", () => {
      render(
        <ContactSearchList
          {...createDefaultProps()}
          searchPlaceholder="Find a contact..."
        />
      );

      expect(
        screen.getByPlaceholderText("Find a contact...")
      ).toBeInTheDocument();
    });

    // Note: selection-count footer was removed in the SPRINT-066 UX redesign
    // Selection is now tracked by the parent component

    it("applies custom className", () => {
      render(
        <ContactSearchList {...createDefaultProps()} className="custom-class" />
      );

      expect(screen.getByTestId("contact-search-list")).toHaveClass(
        "custom-class"
      );
    });
  });

  describe("search filtering", () => {
    const contacts = [
      createImportedContact({
        id: "c1",
        name: "Alice Anderson",
        display_name: "Alice Anderson",
        email: "alice@company.com",
        phone: "555-1111",
      }),
      createImportedContact({
        id: "c2",
        name: "Bob Builder",
        display_name: "Bob Builder",
        email: "bob@builders.com",
        phone: "555-2222",
      }),
      createImportedContact({
        id: "c3",
        name: "Carol Chen",
        display_name: "Carol Chen",
        email: "carol@realty.com",
        phone: "555-3333",
      }),
    ];

    it("filters contacts by name", async () => {
      const user = userEvent.setup();
      render(
        <ContactSearchList {...createDefaultProps({ contacts })} />
      );

      await user.type(screen.getByTestId("contact-search-input"), "Alice");

      expect(screen.getByTestId("contact-row-c1")).toBeInTheDocument();
      expect(screen.queryByTestId("contact-row-c2")).not.toBeInTheDocument();
      expect(screen.queryByTestId("contact-row-c3")).not.toBeInTheDocument();
    });

    it("filters contacts by email", async () => {
      const user = userEvent.setup();
      render(
        <ContactSearchList {...createDefaultProps({ contacts })} />
      );

      await user.type(screen.getByTestId("contact-search-input"), "builders");

      expect(screen.queryByTestId("contact-row-c1")).not.toBeInTheDocument();
      expect(screen.getByTestId("contact-row-c2")).toBeInTheDocument();
      expect(screen.queryByTestId("contact-row-c3")).not.toBeInTheDocument();
    });

    it("filters contacts by phone", async () => {
      const user = userEvent.setup();
      render(
        <ContactSearchList {...createDefaultProps({ contacts })} />
      );

      await user.type(screen.getByTestId("contact-search-input"), "555-3333");

      expect(screen.queryByTestId("contact-row-c1")).not.toBeInTheDocument();
      expect(screen.queryByTestId("contact-row-c2")).not.toBeInTheDocument();
      expect(screen.getByTestId("contact-row-c3")).toBeInTheDocument();
    });

    it("search is case-insensitive", async () => {
      const user = userEvent.setup();
      render(
        <ContactSearchList {...createDefaultProps({ contacts })} />
      );

      await user.type(screen.getByTestId("contact-search-input"), "ALICE");

      expect(screen.getByTestId("contact-row-c1")).toBeInTheDocument();
    });

    it("matches contacts when search query has leading/trailing whitespace (BACKLOG-1760)", async () => {
      const user = userEvent.setup();
      const contactsWithSullivan = [
        createImportedContact({
          id: "ms1",
          name: "Mark Sullivan",
          display_name: "Mark Sullivan",
          email: "mark@example.com",
          phone: "555-9999",
        }),
        createImportedContact({
          id: "bj1",
          name: "Bob Jones",
          display_name: "Bob Jones",
          email: "bob@example.com",
          phone: "555-8888",
        }),
      ];
      render(<ContactSearchList {...createDefaultProps({ contacts: contactsWithSullivan })} />);

      await user.type(screen.getByTestId("contact-search-input"), "  mark sullivan ");

      expect(screen.getByTestId("contact-row-ms1")).toBeInTheDocument();
      expect(screen.queryByTestId("contact-row-bj1")).not.toBeInTheDocument();
    });

    it("shows all contacts when search is empty", () => {
      render(
        <ContactSearchList {...createDefaultProps({ contacts })} />
      );

      expect(screen.getByTestId("contact-row-c1")).toBeInTheDocument();
      expect(screen.getByTestId("contact-row-c2")).toBeInTheDocument();
      expect(screen.getByTestId("contact-row-c3")).toBeInTheDocument();
    });

    it('shows "no matches" message when search has no results', async () => {
      const user = userEvent.setup();
      render(
        <ContactSearchList {...createDefaultProps({ contacts })} />
      );

      await user.type(screen.getByTestId("contact-search-input"), "xyz123");

      expect(screen.getByTestId("empty-state")).toBeInTheDocument();
      expect(screen.getByText(/No contacts match "xyz123"/)).toBeInTheDocument();
    });

    it("filters both imported and external contacts", async () => {
      const user = userEvent.setup();
      const externalContacts = [
        createExternalContact({
          id: "e1",
          name: "External Alice",
          email: "ext.alice@test.com",
        }),
      ];

      render(
        <ContactSearchList
          {...createDefaultProps({ contacts, externalContacts })}
        />
      );

      await user.type(screen.getByTestId("contact-search-input"), "Alice");

      expect(screen.getByTestId("contact-row-c1")).toBeInTheDocument();
      expect(screen.getByTestId("contact-row-e1")).toBeInTheDocument();
      expect(screen.queryByTestId("contact-row-c2")).not.toBeInTheDocument();
    });
  });

  describe("combined list", () => {
    it("shows both imported and external contacts", () => {
      const contacts = [createImportedContact({ id: "c1" })];
      const externalContacts = [createExternalContact({ id: "e1" })];

      render(
        <ContactSearchList
          {...createDefaultProps({ contacts, externalContacts })}
        />
      );

      expect(screen.getByTestId("contact-row-c1")).toBeInTheDocument();
      expect(screen.getByTestId("contact-row-e1")).toBeInTheDocument();
    });

    it("marks imported contacts as not external", () => {
      const contacts = [createImportedContact({ id: "c1" })];

      render(<ContactSearchList {...createDefaultProps({ contacts })} />);

      const row = screen.getByTestId("contact-row-c1");
      // is_message_derived would be undefined/false for imported contacts
      expect(row.getAttribute("data-is-external")).not.toBe("true");
    });

    it("marks external contacts as external (is_message_derived)", () => {
      const externalContacts = [createExternalContact({ id: "e1" })];

      render(
        <ContactSearchList {...createDefaultProps({ externalContacts })} />
      );

      const row = screen.getByTestId("contact-row-e1");
      expect(row.getAttribute("data-is-external")).toBe("true");
    });

    it("shows import button only for external contacts when onImportContact provided", () => {
      const contacts = [createImportedContact({ id: "c1" })];
      const externalContacts = [createExternalContact({ id: "e1" })];
      const onImportContact = jest.fn();
      const onContactClick = jest.fn();

      render(
        <ContactSearchList
          {...createDefaultProps({ contacts, externalContacts, onImportContact, onContactClick })}
        />
      );

      expect(
        screen.getByTestId("contact-row-c1").getAttribute("data-show-import-button")
      ).toBe("false");
      expect(
        screen.getByTestId("contact-row-e1").getAttribute("data-show-import-button")
      ).toBe("true");
    });

    it("does not show import button when onImportContact is not provided", () => {
      const externalContacts = [createExternalContact({ id: "e1" })];
      const onContactClick = jest.fn();

      render(
        <ContactSearchList {...createDefaultProps({ externalContacts, onContactClick })} />
      );

      expect(
        screen.getByTestId("contact-row-e1").getAttribute("data-show-import-button")
      ).toBe("false");
    });

    it("shows checkboxes in selection mode (no onContactClick)", () => {
      const contacts = [createImportedContact({ id: "c1" })];
      const externalContacts = [createExternalContact({ id: "e1" })];

      render(
        <ContactSearchList
          {...createDefaultProps({ contacts, externalContacts })}
        />
      );

      // Selection mode (no onContactClick): checkboxes are shown
      expect(
        screen.getByTestId("contact-row-c1").getAttribute("data-show-checkbox")
      ).toBe("true");
      expect(
        screen.getByTestId("contact-row-e1").getAttribute("data-show-checkbox")
      ).toBe("true");
    });

    it("hides checkboxes in preview mode (with onContactClick)", () => {
      const contacts = [createImportedContact({ id: "c1" })];
      const externalContacts = [createExternalContact({ id: "e1" })];
      const onContactClick = jest.fn();

      render(
        <ContactSearchList
          {...createDefaultProps({ contacts, externalContacts, onContactClick })}
        />
      );

      // Preview mode (with onContactClick): checkboxes are hidden
      expect(
        screen.getByTestId("contact-row-c1").getAttribute("data-show-checkbox")
      ).toBe("false");
      expect(
        screen.getByTestId("contact-row-e1").getAttribute("data-show-checkbox")
      ).toBe("false");
    });
  });

  describe("selection", () => {
    it("adds contact to selection on click", () => {
      const contacts = [createImportedContact({ id: "c1" })];
      const onSelectionChange = jest.fn();

      render(
        <ContactSearchList
          {...createDefaultProps({ contacts, onSelectionChange })}
        />
      );

      fireEvent.click(screen.getByTestId("contact-row-c1"));

      expect(onSelectionChange).toHaveBeenCalledWith(["c1"]);
    });

    it("removes contact from selection on second click", () => {
      const contacts = [createImportedContact({ id: "c1" })];
      const onSelectionChange = jest.fn();

      render(
        <ContactSearchList
          {...createDefaultProps({
            contacts,
            selectedIds: ["c1"],
            onSelectionChange,
          })}
        />
      );

      fireEvent.click(screen.getByTestId("contact-row-c1"));

      expect(onSelectionChange).toHaveBeenCalledWith([]);
    });

    it("shows selected styling for selected contacts", () => {
      const contacts = [
        createImportedContact({ id: "c1" }),
        createImportedContact({ id: "c2" }),
      ];

      render(
        <ContactSearchList
          {...createDefaultProps({ contacts, selectedIds: ["c1"] })}
        />
      );

      expect(screen.getByTestId("contact-row-c1").getAttribute("data-selected")).toBe(
        "true"
      );
      expect(screen.getByTestId("contact-row-c2").getAttribute("data-selected")).toBe(
        "false"
      );
    });

    // Note: "updates selection count display" test removed - selection count
    // footer was removed in SPRINT-066 UX redesign

    it("supports multi-select", () => {
      const contacts = [
        createImportedContact({ id: "c1" }),
        createImportedContact({ id: "c2" }),
      ];
      const onSelectionChange = jest.fn();

      render(
        <ContactSearchList
          {...createDefaultProps({
            contacts,
            selectedIds: ["c1"],
            onSelectionChange,
          })}
        />
      );

      fireEvent.click(screen.getByTestId("contact-row-c2"));

      expect(onSelectionChange).toHaveBeenCalledWith(["c1", "c2"]);
    });
  });

  describe("auto-import", () => {
    it("calls onImportContact when selecting external contact", async () => {
      const externalContacts = [createExternalContact({ id: "e1" })];
      const onImportContact = jest.fn().mockResolvedValue({
        id: "imported-e1",
        name: "Jane Doe",
        user_id: "user-1",
      });
      const onSelectionChange = jest.fn();

      render(
        <ContactSearchList
          {...createDefaultProps({
            externalContacts,
            onImportContact,
            onSelectionChange,
          })}
        />
      );

      fireEvent.click(screen.getByTestId("contact-row-e1"));

      await waitFor(() => {
        expect(onImportContact).toHaveBeenCalledWith(
          expect.objectContaining({
            id: "e1",
            is_message_derived: true,
          })
        );
      });
    });

    it("adds imported contact ID to selection after import", async () => {
      const externalContacts = [createExternalContact({ id: "e1" })];
      const onImportContact = jest.fn().mockResolvedValue({
        id: "imported-e1",
        name: "Jane Doe",
        user_id: "user-1",
      });
      const onSelectionChange = jest.fn();

      render(
        <ContactSearchList
          {...createDefaultProps({
            externalContacts,
            onImportContact,
            onSelectionChange,
          })}
        />
      );

      fireEvent.click(screen.getByTestId("contact-row-e1"));

      await waitFor(() => {
        expect(onSelectionChange).toHaveBeenCalledWith(["imported-e1"]);
      });
    });

    it("handles import errors gracefully", async () => {
      const consoleSpy = jest.spyOn(console, "error").mockImplementation();
      const externalContacts = [createExternalContact({ id: "e1" })];
      const onImportContact = jest
        .fn()
        .mockRejectedValue(new Error("Import failed"));
      const onSelectionChange = jest.fn();

      render(
        <ContactSearchList
          {...createDefaultProps({
            externalContacts,
            onImportContact,
            onSelectionChange,
          })}
        />
      );

      fireEvent.click(screen.getByTestId("contact-row-e1"));

      await waitFor(() => {
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining("[ERROR] Failed to import contact:"),
          expect.any(Error)
        );
      });

      // Selection should not have been updated on error
      expect(onSelectionChange).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it("shows loading state while importing", async () => {
      const externalContacts = [createExternalContact({ id: "e1" })];
      let resolveImport: (value: ExtendedContact) => void;
      const importPromise = new Promise<ExtendedContact>((resolve) => {
        resolveImport = resolve;
      });
      const onImportContact = jest.fn().mockReturnValue(importPromise);

      render(
        <ContactSearchList
          {...createDefaultProps({
            externalContacts,
            onImportContact,
          })}
        />
      );

      fireEvent.click(screen.getByTestId("contact-row-e1"));

      // Row should show importing state (opacity-50 class)
      await waitFor(() => {
        expect(screen.getByTestId("contact-row-e1")).toHaveClass("opacity-50");
      });

      // Resolve the import
      resolveImport!({
        id: "imported-e1",
        name: "Jane Doe",
        user_id: "user-1",
      });

      // Wait for loading state to clear
      await waitFor(() => {
        expect(screen.getByTestId("contact-row-e1")).not.toHaveClass(
          "opacity-50"
        );
      });
    });

    it("prevents duplicate import calls while importing", async () => {
      const externalContacts = [createExternalContact({ id: "e1" })];
      let resolveImport: (value: ExtendedContact) => void;
      const importPromise = new Promise<ExtendedContact>((resolve) => {
        resolveImport = resolve;
      });
      const onImportContact = jest.fn().mockReturnValue(importPromise);

      render(
        <ContactSearchList
          {...createDefaultProps({
            externalContacts,
            onImportContact,
          })}
        />
      );

      // Click multiple times while importing
      fireEvent.click(screen.getByTestId("contact-row-e1"));
      fireEvent.click(screen.getByTestId("contact-row-e1"));
      fireEvent.click(screen.getByTestId("contact-row-e1"));

      // Should only call once
      expect(onImportContact).toHaveBeenCalledTimes(1);

      // Cleanup
      resolveImport!({
        id: "imported-e1",
        name: "Jane Doe",
        user_id: "user-1",
      });
      await waitFor(() => {});
    });
  });

  describe("manual import button", () => {
    it("calls onImportContact when import button clicked", async () => {
      const externalContacts = [createExternalContact({ id: "e1" })];
      const onImportContact = jest.fn().mockResolvedValue({
        id: "imported-e1",
        name: "Jane Doe",
        user_id: "user-1",
      });
      const onContactClick = jest.fn();

      render(
        <ContactSearchList
          {...createDefaultProps({
            externalContacts,
            onImportContact,
            onContactClick,
          })}
        />
      );

      fireEvent.click(screen.getByTestId("import-button-e1"));

      await waitFor(() => {
        expect(onImportContact).toHaveBeenCalled();
      });
    });

    it("does not add to selection when import button clicked (manual import)", async () => {
      const externalContacts = [createExternalContact({ id: "e1" })];
      const onImportContact = jest.fn().mockResolvedValue({
        id: "imported-e1",
        name: "Jane Doe",
        user_id: "user-1",
      });
      const onSelectionChange = jest.fn();
      const onContactClick = jest.fn();

      render(
        <ContactSearchList
          {...createDefaultProps({
            externalContacts,
            onImportContact,
            onSelectionChange,
            onContactClick,
          })}
        />
      );

      fireEvent.click(screen.getByTestId("import-button-e1"));

      await waitFor(() => {
        expect(onImportContact).toHaveBeenCalled();
      });

      // Selection should NOT have been updated for manual import
      expect(onSelectionChange).not.toHaveBeenCalled();
    });
  });

  describe("states", () => {
    it("shows loading spinner when isLoading is true", () => {
      render(<ContactSearchList {...createDefaultProps({ isLoading: true })} />);

      expect(screen.getByTestId("loading-state")).toBeInTheDocument();
      expect(screen.getByText("Loading contacts...")).toBeInTheDocument();
    });

    it("does not show contact list when loading", () => {
      const contacts = [createImportedContact({ id: "c1" })];

      render(
        <ContactSearchList {...createDefaultProps({ contacts, isLoading: true })} />
      );

      expect(screen.queryByTestId("contact-row-c1")).not.toBeInTheDocument();
    });

    it("shows error message when error is provided", () => {
      render(
        <ContactSearchList
          {...createDefaultProps({ error: "Failed to load contacts" })}
        />
      );

      expect(screen.getByTestId("error-state")).toBeInTheDocument();
      expect(screen.getByText("Failed to load contacts")).toBeInTheDocument();
    });

    it("does not show contact list when error", () => {
      const contacts = [createImportedContact({ id: "c1" })];

      render(
        <ContactSearchList
          {...createDefaultProps({ contacts, error: "Failed" })}
        />
      );

      expect(screen.queryByTestId("contact-row-c1")).not.toBeInTheDocument();
    });

    it("shows empty state when no contacts", () => {
      render(<ContactSearchList {...createDefaultProps()} />);

      expect(screen.getByTestId("empty-state")).toBeInTheDocument();
      expect(screen.getByText("No contacts available")).toBeInTheDocument();
    });

    it("prioritizes loading over error", () => {
      render(
        <ContactSearchList
          {...createDefaultProps({ isLoading: true, error: "Error" })}
        />
      );

      expect(screen.getByTestId("loading-state")).toBeInTheDocument();
      expect(screen.queryByTestId("error-state")).not.toBeInTheDocument();
    });
  });

  describe("keyboard navigation", () => {
    it("clears search and resets focus on Escape", async () => {
      const user = userEvent.setup();
      const contacts = [createImportedContact({ id: "c1" })];

      render(<ContactSearchList {...createDefaultProps({ contacts })} />);

      const searchInput = screen.getByTestId("contact-search-input");
      await user.type(searchInput, "test");

      expect(searchInput).toHaveValue("test");

      await user.keyboard("{Escape}");

      expect(searchInput).toHaveValue("");
    });
  });

  describe("category filter - outlook", () => {
    it("shows Outlook contacts by default (outlook filter is on)", () => {
      const contacts = [
        createImportedContact({
          id: "outlook-1",
          name: "Outlook Contact",
          display_name: "Outlook Contact",
          source: "outlook",
        }),
        createImportedContact({
          id: "manual-1",
          name: "Manual Contact",
          display_name: "Manual Contact",
          source: "manual",
        }),
      ];

      render(<ContactSearchList {...createDefaultProps({ contacts })} />);

      expect(screen.getByTestId("contact-row-outlook-1")).toBeInTheDocument();
      expect(screen.getByTestId("contact-row-manual-1")).toBeInTheDocument();
    });

    it("hides Outlook contacts when outlook filter is toggled off", async () => {
      const user = userEvent.setup();
      const contacts = [
        createImportedContact({
          id: "outlook-1",
          name: "Outlook Contact",
          display_name: "Outlook Contact",
          source: "outlook",
        }),
        createImportedContact({
          id: "manual-1",
          name: "Manual Contact",
          display_name: "Manual Contact",
          source: "manual",
        }),
      ];

      render(<ContactSearchList {...createDefaultProps({ contacts })} />);

      // Outlook contact should be visible initially
      expect(screen.getByTestId("contact-row-outlook-1")).toBeInTheDocument();

      // Toggle off the Outlook filter
      await user.click(screen.getByTestId("filter-outlook"));

      // Outlook contact should be hidden
      expect(screen.queryByTestId("contact-row-outlook-1")).not.toBeInTheDocument();
      // Manual contact should still be visible
      expect(screen.getByTestId("contact-row-manual-1")).toBeInTheDocument();
    });

    it("shows Outlook contacts again when filter is toggled back on", async () => {
      const user = userEvent.setup();
      const contacts = [
        createImportedContact({
          id: "outlook-1",
          name: "Outlook Contact",
          display_name: "Outlook Contact",
          source: "outlook",
        }),
      ];

      render(<ContactSearchList {...createDefaultProps({ contacts })} />);

      // Toggle off
      await user.click(screen.getByTestId("filter-outlook"));
      expect(screen.queryByTestId("contact-row-outlook-1")).not.toBeInTheDocument();

      // Toggle back on
      await user.click(screen.getByTestId("filter-outlook"));
      expect(screen.getByTestId("contact-row-outlook-1")).toBeInTheDocument();
    });

    it("renders Outlook filter button with indigo styling when active", () => {
      render(<ContactSearchList {...createDefaultProps()} />);

      const outlookButton = screen.getByTestId("filter-outlook");
      expect(outlookButton).toBeInTheDocument();
      expect(outlookButton).toHaveTextContent("Outlook");
      expect(outlookButton.className).toContain("bg-indigo-100");
      expect(outlookButton.className).toContain("text-indigo-700");
    });

    it("renders Outlook filter button with gray styling when inactive", async () => {
      const user = userEvent.setup();
      render(<ContactSearchList {...createDefaultProps()} />);

      const outlookButton = screen.getByTestId("filter-outlook");
      await user.click(outlookButton);

      expect(outlookButton.className).toContain("bg-gray-100");
      expect(outlookButton.className).toContain("text-gray-400");
    });

    it("categorizes outlook-sourced contacts separately from other imported contacts", () => {
      const contacts = [
        createImportedContact({
          id: "outlook-1",
          name: "Outlook Contact",
          display_name: "Outlook Contact",
          source: "outlook",
        }),
        createImportedContact({
          id: "imported-1",
          name: "Imported Contact",
          display_name: "Imported Contact",
          source: "contacts_app",
        }),
      ];

      render(<ContactSearchList {...createDefaultProps({ contacts })} />);

      // Both should be visible with default filters
      expect(screen.getByTestId("contact-row-outlook-1")).toBeInTheDocument();
      expect(screen.getByTestId("contact-row-imported-1")).toBeInTheDocument();
    });
  });

  describe("accessibility", () => {
    it("has aria-label on search input", () => {
      render(<ContactSearchList {...createDefaultProps()} />);

      expect(screen.getByLabelText("Search contacts")).toBeInTheDocument();
    });

    it("has listbox role on contact list", () => {
      render(<ContactSearchList {...createDefaultProps()} />);

      expect(screen.getByRole("listbox")).toBeInTheDocument();
    });

    it("has aria-multiselectable on listbox", () => {
      render(<ContactSearchList {...createDefaultProps()} />);

      expect(screen.getByRole("listbox")).toHaveAttribute(
        "aria-multiselectable",
        "true"
      );
    });
  });
});
