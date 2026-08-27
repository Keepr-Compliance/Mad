/**
 * Tests for RoleAssigner.tsx
 *
 * Contact-Centric UI Tests:
 * - Rendering (contact list with role dropdowns, empty states)
 * - Assigning contacts to roles via dropdown
 * - Changing roles (removes from old, adds to new)
 * - Clearing roles
 * - Transaction type filtering
 *
 * @see TASK-1760: RoleAssigner Redesign - Contact-Centric Approach
 */

import React from "react";
import { render, screen, fireEvent, within, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";
import { RoleAssigner, RoleAssignments } from "./RoleAssigner";
import type { ExtendedContact } from "../../types/components";

describe("RoleAssigner", () => {
  const mockOnAssignmentsChange = jest.fn();

  // Standard test contacts
  const mockContacts: ExtendedContact[] = [
    {
      id: "contact-1",
      user_id: "user-1",
      display_name: "John Smith",
      name: "John Smith",
      email: "john@example.com",
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
      source: "contacts_app",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ];

  const emptyAssignments: RoleAssignments = {};

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Rendering", () => {
    it("should render the component with header and contact list", () => {
      render(
        <RoleAssigner
          selectedContacts={mockContacts}
          transactionType="purchase"
          assignments={emptyAssignments}
          onAssignmentsChange={mockOnAssignmentsChange}
        />
      );

      expect(screen.getByTestId("role-assigner")).toBeInTheDocument();
      expect(screen.getByText("Assign Roles to Contacts")).toBeInTheDocument();
    });

    it("should display each contact with a role dropdown", () => {
      render(
        <RoleAssigner
          selectedContacts={mockContacts}
          transactionType="purchase"
          assignments={emptyAssignments}
          onAssignmentsChange={mockOnAssignmentsChange}
        />
      );

      // Check contact rows exist
      expect(screen.getByTestId("contact-role-row-contact-1")).toBeInTheDocument();
      expect(screen.getByTestId("contact-role-row-contact-2")).toBeInTheDocument();
      expect(screen.getByTestId("contact-role-row-contact-3")).toBeInTheDocument();

      // Check role dropdowns exist
      expect(screen.getByTestId("role-select-contact-1")).toBeInTheDocument();
      expect(screen.getByTestId("role-select-contact-2")).toBeInTheDocument();
      expect(screen.getByTestId("role-select-contact-3")).toBeInTheDocument();

      // Verify contact names are displayed
      expect(
        within(screen.getByTestId("contact-role-row-contact-1")).getByText("John Smith")
      ).toBeInTheDocument();
      expect(
        within(screen.getByTestId("contact-role-row-contact-2")).getByText("Jane Doe")
      ).toBeInTheDocument();
      expect(
        within(screen.getByTestId("contact-role-row-contact-3")).getByText("Bob Wilson")
      ).toBeInTheDocument();
    });

    it("should show contact count in header", () => {
      render(
        <RoleAssigner
          selectedContacts={mockContacts}
          transactionType="purchase"
          assignments={emptyAssignments}
          onAssignmentsChange={mockOnAssignmentsChange}
        />
      );

      expect(
        screen.getByText("0 of 3 contacts have roles assigned")
      ).toBeInTheDocument();
    });

    it("should apply custom className", () => {
      render(
        <RoleAssigner
          selectedContacts={mockContacts}
          transactionType="purchase"
          assignments={emptyAssignments}
          onAssignmentsChange={mockOnAssignmentsChange}
          className="custom-class"
        />
      );

      expect(screen.getByTestId("role-assigner")).toHaveClass("custom-class");
    });

    it("should show all available roles in each dropdown", () => {
      render(
        <RoleAssigner
          selectedContacts={mockContacts}
          transactionType="purchase"
          assignments={emptyAssignments}
          onAssignmentsChange={mockOnAssignmentsChange}
        />
      );

      const roleSelect = screen.getByTestId("role-select-contact-1");
      const options = within(roleSelect).getAllByRole("option");

      // Should have placeholder + actual roles
      expect(options.length).toBeGreaterThan(1);

      // First option should be placeholder
      expect(options[0]).toHaveValue("");
      expect(options[0]).toHaveTextContent("Select role...");

      // BACKLOG-2859 — asserted at the SURFACE, as an EXACT SET.
      //
      // The constants being right does not mean the dropdown is right; this is
      // the defect's visible location, so this is where the set is pinned. A
      // membership check would pass while the user's own role was still in the
      // list, which is the failure this item exists to remove.
      const optionValues = options.map((o) => (o as HTMLOptionElement).value);
      expect(optionValues).toEqual([
        "", // placeholder
        "client",
        "agent",
        "co_agent",
        "title_company",
        "escrow_officer",
        "inspector",
        "appraiser",
        "surveyor",
        "mortgage_broker",
        "real_estate_attorney",
        "transaction_coordinator",
        "insurance_agent",
        "hoa_management",
        "condo_management",
        "other",
      ]);

      // The party labels this Listing renders, and the ones it must NOT.
      const optionTexts = options.map((o) => o.textContent);
      expect(optionTexts).toContain("Seller (Client)");
      expect(optionTexts).not.toContain("Buyer (Client)");
      expect(optionTexts).toContain("Buyer's Agent");
      // The USER'S OWN role. On a Listing the user IS the listing agent.
      expect(optionTexts).not.toContain("Listing Agent");
      expect(optionTexts).toContain("Co-Agent");
      // The other side's principal, removed by founder ruling.
      expect(optionTexts).not.toContain("Buyer");
      expect(optionTexts).not.toContain("Seller");
    });
  });

  describe("Empty States", () => {
    it("should show empty state when no contacts selected", () => {
      render(
        <RoleAssigner
          selectedContacts={[]}
          transactionType="purchase"
          assignments={emptyAssignments}
          onAssignmentsChange={mockOnAssignmentsChange}
        />
      );

      expect(screen.getByText("No contacts selected")).toBeInTheDocument();
    });
  });

  describe("Contact-Centric Role Assignment", () => {
    it("should call onAssignmentsChange when role is selected", () => {
      render(
        <RoleAssigner
          selectedContacts={mockContacts}
          transactionType="purchase"
          assignments={emptyAssignments}
          onAssignmentsChange={mockOnAssignmentsChange}
        />
      );

      // Select role for contact-1
      const roleSelect = screen.getByTestId("role-select-contact-1");
      fireEvent.change(roleSelect, { target: { value: "client" } });

      expect(mockOnAssignmentsChange).toHaveBeenCalledWith({
        client: ["contact-1"],
      });
    });

    it("should show current role as selected in dropdown", () => {
      const assignments: RoleAssignments = {
        client: ["contact-1"],
        agent: ["contact-2"],
      };

      render(
        <RoleAssigner
          selectedContacts={mockContacts}
          transactionType="purchase"
          assignments={assignments}
          onAssignmentsChange={mockOnAssignmentsChange}
        />
      );

      // Verify dropdowns show correct current values
      const select1 = screen.getByTestId("role-select-contact-1") as HTMLSelectElement;
      const select2 = screen.getByTestId("role-select-contact-2") as HTMLSelectElement;
      const select3 = screen.getByTestId("role-select-contact-3") as HTMLSelectElement;

      expect(select1.value).toBe("client");
      expect(select2.value).toBe("agent");
      expect(select3.value).toBe("");
    });

    it("should update assignment count when contacts have roles", () => {
      const assignments: RoleAssignments = {
        client: ["contact-1"],
        agent: ["contact-2"],
      };

      render(
        <RoleAssigner
          selectedContacts={mockContacts}
          transactionType="purchase"
          assignments={assignments}
          onAssignmentsChange={mockOnAssignmentsChange}
        />
      );

      expect(
        screen.getByText("2 of 3 contacts have roles assigned")
      ).toBeInTheDocument();
    });

    it("should remove contact from old role when changing to new role", () => {
      const initialAssignments: RoleAssignments = {
        client: ["contact-1"],
      };

      render(
        <RoleAssigner
          selectedContacts={mockContacts}
          transactionType="purchase"
          assignments={initialAssignments}
          onAssignmentsChange={mockOnAssignmentsChange}
        />
      );

      // Change contact-1 from client to agent (BACKLOG-2859: one agent role)
      const roleSelect = screen.getByTestId("role-select-contact-1");
      fireEvent.change(roleSelect, { target: { value: "agent" } });

      // Should have contact removed from client and added to agent
      expect(mockOnAssignmentsChange).toHaveBeenCalledWith({
        agent: ["contact-1"],
      });
    });

    it("should clear role when empty option is selected", () => {
      const initialAssignments: RoleAssignments = {
        client: ["contact-1"],
      };

      render(
        <RoleAssigner
          selectedContacts={mockContacts}
          transactionType="purchase"
          assignments={initialAssignments}
          onAssignmentsChange={mockOnAssignmentsChange}
        />
      );

      // Clear role for contact-1
      const roleSelect = screen.getByTestId("role-select-contact-1");
      fireEvent.change(roleSelect, { target: { value: "" } });

      // Should have empty assignments (client array removed due to cleanup)
      expect(mockOnAssignmentsChange).toHaveBeenCalledWith({});
    });

    it("should preserve other contacts assignments when changing one", () => {
      const initialAssignments: RoleAssignments = {
        client: ["contact-1", "contact-2"],
      };

      render(
        <RoleAssigner
          selectedContacts={mockContacts}
          transactionType="purchase"
          assignments={initialAssignments}
          onAssignmentsChange={mockOnAssignmentsChange}
        />
      );

      // Change contact-1 from client to agent (BACKLOG-2859: one agent role)
      const roleSelect = screen.getByTestId("role-select-contact-1");
      fireEvent.change(roleSelect, { target: { value: "agent" } });

      // Should preserve contact-2 in client
      expect(mockOnAssignmentsChange).toHaveBeenCalledWith({
        client: ["contact-2"],
        agent: ["contact-1"],
      });
    });
  });

  describe("Transaction Type Labels (BACKLOG-2859)", () => {
    /**
     * The stored option set is IDENTICAL on both types — the collapse is what
     * scopes the roles, so there is nothing left to filter. What moves is the
     * LABEL. These two tests assert the same three party roles resolve to
     * different words per type, and that each type's WRONG label is absent.
     */
    const partyLabels = (type: "purchase" | "sale"): string[] => {
      render(
        <RoleAssigner
          selectedContacts={mockContacts}
          transactionType={type}
          assignments={emptyAssignments}
          onAssignmentsChange={mockOnAssignmentsChange}
        />
      );
      const roleSelect = screen.getByTestId("role-select-contact-1");
      return within(roleSelect)
        .getAllByRole("option")
        .map((o) => o.textContent ?? "");
    };

    it("labels a Listing from the seller side, and never offers the user's own role", () => {
      const texts = partyLabels("purchase");
      expect(texts).toContain("Seller (Client)");
      expect(texts).toContain("Buyer's Agent");
      expect(texts).toContain("Co-Agent");
      // The user IS the listing agent on a Listing.
      expect(texts).not.toContain("Listing Agent");
      expect(texts).not.toContain("Buyer (Client)");
    });

    it("labels a Sale from the buyer side, and never offers the user's own role", () => {
      const texts = partyLabels("sale");
      expect(texts).toContain("Buyer (Client)");
      // BACKLOG-2804 survives the collapse as a label rule.
      expect(texts).toContain("Listing Agent");
      expect(texts).toContain("Co-Agent");
      // The user IS the buyer's agent on a Sale.
      expect(texts).not.toContain("Buyer's Agent");
      expect(texts).not.toContain("Seller (Client)");
    });

    it("renders Co-Agent IDENTICALLY on both types — it is not dynamic", () => {
      const onListing = partyLabels("purchase").filter((t) => t.includes("Co-"));
      cleanup();
      const onSale = partyLabels("sale").filter((t) => t.includes("Co-"));
      expect(onListing).toEqual(["Co-Agent"]);
      expect(onListing).toEqual(onSale);
    });
  });

  describe("Edge Cases", () => {
    it("should handle contacts without display_name", () => {
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
        <RoleAssigner
          selectedContacts={contactsWithLegacyName}
          transactionType="purchase"
          assignments={emptyAssignments}
          onAssignmentsChange={mockOnAssignmentsChange}
        />
      );

      const contactRow = screen.getByTestId("contact-role-row-contact-legacy");
      expect(within(contactRow).getByText("Legacy Name")).toBeInTheDocument();
    });

    // BACKLOG-2461: was a bare "Unknown". The record holds an email; show it.
    it("should show the email for contacts without any name", () => {
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
        <RoleAssigner
          selectedContacts={contactsWithNoName}
          transactionType="purchase"
          assignments={emptyAssignments}
          onAssignmentsChange={mockOnAssignmentsChange}
        />
      );

      expect(screen.getByText("anonymous@example.com")).toBeInTheDocument();
    });

    it("should handle rapid assignment changes", () => {
      render(
        <RoleAssigner
          selectedContacts={mockContacts}
          transactionType="purchase"
          assignments={emptyAssignments}
          onAssignmentsChange={mockOnAssignmentsChange}
        />
      );

      const roleSelect = screen.getByTestId("role-select-contact-1");

      // Rapid changes
      fireEvent.change(roleSelect, { target: { value: "client" } });
      fireEvent.change(roleSelect, { target: { value: "agent" } });
      fireEvent.change(roleSelect, { target: { value: "title_company" } });

      expect(mockOnAssignmentsChange).toHaveBeenCalledTimes(3);
    });

    it("should display contact email when available", () => {
      render(
        <RoleAssigner
          selectedContacts={mockContacts}
          transactionType="purchase"
          assignments={emptyAssignments}
          onAssignmentsChange={mockOnAssignmentsChange}
        />
      );

      const contactRow = screen.getByTestId("contact-role-row-contact-1");
      expect(within(contactRow).getByText("john@example.com")).toBeInTheDocument();
    });
  });

  describe("Integration Scenarios", () => {
    it("should handle complete assignment workflow", () => {
      const { rerender } = render(
        <RoleAssigner
          selectedContacts={mockContacts}
          transactionType="purchase"
          assignments={emptyAssignments}
          onAssignmentsChange={mockOnAssignmentsChange}
        />
      );

      // Step 1: Assign John as client
      let roleSelect1 = screen.getByTestId("role-select-contact-1");
      fireEvent.change(roleSelect1, { target: { value: "client" } });
      expect(mockOnAssignmentsChange).toHaveBeenLastCalledWith({
        client: ["contact-1"],
      });

      // Simulate parent updating assignments
      const afterFirstAssign: RoleAssignments = { client: ["contact-1"] };
      rerender(
        <RoleAssigner
          selectedContacts={mockContacts}
          transactionType="purchase"
          assignments={afterFirstAssign}
          onAssignmentsChange={mockOnAssignmentsChange}
        />
      );

      // Verify count updated
      expect(
        screen.getByText("1 of 3 contacts have roles assigned")
      ).toBeInTheDocument();

      // Step 2: Assign Jane as seller agent
      const roleSelect2 = screen.getByTestId("role-select-contact-2");
      fireEvent.change(roleSelect2, { target: { value: "agent" } });
      expect(mockOnAssignmentsChange).toHaveBeenLastCalledWith({
        client: ["contact-1"],
        agent: ["contact-2"],
      });

      // Final state
      const finalAssignments: RoleAssignments = {
        client: ["contact-1"],
        agent: ["contact-2"],
      };
      rerender(
        <RoleAssigner
          selectedContacts={mockContacts}
          transactionType="purchase"
          assignments={finalAssignments}
          onAssignmentsChange={mockOnAssignmentsChange}
        />
      );

      // Verify final state
      expect(
        screen.getByText("2 of 3 contacts have roles assigned")
      ).toBeInTheDocument();
    });
  });

  describe("Accessibility", () => {
    it("should have proper aria-label on role dropdowns", () => {
      render(
        <RoleAssigner
          selectedContacts={mockContacts}
          transactionType="purchase"
          assignments={emptyAssignments}
          onAssignmentsChange={mockOnAssignmentsChange}
        />
      );

      const roleSelect = screen.getByTestId("role-select-contact-1");
      expect(roleSelect).toHaveAttribute("aria-label", "Role for John Smith");
    });
  });
});
