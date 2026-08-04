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
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import ContactAssignmentStep from "./ContactAssignmentStep";
import type { Contact, ContactSource } from "../../../electron/types/models";

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

    it("allows selecting a contact by clicking its row", async () => {
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

  // BACKLOG-2400: Step 2 is a two-pane — LEFT "Available" (ContactSearchList in
  // "add" mode) and RIGHT "Added (N)" chips driven SOLELY by selectedContactIds.
  describe("Step 2: two-pane Available | Added (BACKLOG-2400)", () => {
    it("renders both the Available list and the Added column", () => {
      render(<ContactAssignmentStep {...defaultProps} step={2} />);

      expect(screen.getByTestId("contact-search-list")).toBeInTheDocument();
      expect(screen.getByTestId("contact-assignment-added-pane")).toBeInTheDocument();
    });

    it("shows a + Add affordance per available row and no selection checkboxes", () => {
      render(<ContactAssignmentStep {...defaultProps} step={2} />);

      // Add mode replaces the checkbox with a "+ Add" button on every row.
      expect(screen.queryByTestId("contact-row-checkbox")).not.toBeInTheDocument();
      expect(screen.getAllByTestId("contact-row-add-button")).toHaveLength(3);
    });

    it("+ Add moves a contact into the selection", async () => {
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

      const johnRow = screen
        .getAllByTestId("contact-row")
        .find((row) => row.textContent?.includes("John Client"))!;
      await user.click(within(johnRow).getByTestId("contact-row-add-button"));

      expect(onSelectedContactIdsChange).toHaveBeenCalledWith(["contact-1"]);
    });

    it("the Added column reflects EXACTLY selectedContactIds; those rows drop out of Available", () => {
      render(
        <ContactAssignmentStep
          {...defaultProps}
          step={2}
          selectedContactIds={["contact-1", "contact-3"]}
        />
      );

      // Right column: exactly contact-1 and contact-3 as chips, count = 2.
      expect(screen.getByTestId("added-chip-contact-1")).toBeInTheDocument();
      expect(screen.getByTestId("added-chip-contact-3")).toBeInTheDocument();
      expect(screen.queryByTestId("added-chip-contact-2")).not.toBeInTheDocument();
      expect(screen.getByTestId("added-count")).toHaveTextContent("2");

      // Left column: the two added contacts are gone; the unselected one remains.
      const availableNames = screen
        .getAllByTestId("contact-row")
        .map((row) => row.textContent || "");
      expect(availableNames.some((n) => n.includes("Jane Agent"))).toBe(true);
      expect(availableNames.some((n) => n.includes("John Client"))).toBe(false);
      expect(availableNames.some((n) => n.includes("Bob Inspector"))).toBe(false);
    });

    it("✕ on an Added chip deselects the contact (returns it to Available)", async () => {
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

      // contact-1 is a chip on the right, NOT a row on the left.
      expect(screen.getByTestId("added-chip-contact-1")).toBeInTheDocument();
      const johnRow = screen
        .queryAllByTestId("contact-row")
        .find((row) => row.textContent?.includes("John Client"));
      expect(johnRow).toBeUndefined();

      await user.click(screen.getByTestId("remove-added-contact-1"));

      expect(onSelectedContactIdsChange).toHaveBeenCalledWith([]);
    });

    it("cannot desync: with a selection, the contact is a chip and never also a checked row", () => {
      render(
        <ContactAssignmentStep
          {...defaultProps}
          step={2}
          selectedContactIds={["contact-2"]}
        />
      );

      // Exactly one representation of contact-2: the Added chip. It is absent
      // from Available, so there is no second (row) source that could drift.
      expect(screen.getByTestId("added-chip-contact-2")).toBeInTheDocument();
      const janeRow = screen
        .queryAllByTestId("contact-row")
        .find((row) => row.textContent?.includes("Jane Agent"));
      expect(janeRow).toBeUndefined();
      // No selection checkboxes exist at all in add mode.
      expect(screen.queryByTestId("contact-row-checkbox")).not.toBeInTheDocument();
    });

    it("shows an empty-Added hint when nothing is selected", () => {
      render(<ContactAssignmentStep {...defaultProps} step={2} selectedContactIds={[]} />);

      expect(screen.getByTestId("added-empty")).toBeInTheDocument();
      expect(screen.getByTestId("added-count")).toHaveTextContent("0");
    });
  });

  // BACKLOG-2400 founder-QA fix: adding an EXTERNAL (not-yet-imported) contact
  // imports it to a NEW db id; the row still on screen is the external twin with
  // its OLD id. It must leave Available immediately (not show in BOTH places),
  // even when imported<->external cannot be bridged by identity dedup (phone-only
  // / message-derived). These use a STATEFUL harness so selection updates
  // propagate — exercising the real click -> import -> re-render cycle a static
  // selectedContactIds prop would miss.
  describe("Step 2: external-twin add (BACKLOG-2400 founder-QA fix)", () => {
    // Phone-only external contact: no email, so the imported copy below (which we
    // give NO email/phone) cannot be deduped against it — forcing the pure
    // id-based exclusion path that the founder's bug exposed.
    const phoneOnlyExternal: Contact = {
      id: "ext-1",
      user_id: "user-123",
      name: "Paul Phone",
      display_name: "Paul Phone",
      email: undefined,
      phone: "555-0001",
      company: undefined,
      // "imessage" is not a member of ContactSource (the union has "messages" /
      // "sms" / "iphone"). Kept verbatim because getSourceBadge() falls back to the
      // "Manual" badge for unknown values, so renaming it would change what this
      // test renders. See the report on this fixture.
      source: "imessage" as unknown as ContactSource,
      is_message_derived: true,
      created_at: "2024-02-01T00:00:00Z",
      updated_at: "2024-02-01T00:00:00Z",
    };

    function Harness({
      externalContacts = [phoneOnlyExternal],
      initialSelected = [] as string[],
    }: {
      externalContacts?: Contact[];
      initialSelected?: string[];
    }): React.ReactElement {
      const [selected, setSelected] = React.useState<string[]>(initialSelected);
      return (
        <ContactAssignmentStep
          {...defaultProps}
          step={2}
          selectedContactIds={selected}
          onSelectedContactIdsChange={setSelected}
          externalContacts={externalContacts}
          onSilentRefreshContacts={jest.fn().mockResolvedValue(undefined)}
        />
      );
    }

    const availableNames = (): string[] =>
      screen.queryAllByTestId("contact-row").map((r) => r.textContent || "");

    it("moves an external contact out of Available and shows it as exactly one Added chip; ✕ restores it (imported id ≠ external id, no shared email)", async () => {
      const { contactService } = jest.requireMock("../../services");
      // Imported result carries a DIFFERENT id and (deliberately) no email/phone.
      // The renderer's identity dedup could not have bridged it to the external
      // twin even when it existed, and BACKLOG-2370 has since removed that pass
      // entirely — so the explicit `importedTwins` link is the ONLY thing that
      // hides the twin, which is exactly what this case pins. On the pre-fix code
      // the twin survived in Available while its chip also showed — "in both
      // places". The fix hides it by its own id.
      contactService.create.mockResolvedValue({
        success: true,
        data: {
          id: "db-1",
          user_id: "user-123",
          name: "Paul Phone",
          display_name: "Paul Phone",
          email: null,
          phone: null,
          source: "imessage",
          is_message_derived: false,
          created_at: "2024-02-01T00:00:00Z",
          updated_at: "2024-02-01T00:00:00Z",
        },
      });

      const user = userEvent.setup();
      render(<Harness />);

      // Precondition: the external contact is in Available.
      expect(availableNames().some((n) => n.includes("Paul Phone"))).toBe(true);

      // Add it via its row's "+ Add".
      const paulRow = screen
        .getAllByTestId("contact-row")
        .find((r) => r.textContent?.includes("Paul Phone"))!;
      await user.click(within(paulRow).getByTestId("contact-row-add-button"));

      // After import: exactly one Added chip (the imported db id), count 1, and
      // the external twin has LEFT Available — not shown in both places.
      await waitFor(() => {
        expect(screen.getByTestId("added-chip-db-1")).toBeInTheDocument();
      });
      expect(screen.getByTestId("added-count")).toHaveTextContent("1");
      expect(availableNames().some((n) => n.includes("Paul Phone"))).toBe(false);
      // The external id is never itself a chip — the chip is the imported id only.
      expect(screen.queryByTestId("added-chip-ext-1")).not.toBeInTheDocument();

      // ✕ on the chip returns the external contact to Available.
      await user.click(screen.getByTestId("remove-added-db-1"));
      await waitFor(() => {
        expect(availableNames().some((n) => n.includes("Paul Phone"))).toBe(true);
      });
      expect(screen.queryByTestId("added-chip-db-1")).not.toBeInTheDocument();
    });

    it("keeps the imported-contact path working: + Add moves an imported contact to Added, ✕ restores it", async () => {
      const user = userEvent.setup();
      render(<Harness externalContacts={[]} />);

      const johnRow = screen
        .getAllByTestId("contact-row")
        .find((r) => r.textContent?.includes("John Client"))!;
      await user.click(within(johnRow).getByTestId("contact-row-add-button"));

      await waitFor(() => {
        expect(screen.getByTestId("added-chip-contact-1")).toBeInTheDocument();
      });
      expect(availableNames().some((n) => n.includes("John Client"))).toBe(false);

      await user.click(screen.getByTestId("remove-added-contact-1"));
      await waitFor(() => {
        expect(availableNames().some((n) => n.includes("John Client"))).toBe(true);
      });
      expect(screen.queryByTestId("added-chip-contact-1")).not.toBeInTheDocument();
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

    it("defaults every unassigned contact to Client on step-3 entry, even with auto-role OFF (BACKLOG-2358)", async () => {
      const onAssignContact = jest.fn();

      // Auto-role setting is OFF (mocked) and these contacts have no
      // default_role, so each still gets the Client baseline (never empty).
      render(
        <ContactAssignmentStep {...step3Props} onAssignContact={onAssignContact} />
      );

      await waitFor(() => {
        expect(onAssignContact).toHaveBeenCalledWith("client", "contact-1", false, "");
      });
      expect(onAssignContact).toHaveBeenCalledWith("client", "contact-2", false, "");
    });

    it("uses the contact's default_role (override) instead of the Client baseline when auto-role is ON (BACKLOG-2358)", async () => {
      // This exercises the autoRoleLoaded timing gate: the step-3 fill must wait
      // for the setting to resolve to ON so the default_role override wins rather
      // than the Client baseline latching first.
      const { settingsService } = jest.requireMock("../../services");
      settingsService.getContactAutoRoleEnabled.mockResolvedValueOnce(true);

      const onAssignContact = jest.fn();
      // seller_agent is a valid role for a purchase, so it's used directly.
      const contactWithRole: Contact = {
        ...mockContacts[1],
        default_role: "seller_agent",
      };

      render(
        <ContactAssignmentStep
          {...step3Props}
          contacts={[mockContacts[0], contactWithRole, mockContacts[2]]}
          selectedContactIds={["contact-2"]}
          onAssignContact={onAssignContact}
        />
      );

      await waitFor(() => {
        expect(onAssignContact).toHaveBeenCalledWith("seller_agent", "contact-2", false, "");
      });
      // The Client baseline must NOT be applied to this contact.
      expect(onAssignContact).not.toHaveBeenCalledWith("client", "contact-2", false, "");
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
