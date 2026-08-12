import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ContactCard, { ContactCardProps } from "./ContactCard";
import type { ExtendedContact } from "../../../types/components";

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

// Helper to render with default props
function renderContactCard(props: Partial<ContactCardProps> = {}) {
  const defaultProps: ContactCardProps = {
    contact: createTestContact(),
    onClick: jest.fn(),
    ...props,
  };
  return render(<ContactCard {...defaultProps} />);
}

describe("ContactCard", () => {
  describe("source pill", () => {
    it("shows [Manual] pill for manual source contacts", () => {
      renderContactCard({
        contact: createTestContact({ source: "manual", is_message_derived: false }),
      });
      expect(screen.getByTestId("source-pill-manual")).toBeInTheDocument();
    });

    it("shows [Imported] pill for contacts_app source", () => {
      renderContactCard({
        contact: createTestContact({ source: "contacts_app", is_message_derived: false }),
      });
      expect(screen.getByTestId("source-pill-contacts_app")).toBeInTheDocument();
    });

    it("shows [External] pill for message-derived contacts", () => {
      renderContactCard({
        contact: createTestContact({ is_message_derived: true }),
      });
      expect(screen.getByTestId("source-pill-contacts_app")).toBeInTheDocument();
    });

    it("shows [External] pill for message-derived contacts with is_message_derived=1", () => {
      renderContactCard({
        contact: createTestContact({ is_message_derived: 1 }),
      });
      expect(screen.getByTestId("source-pill-contacts_app")).toBeInTheDocument();
    });

    it("shows [Message] pill for sms source when not message-derived", () => {
      renderContactCard({
        contact: createTestContact({ source: "sms", is_message_derived: false }),
      });
      expect(screen.getByTestId("source-pill-message")).toBeInTheDocument();
    });

    it("shows [Email] pill for email source", () => {
      renderContactCard({
        contact: createTestContact({ source: "email", is_message_derived: false }),
      });
      expect(screen.getByTestId("source-pill-email")).toBeInTheDocument();
    });

    it("shows [External] for message-derived even with contacts_app source", () => {
      // is_message_derived takes precedence over source
      renderContactCard({
        contact: createTestContact({ source: "contacts_app", is_message_derived: true }),
      });
      expect(screen.getByTestId("source-pill-contacts_app")).toBeInTheDocument();
    });
  });

  describe("import button", () => {
    it("shows import button for external contacts when onImport provided", () => {
      renderContactCard({
        contact: createTestContact({ is_message_derived: true }),
        onImport: jest.fn(),
      });
      expect(
        screen.getByTestId("import-button-test-contact-1")
      ).toBeInTheDocument();
    });

    it("shows import button for contacts with is_message_derived=1", () => {
      renderContactCard({
        contact: createTestContact({ is_message_derived: 1 }),
        onImport: jest.fn(),
      });
      expect(
        screen.getByTestId("import-button-test-contact-1")
      ).toBeInTheDocument();
    });

    it("hides import button for imported contacts", () => {
      renderContactCard({
        contact: createTestContact({ is_message_derived: false }),
        onImport: jest.fn(),
      });
      expect(
        screen.queryByTestId("import-button-test-contact-1")
      ).not.toBeInTheDocument();
    });

    it("hides import button when onImport not provided", () => {
      renderContactCard({
        contact: createTestContact({ is_message_derived: true }),
        onImport: undefined,
      });
      expect(
        screen.queryByTestId("import-button-test-contact-1")
      ).not.toBeInTheDocument();
    });

    it("calls onImport when import button clicked", async () => {
      const onImport = jest.fn();
      const contact = createTestContact({ is_message_derived: true });
      renderContactCard({
        contact,
        onImport,
      });

      await userEvent.click(screen.getByTestId("import-button-test-contact-1"));
      expect(onImport).toHaveBeenCalledTimes(1);
      expect(onImport).toHaveBeenCalledWith(contact);
    });

    it("does not call onClick when import button clicked", async () => {
      const onClick = jest.fn();
      const onImport = jest.fn();
      renderContactCard({
        contact: createTestContact({ is_message_derived: true }),
        onClick,
        onImport,
      });

      await userEvent.click(screen.getByTestId("import-button-test-contact-1"));
      expect(onImport).toHaveBeenCalledTimes(1);
      expect(onClick).not.toHaveBeenCalled();
    });

    it("import button has accessible label", () => {
      renderContactCard({
        contact: createTestContact({ is_message_derived: true, display_name: "Jane" }),
        onImport: jest.fn(),
      });
      const button = screen.getByTestId("import-button-test-contact-1");
      expect(button).toHaveAttribute("aria-label", "Import Jane");
    });
  });

  describe("card click", () => {
    it("calls onClick when card is clicked", async () => {
      const onClick = jest.fn();
      renderContactCard({ onClick });

      await userEvent.click(screen.getByTestId("contact-card-test-contact-1"));
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("passes contact to onClick callback", async () => {
      const onClick = jest.fn();
      const contact = createTestContact();
      renderContactCard({ contact, onClick });

      await userEvent.click(screen.getByTestId("contact-card-test-contact-1"));
      expect(onClick).toHaveBeenCalledWith(contact);
    });
  });

  describe("contact display", () => {
    it("displays contact name", () => {
      renderContactCard({
        contact: createTestContact({ display_name: "Jane Smith" }),
      });
      expect(screen.getByTestId("contact-card-name")).toHaveTextContent(
        "Jane Smith"
      );
    });

    it("displays avatar with first initial", () => {
      renderContactCard({
        contact: createTestContact({ display_name: "Michael" }),
      });
      expect(screen.getByTestId("contact-card-avatar")).toHaveTextContent("M");
    });

    it("uses display_name over name if available", () => {
      renderContactCard({
        contact: createTestContact({
          name: "John D",
          display_name: "John Doe III",
        }),
      });
      expect(screen.getByTestId("contact-card-name")).toHaveTextContent(
        "John Doe III"
      );
    });

    it("falls back to name if display_name is not available", () => {
      renderContactCard({
        contact: createTestContact({
          name: "Jane Smith",
          display_name: undefined,
        }),
      });
      expect(screen.getByTestId("contact-card-name")).toHaveTextContent(
        "Jane Smith"
      );
    });

    // BACKLOG-2461: was "Unknown Contact". See src/utils/contactDisplayLabel.ts.
    it("falls back through organisation, then phone, then email", () => {
      renderContactCard({
        contact: createTestContact({
          name: undefined,
          display_name: undefined,
        }),
      });
      expect(screen.getByTestId("contact-card-name")).toHaveTextContent(
        "Acme Inc"
      );

      renderContactCard({
        contact: createTestContact({
          name: undefined,
          display_name: undefined,
          company: undefined,
          phone: "+14155550134",
        }),
      });
      expect(screen.getAllByTestId("contact-card-name")[1]).toHaveTextContent(
        "+1 (415) 555-0134"
      );
    });

    it('shows "No name" only when we hold nothing at all', () => {
      renderContactCard({
        contact: createTestContact({
          name: undefined,
          display_name: undefined,
          company: undefined,
          phone: undefined,
          email: undefined,
        }),
      });
      expect(screen.getByTestId("contact-card-name")).toHaveTextContent(
        "No name"
      );
    });

    it("takes the avatar initial from whatever the label resolved to", () => {
      renderContactCard({
        contact: createTestContact({
          name: undefined,
          display_name: undefined,
        }),
      });
      // "A" from "Acme Inc" — the organisation, not a placeholder.
      expect(screen.getByTestId("contact-card-avatar")).toHaveTextContent("A");
    });

    it("displays email", () => {
      renderContactCard({
        contact: createTestContact({ email: "test@example.com" }),
      });
      expect(screen.getByTestId("contact-card-email-0")).toHaveTextContent(
        "test@example.com"
      );
    });

    it("displays phone", () => {
      renderContactCard({
        contact: createTestContact({ phone: "555-9999" }),
      });
      expect(screen.getByTestId("contact-card-phone-0")).toHaveTextContent(
        "555-9999"
      );
    });

    it("displays company if present", () => {
      renderContactCard({
        contact: createTestContact({ company: "Test Corp" }),
      });
      expect(screen.getByTestId("contact-card-company")).toHaveTextContent(
        "Test Corp"
      );
    });

    it("displays title if present", () => {
      renderContactCard({
        contact: createTestContact({ title: "Senior Agent" }),
      });
      expect(screen.getByTestId("contact-card-title")).toHaveTextContent(
        "Senior Agent"
      );
    });

    it("handles missing optional fields gracefully", () => {
      renderContactCard({
        contact: createTestContact({
          email: undefined,
          phone: undefined,
          company: undefined,
          title: undefined,
        }),
      });
      // Should not throw and card should still render
      expect(
        screen.getByTestId("contact-card-test-contact-1")
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId("contact-card-email-0")
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("contact-card-phone-0")
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("contact-card-company")
      ).not.toBeInTheDocument();
      expect(screen.queryByTestId("contact-card-title")).not.toBeInTheDocument();
    });
  });

  describe("multiple emails and phones", () => {
    it("displays all emails for contacts_app source with allEmails", () => {
      renderContactCard({
        contact: createTestContact({
          source: "contacts_app",
          email: "old@example.com",
          allEmails: ["primary@example.com", "secondary@example.com"],
        }),
      });
      expect(screen.getByTestId("contact-card-email-0")).toHaveTextContent(
        "primary@example.com"
      );
      expect(screen.getByTestId("contact-card-email-1")).toHaveTextContent(
        "secondary@example.com"
      );
    });

    it("displays all phones for contacts_app source with allPhones", () => {
      renderContactCard({
        contact: createTestContact({
          source: "contacts_app",
          phone: "old-phone",
          allPhones: ["555-1111", "555-2222"],
        }),
      });
      expect(screen.getByTestId("contact-card-phone-0")).toHaveTextContent(
        "555-1111"
      );
      expect(screen.getByTestId("contact-card-phone-1")).toHaveTextContent(
        "555-2222"
      );
    });

    it("uses primary email for non-contacts_app source even with allEmails", () => {
      renderContactCard({
        contact: createTestContact({
          source: "manual",
          email: "primary@example.com",
          allEmails: ["other@example.com"],
        }),
      });
      expect(screen.getByTestId("contact-card-email-0")).toHaveTextContent(
        "primary@example.com"
      );
      expect(
        screen.queryByTestId("contact-card-email-1")
      ).not.toBeInTheDocument();
    });
  });

  describe("accessibility", () => {
    it("has data-testid with contact id", () => {
      renderContactCard({
        contact: createTestContact({ id: "contact-123" }),
      });
      expect(screen.getByTestId("contact-card-contact-123")).toBeInTheDocument();
    });

    it("card is clickable with cursor-pointer class", () => {
      renderContactCard();
      const card = screen.getByTestId("contact-card-test-contact-1");
      expect(card).toHaveClass("cursor-pointer");
    });
  });
});
