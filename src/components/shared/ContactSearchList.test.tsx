/**
 * ContactSearchList Component Tests
 *
 * @see TASK-1763: ContactSearchList Component
 */

import React, { useState } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ContactSearchList,
  ContactSearchListProps,
} from "./ContactSearchList";
import type { ExtendedContact } from "../../types/components";
import { defaultSourceSelection } from "../../utils/contactFilterModel";

// Mock ContactRow to simplify tests and verify props passed correctly
jest.mock("./ContactRow", () => ({
  ContactRow: ({
    contact,
    isSelected,
    isAdding,
    showCheckbox,
    showImportButton,
    showAddButton,
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
    showAddButton?: boolean;
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
      data-show-add-button={showAddButton}
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
      {showAddButton && (
        <button
          data-testid={`add-button-${contact.id}`}
          onClick={(e) => {
            e.stopPropagation();
            onSelect?.();
          }}
        >
          + Add
        </button>
      )}
    </div>
  ),
}));

// Test data factories
// Cast: this factory builds only the identity/display fields the list renders.
// Contact also requires created_at / updated_at; they are omitted deliberately
// so imported rows stay distinguishable from the external ones below (which do
// carry timestamps).
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
} as ExtendedContact);

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
  filterMode: "off",
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

  // BACKLOG-2400: two-pane "add" selection mode. Rows show a "+ Add" button
  // instead of a checkbox, and any contact in selectedIds DROPS OUT of the list
  // (it has moved to the caller's Added column) — making selection single-sourced.
  describe("add selection mode (BACKLOG-2400)", () => {
    it("forwards showAddButton and hides the checkbox in add mode", () => {
      const contacts = [
        createImportedContact({ id: "c1" }),
        createExternalContact({ id: "e1" }),
      ];

      render(
        <ContactSearchList
          {...createDefaultProps({ contacts, selectionMode: "add" })}
        />
      );

      for (const id of ["c1", "e1"]) {
        expect(
          screen.getByTestId(`contact-row-${id}`).getAttribute("data-show-add-button")
        ).toBe("true");
        expect(
          screen.getByTestId(`contact-row-${id}`).getAttribute("data-show-checkbox")
        ).toBe("false");
      }
    });

    it("drops selected contacts out of the list (they moved to the Added column)", () => {
      const contacts = [
        createImportedContact({ id: "c1", display_name: "Alice" }),
        createImportedContact({ id: "c2", display_name: "Bob" }),
        createImportedContact({ id: "c3", display_name: "Carol" }),
      ];

      render(
        <ContactSearchList
          {...createDefaultProps({
            contacts,
            selectionMode: "add",
            selectedIds: ["c2"],
          })}
        />
      );

      // Exact-identity assertion: c1 and c3 remain available, c2 is gone.
      expect(screen.getByTestId("contact-row-c1")).toBeInTheDocument();
      expect(screen.getByTestId("contact-row-c3")).toBeInTheDocument();
      expect(screen.queryByTestId("contact-row-c2")).not.toBeInTheDocument();
    });

    it("clicking + Add adds the contact to selection", () => {
      const contacts = [createImportedContact({ id: "c1" })];
      const onSelectionChange = jest.fn();

      render(
        <ContactSearchList
          {...createDefaultProps({
            contacts,
            selectionMode: "add",
            selectedIds: [],
            onSelectionChange,
          })}
        />
      );

      fireEvent.click(screen.getByTestId("add-button-c1"));
      expect(onSelectionChange).toHaveBeenCalledWith(["c1"]);
    });

    it("returning a contact to Available (deselect) restores its row", () => {
      const contacts = [
        createImportedContact({ id: "c1", display_name: "Alice" }),
        createImportedContact({ id: "c2", display_name: "Bob" }),
      ];

      const { rerender } = render(
        <ContactSearchList
          {...createDefaultProps({
            contacts,
            selectionMode: "add",
            selectedIds: ["c1"],
          })}
        />
      );
      expect(screen.queryByTestId("contact-row-c1")).not.toBeInTheDocument();

      // Deselect c1 -> its row comes back to Available.
      rerender(
        <ContactSearchList
          {...createDefaultProps({
            contacts,
            selectionMode: "add",
            selectedIds: [],
          })}
        />
      );
      expect(screen.getByTestId("contact-row-c1")).toBeInTheDocument();
      expect(screen.getByTestId("contact-row-c2")).toBeInTheDocument();
    });

    it("checkbox mode (default) keeps selected rows visible — unchanged", () => {
      const contacts = [
        createImportedContact({ id: "c1" }),
        createImportedContact({ id: "c2" }),
      ];

      render(
        <ContactSearchList
          {...createDefaultProps({ contacts, selectedIds: ["c1"] })}
        />
      );

      // Selected row stays in the list (checked), never dropped.
      expect(screen.getByTestId("contact-row-c1")).toBeInTheDocument();
      expect(
        screen.getByTestId("contact-row-c1").getAttribute("data-selected")
      ).toBe("true");
      expect(
        screen.getByTestId("contact-row-c1").getAttribute("data-show-checkbox")
      ).toBe("true");
      expect(
        screen.getByTestId("contact-row-c1").getAttribute("data-show-add-button")
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
      // Cast: the resolved value only needs the fields the import handler reads
      // back; a full ExtendedContact row is not required here.
      resolveImport!({
        id: "imported-e1",
        name: "Jane Doe",
        user_id: "user-1",
      } as ExtendedContact);

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
      // Cast: the resolved value only needs the fields the import handler reads
      // back; a full ExtendedContact row is not required here.
      resolveImport!({
        id: "imported-e1",
        name: "Jane Doe",
        user_id: "user-1",
      } as ExtendedContact);
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
        <ContactSearchList {...createDefaultProps({ contacts: [outlookBuyer], filterMode: "persistent" })} />
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
            filterMode: "persistent",
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
            filterMode: "persistent",
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
            filterMode: "persistent",
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
            filterMode: "persistent",
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
          {...createDefaultProps({ contacts: [gmailAgent], filterMode: "off" })}
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
            {...createDefaultProps({ contacts: [gmailAgent], filterMode: "persistent" })}
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
            {...createDefaultProps({ contacts: [gmailAgent], filterMode: "persistent" })}
          />
        );
        expect(screen.queryByTestId("contact-row-gmail-agent")).not.toBeInTheDocument();
      });

      // NOTE (BACKLOG-2352): the legacy `contactModal.categoryFilter` migration
      // and the {buyers,sellers} -> all-leaves role upgrade were removed as
      // accidental complexity. Persistence now reads/writes ONLY the current
      // `contactModal.filterModel.v1` key; a stored selection is honored
      // literally. The corresponding migration tests were deleted with them.
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
            filterMode: "persistent",
          })}
        />
      );

      expect(renderedRowIds()).toEqual(
        new Set(["contact-row-buyer-1", "contact-row-agent-1", "contact-row-null-role-1"]),
      );
    });

    it("honors a stored {sellers} selection literally (buyer/agent/null-role stay hidden)", () => {
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
            filterMode: "persistent",
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

    it("is stable under a StrictMode double-invoke (no drift, no dupes, persistence intact)", () => {
      // BACKLOG-2352: the SVO wrote to refs during render and corrupted under
      // StrictMode's double-invoke. The pure engine must render identically.
      const seed = JSON.stringify({
        sources: Array.from(defaultSourceSelection()),
        roles: ["sellers"],
      });
      localStorage.setItem("contactModal.filterModel.v1", seed);

      const seller = createImportedContact({
        id: "seller-1",
        display_name: "Seller One",
        source: "outlook",
        default_role: "seller",
      });

      render(
        <React.StrictMode>
          <ContactSearchList
            {...createDefaultProps({
              contacts: [buyer, agent, nullRole, seller],
              filterMode: "persistent",
            })}
          />
        </React.StrictMode>
      );

      // Stored selection honored literally under double-invoke — only the seller
      // matches {sellers}; no row appears twice.
      expect(renderedRowIds()).toEqual(new Set(["contact-row-seller-1"]));
      const rows = screen.queryAllByTestId(/^contact-row-/);
      expect(rows.length).toBe(1); // exactly one node, not a doubled render
      // The deliberate selection was not clobbered by the double mount.
      const stored = JSON.parse(
        localStorage.getItem("contactModal.filterModel.v1") as string
      );
      expect(new Set(stored.roles)).toEqual(new Set(["sellers"]));
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
            filterMode: "persistent",
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
            filterMode: "persistent",
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

      // PLACEMENT (iteration 2): the action row renders INSIDE the scrollable
      // list flow (a descendant of `contact-list`, NOT a sibling pinned below
      // it) and AFTER the last visible contact row in DOM order — so it scrolls
      // with the list and sits directly beneath the final contact.
      const scrollContainer = screen.getByTestId("contact-list");
      expect(scrollContainer).toContainElement(footer);
      const domOrder = Array.from(
        scrollContainer.querySelectorAll(
          '[data-testid^="contact-row-"],[data-testid="filter-hidden-footer"]',
        ),
      ).map((el) => el.getAttribute("data-testid"));
      expect(domOrder).toEqual(["contact-row-buyer-1", "filter-hidden-footer"]);

      // ALIGNMENT (iteration 2): content is centered, not left-aligned.
      const rowButton = screen.getByTestId("show-all-filters-footer");
      expect(rowButton).toHaveClass("items-center", "text-center");
      expect(rowButton).not.toHaveClass("text-left");

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
            filterMode: "persistent",
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
            filterMode: "persistent",
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
            filterMode: "persistent",
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
            filterMode: "persistent",
            onVisibleCountChange,
          })}
        />
      );

      await waitFor(() => expect(onVisibleCountChange).toHaveBeenLastCalledWith(1));
    });
  });

  // ------------------------------------------------------------------
  // BACKLOG-2341 (support #89) — transaction-flow filter contract.
  // The add-contacts picker (existing transaction) opts INTO the Source/Role
  // filter but must open on "show everything" and NEVER pre-hide a contact.
  // `categoryFilterDefaultsToAll` = true means:
  //   1. initial selection = TRUE select-all (incl. Inferred sources +
  //      Unassigned roles), regardless of any persisted narrowing, and
  //   2. the selection is EPHEMERAL — the shared `contactModal.filterModel.v1`
  //      key is never read from nor written to (no inherit, no clobber).
  // Identity-set assertions per the founder directive (not counts).
  // ------------------------------------------------------------------
  describe("categoryFilterDefaultsToAll (transaction flow, BACKLOG-2341)", () => {
    const STORAGE_KEY = "contactModal.filterModel.v1";

    // Message-derived (Inferred source) → HIDDEN by the Contacts-screen default
    // (Inferred OFF) but MUST be visible in a transaction flow.
    const inferredContact = createImportedContact({
      id: "inferred-1",
      display_name: "Inferred Contact",
      source: "inferred",
      is_message_derived: true,
      default_role: "buyer",
    });
    // No-role contact → matches the Unassigned role leaf only.
    const unassigned = createImportedContact({
      id: "unassigned-1",
      display_name: "No Role",
      source: "manual",
      default_role: undefined,
    });
    const outlookBuyer = createImportedContact({
      id: "outlook-1",
      display_name: "Outlook Buyer",
      source: "outlook",
      default_role: "buyer",
    });

    const renderedRowIds = (): Set<string> =>
      new Set(
        screen
          .queryAllByTestId(/^contact-row-/)
          .map((el) => el.getAttribute("data-testid") as string),
      );

    it("opens on TRUE select-all — shows Inferred + Unassigned contacts (never pre-hides)", () => {
      render(
        <ContactSearchList
          {...createDefaultProps({
            contacts: [inferredContact, unassigned, outlookBuyer],
            filterMode: "ephemeral",
          })}
        />
      );

      expect(renderedRowIds()).toEqual(
        new Set([
          "contact-row-inferred-1",
          "contact-row-unassigned-1",
          "contact-row-outlook-1",
        ]),
      );
    });

    it("IGNORES a narrowed persisted selection (does not inherit → no pre-hide)", () => {
      // A saved Contacts-screen selection that WOULD hide the inferred + no-role.
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ sources: ["outlook"], roles: ["buyers"] })
      );

      render(
        <ContactSearchList
          {...createDefaultProps({
            contacts: [inferredContact, unassigned, outlookBuyer],
            filterMode: "ephemeral",
          })}
        />
      );

      // Persisted narrowing ignored — every contact still visible.
      expect(renderedRowIds()).toEqual(
        new Set([
          "contact-row-inferred-1",
          "contact-row-unassigned-1",
          "contact-row-outlook-1",
        ]),
      );
    });

    it("is EPHEMERAL: narrowing never writes the shared storage key", async () => {
      const user = userEvent.setup();
      render(
        <ContactSearchList
          {...createDefaultProps({
            contacts: [inferredContact, outlookBuyer],
            filterMode: "ephemeral",
          })}
        />
      );

      // Opt into narrowing: uncheck the Outlook source leaf.
      await user.click(screen.getByTestId("source-filter-trigger"));
      await user.click(screen.getByTestId("source-filter-checkbox-outlook"));

      // In-session narrowing applied (outlook buyer hidden)...
      expect(screen.queryByTestId("contact-row-outlook-1")).not.toBeInTheDocument();
      // ...but nothing persisted to the shared key.
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it("does NOT clobber the Contacts screen's saved selection", async () => {
      const user = userEvent.setup();
      const saved = JSON.stringify({ sources: ["outlook"], roles: ["sellers"] });
      localStorage.setItem(STORAGE_KEY, saved);

      render(
        <ContactSearchList
          {...createDefaultProps({
            contacts: [inferredContact, outlookBuyer],
            filterMode: "ephemeral",
          })}
        />
      );

      // Interact with a role leaf — must NOT write through to the shared key.
      await user.click(screen.getByTestId("role-filter-trigger"));
      await user.click(screen.getByTestId("role-filter-checkbox-buyers"));

      expect(localStorage.getItem(STORAGE_KEY)).toBe(saved);
    });

    it("still supports opt-in narrowing + the Show-all footer escape hatch", async () => {
      const user = userEvent.setup();
      render(
        <ContactSearchList
          {...createDefaultProps({
            contacts: [inferredContact, outlookBuyer],
            filterMode: "ephemeral",
          })}
        />
      );

      // Opt into narrowing: hide the Inferred source (both leaves).
      await user.click(screen.getByTestId("source-filter-trigger"));
      await user.click(screen.getByTestId("source-filter-checkbox-inferred_email"));
      await user.click(screen.getByTestId("source-filter-checkbox-inferred_texts"));
      expect(screen.queryByTestId("contact-row-inferred-1")).not.toBeInTheDocument();

      // Footer escape hatch reveals everything again (true select-all).
      await user.click(screen.getByTestId("show-all-filters-footer"));
      expect(renderedRowIds()).toEqual(
        new Set(["contact-row-inferred-1", "contact-row-outlook-1"]),
      );
    });
  });

  // ------------------------------------------------------------------
  // BACKLOG-2352 — Sort control + dedup/determinism wiring.
  // The pure engine is unit-tested exhaustively in
  // src/utils/__tests__/contactPickerList.test.ts; these assert the component
  // wires it correctly. Order assertions use rendered DOM order.
  // ------------------------------------------------------------------
  describe("sort control (BACKLOG-2352)", () => {
    /** Ordered list of rendered contact ids (DOM order). */
    const rowOrder = (): string[] =>
      screen
        .queryAllByTestId(/^contact-row-/)
        .map((el) => (el.getAttribute("data-testid") as string).replace("contact-row-", ""));

    const zed = createImportedContact({
      id: "zed",
      display_name: "Zed",
      email: "zed@x.com",
      last_communication_at: "2026-06-01T00:00:00Z",
    });
    const mike = createImportedContact({
      id: "mike",
      display_name: "Mike",
      email: "mike@x.com",
      last_communication_at: "2026-05-01T00:00:00Z",
    });
    const abe = createImportedContact({
      id: "abe",
      display_name: "Abe",
      email: "abe@x.com",
      last_communication_at: "2026-04-01T00:00:00Z",
    });

    it("renders a Recent/Alphabetical toggle, Recent active by default", () => {
      render(<ContactSearchList {...createDefaultProps({ contacts: [zed, mike, abe] })} />);
      expect(screen.getByTestId("contact-sort-control")).toBeInTheDocument();
      expect(screen.getByTestId("sort-recent")).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByTestId("sort-alphabetical")).toHaveAttribute("aria-pressed", "false");
    });

    it("defaults to Recent order (last_communication_at DESC)", () => {
      render(<ContactSearchList {...createDefaultProps({ contacts: [abe, mike, zed] })} />);
      expect(rowOrder()).toEqual(["zed", "mike", "abe"]);
    });

    it("toggles to Alphabetical (A-Z) and back to Recent", async () => {
      const user = userEvent.setup();
      render(<ContactSearchList {...createDefaultProps({ contacts: [zed, mike, abe] })} />);
      expect(rowOrder()).toEqual(["zed", "mike", "abe"]);

      await user.click(screen.getByTestId("sort-alphabetical"));
      expect(screen.getByTestId("sort-alphabetical")).toHaveAttribute("aria-pressed", "true");
      expect(rowOrder()).toEqual(["abe", "mike", "zed"]);

      await user.click(screen.getByTestId("sort-recent"));
      expect(rowOrder()).toEqual(["zed", "mike", "abe"]);
    });

    it("honors initialSortOrder='alphabetical' on first render", () => {
      render(
        <ContactSearchList
          {...createDefaultProps({ contacts: [zed, mike, abe], initialSortOrder: "alphabetical" })}
        />
      );
      expect(rowOrder()).toEqual(["abe", "mike", "zed"]);
    });

    it("the sort control is present even in transaction flows (filterMode off)", () => {
      render(<ContactSearchList {...createDefaultProps({ contacts: [zed], filterMode: "off" })} />);
      expect(screen.getByTestId("contact-sort-control")).toBeInTheDocument();
      // ...and no filter UI is shown in "off" mode.
      expect(screen.queryByTestId("source-filter-trigger")).not.toBeInTheDocument();
    });
  });

  describe("assembly + determinism wiring (BACKLOG-2352, BACKLOG-2370)", () => {
    const renderedRowIds = (): Set<string> =>
      new Set(
        screen
          .queryAllByTestId(/^contact-row-/)
          .map((el) => el.getAttribute("data-testid") as string),
      );

    /**
     * BACKLOG-2370 — this list RENDERS WHAT IT IS GIVEN.
     *
     * It used to drop an external record that shared an email with a saved
     * contact, and this case asserted that drop. The founder had that rule
     * removed: it was a second answer to "are these the same person?", it stored
     * nothing, and it silently reversed an unlink he had just performed by
     * re-hiding the record `contacts:get-available` had deliberately released.
     *
     * Note what the old fixture could not have been. On the real data path main
     * builds `importedEmails` from every saved contact's primary address, so an
     * external whose PRIMARY email matches a saved one never reaches this
     * component — the row was reachable only by hand-feeding it. That is the
     * same trap `contact-handlers.collapseDisclosure.test.ts` documents: a pure
     * function fed raw duplicates passes tests about a set the real path cannot
     * produce. The end-to-end behaviour is pinned against the REAL handler in
     * `electron/__tests__/contact-handlers.oneMatchingRule.test.ts`.
     */
    it("renders every row it is handed, including one sharing an email with a saved contact", () => {
      const imported = [
        createImportedContact({ id: "imp-1", display_name: "Imp One", email: "a@example.test", phone: "555-0101" }),
        createImportedContact({ id: "imp-2", display_name: "Imp Two", email: "b@example.test", phone: "555-0102" }),
      ];
      const external = [
        createExternalContact({ id: "ext-same-email", display_name: "Same Email", email: "A@EXAMPLE.TEST" }),
        createExternalContact({ id: "ext-new", display_name: "New", email: "c@example.test" }),
      ];

      render(
        <ContactSearchList {...createDefaultProps({ contacts: imported, externalContacts: external })} />
      );

      // Was: ext-same-email absent.
      expect(renderedRowIds()).toEqual(
        new Set([
          "contact-row-imp-1",
          "contact-row-imp-2",
          "contact-row-ext-same-email",
          "contact-row-ext-new",
        ]),
      );
      // No id renders twice.
      const all = screen.queryAllByTestId(/^contact-row-/).map((el) => el.getAttribute("data-testid"));
      expect(all.length).toBe(new Set(all).size);
    });

    it("renders one row for a record handed to it in BOTH arrays (exact-id only)", () => {
      // The one thing `assembleContacts` still drops, at the component level:
      // React keys must stay unique. It is not an identity judgement — the two
      // objects are the same record.
      const both = createImportedContact({ id: "dup-id", display_name: "Only Once", email: "once@example.test" });

      render(
        <ContactSearchList
          {...createDefaultProps({ contacts: [both], externalContacts: [{ ...both }] })}
        />
      );

      expect(renderedRowIds()).toEqual(new Set(["contact-row-dup-id"]));
    });

    it("stays deterministic across a silent data refresh (no dupes, no drift)", () => {
      const imported = [
        createImportedContact({ id: "a", display_name: "A", email: "a@x.com", last_communication_at: "2026-06-01T00:00:00Z" }),
        createImportedContact({ id: "b", display_name: "B", email: "b@x.com", last_communication_at: "2026-05-01T00:00:00Z" }),
      ];
      const { rerender } = render(
        <ContactSearchList {...createDefaultProps({ contacts: imported })} />
      );
      const before = screen.queryAllByTestId(/^contact-row-/).map((el) => el.getAttribute("data-testid"));

      // Silent refresh: same identities, new object refs, unchanged sort data.
      rerender(
        <ContactSearchList {...createDefaultProps({ contacts: imported.map((c) => ({ ...c })) })} />
      );
      const after = screen.queryAllByTestId(/^contact-row-/).map((el) => el.getAttribute("data-testid"));

      expect(after).toEqual(before);
      expect(after.length).toBe(new Set(after).size);
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

// ---------------------------------------------------------------------------
// BACKLOG-2355 — selection-stability: checking/importing an external contact
// must NOT reorder the list. This is the regression the frozen order fixes.
// ---------------------------------------------------------------------------
describe("ContactSearchList — order stability on select/import (BACKLOG-2355)", () => {
  /** Names of the rendered rows, in DOM order. Stable across the id swap. */
  function renderedNames(): string[] {
    return screen
      .getAllByRole("option")
      .map((el) => el.querySelector('span[data-testid^="contact-name-"]')?.textContent ?? "");
  }

  /** The rendered row whose display name is `name` (or undefined). */
  function rowByName(name: string): HTMLElement | undefined {
    return screen
      .getAllByRole("option")
      .find((el) => el.querySelector('span[data-testid^="contact-name-"]')?.textContent === name);
  }

  /**
   * Stateful harness mimicking ContactAssignmentStep: importing an external
   * contact creates a NEW DB row (fresh UUID) with a now-populated (newest)
   * recency, removes the external, and auto-selects the import — the exact
   * null->real + UUID-swap that dragged the row to the top before the fix.
   */
  function SelectionHarness(): React.ReactElement {
    const [contacts, setContacts] = useState<ExtendedContact[]>([
      createImportedContact({
        id: "imp-alice",
        display_name: "Alice",
        name: "Alice",
        email: "alice@x.com",
        last_communication_at: "2026-06-01T00:00:00Z",
      }),
      createImportedContact({
        id: "imp-bob",
        display_name: "Bob",
        name: "Bob",
        email: "bob@x.com",
        last_communication_at: "2026-05-01T00:00:00Z",
      }),
    ]);
    const [externalContacts, setExternalContacts] = useState<ExtendedContact[]>([
      createExternalContact({
        id: "ext-zoe",
        display_name: "Zoe",
        name: "Zoe",
        email: "zoe@x.com",
        last_communication_at: null, // no recency -> sorts LAST under Recent
      }),
    ]);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);

    const handleImport = async (ext: ExtendedContact): Promise<ExtendedContact> => {
      const imported: ExtendedContact = {
        ...ext,
        id: `db-${ext.id}`,
        is_message_derived: false,
        last_communication_at: "2026-12-01T00:00:00Z", // freshest -> would jump to top
      };
      setExternalContacts((prev) => prev.filter((c) => c.id !== ext.id));
      setContacts((prev) => [...prev, imported]);
      return imported;
    };

    return (
      <ContactSearchList
        contacts={contacts}
        externalContacts={externalContacts}
        selectedIds={selectedIds}
        onSelectionChange={setSelectedIds}
        onImportContact={handleImport}
      />
    );
  }

  it("keeps the exact rendered order (and the row's index) after an external contact is checked/imported", async () => {
    render(<SelectionHarness />);

    // Frozen Recent order: Alice (Jun) > Bob (May) > Zoe (null, last).
    expect(renderedNames()).toEqual(["Alice", "Bob", "Zoe"]);
    expect(rowByName("Zoe")?.getAttribute("data-selected")).toBe("false");

    // Check Zoe -> auto-import (new UUID + freshest recency).
    fireEvent.click(rowByName("Zoe")!);

    // The imported row (new id) appears and is selected.
    await waitFor(() => {
      expect(screen.getByTestId("contact-row-db-ext-zoe")).toBeInTheDocument();
    });

    // Order is UNCHANGED: Zoe stays at index 2 despite its new id and newest
    // date — no jump. (Live re-sort would have produced ["Zoe","Alice","Bob"].)
    expect(renderedNames()).toEqual(["Alice", "Bob", "Zoe"]);
    const zoeRow = rowByName("Zoe");
    expect(zoeRow).toBeDefined();
    expect(zoeRow?.getAttribute("data-selected")).toBe("true");
    expect(renderedNames().indexOf("Zoe")).toBe(2);
  });

  it("a background refresh that adds recency to the external row does not reorder it", async () => {
    // Simulates a silent refresh (contacts:external-sync-complete) that repopulates
    // externalContacts with the SAME identity but now a fresh (newest) date.
    function RefreshHarness(): React.ReactElement {
      const [externalContacts, setExternalContacts] = useState<ExtendedContact[]>([
        createExternalContact({
          id: "ext-zoe",
          display_name: "Zoe",
          name: "Zoe",
          email: "zoe@x.com",
          last_communication_at: null,
        }),
      ]);
      const contacts = [
        createImportedContact({ id: "imp-alice", display_name: "Alice", name: "Alice", email: "alice@x.com", last_communication_at: "2026-06-01T00:00:00Z" }),
        createImportedContact({ id: "imp-bob", display_name: "Bob", name: "Bob", email: "bob@x.com", last_communication_at: "2026-05-01T00:00:00Z" }),
      ];
      return (
        <>
          <button
            type="button"
            data-testid="simulate-refresh"
            onClick={() =>
              setExternalContacts([
                createExternalContact({
                  id: "ext-zoe",
                  display_name: "Zoe",
                  name: "Zoe",
                  email: "zoe@x.com",
                  last_communication_at: "2026-12-01T00:00:00Z",
                }),
              ])
            }
          />
          <ContactSearchList
            contacts={contacts}
            externalContacts={externalContacts}
            selectedIds={[]}
            onSelectionChange={jest.fn()}
          />
        </>
      );
    }

    render(<RefreshHarness />);
    expect(renderedNames()).toEqual(["Alice", "Bob", "Zoe"]);

    fireEvent.click(screen.getByTestId("simulate-refresh"));

    // Recency data arrived in the background, but the order is frozen: no jump.
    await waitFor(() => {
      expect(renderedNames()).toEqual(["Alice", "Bob", "Zoe"]);
    });
  });
});

// ---------------------------------------------------------------------------
// BACKLOG-2357 — the LATE-LOADING external case that BACKLOG-2355's freeze
// missed. externalContacts resolve a beat AFTER imported contacts (getAvailable),
// so the freeze — which snapshots orderKeys once on first data — never captured
// them: they were positioned LIVE by projectOntoOrder and jumped the instant
// their recency changed on select/import (the founder's email-only Paul/Daniel).
// Fix B additively merges late identities into the frozen order. These tests use
// EXACT rendered DOM order / indices (never bare counts).
// ---------------------------------------------------------------------------
describe("ContactSearchList — late-loading external gets a frozen slot (BACKLOG-2357)", () => {
  /** Rendered row names in DOM order (stable across the import id swap). */
  function names(): string[] {
    return screen
      .getAllByRole("option")
      .map((el) => el.querySelector('span[data-testid^="contact-name-"]')?.textContent ?? "");
  }
  function rowByName(name: string): HTMLElement | undefined {
    return screen
      .getAllByRole("option")
      .find((el) => el.querySelector('span[data-testid^="contact-name-"]')?.textContent === name);
  }

  const alice = () =>
    createImportedContact({ id: "imp-alice", display_name: "Alice", name: "Alice", email: "alice@x.com", last_communication_at: "2026-06-01T00:00:00Z" });
  const bob = () =>
    createImportedContact({ id: "imp-bob", display_name: "Bob", name: "Bob", email: "bob@x.com", last_communication_at: "2026-05-01T00:00:00Z" });

  /**
   * Imported contacts render first; externals arrive on a "load externals" click
   * (the real getAvailable-resolves-later timing). `paulDate` places email-only
   * Paul between Alice (Jun) and Bob (May); Daniel (Apr) sorts last.
   */
  function LateLoadHarness({ onImportRecency }: { onImportRecency?: string }): React.ReactElement {
    const [contacts, setContacts] = useState<ExtendedContact[]>([alice(), bob()]);
    const [externalContacts, setExternalContacts] = useState<ExtendedContact[]>([]);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);

    // Truly EMAIL-ONLY (phone undefined) — the founder's actual case. It used to
    // matter for a second reason (the factory's default shared phone would have
    // collapsed the two under the renderer dedup BACKLOG-2370 deleted); it is
    // kept as-is because the case is about the FREEZE, and changing a fixture
    // that is not under test only makes a later failure harder to read.
    const loadExternals = (): void =>
      setExternalContacts([
        createExternalContact({ id: "ext-paul", display_name: "Paul", name: "Paul", email: "paul@x.com", phone: undefined, last_communication_at: "2026-05-15T00:00:00Z" }),
        createExternalContact({ id: "ext-daniel", display_name: "Daniel", name: "Daniel", email: "daniel@x.com", phone: undefined, last_communication_at: "2026-04-15T00:00:00Z" }),
      ]);

    // Newest-date refresh for the SAME identity (would jump a non-frozen row to top).
    const refreshPaulRecency = (): void =>
      setExternalContacts((prev) =>
        prev.map((c) =>
          c.id === "ext-paul" ? { ...c, last_communication_at: "2026-12-01T00:00:00Z" } : c,
        ),
      );

    const handleImport = async (ext: ExtendedContact): Promise<ExtendedContact> => {
      const imported: ExtendedContact = {
        ...ext,
        id: `db-${ext.id}`,
        is_message_derived: false,
        // Post-Fix-A the imported twin keeps the email date; this harness flips it
        // to the NEWEST to PROVE the frozen slot holds even under a recency change.
        last_communication_at: onImportRecency ?? ext.last_communication_at ?? null,
      };
      setExternalContacts((prev) => prev.filter((c) => c.id !== ext.id));
      setContacts((prev) => [...prev, imported]);
      return imported;
    };

    return (
      <>
        <button type="button" data-testid="load-externals" onClick={loadExternals} />
        <button type="button" data-testid="refresh-paul" onClick={refreshPaulRecency} />
        <ContactSearchList
          contacts={contacts}
          externalContacts={externalContacts}
          selectedIds={selectedIds}
          onSelectionChange={setSelectedIds}
          onImportContact={handleImport}
        />
      </>
    );
  }

  it("merges a late-arriving external into the frozen order at its SORTED position", async () => {
    render(<LateLoadHarness />);
    // Imported-only first paint (externals not resolved yet).
    expect(names()).toEqual(["Alice", "Bob"]);

    fireEvent.click(screen.getByTestId("load-externals"));

    // Paul (May 15) lands BETWEEN Alice (Jun) and Bob (May 1); Daniel (Apr) last.
    await waitFor(() => {
      expect(names()).toEqual(["Alice", "Paul", "Bob", "Daniel"]);
    });
  });

  it("keeps a late-loaded email-only external at its EXACT index after select/import (Paul/Daniel)", async () => {
    // On import Paul's recency flips to the NEWEST date — a LIVE re-sort would send
    // him to the top. The frozen slot from the additive merge must hold him at idx 1.
    render(<LateLoadHarness onImportRecency="2026-12-01T00:00:00Z" />);
    fireEvent.click(screen.getByTestId("load-externals"));
    await waitFor(() => expect(names()).toEqual(["Alice", "Paul", "Bob", "Daniel"]));
    expect(names().indexOf("Paul")).toBe(1);

    // Select Paul -> auto-import (new UUID + newest recency).
    fireEvent.click(rowByName("Paul")!);
    await waitFor(() => {
      expect(screen.getByTestId("contact-row-db-ext-paul")).toBeInTheDocument();
    });

    // No jump: Paul stays at index 1 (a live re-sort would be ["Paul","Alice","Bob","Daniel"]).
    expect(names()).toEqual(["Alice", "Paul", "Bob", "Daniel"]);
    expect(names().indexOf("Paul")).toBe(1);
    expect(rowByName("Paul")?.getAttribute("data-selected")).toBe("true");
  });

  it("a background refresh AFTER the late external loaded still does NOT reorder (additive merge, not a re-freeze)", async () => {
    render(<LateLoadHarness />);
    fireEvent.click(screen.getByTestId("load-externals"));
    await waitFor(() => expect(names()).toEqual(["Alice", "Paul", "Bob", "Daniel"]));

    // Paul's recency jumps to the newest date via a silent refresh (same identity).
    fireEvent.click(screen.getByTestId("refresh-paul"));

    // Additive merge finds NO new key (Paul already frozen) -> returns the same
    // orderKeys reference -> no reorder. If Fix B had instead added contacts/
    // externalContacts to the freeze deps, this would re-sort to ["Paul", ...].
    await waitFor(() => {
      expect(names()).toEqual(["Alice", "Paul", "Bob", "Daniel"]);
    });
    expect(names().indexOf("Paul")).toBe(1);
  });
});
