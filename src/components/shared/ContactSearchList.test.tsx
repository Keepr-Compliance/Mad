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
import {
  defaultSourceSelection,
  ALL_ROLE_LEAF_IDS,
} from "../../utils/contactFilterModel";

// Mock ContactRow to simplify tests and verify props passed correctly
jest.mock("./ContactRow", () => ({
  ContactRow: ({
    contact,
    isSelected,
    isAdding,
    showCheckbox,
    showImportButton,
    compact,
    onSelect,
    onImport,
    className,
  }: {
    contact: ExtendedContact;
    isSelected: boolean;
    isAdding?: boolean;
    showCheckbox: boolean;
    showImportButton: boolean;
    compact?: boolean;
    onSelect: () => void;
    onImport?: () => void;
    className?: string;
  }) => (
    <div
      data-testid={`contact-row-${contact.id}`}
      data-selected={isSelected}
      data-show-checkbox={showCheckbox}
      data-show-import-button={showImportButton}
      data-compact={compact}
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

// Default props factory.
//
// `showCategoryFilter` defaults to `false` here so the search / selection / state
// tests exercise their behavior WITHOUT the Source/Role filter narrowing the list.
// This mirrors real usage: transaction flows (audit, EditContacts) render with the
// filter OFF; only the Contacts screen turns it ON. The dedicated "source/role
// filters" describe-block below opts INTO `showCategoryFilter` explicitly.
const createDefaultProps = (
  overrides: Partial<ContactSearchListProps> = {}
): ContactSearchListProps => ({
  contacts: [],
  selectedIds: [],
  onSelectionChange: jest.fn(),
  showCategoryFilter: false,
  ...overrides,
});

describe("ContactSearchList", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
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

    it("defaults compact to false and does not force the row's import button off", () => {
      const externalContacts = [createExternalContact({ id: "e1" })];
      const onImportContact = jest.fn();
      const onContactClick = jest.fn();

      render(
        <ContactSearchList
          {...createDefaultProps({ externalContacts, onImportContact, onContactClick })}
        />
      );

      expect(
        screen.getByTestId("contact-row-e1").getAttribute("data-compact")
      ).toBe("false");
      expect(
        screen.getByTestId("contact-row-e1").getAttribute("data-show-import-button")
      ).toBe("true");
    });

    it("forces the row's import button off in compact mode even for external contacts with onImportContact", () => {
      const externalContacts = [createExternalContact({ id: "e1" })];
      const onImportContact = jest.fn();
      const onContactClick = jest.fn();

      render(
        <ContactSearchList
          {...createDefaultProps({ externalContacts, onImportContact, onContactClick, compact: true })}
        />
      );

      expect(
        screen.getByTestId("contact-row-e1").getAttribute("data-compact")
      ).toBe("true");
      expect(
        screen.getByTestId("contact-row-e1").getAttribute("data-show-import-button")
      ).toBe("false");
    });

    it("forwards compact to ContactRow for every rendered row", () => {
      const contacts = [createImportedContact({ id: "c1" })];
      const externalContacts = [createExternalContact({ id: "e1" })];

      render(
        <ContactSearchList
          {...createDefaultProps({ contacts, externalContacts, compact: true })}
        />
      );

      expect(screen.getByTestId("contact-row-c1").getAttribute("data-compact")).toBe("true");
      expect(screen.getByTestId("contact-row-e1").getAttribute("data-compact")).toBe("true");
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

  describe("master-detail active row highlight (BACKLOG-1898 QA fix)", () => {
    it("highlights the row matching activeContactId when onContactClick is provided", () => {
      const contacts = [
        createImportedContact({ id: "c1" }),
        createImportedContact({ id: "c2" }),
      ];
      const onContactClick = jest.fn();

      render(
        <ContactSearchList
          {...createDefaultProps({
            contacts,
            selectedIds: [],
            onContactClick,
            activeContactId: "c1",
          })}
        />
      );

      expect(
        screen.getByTestId("contact-row-c1").getAttribute("data-selected")
      ).toBe("true");
      expect(
        screen.getByTestId("contact-row-c2").getAttribute("data-selected")
      ).toBe("false");
    });

    it("does not highlight any row when activeContactId matches nothing", () => {
      const contacts = [
        createImportedContact({ id: "c1" }),
        createImportedContact({ id: "c2" }),
      ];
      const onContactClick = jest.fn();

      render(
        <ContactSearchList
          {...createDefaultProps({
            contacts,
            selectedIds: [],
            onContactClick,
            activeContactId: "does-not-exist",
          })}
        />
      );

      expect(
        screen.getByTestId("contact-row-c1").getAttribute("data-selected")
      ).toBe("false");
      expect(
        screen.getByTestId("contact-row-c2").getAttribute("data-selected")
      ).toBe("false");
    });

    it("leaves selection-mode highlighting unchanged when activeContactId is not provided", () => {
      // No onContactClick, no activeContactId: pure selection mode (checkbox
      // flows like ContactAssignmentStep). Behavior must be byte-for-byte the
      // same as before this fix - only selectedIds drives the highlight.
      const contacts = [
        createImportedContact({ id: "c1" }),
        createImportedContact({ id: "c2" }),
      ];

      render(
        <ContactSearchList
          {...createDefaultProps({ contacts, selectedIds: ["c2"] })}
        />
      );

      expect(
        screen.getByTestId("contact-row-c1").getAttribute("data-selected")
      ).toBe("false");
      expect(
        screen.getByTestId("contact-row-c2").getAttribute("data-selected")
      ).toBe("true");
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

  // ------------------------------------------------------------------
  // Source + Role grouped filters (BACKLOG-1898 T3)
  //
  // Replaces the retired 5-pill "category filter" block. These tests opt INTO
  // showCategoryFilter and use contacts with real post-BACKLOG-1900 source
  // values + default_role so the grouped predicate is exercised end-to-end.
  // ------------------------------------------------------------------
  describe("source + role filters (BACKLOG-1898)", () => {
    // A client (buyer) from Outlook — matches the DEFAULT filter (Clients role, Email source).
    const outlookBuyer = createImportedContact({
      id: "outlook-buyer",
      name: "Outlook Buyer",
      display_name: "Outlook Buyer",
      source: "outlook",
      default_role: "buyer",
    });
    // A client (seller) from iPhone — matches the DEFAULT filter (Clients role, Phone source).
    const iphoneSeller = createImportedContact({
      id: "iphone-seller",
      name: "iPhone Seller",
      display_name: "iPhone Seller",
      source: "iphone",
      default_role: "seller",
    });
    // An agent (Colleague) from Gmail — role is OFF by default (only Clients on).
    const gmailAgent = createImportedContact({
      id: "gmail-agent",
      name: "Gmail Agent",
      display_name: "Gmail Agent",
      source: "google_contacts",
      default_role: "buyer_agent",
    });
    // A no-role buyer-sourced contact — matches Unassigned only (OFF by default).
    const unassignedManual = createImportedContact({
      id: "unassigned-manual",
      name: "Unassigned Manual",
      display_name: "Unassigned Manual",
      source: "manual",
      default_role: undefined,
    });

    it("renders the Source and Role dropdown triggers (no old pills)", () => {
      render(
        <ContactSearchList {...createDefaultProps({ contacts: [outlookBuyer], showCategoryFilter: true })} />
      );

      expect(screen.getByTestId("source-filter-trigger")).toBeInTheDocument();
      expect(screen.getByTestId("role-filter-trigger")).toBeInTheDocument();
      // The old pill filters are gone.
      expect(screen.queryByTestId("filter-outlook")).not.toBeInTheDocument();
      expect(screen.queryByTestId("filter-manual")).not.toBeInTheDocument();
    });

    it("default filter shows ALL roles incl. Unassigned from non-Inferred sources (BACKLOG-2141)", () => {
      render(
        <ContactSearchList
          {...createDefaultProps({
            contacts: [outlookBuyer, iphoneSeller, gmailAgent, unassignedManual],
            showCategoryFilter: true,
          })}
        />
      );

      // Exact rendered row ID SET (identity, not counts): every contact is
      // visible under the new all-roles default — clients, the agent, AND the
      // no-role (Unassigned) contact.
      const rendered = screen
        .getAllByTestId(/^contact-row-/)
        .map((el) => el.getAttribute("data-testid"));
      expect(new Set(rendered)).toEqual(
        new Set([
          "contact-row-outlook-buyer",
          "contact-row-iphone-seller",
          "contact-row-gmail-agent",
          "contact-row-unassigned-manual",
        ]),
      );
    });

    it("deselecting Colleagues > Agents hides agents (default is all roles ON, BACKLOG-2141)", async () => {
      const user = userEvent.setup();
      render(
        <ContactSearchList
          {...createDefaultProps({
            contacts: [outlookBuyer, gmailAgent],
            showCategoryFilter: true,
          })}
        />
      );

      // Under the new default, the agent starts VISIBLE.
      expect(screen.getByTestId("contact-row-gmail-agent")).toBeInTheDocument();

      // Open the Role dropdown and UNtick the "Agents" leaf (ON by default now).
      await user.click(screen.getByTestId("role-filter-trigger"));
      await user.click(screen.getByTestId("role-filter-checkbox-agents"));

      expect(screen.queryByTestId("contact-row-gmail-agent")).not.toBeInTheDocument();
      // The client buyer stays visible.
      expect(screen.getByTestId("contact-row-outlook-buyer")).toBeInTheDocument();
    });

    it("changing the Source filter (uncheck iPhone) hides that source", async () => {
      const user = userEvent.setup();
      render(
        <ContactSearchList
          {...createDefaultProps({
            contacts: [outlookBuyer, iphoneSeller],
            showCategoryFilter: true,
          })}
        />
      );

      expect(screen.getByTestId("contact-row-iphone-seller")).toBeInTheDocument();

      // Open the Source dropdown and uncheck the "iPhone" leaf (ON by default).
      await user.click(screen.getByTestId("source-filter-trigger"));
      await user.click(screen.getByTestId("source-filter-checkbox-iphone"));

      // iPhone-sourced seller hidden; Outlook-sourced buyer stays.
      expect(screen.queryByTestId("contact-row-iphone-seller")).not.toBeInTheDocument();
      expect(screen.getByTestId("contact-row-outlook-buyer")).toBeInTheDocument();
    });

    it("deselecting Unassigned hides NULL default_role contacts (default is ON, BACKLOG-2141)", async () => {
      const user = userEvent.setup();
      render(
        <ContactSearchList
          {...createDefaultProps({
            contacts: [outlookBuyer, unassignedManual],
            showCategoryFilter: true,
          })}
        />
      );

      // Unassigned ON by default → no-role contact starts visible.
      expect(screen.getByTestId("contact-row-unassigned-manual")).toBeInTheDocument();

      // Open the Role dropdown and UNtick the standalone "Unassigned" toggle.
      await user.click(screen.getByTestId("role-filter-trigger"));
      await user.click(screen.getByTestId("role-filter-checkbox-unassigned"));

      expect(screen.queryByTestId("contact-row-unassigned-manual")).not.toBeInTheDocument();
      // The client buyer stays visible.
      expect(screen.getByTestId("contact-row-outlook-buyer")).toBeInTheDocument();
    });

    it("does NOT render the filter UI when showCategoryFilter is false", () => {
      render(
        <ContactSearchList
          {...createDefaultProps({ contacts: [gmailAgent], showCategoryFilter: false })}
        />
      );

      // No dropdowns, and — crucially — no filtering: the agent is visible.
      expect(screen.queryByTestId("source-filter-trigger")).not.toBeInTheDocument();
      expect(screen.queryByTestId("role-filter-trigger")).not.toBeInTheDocument();
      expect(screen.getByTestId("contact-row-gmail-agent")).toBeInTheDocument();
    });

    describe("localStorage persistence", () => {
      it("round-trips the new filter model (persist then reload)", async () => {
        const user = userEvent.setup();

        // First mount: DEselect the Agents role (ON by default post-BACKLOG-2141),
        // which should persist and hide the agent.
        const { unmount } = render(
          <ContactSearchList
            {...createDefaultProps({ contacts: [gmailAgent], showCategoryFilter: true })}
          />
        );
        // Agent starts visible under the all-roles default.
        expect(screen.getByTestId("contact-row-gmail-agent")).toBeInTheDocument();
        await user.click(screen.getByTestId("role-filter-trigger"));
        await user.click(screen.getByTestId("role-filter-checkbox-agents"));
        expect(screen.queryByTestId("contact-row-gmail-agent")).not.toBeInTheDocument();

        // localStorage now holds the new-shape key WITHOUT the agents leaf.
        const stored = localStorage.getItem("contactModal.filterModel.v1");
        expect(stored).not.toBeNull();
        expect(JSON.parse(stored as string).roles).not.toContain("agents");

        unmount();

        // Second mount reads persisted state → agent still hidden without re-toggling.
        render(
          <ContactSearchList
            {...createDefaultProps({ contacts: [gmailAgent], showCategoryFilter: true })}
          />
        );
        expect(screen.queryByTestId("contact-row-gmail-agent")).not.toBeInTheDocument();
      });

      it("migrates the legacy contactModal.categoryFilter key on first load", () => {
        // Legacy shape with messageDerived=true → Inferred sources should be enabled.
        localStorage.setItem(
          "contactModal.categoryFilter",
          JSON.stringify({ imported: true, manuallyAdded: true, external: true, messageDerived: true })
        );

        const inferredContact = createImportedContact({
          id: "inferred-buyer",
          name: "Inferred Buyer",
          display_name: "Inferred Buyer",
          source: "inferred",
          is_message_derived: true,
          default_role: "buyer",
        });

        render(
          <ContactSearchList
            {...createDefaultProps({ contacts: [inferredContact], showCategoryFilter: true })}
          />
        );

        // Migration turned Inferred ON → the inferred client is visible.
        expect(screen.getByTestId("contact-row-inferred-buyer")).toBeInTheDocument();

        // The new key was written forward with the Inferred source leaves.
        const stored = localStorage.getItem("contactModal.filterModel.v1");
        expect(stored).not.toBeNull();
        expect(JSON.parse(stored as string).sources).toEqual(
          expect.arrayContaining(["inferred_email", "inferred_texts"])
        );
      });
    });
  });

  // ------------------------------------------------------------------
  // BACKLOG-2141 — default role filter includes Unassigned + escape hatches.
  // All assertions use EXACT rendered contact-row-<id> ID SETS (identity, not
  // counts) per the founder directive.
  // ------------------------------------------------------------------
  describe("default role filter + filtered-empty escape hatches (BACKLOG-2141)", () => {
    const buyer = createImportedContact({
      id: "buyer-1",
      display_name: "Buyer One",
      source: "outlook",
      default_role: "buyer",
    });
    const agent = createImportedContact({
      id: "agent-1",
      display_name: "Agent One",
      source: "google_contacts",
      default_role: "buyer_agent",
    });
    const nullRole = createImportedContact({
      id: "null-role-1",
      display_name: "No Role One",
      source: "manual",
      default_role: undefined,
    });

    /** Exact set of rendered contact-row testids currently in the DOM. */
    const renderedRowIds = (): Set<string> =>
      new Set(
        screen
          .queryAllByTestId(/^contact-row-/)
          .map((el) => el.getAttribute("data-testid") as string),
      );

    it("fresh mount (empty localStorage) shows null-role + buyer + agent (exact set)", () => {
      render(
        <ContactSearchList
          {...createDefaultProps({
            contacts: [buyer, agent, nullRole],
            showCategoryFilter: true,
          })}
        />
      );

      expect(renderedRowIds()).toEqual(
        new Set(["contact-row-buyer-1", "contact-row-agent-1", "contact-row-null-role-1"]),
      );
    });

    it("migrates the old {buyers, sellers} seed forward → null-role row appears, key upgraded", () => {
      // Seed the persisted key with EXACTLY the old pre-2141 default.
      localStorage.setItem(
        "contactModal.filterModel.v1",
        JSON.stringify({
          sources: Array.from(defaultSourceSelection()),
          roles: ["buyers", "sellers"],
        })
      );

      render(
        <ContactSearchList
          {...createDefaultProps({
            contacts: [buyer, agent, nullRole],
            showCategoryFilter: true,
          })}
        />
      );

      // Migration upgraded to the all-roles default → every contact visible.
      expect(renderedRowIds()).toEqual(
        new Set(["contact-row-buyer-1", "contact-row-agent-1", "contact-row-null-role-1"]),
      );

      // The persisted key was written forward with the all-leaves role set
      // (no longer the old seed → idempotent on re-mount).
      const stored = JSON.parse(
        localStorage.getItem("contactModal.filterModel.v1") as string
      );
      expect(new Set(stored.roles)).toEqual(new Set(ALL_ROLE_LEAF_IDS));
    });

    it("does NOT migrate a deliberate {sellers} selection (buyer/agent/null-role stay hidden)", () => {
      // A deliberate narrow selection — NOT the old seed → must be preserved.
      localStorage.setItem(
        "contactModal.filterModel.v1",
        JSON.stringify({
          sources: Array.from(defaultSourceSelection()),
          roles: ["sellers"],
        })
      );

      const seller = createImportedContact({
        id: "seller-1",
        display_name: "Seller One",
        source: "outlook",
        default_role: "seller",
      });

      render(
        <ContactSearchList
          {...createDefaultProps({
            contacts: [buyer, agent, nullRole, seller],
            showCategoryFilter: true,
          })}
        />
      );

      // Only the seller matches the preserved {sellers} selection.
      expect(renderedRowIds()).toEqual(new Set(["contact-row-seller-1"]));

      // The stored selection is untouched (still exactly {sellers}).
      const stored = JSON.parse(
        localStorage.getItem("contactModal.filterModel.v1") as string
      );
      expect(new Set(stored.roles)).toEqual(new Set(["sellers"]));
    });

    it("migration is idempotent under StrictMode double-invoke", () => {
      localStorage.setItem(
        "contactModal.filterModel.v1",
        JSON.stringify({
          sources: Array.from(defaultSourceSelection()),
          roles: ["buyers", "sellers"],
        })
      );

      render(
        <React.StrictMode>
          <ContactSearchList
            {...createDefaultProps({
              contacts: [buyer, agent, nullRole],
              showCategoryFilter: true,
            })}
          />
        </React.StrictMode>
      );

      // All contacts visible; stored roles are the all-leaves set (a double
      // loadContactFilters() call is a no-op after the first forward write).
      expect(renderedRowIds()).toEqual(
        new Set(["contact-row-buyer-1", "contact-row-agent-1", "contact-row-null-role-1"]),
      );
      const stored = JSON.parse(
        localStorage.getItem("contactModal.filterModel.v1") as string
      );
      expect(new Set(stored.roles)).toEqual(new Set(ALL_ROLE_LEAF_IDS));
    });

    it("filtered-empty: all rows hidden by filters → escape hatch + Show all reveals exact set", async () => {
      const user = userEvent.setup();
      // Seed a selection that hides EVERYTHING: roles={sellers}, but the only
      // contacts are a buyer + an agent → zero rows match.
      localStorage.setItem(
        "contactModal.filterModel.v1",
        JSON.stringify({
          sources: Array.from(defaultSourceSelection()),
          roles: ["sellers"],
        })
      );

      render(
        <ContactSearchList
          {...createDefaultProps({
            contacts: [buyer, agent],
            showCategoryFilter: true,
          })}
        />
      );

      // Filtered-empty escape hatch present; generic empty state absent.
      expect(screen.getByTestId("empty-state-filtered")).toBeInTheDocument();
      expect(screen.queryByTestId("empty-state")).not.toBeInTheDocument();
      expect(screen.getByTestId("empty-state-filtered").textContent).toContain("2 hidden");
      expect(renderedRowIds().size).toBe(0);

      // Click "Show all" → true select-all reveals the exact expected set.
      await user.click(screen.getByTestId("show-all-filters"));
      expect(renderedRowIds()).toEqual(
        new Set(["contact-row-buyer-1", "contact-row-agent-1"]),
      );
      expect(screen.queryByTestId("empty-state-filtered")).not.toBeInTheDocument();
    });

    it("footer action row: singular hidden count + clicking the row reveals full set; absent when nothing hidden", async () => {
      const user = userEvent.setup();
      // roles={buyers} → buyer shown, agent hidden (1 hidden → singular copy).
      localStorage.setItem(
        "contactModal.filterModel.v1",
        JSON.stringify({
          sources: Array.from(defaultSourceSelection()),
          roles: ["buyers"],
        })
      );

      render(
        <ContactSearchList
          {...createDefaultProps({
            contacts: [buyer, agent],
            showCategoryFilter: true,
          })}
        />
      );

      // Some shown, some hidden → action row present with the exact "Show N more
      // contacts" copy (singular) and the secondary "hidden by your filters" line.
      expect(renderedRowIds()).toEqual(new Set(["contact-row-buyer-1"]));
      const footer = screen.getByTestId("filter-hidden-footer");
      expect(footer).toBeInTheDocument();
      expect(footer.textContent).toContain("Show 1 more contact");
      expect(footer.textContent).not.toContain("Show 1 more contacts");
      expect(footer.textContent).toContain("hidden by your filters");

      // The whole action row is a button — clicking it (via the row testid)
      // performs the "Show all" reset for the user; full set revealed AND the
      // row disappears (nothing hidden now).
      await user.click(screen.getByTestId("show-all-filters-footer"));
      expect(renderedRowIds()).toEqual(
        new Set(["contact-row-buyer-1", "contact-row-agent-1"]),
      );
      expect(screen.queryByTestId("filter-hidden-footer")).not.toBeInTheDocument();
    });

    it("footer action row: plural hidden count + clicking the row body reveals full set", async () => {
      const user = userEvent.setup();
      // roles={buyers} → buyer shown, agent + nullRole hidden (2 hidden → plural).
      localStorage.setItem(
        "contactModal.filterModel.v1",
        JSON.stringify({
          sources: Array.from(defaultSourceSelection()),
          roles: ["buyers"],
        })
      );

      render(
        <ContactSearchList
          {...createDefaultProps({
            contacts: [buyer, agent, nullRole],
            showCategoryFilter: true,
          })}
        />
      );

      expect(renderedRowIds()).toEqual(new Set(["contact-row-buyer-1"]));
      const footer = screen.getByTestId("filter-hidden-footer");
      expect(footer.textContent).toContain("Show 2 more contacts");

      // The action row is a full-width button; clicking it (the row body, not a
      // nested "Show all" link) resets the filters for the user.
      await user.click(screen.getByTestId("show-all-filters-footer"));
      expect(renderedRowIds()).toEqual(
        new Set([
          "contact-row-buyer-1",
          "contact-row-agent-1",
          "contact-row-null-role-1",
        ]),
      );
      expect(screen.queryByTestId("filter-hidden-footer")).not.toBeInTheDocument();
    });

    it("footer is absent under the default (nothing hidden)", () => {
      render(
        <ContactSearchList
          {...createDefaultProps({
            contacts: [buyer, agent, nullRole],
            showCategoryFilter: true,
          })}
        />
      );
      expect(screen.queryByTestId("filter-hidden-footer")).not.toBeInTheDocument();
    });

    it("does NOT show the filter footer/empty-hatch when a search narrows the list", async () => {
      const user = userEvent.setup();
      render(
        <ContactSearchList
          {...createDefaultProps({
            contacts: [buyer, agent, nullRole],
            showCategoryFilter: true,
          })}
        />
      );

      // Type a search that matches nothing → generic empty state, NOT the
      // filter escape hatch (search-narrowing must not masquerade as filtering).
      await user.type(screen.getByTestId("contact-search-input"), "zzzznomatch");
      expect(screen.getByTestId("empty-state")).toBeInTheDocument();
      expect(screen.queryByTestId("empty-state-filtered")).not.toBeInTheDocument();
      expect(screen.queryByTestId("filter-hidden-footer")).not.toBeInTheDocument();
    });

    it("reports the rendered row count via onVisibleCountChange", async () => {
      const onVisibleCountChange = jest.fn();
      // Seed roles={buyers} → only the buyer renders (1 row).
      localStorage.setItem(
        "contactModal.filterModel.v1",
        JSON.stringify({
          sources: Array.from(defaultSourceSelection()),
          roles: ["buyers"],
        })
      );

      render(
        <ContactSearchList
          {...createDefaultProps({
            contacts: [buyer, agent],
            showCategoryFilter: true,
            onVisibleCountChange,
          })}
        />
      );

      await waitFor(() => expect(onVisibleCountChange).toHaveBeenLastCalledWith(1));
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
