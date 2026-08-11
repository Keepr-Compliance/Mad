/**
 * EditContactsModal Component Tests
 *
 * Tests for the 2-screen EditContactsModal flow:
 * - Screen 1: Assigned contacts with role dropdowns
 * - Screen 2: Add contacts overlay
 *
 * @see TASK-1765: EditContactsModal 2-Screen Flow Redesign
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditContactsModal, EditContactsModalProps } from "./EditContactsModal";
import type { Transaction } from "@/types";
import type { ExtendedContact } from "../../../../types/components";

// Mock window.api
const mockGetDetails = jest.fn();
const mockBatchUpdateContacts = jest.fn();

beforeAll(() => {
  (window as unknown as { api: unknown }).api = {
    transactions: {
      getDetails: mockGetDetails,
      batchUpdateContacts: mockBatchUpdateContacts,
    },
  };
});

// Mock ContactsContext
// Use source: "contacts_app" to mark as imported (not message-derived)
// This ensures contacts show by default with the category filter
const mockContacts: ExtendedContact[] = [
  {
    id: "contact-1",
    name: "John Smith",
    display_name: "John Smith",
    email: "john@example.com",
    user_id: "user-1",
    source: "contacts_app",
    created_at: "2024-01-01",
    updated_at: "2024-01-01",
  },
  {
    id: "contact-2",
    name: "Jane Doe",
    display_name: "Jane Doe",
    email: "jane@example.com",
    user_id: "user-1",
    source: "contacts_app",
    created_at: "2024-01-01",
    updated_at: "2024-01-01",
  },
  {
    id: "contact-3",
    name: "Bob Wilson",
    display_name: "Bob Wilson",
    email: "bob@example.com",
    user_id: "user-1",
    source: "contacts_app",
    created_at: "2024-01-01",
    updated_at: "2024-01-01",
  },
];

jest.mock("../../../../contexts/ContactsContext", () => ({
  ContactsProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  useContacts: () => ({
    contacts: mockContacts,
    loading: false,
    error: null,
    refreshContacts: jest.fn(),
    // BACKLOG-2631: the provider carries the address-book half and the shared
    // both-halves refresh now. `Screen2Overlay` calls `triggerLazyLoad` on mount,
    // so a mock without it throws before this suite's subject renders.
    refreshBothLists: jest.fn().mockResolvedValue(undefined),
    externalContacts: [],
    externalContactsLoading: false,
    triggerLazyLoad: jest.fn(),
  }),
}));

// Mock ContactSearchList. Models the real component's "add" selection mode
// (BACKLOG-2400/2405): a selected contact DROPS OUT of the "Available" list (it
// has moved to the Added column), so search-contact-<id> is not rendered for it.
jest.mock("../../../shared/ContactSearchList", () => ({
  ContactSearchList: ({
    contacts,
    selectedIds,
    onSelectionChange,
    selectionMode = "checkbox",
    className,
  }: {
    contacts: ExtendedContact[];
    selectedIds: string[];
    onSelectionChange: (ids: string[]) => void;
    selectionMode?: "checkbox" | "add";
    className?: string;
  }) => (
    <div data-testid="contact-search-list" className={className}>
      {contacts
        .filter((contact) => selectionMode !== "add" || !selectedIds.includes(contact.id))
        .map((contact) => (
          <div
            key={contact.id}
            data-testid={`search-contact-${contact.id}`}
            onClick={() => {
              const newIds = selectedIds.includes(contact.id)
                ? selectedIds.filter((id) => id !== contact.id)
                : [...selectedIds, contact.id];
              onSelectionChange(newIds);
            }}
          >
            <input
              type="checkbox"
              checked={selectedIds.includes(contact.id)}
              readOnly
              data-testid={`search-checkbox-${contact.id}`}
            />
            <span>{contact.display_name}</span>
          </div>
        ))}
    </div>
  ),
}));

// Mock ContactRoleRow.
//
// BACKLOG-2567 — READ THIS BEFORE ASSERTING ANYTHING ABOUT THE ROW'S CHROME.
// This stub renders ONLY a name and a <select>. It has never rendered the
// "(Auto)" badge, so NO assertion in this suite can observe whether the real
// component still shows it: a "badge is gone" test here would pass against the
// mock and prove nothing. That coverage lives in ContactRoleRow.test.tsx,
// against the real component, and it must stay there.
//
// What this suite CAN still prove is the behaviour the founder kept — that a
// role is assigned automatically — because the mock's value is driven by the
// parent's `roleAssignments` state. See "auto-assignment survives" below.
jest.mock("../../../shared/ContactRoleRow", () => ({
  ContactRoleRow: ({
    contact,
    currentRole,
    roleOptions,
    onRoleChange,
  }: {
    contact: ExtendedContact;
    currentRole: string;
    roleOptions: Array<{ value: string; label: string }>;
    onRoleChange: (role: string) => void;
  }) => (
    <div data-testid={`contact-role-row-${contact.id}`}>
      <span data-testid={`contact-name-${contact.id}`}>
        {contact.display_name}
      </span>
      <select
        data-testid={`role-select-${contact.id}`}
        value={currentRole}
        onChange={(e) => onRoleChange(e.target.value)}
      >
        <option value="">Select role...</option>
        {roleOptions.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  ),
}));

// Mock contactService and settingsService
jest.mock("../../../../services", () => ({
  contactService: {
    create: jest.fn().mockResolvedValue({
      success: true,
      data: {
        id: "new-contact-1",
        name: "New Contact",
        display_name: "New Contact",
        email: "new@example.com",
        user_id: "user-1",
        source: "manual",
      },
    }),
  },
  settingsService: {
    getContactAutoRoleEnabled: jest.fn().mockResolvedValue(false),
  },
}));

jest.mock("../../../../contexts/NetworkContext", () => ({
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

// Test transaction factory
const createTestTransaction = (
  overrides: Partial<Transaction> = {}
): Transaction =>
  ({
    id: "txn-1",
    user_id: "user-1",
    property_address: "123 Main St",
    transaction_type: "purchase",
    status: "active",
    created_at: "2024-01-01",
    updated_at: "2024-01-01",
    ...overrides,
  }) as Transaction;

// Default props factory
const createDefaultProps = (
  overrides: Partial<EditContactsModalProps> = {}
): EditContactsModalProps => ({
  transaction: createTestTransaction(),
  userId: "user-1",
  onClose: jest.fn(),
  onSave: jest.fn(),
  ...overrides,
});

describe("EditContactsModal", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default mock: no existing assignments
    mockGetDetails.mockResolvedValue({
      success: true,
      transaction: {
        contact_assignments: [],
      },
    });
    mockBatchUpdateContacts.mockResolvedValue({
      success: true,
      autoLinkResults: [],
    });
  });

  describe("Screen 1: Assigned Contacts View", () => {
    it("renders loading state initially", () => {
      render(<EditContactsModal {...createDefaultProps()} />);

      expect(screen.getByText("Loading contacts...")).toBeInTheDocument();
    });

    it("renders modal header with correct title", async () => {
      render(<EditContactsModal {...createDefaultProps()} />);

      await waitFor(() => {
        expect(
          screen.getByText("Edit Transaction Contacts")
        ).toBeInTheDocument();
      });
    });

    it("shows empty state when no contacts assigned", async () => {
      render(<EditContactsModal {...createDefaultProps()} />);

      await waitFor(() => {
        expect(screen.getByTestId("empty-assigned-state")).toBeInTheDocument();
      });
      expect(screen.getByText("No contacts assigned")).toBeInTheDocument();
      expect(
        screen.getByText(/Click "Add Contacts" to get started/)
      ).toBeInTheDocument();
    });

    it("displays assigned contacts with role dropdowns", async () => {
      mockGetDetails.mockResolvedValue({
        success: true,
        transaction: {
          contact_assignments: [
            {
              id: "assign-1",
              contact_id: "contact-1",
              contact_name: "John Smith",
              role: "client",
            },
          ],
        },
      });

      render(<EditContactsModal {...createDefaultProps()} />);

      await waitFor(() => {
        expect(
          screen.getByTestId("contact-role-row-contact-1")
        ).toBeInTheDocument();
      });
      expect(screen.getByTestId("role-select-contact-1")).toHaveValue("client");
    });

    it("shows count of assigned contacts", async () => {
      mockGetDetails.mockResolvedValue({
        success: true,
        transaction: {
          contact_assignments: [
            { id: "a1", contact_id: "contact-1", role: "client" },
            { id: "a2", contact_id: "contact-2", role: "inspector" },
          ],
        },
      });

      render(<EditContactsModal {...createDefaultProps()} />);

      await waitFor(() => {
        expect(screen.getByText("2 contacts assigned")).toBeInTheDocument();
      });
    });

    it("updates role when dropdown changed", async () => {
      mockGetDetails.mockResolvedValue({
        success: true,
        transaction: {
          contact_assignments: [
            { id: "a1", contact_id: "contact-1", role: "client" },
          ],
        },
      });

      const user = userEvent.setup();
      render(<EditContactsModal {...createDefaultProps()} />);

      await waitFor(() => {
        expect(screen.getByTestId("role-select-contact-1")).toBeInTheDocument();
      });

      const select = screen.getByTestId("role-select-contact-1");
      await user.selectOptions(select, "inspector");

      expect(select).toHaveValue("inspector");
    });

    it('shows "Add Contacts" button when contacts are assigned', async () => {
      mockGetDetails.mockResolvedValue({
        success: true,
        transaction: {
          contact_assignments: [
            { id: "a1", contact_id: "contact-1", role: "client" },
          ],
        },
      });

      render(<EditContactsModal {...createDefaultProps()} />);

      await waitFor(() => {
        expect(screen.getByTestId("add-contacts-button")).toBeInTheDocument();
      });
    });
  });

  describe("Screen 2: Add Contacts Modal", () => {
    it('opens when "Add Contacts" button clicked', async () => {
      mockGetDetails.mockResolvedValue({
        success: true,
        transaction: {
          contact_assignments: [
            { id: "a1", contact_id: "contact-1", role: "client" },
          ],
        },
      });

      const user = userEvent.setup();
      render(<EditContactsModal {...createDefaultProps()} />);

      await waitFor(() => {
        expect(screen.getByTestId("add-contacts-button")).toBeInTheDocument();
      });

      await user.click(screen.getByTestId("add-contacts-button"));

      expect(screen.getByTestId("add-contacts-overlay")).toBeInTheDocument();
    });

    it("opens from empty state button", async () => {
      const user = userEvent.setup();
      render(<EditContactsModal {...createDefaultProps()} />);

      await waitFor(() => {
        expect(
          screen.getByTestId("empty-state-add-button")
        ).toBeInTheDocument();
      });

      await user.click(screen.getByTestId("empty-state-add-button"));

      expect(screen.getByTestId("add-contacts-overlay")).toBeInTheDocument();
    });

    it("shows ContactSearchList component", async () => {
      const user = userEvent.setup();
      render(<EditContactsModal {...createDefaultProps()} />);

      await waitFor(() => {
        expect(screen.getByTestId("empty-state-add-button")).toBeInTheDocument();
      });

      await user.click(screen.getByTestId("empty-state-add-button"));

      expect(screen.getByTestId("contact-search-list")).toBeInTheDocument();
    });

    it("filters out already assigned contacts", async () => {
      mockGetDetails.mockResolvedValue({
        success: true,
        transaction: {
          contact_assignments: [
            { id: "a1", contact_id: "contact-1", role: "client" },
          ],
        },
      });

      const user = userEvent.setup();
      render(<EditContactsModal {...createDefaultProps()} />);

      await waitFor(() => {
        expect(screen.getByTestId("add-contacts-button")).toBeInTheDocument();
      });

      await user.click(screen.getByTestId("add-contacts-button"));

      // contact-1 is assigned, so should not appear in search list
      expect(
        screen.queryByTestId("search-contact-contact-1")
      ).not.toBeInTheDocument();
      // contact-2 and contact-3 are not assigned, so should appear
      expect(
        screen.getByTestId("search-contact-contact-2")
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("search-contact-contact-3")
      ).toBeInTheDocument();
    });

    it('closes when X button clicked', async () => {
      const user = userEvent.setup();
      render(<EditContactsModal {...createDefaultProps()} />);

      await waitFor(() => {
        expect(screen.getByTestId("empty-state-add-button")).toBeInTheDocument();
      });

      await user.click(screen.getByTestId("empty-state-add-button"));
      expect(screen.getByTestId("add-contacts-overlay")).toBeInTheDocument();

      await user.click(screen.getByTestId("add-contacts-overlay-close"));

      expect(
        screen.queryByTestId("add-contacts-overlay")
      ).not.toBeInTheDocument();
    });

    // Note: "Add Selected" tests removed - SPRINT-066 UX redesign changed to direct-add pattern
    // Contacts are now added by clicking the "+" import button, not multi-select + "Add Selected"
  });

  describe("integration", () => {
    // Note: "added contacts appear in Screen 1" and "save generates correct add operations"
    // tests removed - SPRINT-066 UX redesign changed from multi-select + "Add Selected"
    // to direct-add via "+" import button. The flow no longer uses add-selected-button.

    it("save generates correct remove operations", async () => {
      mockGetDetails.mockResolvedValue({
        success: true,
        transaction: {
          contact_assignments: [
            { id: "a1", contact_id: "contact-1", role: "client" },
          ],
        },
      });

      const user = userEvent.setup();
      render(<EditContactsModal {...createDefaultProps()} />);

      await waitFor(() => {
        expect(screen.getByTestId("role-select-contact-1")).toBeInTheDocument();
      });

      // Change role from client to something else (removing original role)
      const select = screen.getByTestId("role-select-contact-1");
      await user.selectOptions(select, "inspector");

      // Save
      await user.click(screen.getByTestId("edit-contacts-modal-save"));

      await waitFor(() => {
        expect(mockBatchUpdateContacts).toHaveBeenCalledWith(
          "txn-1",
          expect.arrayContaining([
            expect.objectContaining({
              action: "remove",
              contactId: "contact-1",
              role: "client",
            }),
            expect.objectContaining({
              action: "add",
              contactId: "contact-1",
              role: "inspector",
            }),
          ])
        );
      });
    });

    // BACKLOG-2405: the two-pane "Added" column pre-populates the deal's existing
    // contacts (removable there), and existing contacts are excluded from
    // Available. Removing an existing chip queues an unlink-on-Save; new adds must
    // not re-add the pre-existing ones.
    describe("pre-populated existing contacts (BACKLOG-2405)", () => {
      const withAssignedContact1 = () =>
        mockGetDetails.mockResolvedValue({
          success: true,
          transaction: {
            contact_assignments: [
              { id: "a1", contact_id: "contact-1", role: "client" },
            ],
          },
        });

      it("shows the deal's existing contact as an Added chip and excludes it from Available", async () => {
        withAssignedContact1();
        const user = userEvent.setup();
        render(<EditContactsModal {...createDefaultProps()} />);

        await waitFor(() => {
          expect(screen.getByTestId("add-contacts-button")).toBeInTheDocument();
        });
        await user.click(screen.getByTestId("add-contacts-button"));

        // Pre-populated Added chip for the existing contact...
        expect(screen.getByTestId("added-chip-contact-1")).toBeInTheDocument();
        // ...and it is NOT offered in Available, while the unassigned ones are.
        expect(screen.queryByTestId("search-contact-contact-1")).not.toBeInTheDocument();
        expect(screen.getByTestId("search-contact-contact-2")).toBeInTheDocument();
        expect(screen.getByTestId("search-contact-contact-3")).toBeInTheDocument();
      });

      it("✕ on an existing chip queues an unlink-on-Save (remove op) and never re-adds it", async () => {
        withAssignedContact1();
        const user = userEvent.setup();
        render(<EditContactsModal {...createDefaultProps()} />);

        await waitFor(() => {
          expect(screen.getByTestId("add-contacts-button")).toBeInTheDocument();
        });
        await user.click(screen.getByTestId("add-contacts-button"));

        // Remove the existing contact via its Added chip ✕.
        await user.click(screen.getByTestId("remove-added-contact-1"));
        expect(screen.queryByTestId("added-chip-contact-1")).not.toBeInTheDocument();

        // Close the overlay and Save.
        await user.click(screen.getByTestId("add-contacts-overlay-close"));
        await waitFor(() => {
          expect(screen.getByTestId("edit-contacts-modal-save")).toBeInTheDocument();
        });
        await user.click(screen.getByTestId("edit-contacts-modal-save"));

        await waitFor(() => {
          expect(mockBatchUpdateContacts).toHaveBeenCalled();
        });
        const ops = mockBatchUpdateContacts.mock.calls[0][1] as Array<{
          action: string;
          contactId: string;
          role?: string;
        }>;
        // Exactly an unlink for contact-1, and NOT a re-add of it.
        expect(
          ops.some((o) => o.action === "remove" && o.contactId === "contact-1")
        ).toBe(true);
        expect(
          ops.some((o) => o.action === "add" && o.contactId === "contact-1")
        ).toBe(false);
      });

      it("adds only the NEW selection when an existing contact is pre-populated (no double-add)", async () => {
        withAssignedContact1();
        const user = userEvent.setup();
        render(<EditContactsModal {...createDefaultProps()} />);

        await waitFor(() => {
          expect(screen.getByTestId("add-contacts-button")).toBeInTheDocument();
        });
        await user.click(screen.getByTestId("add-contacts-button"));

        // Add a brand-new (unassigned) contact.
        await user.click(screen.getByTestId("search-contact-contact-2"));
        await user.click(screen.getByTestId("add-selected-button"));

        // Back on Screen 1, Save.
        await waitFor(() => {
          expect(screen.getByTestId("edit-contacts-modal-save")).toBeInTheDocument();
        });
        await user.click(screen.getByTestId("edit-contacts-modal-save"));

        await waitFor(() => {
          expect(mockBatchUpdateContacts).toHaveBeenCalled();
        });
        const ops = mockBatchUpdateContacts.mock.calls[0][1] as Array<{
          action: string;
          contactId: string;
        }>;
        // The new contact is added; the pre-existing one is NOT re-added and NOT removed.
        expect(ops.some((o) => o.action === "add" && o.contactId === "contact-2")).toBe(true);
        expect(ops.some((o) => o.action === "add" && o.contactId === "contact-1")).toBe(false);
        expect(ops.some((o) => o.action === "remove" && o.contactId === "contact-1")).toBe(false);
      });
    });

    it("cancel calls onClose without saving", async () => {
      const onClose = jest.fn();
      const onSave = jest.fn();
      const user = userEvent.setup();

      render(
        <EditContactsModal {...createDefaultProps({ onClose, onSave })} />
      );

      await waitFor(() => {
        expect(
          screen.getByTestId("edit-contacts-modal-cancel")
        ).toBeInTheDocument();
      });

      await user.click(screen.getByTestId("edit-contacts-modal-cancel"));

      expect(onClose).toHaveBeenCalled();
      expect(onSave).not.toHaveBeenCalled();
      expect(mockBatchUpdateContacts).not.toHaveBeenCalled();
    });
  });

  describe("loading and errors", () => {
    it("shows loading state while fetching contacts", () => {
      // Don't resolve the promise immediately
      mockGetDetails.mockImplementation(
        () => new Promise(() => {})
      );

      render(<EditContactsModal {...createDefaultProps()} />);

      expect(screen.getByText("Loading contacts...")).toBeInTheDocument();
    });

    it("shows error message on load failure", async () => {
      mockGetDetails.mockRejectedValue(new Error("Network error"));

      render(<EditContactsModal {...createDefaultProps()} />);

      await waitFor(() => {
        expect(screen.getByText("Failed to load contacts")).toBeInTheDocument();
      });
    });

    it("shows error message on save failure", async () => {
      mockGetDetails.mockResolvedValue({
        success: true,
        transaction: {
          contact_assignments: [
            { id: "a1", contact_id: "contact-1", role: "client" },
          ],
        },
      });
      mockBatchUpdateContacts.mockResolvedValue({
        success: false,
        error: "Save failed",
      });

      const user = userEvent.setup();
      render(<EditContactsModal {...createDefaultProps()} />);

      await waitFor(() => {
        expect(screen.getByTestId("role-select-contact-1")).toBeInTheDocument();
      });

      // Change role to trigger save operation
      const select = screen.getByTestId("role-select-contact-1");
      await user.selectOptions(select, "inspector");

      await user.click(screen.getByTestId("edit-contacts-modal-save"));

      await waitFor(() => {
        expect(screen.getByText("Save failed")).toBeInTheDocument();
      });
    });

    it('shows "Saving..." while save in progress', async () => {
      mockGetDetails.mockResolvedValue({
        success: true,
        transaction: {
          contact_assignments: [
            { id: "a1", contact_id: "contact-1", role: "client" },
          ],
        },
      });
      // Delay the save response
      mockBatchUpdateContacts.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ success: true }), 100)
          )
      );

      const user = userEvent.setup();
      render(<EditContactsModal {...createDefaultProps()} />);

      await waitFor(() => {
        expect(screen.getByTestId("role-select-contact-1")).toBeInTheDocument();
      });

      // Change role
      const select = screen.getByTestId("role-select-contact-1");
      await user.selectOptions(select, "inspector");

      // Click save
      await user.click(screen.getByTestId("edit-contacts-modal-save"));

      expect(screen.getByTestId("edit-contacts-modal-save")).toHaveTextContent(
        "Saving..."
      );
      expect(screen.getByTestId("edit-contacts-modal-save")).toBeDisabled();
    });
  });

  describe("close button", () => {
    it("closes modal when header X button clicked", async () => {
      const onClose = jest.fn();
      const user = userEvent.setup();

      render(<EditContactsModal {...createDefaultProps({ onClose })} />);

      await waitFor(() => {
        expect(
          screen.getByTestId("edit-contacts-modal-close")
        ).toBeInTheDocument();
      });

      await user.click(screen.getByTestId("edit-contacts-modal-close"));

      expect(onClose).toHaveBeenCalled();
    });
  });
  /**
   * BACKLOG-2567 — the auto-ASSIGNMENT survives the removal of the "(Auto)"
   * LABEL. The founder was explicit: "keep the auto assignment of role
   * functionality i just don't want it to say auto."
   *
   * This is the control for the risky half of that change. Removing the badge
   * meant deleting `autoFilledContactIds` bookkeeping that sat DIRECTLY BESIDE
   * two live statements — `setRoleAssignments` in `handleAutoFillForContact`,
   * and `onRoleAssignmentsChange` in `handleRoleChange`. A careless deletion
   * that took a neighbouring line with it would not have been caught by any
   * badge test, because a missing role is not a missing badge.
   *
   * Before this suite existed no test referenced the auto-fill path at all
   * (grep for default_role / autoRole here returned zero hits), so that
   * behaviour was entirely unverified.
   */
  describe("BACKLOG-2567: auto-assignment survives the badge removal", () => {
    it("gives a newly added contact a role automatically", async () => {
      // C2 — controls `setRoleAssignments` inside handleAutoFillForContact.
      // Revert that call and this goes red: the new contact's role stays "".
      //
      // One contact is pre-assigned so the toolbar "Add Contacts" button is
      // present (the empty state offers a different button); contact-2 is the
      // one being newly added, and its role is what this asserts.
      mockGetDetails.mockResolvedValue({
        success: true,
        transaction: {
          contact_assignments: [
            { id: "a1", contact_id: "contact-1", role: "client" },
          ],
        },
      });

      const user = userEvent.setup();
      render(<EditContactsModal {...createDefaultProps()} />);

      await waitFor(() => {
        expect(screen.getByTestId("add-contacts-button")).toBeInTheDocument();
      });
      await user.click(screen.getByTestId("add-contacts-button"));
      await user.click(screen.getByTestId("search-contact-contact-2"));
      // "Add Selected" is what commits the addition (handleAddSelected ->
      // onAddContact -> handleAutoFillForContact) and returns to screen 1.
      // The Back button dismisses WITHOUT adding.
      await user.click(screen.getByTestId("add-selected-button"));

      await waitFor(() => {
        expect(screen.getByTestId("role-select-contact-2")).toBeInTheDocument();
      });

      // The role is filled in without the user choosing one. Asserted as "not
      // empty" AND as the exact baseline value, so neither a blank nor a
      // silently changed default can pass.
      const select = screen.getByTestId("role-select-contact-2");
      expect(select).not.toHaveValue("");
      expect(select).toHaveValue("client");
    });

    it("keeps a manual role change sticking", async () => {
      // C2b — controls `onRoleAssignmentsChange(newAssignments)` in
      // handleRoleChange, the OTHER live statement the badge deletion sat next
      // to. Revert that call and this goes red: the select snaps back.
      mockGetDetails.mockResolvedValue({
        success: true,
        transaction: {
          contact_assignments: [
            { id: "a1", contact_id: "contact-1", role: "client" },
          ],
        },
      });

      const user = userEvent.setup();
      render(<EditContactsModal {...createDefaultProps()} />);

      await waitFor(() => {
        expect(screen.getByTestId("role-select-contact-1")).toBeInTheDocument();
      });

      const select = screen.getByTestId("role-select-contact-1");
      await user.selectOptions(select, "inspector");

      expect(select).toHaveValue("inspector");
    });
  });
});
