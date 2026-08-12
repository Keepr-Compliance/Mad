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
import { render, screen, fireEvent, within } from "@testing-library/react";
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

      // Should include common roles
      const optionTexts = options.map((o) => o.textContent);
      expect(optionTexts).toContain("Buyer (Client)");
      expect(optionTexts).toContain("Seller Agent");
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
        seller_agent: ["contact-2"],
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
      expect(select2.value).toBe("seller_agent");
      expect(select3.value).toBe("");
    });

    it("should update assignment count when contacts have roles", () => {
      const assignments: RoleAssignments = {
        client: ["contact-1"],
        seller_agent: ["contact-2"],
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

      // Change contact-1 from client to seller_agent
      const roleSelect = screen.getByTestId("role-select-contact-1");
      fireEvent.change(roleSelect, { target: { value: "seller_agent" } });

      // Should have contact removed from client and added to seller_agent
      expect(mockOnAssignmentsChange).toHaveBeenCalledWith({
        seller_agent: ["contact-1"],
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

      // Change contact-1 from client to seller_agent
      const roleSelect = screen.getByTestId("role-select-contact-1");
      fireEvent.change(roleSelect, { target: { value: "seller_agent" } });

      // Should preserve contact-2 in client
      expect(mockOnAssignmentsChange).toHaveBeenCalledWith({
        client: ["contact-2"],
        seller_agent: ["contact-1"],
      });
    });
  });

  describe("Transaction Type Filtering", () => {
    it("should show seller agent for purchase transactions", () => {
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
      const optionTexts = options.map((o) => o.textContent);

      expect(optionTexts).toContain("Seller Agent");
      expect(optionTexts).not.toContain("Buyer Agent");
    });

    it("should show buyer agent for sale transactions", () => {
      render(
        <RoleAssigner
          selectedContacts={mockContacts}
          transactionType="sale"
          assignments={emptyAssignments}
          onAssignmentsChange={mockOnAssignmentsChange}
        />
      );

      const roleSelect = screen.getByTestId("role-select-contact-1");
      const options = within(roleSelect).getAllByRole("option");
      const optionTexts = options.map((o) => o.textContent);

      expect(optionTexts).toContain("Buyer Agent");
      expect(optionTexts).not.toContain("Seller Agent");
    });

    it("should show correct client label for purchase (Buyer)", () => {
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
      const optionTexts = options.map((o) => o.textContent);

      expect(optionTexts).toContain("Buyer (Client)");
    });

    it("should show correct client label for sale (Seller)", () => {
      render(
        <RoleAssigner
          selectedContacts={mockContacts}
          transactionType="sale"
          assignments={emptyAssignments}
          onAssignmentsChange={mockOnAssignmentsChange}
        />
      );

      const roleSelect = screen.getByTestId("role-select-contact-1");
      const options = within(roleSelect).getAllByRole("option");
      const optionTexts = options.map((o) => o.textContent);

      expect(optionTexts).toContain("Seller (Client)");
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
      fireEvent.change(roleSelect, { target: { value: "seller_agent" } });
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
      fireEvent.change(roleSelect2, { target: { value: "seller_agent" } });
      expect(mockOnAssignmentsChange).toHaveBeenLastCalledWith({
        client: ["contact-1"],
        seller_agent: ["contact-2"],
      });

      // Final state
      const finalAssignments: RoleAssignments = {
        client: ["contact-1"],
        seller_agent: ["contact-2"],
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
