import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContactRow, ContactRowProps } from "./ContactRow";
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
    source: "imported",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// Helper to render with default props
function renderContactRow(props: Partial<ContactRowProps> = {}) {
  const defaultProps: ContactRowProps = {
    contact: createTestContact(),
    ...props,
  };
  return render(<ContactRow {...defaultProps} />);
}

describe("ContactRow", () => {
  describe("Rendering", () => {
    it("displays contact name", () => {
      renderContactRow();
      expect(screen.getByTestId("contact-row-name")).toHaveTextContent(
        "John Doe"
      );
    });

    it("displays contact email", () => {
      renderContactRow();
      expect(screen.getByTestId("contact-row-email")).toHaveTextContent(
        "john@example.com"
      );
    });

    it("displays avatar with first initial", () => {
      renderContactRow();
      const avatar = screen.getByTestId("contact-row-avatar");
      expect(avatar).toHaveTextContent("J");
    });

    it("displays source pill based on contact.source", () => {
      renderContactRow({
        contact: createTestContact({ source: "contacts_app" }),
      });
      expect(screen.getByTestId("source-pill-contacts_app")).toBeInTheDocument();
    });

    it("displays external source pill for message-derived contacts", () => {
      renderContactRow({
        contact: createTestContact({ is_message_derived: true }),
      });
      expect(screen.getByTestId("source-pill-contacts_app")).toBeInTheDocument();
    });

    it("handles missing email gracefully", () => {
      renderContactRow({
        contact: createTestContact({ email: undefined }),
      });
      expect(screen.queryByTestId("contact-row-email")).not.toBeInTheDocument();
    });

    it("uses display_name over name if available", () => {
      renderContactRow({
        contact: createTestContact({
          name: "John D",
          display_name: "John Doe III",
        }),
      });
      expect(screen.getByTestId("contact-row-name")).toHaveTextContent(
        "John Doe III"
      );
    });

    it("falls back to name if display_name is not available", () => {
      renderContactRow({
        contact: createTestContact({
          name: "Jane Smith",
          display_name: undefined,
        }),
      });
      expect(screen.getByTestId("contact-row-name")).toHaveTextContent(
        "Jane Smith"
      );
    });

    it("shows Unknown Contact when no name available", () => {
      renderContactRow({
        contact: createTestContact({
          name: undefined,
          display_name: undefined,
        }),
      });
      expect(screen.getByTestId("contact-row-name")).toHaveTextContent(
        "Unknown Contact"
      );
    });

    it("uses allEmails array if available", () => {
      renderContactRow({
        contact: createTestContact({
          email: "old@example.com",
          allEmails: ["primary@example.com", "secondary@example.com"],
        }),
      });
      expect(screen.getByTestId("contact-row-email")).toHaveTextContent(
        "primary@example.com"
      );
    });

    it("shows U initial for Unknown Contact when no name available", () => {
      renderContactRow({
        contact: createTestContact({
          name: undefined,
          display_name: undefined,
        }),
      });
      const avatar = screen.getByTestId("contact-row-avatar");
      // Shows "U" from "Unknown Contact" fallback
      expect(avatar).toHaveTextContent("U");
    });
  });

  describe("Checkbox", () => {
    it("shows checkbox when showCheckbox is true", () => {
      renderContactRow({ showCheckbox: true });
      expect(screen.getByTestId("contact-row-checkbox")).toBeInTheDocument();
    });

    it("hides checkbox when showCheckbox is false", () => {
      renderContactRow({ showCheckbox: false });
      expect(
        screen.queryByTestId("contact-row-checkbox")
      ).not.toBeInTheDocument();
    });

    it("checkbox is checked when isSelected is true", () => {
      renderContactRow({ showCheckbox: true, isSelected: true });
      const checkbox = screen.getByTestId("contact-row-checkbox");
      // Check for purple background indicating checked state
      expect(checkbox).toHaveClass("bg-purple-600");
    });

    it("checkbox is unchecked when isSelected is false", () => {
      renderContactRow({ showCheckbox: true, isSelected: false });
      const checkbox = screen.getByTestId("contact-row-checkbox");
      expect(checkbox).toHaveClass("bg-white");
      expect(checkbox).not.toHaveClass("bg-purple-600");
    });
  });

  describe("Import Button", () => {
    it("shows import button for external (message-derived) contacts when showImportButton is true", () => {
      renderContactRow({
        showImportButton: true,
        contact: createTestContact({ is_message_derived: true }),
      });
      expect(
        screen.getByTestId("contact-row-import-button")
      ).toBeInTheDocument();
    });

    it("shows import button for external contacts with is_message_derived=1", () => {
      renderContactRow({
        showImportButton: true,
        contact: createTestContact({ is_message_derived: 1 }),
      });
      expect(
        screen.getByTestId("contact-row-import-button")
      ).toBeInTheDocument();
    });

    it("shows import button for any contact when showImportButton is true", () => {
      // Note: The parent component is responsible for deciding when to show
      // the import button based on contact type
      renderContactRow({
        showImportButton: true,
        contact: createTestContact({ is_message_derived: false }),
      });
      expect(
        screen.getByTestId("contact-row-import-button")
      ).toBeInTheDocument();
    });

    it("hides import button when showImportButton is false", () => {
      renderContactRow({
        showImportButton: false,
        contact: createTestContact({ is_message_derived: true }),
      });
      expect(
        screen.queryByTestId("contact-row-import-button")
      ).not.toBeInTheDocument();
    });

    it("calls onImport when import button clicked", async () => {
      const onImport = jest.fn();
      renderContactRow({
        showImportButton: true,
        contact: createTestContact({ is_message_derived: true }),
        onImport,
      });

      await userEvent.click(screen.getByTestId("contact-row-import-button"));
      expect(onImport).toHaveBeenCalledTimes(1);
    });

    it("does not call onSelect when import button clicked", async () => {
      const onSelect = jest.fn();
      const onImport = jest.fn();
      renderContactRow({
        showImportButton: true,
        contact: createTestContact({ is_message_derived: true }),
        onSelect,
        onImport,
      });

      await userEvent.click(screen.getByTestId("contact-row-import-button"));
      expect(onImport).toHaveBeenCalledTimes(1);
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("import button has accessible label", () => {
      renderContactRow({
        showImportButton: true,
        contact: createTestContact({ is_message_derived: true, display_name: "Jane" }),
      });
      const button = screen.getByTestId("contact-row-import-button");
      expect(button).toHaveAttribute("aria-label", "Add Jane");
    });
  });

  describe("Compact mode (BACKLOG-1898 Phase-1 layout polish)", () => {
    it("defaults to non-compact: avatar is rendered", () => {
      renderContactRow();
      expect(screen.getByTestId("contact-row-avatar")).toBeInTheDocument();
    });

    it("omits the avatar when compact is true", () => {
      renderContactRow({ compact: true });
      expect(screen.queryByTestId("contact-row-avatar")).not.toBeInTheDocument();
    });

    it("does not render the + Add Contact button when compact is true, even if showImportButton is true", () => {
      renderContactRow({
        compact: true,
        showImportButton: true,
        contact: createTestContact({ is_message_derived: true }),
      });
      expect(
        screen.queryByTestId("contact-row-import-button")
      ).not.toBeInTheDocument();
    });

    it("renders the + Add Contact button in non-compact mode when showImportButton is true", () => {
      renderContactRow({
        compact: false,
        showImportButton: true,
        contact: createTestContact({ is_message_derived: true }),
      });
      expect(screen.getByTestId("contact-row-import-button")).toBeInTheDocument();
    });

    it("applies the wide-only (min-[1200px]) pill visibility classes in compact mode", () => {
      renderContactRow({ compact: true });
      const sourcePill = screen.getByTestId("source-pill-email");
      expect(sourcePill.parentElement).toHaveClass("hidden", "min-[1200px]:inline-flex");
      expect(sourcePill.parentElement).not.toHaveClass("sm:inline-flex");
    });

    it("applies the sm-only pill visibility classes in non-compact mode", () => {
      renderContactRow({ compact: false });
      const sourcePill = screen.getByTestId("source-pill-email");
      expect(sourcePill.parentElement).toHaveClass("hidden", "sm:inline-flex");
      expect(sourcePill.parentElement).not.toHaveClass("min-[1200px]:inline-flex");
    });
  });

  describe("Selection", () => {
    it("calls onSelect when row is clicked", async () => {
      const onSelect = jest.fn();
      renderContactRow({ onSelect });

      await userEvent.click(screen.getByTestId("contact-row"));
      expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it("calls onSelect on Enter key", () => {
      const onSelect = jest.fn();
      renderContactRow({ onSelect });

      const row = screen.getByTestId("contact-row");
      fireEvent.keyDown(row, { key: "Enter" });
      expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it("calls onSelect on Space key", () => {
      const onSelect = jest.fn();
      renderContactRow({ onSelect });

      const row = screen.getByTestId("contact-row");
      fireEvent.keyDown(row, { key: " " });
      expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it("does not call onSelect on other keys", () => {
      const onSelect = jest.fn();
      renderContactRow({ onSelect });

      const row = screen.getByTestId("contact-row");
      fireEvent.keyDown(row, { key: "Tab" });
      fireEvent.keyDown(row, { key: "Escape" });
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("shows selected styling when isSelected is true", () => {
      renderContactRow({ isSelected: true });
      const row = screen.getByTestId("contact-row");
      expect(row).toHaveClass("bg-purple-50");
    });

    it("shows hover styling when isSelected is false", () => {
      renderContactRow({ isSelected: false });
      const row = screen.getByTestId("contact-row");
      expect(row).toHaveClass("hover:bg-gray-50");
      expect(row).not.toHaveClass("bg-purple-50");
    });
  });

  describe("Accessibility", () => {
    it("has role option", () => {
      renderContactRow();
      const row = screen.getByTestId("contact-row");
      expect(row).toHaveAttribute("role", "option");
    });

    it("has aria-selected attribute matching isSelected", () => {
      const { rerender } = render(
        <ContactRow contact={createTestContact()} isSelected={false} />
      );
      expect(screen.getByTestId("contact-row")).toHaveAttribute(
        "aria-selected",
        "false"
      );

      rerender(<ContactRow contact={createTestContact()} isSelected={true} />);
      expect(screen.getByTestId("contact-row")).toHaveAttribute(
        "aria-selected",
        "true"
      );
    });

    it("is focusable with tabIndex", () => {
      renderContactRow();
      const row = screen.getByTestId("contact-row");
      expect(row).toHaveAttribute("tabIndex", "0");
    });
  });

  describe("Source Pill Variants", () => {
    it("shows manual variant for manual source", () => {
      renderContactRow({
        contact: createTestContact({ source: "manual", is_message_derived: false }),
      });
      expect(screen.getByTestId("source-pill-manual")).toBeInTheDocument();
    });

    it("shows imported variant for contacts_app source", () => {
      renderContactRow({
        contact: createTestContact({ source: "contacts_app", is_message_derived: false }),
      });
      expect(screen.getByTestId("source-pill-contacts_app")).toBeInTheDocument();
    });

    it("shows external variant for message-derived contacts", () => {
      renderContactRow({
        contact: createTestContact({ is_message_derived: true }),
      });
      expect(screen.getByTestId("source-pill-contacts_app")).toBeInTheDocument();
    });

    it("shows external variant for message-derived contacts with is_message_derived=1", () => {
      renderContactRow({
        contact: createTestContact({ is_message_derived: 1 }),
      });
      expect(screen.getByTestId("source-pill-contacts_app")).toBeInTheDocument();
    });

    it("shows message variant for sms source when not message-derived", () => {
      renderContactRow({
        contact: createTestContact({ source: "sms", is_message_derived: false }),
      });
      expect(screen.getByTestId("source-pill-message")).toBeInTheDocument();
    });

    it("shows email variant for email source", () => {
      renderContactRow({
        contact: createTestContact({ source: "email", is_message_derived: false }),
      });
      expect(screen.getByTestId("source-pill-email")).toBeInTheDocument();
    });
  });

  describe("Custom className", () => {
    it("applies custom className to row", () => {
      renderContactRow({ className: "custom-class" });
      const row = screen.getByTestId("contact-row");
      expect(row).toHaveClass("custom-class");
    });
  });
});
