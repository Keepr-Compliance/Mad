import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContactRoleRow, ContactRoleRowProps, RoleOption } from "./ContactRoleRow";
import type { ExtendedContact } from "../../types/components";

// Helper to create a test contact
function createTestContact(
  overrides: Partial<ExtendedContact> = {}
): ExtendedContact {
  return {
    id: "test-contact-1",
    user_id: "user-1",
    name: "John Doe",
    display_name: "John Doe",
    email: "john@example.com",
    phone: "555-1234",
    company: "Acme Inc",
    title: "Agent",
    source: "manual",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// Standard role options for testing
const testRoleOptions: RoleOption[] = [
  { value: "buyer", label: "Buyer" },
  { value: "seller", label: "Seller" },
  { value: "buyer_agent", label: "Buyer Agent" },
  { value: "seller_agent", label: "Seller Agent" },
];

// Helper to render with default props
function renderContactRoleRow(props: Partial<ContactRoleRowProps> = {}) {
  const defaultProps: ContactRoleRowProps = {
    contact: createTestContact(),
    currentRole: "",
    roleOptions: testRoleOptions,
    onRoleChange: jest.fn(),
    ...props,
  };
  return render(<ContactRoleRow {...defaultProps} />);
}

describe("ContactRoleRow", () => {
  describe("Rendering", () => {
    it("displays contact name", () => {
      renderContactRoleRow();
      expect(screen.getByTestId("contact-role-row-name")).toHaveTextContent(
        "John Doe"
      );
    });

    it("displays contact email", () => {
      renderContactRoleRow();
      expect(screen.getByTestId("contact-role-row-email")).toHaveTextContent(
        "john@example.com"
      );
    });

    it("displays avatar with first initial", () => {
      renderContactRoleRow();
      const avatar = screen.getByTestId("contact-role-row-avatar");
      expect(avatar).toHaveTextContent("J");
    });

    it("displays source pill", () => {
      renderContactRoleRow({
        contact: createTestContact({ source: "manual" }),
      });
      expect(screen.getByTestId("source-pill-manual")).toBeInTheDocument();
    });

    it("handles missing email gracefully", () => {
      renderContactRoleRow({
        contact: createTestContact({ email: undefined }),
      });
      expect(
        screen.queryByTestId("contact-role-row-email")
      ).not.toBeInTheDocument();
    });

    it("uses display_name over name if available", () => {
      renderContactRoleRow({
        contact: createTestContact({
          name: "John D",
          display_name: "John Doe III",
        }),
      });
      expect(screen.getByTestId("contact-role-row-name")).toHaveTextContent(
        "John Doe III"
      );
    });

    it("falls back to name if display_name is not available", () => {
      renderContactRoleRow({
        contact: createTestContact({
          name: "Jane Smith",
          display_name: undefined,
        }),
      });
      expect(screen.getByTestId("contact-role-row-name")).toHaveTextContent(
        "Jane Smith"
      );
    });

    // BACKLOG-2461: was "Unknown Contact". See src/utils/contactDisplayLabel.ts.
    it("falls back to the organisation when there is no name", () => {
      renderContactRoleRow({
        contact: createTestContact({
          name: undefined,
          display_name: undefined,
        }),
      });
      expect(screen.getByTestId("contact-role-row-name")).toHaveTextContent(
        "Acme Inc"
      );
    });

    it('shows "No name" only when we hold nothing at all', () => {
      renderContactRoleRow({
        contact: createTestContact({
          name: undefined,
          display_name: undefined,
          company: undefined,
          phone: undefined,
          email: undefined,
        }),
      });
      expect(screen.getByTestId("contact-role-row-name")).toHaveTextContent(
        "No name"
      );
    });

    it("uses allEmails array if available", () => {
      renderContactRoleRow({
        contact: createTestContact({
          email: "old@example.com",
          allEmails: ["primary@example.com", "secondary@example.com"],
        }),
      });
      expect(screen.getByTestId("contact-role-row-email")).toHaveTextContent(
        "primary@example.com"
      );
    });

    it("takes the avatar initial from whatever the label resolved to", () => {
      renderContactRoleRow({
        contact: createTestContact({
          name: undefined,
          display_name: undefined,
        }),
      });
      const avatar = screen.getByTestId("contact-role-row-avatar");
      // "A" from "Acme Inc" — the organisation, not a placeholder.
      expect(avatar).toHaveTextContent("A");
    });
  });

  describe("Role Dropdown", () => {
    it("shows 'Select role...' as first option", () => {
      renderContactRoleRow();
      const select = screen.getAllByRole("combobox")[0];
      const options = select.querySelectorAll("option");
      expect(options[0]).toHaveTextContent("Select role...");
      expect(options[0]).toHaveValue("");
    });

    it("shows all provided role options", () => {
      renderContactRoleRow();
      const select = screen.getAllByRole("combobox")[0];
      const options = select.querySelectorAll("option");
      // First option is placeholder + 4 role options
      expect(options).toHaveLength(5);
      expect(options[1]).toHaveTextContent("Buyer");
      expect(options[2]).toHaveTextContent("Seller");
      expect(options[3]).toHaveTextContent("Buyer Agent");
      expect(options[4]).toHaveTextContent("Seller Agent");
    });

    it("shows current role as selected", () => {
      renderContactRoleRow({ currentRole: "buyer_agent" });
      const select = screen.getAllByRole("combobox")[0] as HTMLSelectElement;
      expect(select.value).toBe("buyer_agent");
    });

    it("shows empty selection when currentRole is empty", () => {
      renderContactRoleRow({ currentRole: "" });
      const select = screen.getAllByRole("combobox")[0] as HTMLSelectElement;
      expect(select.value).toBe("");
    });

    it("displays correct option values", () => {
      renderContactRoleRow();
      const select = screen.getAllByRole("combobox")[0];
      const options = select.querySelectorAll("option");
      expect(options[1]).toHaveValue("buyer");
      expect(options[2]).toHaveValue("seller");
      expect(options[3]).toHaveValue("buyer_agent");
      expect(options[4]).toHaveValue("seller_agent");
    });
  });

  describe("Role Change", () => {
    it("calls onRoleChange when role is selected", async () => {
      const onRoleChange = jest.fn();
      renderContactRoleRow({ onRoleChange });

      const select = screen.getAllByRole("combobox")[0];
      await userEvent.selectOptions(select, "buyer");
      expect(onRoleChange).toHaveBeenCalledTimes(1);
    });

    it("passes selected role value to callback", async () => {
      const onRoleChange = jest.fn();
      renderContactRoleRow({ onRoleChange });

      const select = screen.getAllByRole("combobox")[0];
      await userEvent.selectOptions(select, "seller_agent");
      expect(onRoleChange).toHaveBeenCalledWith("seller_agent");
    });

    it("calls onRoleChange with empty string when placeholder selected", async () => {
      const onRoleChange = jest.fn();
      renderContactRoleRow({ onRoleChange, currentRole: "buyer" });

      const select = screen.getAllByRole("combobox")[0];
      await userEvent.selectOptions(select, "");
      expect(onRoleChange).toHaveBeenCalledWith("");
    });

    it("calls onRoleChange on native change event", () => {
      const onRoleChange = jest.fn();
      renderContactRoleRow({ onRoleChange });

      const select = screen.getAllByRole("combobox")[0];
      fireEvent.change(select, { target: { value: "buyer" } });
      expect(onRoleChange).toHaveBeenCalledWith("buyer");
    });
  });

  describe("Accessibility", () => {
    it("has aria-label on select element", () => {
      renderContactRoleRow({
        contact: createTestContact({ display_name: "Jane Smith" }),
      });
      const select = screen.getAllByRole("combobox")[0];
      expect(select).toHaveAttribute("aria-label", "Role for Jane Smith");
    });

    it("has correct test ID for the row", () => {
      renderContactRoleRow({
        contact: createTestContact({ id: "contact-123" }),
      });
      expect(
        screen.getByTestId("contact-role-row-contact-123")
      ).toBeInTheDocument();
    });

    it("has correct test ID for the select", () => {
      renderContactRoleRow({
        contact: createTestContact({ id: "contact-456" }),
      });
      expect(screen.getAllByTestId("role-select-contact-456")[0]).toBeInTheDocument();
    });

    it("select is focusable", () => {
      renderContactRoleRow();
      const select = screen.getAllByRole("combobox")[0];
      select.focus();
      expect(select).toHaveFocus();
    });
  });

  describe("Source Pill Variants", () => {
    it("shows manual variant for manual source", () => {
      renderContactRoleRow({
        contact: createTestContact({ source: "manual", is_message_derived: false }),
      });
      expect(screen.getByTestId("source-pill-manual")).toBeInTheDocument();
    });

    it("shows imported variant for contacts_app source", () => {
      renderContactRoleRow({
        contact: createTestContact({ source: "contacts_app", is_message_derived: false }),
      });
      expect(screen.getByTestId("source-pill-contacts_app")).toBeInTheDocument();
    });

    it("shows external variant for message-derived contacts", () => {
      renderContactRoleRow({
        contact: createTestContact({ is_message_derived: true }),
      });
      expect(screen.getByTestId("source-pill-contacts_app")).toBeInTheDocument();
    });

    it("shows external variant for message-derived contacts with is_message_derived=1", () => {
      renderContactRoleRow({
        contact: createTestContact({ is_message_derived: 1 }),
      });
      expect(screen.getByTestId("source-pill-contacts_app")).toBeInTheDocument();
    });

    it("shows message variant for sms source when not message-derived", () => {
      renderContactRoleRow({
        contact: createTestContact({ source: "sms", is_message_derived: false }),
      });
      expect(screen.getByTestId("source-pill-message")).toBeInTheDocument();
    });

    it("shows email variant for email source", () => {
      renderContactRoleRow({
        contact: createTestContact({ source: "email", is_message_derived: false }),
      });
      expect(screen.getByTestId("source-pill-email")).toBeInTheDocument();
    });
  });

  describe("Remove Button", () => {
    it("does not show remove button when onRemove is not provided", () => {
      renderContactRoleRow();
      expect(
        screen.queryByTestId("remove-contact-test-contact-1")
      ).not.toBeInTheDocument();
    });

    it("shows remove button when onRemove is provided", () => {
      renderContactRoleRow({ onRemove: jest.fn() });
      expect(
        screen.getAllByTestId("remove-contact-test-contact-1")[0]
      ).toBeInTheDocument();
    });

    it("calls onRemove when remove button is clicked", async () => {
      const onRemove = jest.fn();
      renderContactRoleRow({ onRemove });

      const removeBtn = screen.getAllByTestId("remove-contact-test-contact-1")[0];
      await userEvent.click(removeBtn);
      expect(onRemove).toHaveBeenCalledTimes(1);
    });

    it("has correct aria-label on remove button", () => {
      renderContactRoleRow({
        onRemove: jest.fn(),
        contact: createTestContact({ display_name: "Jane Smith" }),
      });
      const removeBtn = screen.getAllByTestId("remove-contact-test-contact-1")[0];
      expect(removeBtn).toHaveAttribute(
        "aria-label",
        "Remove Jane Smith from transaction"
      );
    });
  });

  describe("Custom className", () => {
    it("applies custom className to row", () => {
      renderContactRoleRow({ className: "custom-class" });
      const row = screen.getByTestId("contact-role-row-test-contact-1");
      expect(row).toHaveClass("custom-class");
    });

    it("preserves default classes when custom className added", () => {
      renderContactRoleRow({ className: "my-custom-class" });
      const row = screen.getByTestId("contact-role-row-test-contact-1");
      expect(row).toHaveClass("p-3");
      expect(row).toHaveClass("rounded-lg");
      expect(row).toHaveClass("my-custom-class");
    });
  });

  /**
   * BACKLOG-2567 — the "(Auto)" badge is gone from BOTH layouts.
   *
   * WHY THIS TEST LIVES HERE AND NOT IN A PARENT SUITE. Before this change NO
   * test anywhere asserted the badge (grep for "auto-filled-badge" or "(Auto)"
   * across src/ test files returned zero hits), so removing it passed every
   * existing suite whether or not it worked. The obvious place to add coverage
   * — EditContactsModal.test.tsx, which drives the role rows — CANNOT see it:
   * that suite MOCKS ContactRoleRow with its own stub that renders only a
   * <select>. A badge assertion there would go green because the mock has no
   * badge to render, which proves nothing about the component. Hence: here,
   * against the real one.
   *
   * BOTH layouts matter. ContactRoleRow renders its mobile and desktop layouts
   * SIMULTANEOUSLY and hides one with CSS, so the badge existed twice in the
   * DOM and deleting one occurrence would leave the other live at the other
   * breakpoint. queryAllBy* sees both.
   */
  describe("BACKLOG-2567: no auto badge", () => {
    it("renders no auto badge in either layout when a role is filled in", () => {
      const contact = createTestContact();
      renderContactRoleRow({ contact, currentRole: "buyer" });

      // The old testid, in both its mobile and desktop instances.
      expect(
        screen.queryAllByTestId(`auto-filled-badge-${contact.id}`)
      ).toHaveLength(0);

      // And the word itself, however it might be re-spelled — catches a
      // re-introduction under a different testid.
      expect(screen.queryAllByText(/auto/i)).toHaveLength(0);
    });

    it("still renders the role as an editable control in both layouts", () => {
      // The founder kept the auto-assignment; only the label went. If "(Auto)"
      // had been the only signal that a value was suggested rather than chosen,
      // removing it would have meant making the field look editable instead —
      // it did not, because the role has always been a native <select>.
      // Asserted so a later refactor to a read-only display goes red here.
      const contact = createTestContact();
      renderContactRoleRow({ contact, currentRole: "buyer" });

      const selects = screen.getAllByTestId(`role-select-${contact.id}`);
      expect(selects).toHaveLength(2); // mobile + desktop
      for (const select of selects) {
        expect(select.tagName).toBe("SELECT");
        expect(select).not.toBeDisabled();
        expect(select).toHaveValue("buyer");
      }
    });
  });
});
