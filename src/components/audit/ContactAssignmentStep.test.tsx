/**
 * Tests for ContactAssignmentStep Component
 * TASK-1766: New Audit Contact Flow (search-first pattern)
 * TASK-1771: Unified audit modal navigation (parent-controlled step)
 *
 * The component displays different content based on the parent-controlled `step` prop:
 * - Step 2: Contact selection (ContactSearchList)
 * - Step 3: Role assignment (ContactRoleRow)
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import ContactAssignmentStep from "./ContactAssignmentStep";
import type { Contact } from "../../../electron/types/models";

// Mock contactService and settingsService
jest.mock("../../services", () => ({
  contactService: {
    create: jest.fn(),
  },
  settingsService: {
    getContactAutoRoleEnabled: jest.fn().mockResolvedValue(false),
  },
}));

describe("ContactAssignmentStep", () => {
  const mockContacts: Contact[] = [
    {
      id: "contact-1",
      user_id: "user-123",
      name: "John Client",
      display_name: "John Client",
      email: "john@example.com",
      phone: "555-1234",
      company: "Homebuyer Inc",
      source: "manual",
      is_message_derived: false,
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
    },
    {
      id: "contact-2",
      user_id: "user-123",
      name: "Jane Agent",
      display_name: "Jane Agent",
      email: "jane@realty.com",
      phone: "555-5678",
      company: "Top Realty",
      source: "email",
      is_message_derived: false,
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
    },
    {
      id: "contact-3",
      user_id: "user-123",
      name: "Bob Inspector",
      display_name: "Bob Inspector",
      email: "bob@inspect.com",
      phone: "555-9012",
      company: "Home Inspections LLC",
      source: "manual",
      is_message_derived: false,
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
    },
  ];

  const defaultProps = {
    step: 2, // Step 2 = contact selection
    contactAssignments: {},
    selectedContactIds: [] as string[],
    onSelectedContactIdsChange: jest.fn(),
    onAssignContact: jest.fn(),
    onRemoveContact: jest.fn(),
    userId: "user-123",
    transactionType: "purchase",
    propertyAddress: "123 Main St",
    contacts: mockContacts,
    contactsLoading: false,
    contactsError: null,
    onRefreshContacts: jest.fn(),
    onSilentRefreshContacts: jest.fn(),
    externalContacts: [] as Contact[],
    externalContactsLoading: false,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Step 2: Contact Selection", () => {
    it("renders contact selection step when step=2", () => {
      render(<ContactAssignmentStep {...defaultProps} step={2} />);

      expect(screen.getByTestId("contact-assignment-step-2")).toBeInTheDocument();
    });

    it("displays ContactSearchList component", () => {
      render(<ContactAssignmentStep {...defaultProps} step={2} />);

      expect(screen.getByTestId("contact-search-list")).toBeInTheDocument();
    });

    it("shows all contacts in the list", () => {
      render(<ContactAssignmentStep {...defaultProps} step={2} />);

      expect(screen.getByText("John Client")).toBeInTheDocument();
      expect(screen.getByText("Jane Agent")).toBeInTheDocument();
      expect(screen.getByText("Bob Inspector")).toBeInTheDocument();
    });

    it("shows loading state when contacts are loading", () => {
      render(<ContactAssignmentStep {...defaultProps} step={2} contactsLoading={true} />);

      expect(screen.getByTestId("loading-state")).toBeInTheDocument();
    });

    it("shows error state when there is an error", () => {
      render(
        <ContactAssignmentStep
          {...defaultProps}
          step={2}
          contactsError="Failed to load contacts"
        />
      );

      expect(screen.getByTestId("error-state")).toBeInTheDocument();
    });

    it("allows deselecting a contact by clicking it again (toggle behavior)", async () => {
      const onSelectedContactIdsChange = jest.fn();
      const user = userEvent.setup();

      render(
        <ContactAssignmentStep
          {...defaultProps}
          step={2}
          selectedContactIds={["contact-1"]}
          onSelectedContactIdsChange={onSelectedContactIdsChange}
        />
      );

      // Find the selected contact row and click it to deselect
      const contactRows = screen.getAllByTestId("contact-row");
      // contact-1 (John Client) should be selected - find the row with that name
      const johnRow = contactRows.find((row) =>
        row.textContent?.includes("John Client")
      );
      expect(johnRow).toBeDefined();

      await user.click(johnRow!);

      // Should call onSelectedContactIdsChange with contact-1 removed
      expect(onSelectedContactIdsChange).toHaveBeenCalledWith([]);
    });

    it("allows selecting a contact by clicking it", async () => {
      const onSelectedContactIdsChange = jest.fn();
      const user = userEvent.setup();

      render(
        <ContactAssignmentStep
          {...defaultProps}
          step={2}
          selectedContactIds={[]}
          onSelectedContactIdsChange={onSelectedContactIdsChange}
        />
      );

      // Find John Client row and click to select
      const contactRows = screen.getAllByTestId("contact-row");
      const johnRow = contactRows.find((row) =>
        row.textContent?.includes("John Client")
      );
      expect(johnRow).toBeDefined();

      await user.click(johnRow!);

      // Should call onSelectedContactIdsChange with contact-1 added
      expect(onSelectedContactIdsChange).toHaveBeenCalledWith(["contact-1"]);
    });
  });

  // BACKLOG-2354: Source/Role filter parity. The audit-wizard (new-transaction)
  // flow passes showCategoryFilter={true}; without it the filter stays off.
  describe("Step 2: Source/Role filter (showCategoryFilter)", () => {
    it("renders the Source and Role filter when showCategoryFilter is true (ephemeral)", () => {
      render(<ContactAssignmentStep {...defaultProps} step={2} showCategoryFilter={true} />);

      expect(screen.getByTestId("source-filter")).toBeInTheDocument();
      expect(screen.getByTestId("role-filter")).toBeInTheDocument();
      // Ephemeral mode opens on the show-all default (all real sources, all
      // roles) — it does NOT pre-hide contacts. John/Bob (source "manual") are
      // visible, confirming the filter did not silently narrow the list.
      expect(screen.getByText("John Client")).toBeInTheDocument();
      expect(screen.getByText("Bob Inspector")).toBeInTheDocument();
    });

    it("does NOT render the filter by default (showCategoryFilter omitted -> off)", () => {
      render(<ContactAssignmentStep {...defaultProps} step={2} />);

      expect(screen.queryByTestId("source-filter")).not.toBeInTheDocument();
      expect(screen.queryByTestId("role-filter")).not.toBeInTheDocument();
    });
  });

  describe("Step 3: Role Assignment", () => {
    const step3Props = {
      ...defaultProps,
      step: 3,
      selectedContactIds: ["contact-1", "contact-2"],
    };

    it("renders role assignment step when step=3", () => {
      render(<ContactAssignmentStep {...step3Props} />);

      expect(screen.getByTestId("contact-assignment-step-3")).toBeInTheDocument();
    });

    it("shows selected contacts with role dropdowns", () => {
      render(<ContactAssignmentStep {...step3Props} />);

      // Should show both selected contacts (responsive layout renders mobile + desktop)
      expect(screen.getAllByText("John Client").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Jane Agent").length).toBeGreaterThan(0);
      // Bob was not selected, should not appear
      expect(screen.queryByText("Bob Inspector")).not.toBeInTheDocument();

      // Should have role dropdowns
      expect(screen.getAllByTestId("role-select-contact-1").length).toBeGreaterThan(0);
      expect(screen.getAllByTestId("role-select-contact-2").length).toBeGreaterThan(0);
    });

    it("displays assigned count", () => {
      render(<ContactAssignmentStep {...step3Props} />);

      // Initially 0 of 2 have roles assigned
      expect(screen.getByText(/0 of 2 contacts? have roles assigned/i)).toBeInTheDocument();
    });

    it("calls onAssignContact when role is selected", async () => {
      const onAssignContact = jest.fn();
      const user = userEvent.setup();

      render(
        <ContactAssignmentStep
          {...step3Props}
          onAssignContact={onAssignContact}
        />
      );

      // Select a role for John (first match from dual mobile/desktop render)
      const roleSelect = screen.getAllByTestId("role-select-contact-1")[0];
      await user.selectOptions(roleSelect, "client");

      expect(onAssignContact).toHaveBeenCalledWith(
        "client",
        "contact-1",
        expect.any(Boolean),
        expect.any(String)
      );
    });

    it("shows empty state when no contacts are selected", () => {
      render(
        <ContactAssignmentStep
          {...defaultProps}
          step={3}
          selectedContactIds={[]}
        />
      );

      expect(screen.getByText(/no contacts selected/i)).toBeInTheDocument();
    });

    it("shows remove button on each contact row in Step 3", () => {
      render(<ContactAssignmentStep {...step3Props} />);

      expect(screen.getAllByTestId("remove-contact-contact-1").length).toBeGreaterThan(0);
      expect(screen.getAllByTestId("remove-contact-contact-2").length).toBeGreaterThan(0);
    });

    it("calls onSelectedContactIdsChange when remove button is clicked", async () => {
      const onSelectedContactIdsChange = jest.fn();
      const user = userEvent.setup();

      render(
        <ContactAssignmentStep
          {...step3Props}
          onSelectedContactIdsChange={onSelectedContactIdsChange}
        />
      );

      // Click remove on contact-1 (first match from dual layout)
      const removeBtn = screen.getAllByTestId("remove-contact-contact-1")[0];
      await user.click(removeBtn);

      // Should remove contact-1 from selectedContactIds
      expect(onSelectedContactIdsChange).toHaveBeenCalledWith(["contact-2"]);
    });

    it("calls onRemoveContact to clear role assignment when removing a contact with a role", async () => {
      const onRemoveContact = jest.fn();
      const user = userEvent.setup();

      render(
        <ContactAssignmentStep
          {...step3Props}
          contactAssignments={{
            buyer: [{ contactId: "contact-1", isPrimary: false, notes: "" }],
          }}
          onRemoveContact={onRemoveContact}
        />
      );

      // Click remove on contact-1 (which has the buyer role)
      const removeBtn = screen.getAllByTestId("remove-contact-contact-1")[0];
      await user.click(removeBtn);

      // Should call onRemoveContact to clear the buyer role assignment
      expect(onRemoveContact).toHaveBeenCalledWith("buyer", "contact-1");
    });
  });

  describe("Search functionality", () => {
    it("filters contacts when searching", async () => {
      const user = userEvent.setup();
      render(<ContactAssignmentStep {...defaultProps} step={2} />);

      const searchInput = screen.getByPlaceholderText(/search contacts/i);
      await user.type(searchInput, "John");

      await waitFor(() => {
        expect(screen.getByText("John Client")).toBeInTheDocument();
        expect(screen.queryByText("Jane Agent")).not.toBeInTheDocument();
      });
    });

    it("shows all contacts when search is cleared", async () => {
      const user = userEvent.setup();
      render(<ContactAssignmentStep {...defaultProps} step={2} />);

      const searchInput = screen.getByPlaceholderText(/search contacts/i);
      await user.type(searchInput, "John");
      await user.clear(searchInput);

      await waitFor(() => {
        expect(screen.getByText("John Client")).toBeInTheDocument();
        expect(screen.getByText("Jane Agent")).toBeInTheDocument();
        expect(screen.getByText("Bob Inspector")).toBeInTheDocument();
      });
    });
  });

  describe("Empty states", () => {
    it("shows empty state when no contacts are available", () => {
      render(
        <ContactAssignmentStep
          {...defaultProps}
          step={2}
          contacts={[]}
        />
      );

      expect(screen.getByTestId("empty-state")).toBeInTheDocument();
    });
  });
});
