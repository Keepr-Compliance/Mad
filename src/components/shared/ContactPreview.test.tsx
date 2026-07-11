import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  ContactPreview,
  type ContactPreviewProps,
  type ContactTransaction,
} from "./ContactPreview";
import type { ExtendedContact } from "../../types/components";
import type { Communication } from "@/types";

/**
 * Build a mock email using the REAL Communication (= Message) shape T1 returns.
 * `has_attachments`, `is_false_positive`, and the timestamps are the fields the
 * shared type requires / EmailViewModal + the row renderer read.
 */
function makeEmail(overrides: Partial<Communication> = {}): Communication {
  return {
    id: "email-1",
    user_id: "user-1",
    subject: "Closing docs",
    sender: "john@email.com",
    recipients: "agent@brokerage.com",
    body_html: "<p>hi</p>",
    body_text: "hi",
    sent_at: "2026-01-15T10:00:00.000Z",
    has_attachments: false,
    is_false_positive: false,
    created_at: "2026-01-15T10:00:00.000Z",
    transaction_id: "txn-1",
    ...overrides,
  } as Communication;
}

const mockEmails: Communication[] = [
  makeEmail({ id: "email-1", subject: "Closing docs", transaction_id: "txn-1" }),
  makeEmail({
    id: "email-2",
    subject: "Inspection report",
    transaction_id: undefined,
  }),
];

// Mock imported contact
const mockImportedContact: ExtendedContact = {
  id: "contact-1",
  user_id: "user-1",
  name: "John Smith",
  display_name: "John Smith",
  email: "john@email.com",
  phone: "+1-555-1234",
  company: "ABC Realty",
  title: "Sales Manager",
  source: "contacts_app",
  allEmails: ["john@email.com", "john.smith@work.com"],
  allPhones: ["+1-555-1234", "+1-555-5678"],
  is_message_derived: false,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

// Mock external contact - now uses ExtendedContact with is_message_derived flag
const mockExternalContact: ExtendedContact = {
  id: "contact-2",
  user_id: "user-1",
  name: "Bob Wilson",
  display_name: "Bob Wilson",
  email: "bob@work.com",
  phone: "+1-310-555-6789",
  company: "XYZ Corp",
  title: "Agent",
  source: "inferred",
  is_message_derived: true, // Marks as external
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

// Mock transactions
const mockTransactions: ContactTransaction[] = [
  { id: "txn-1", property_address: "123 Main St", role: "Buyer" },
  { id: "txn-2", property_address: "456 Oak Ave", role: "Seller Agent" },
  { id: "txn-3", property_address: "789 Elm Blvd", role: "Transaction Coordinator" },
];

const defaultProps: ContactPreviewProps = {
  contact: mockImportedContact,
  isExternal: false,
  transactions: mockTransactions,
  onClose: jest.fn(),
  onEdit: jest.fn(),
};

function renderContactPreview(props: Partial<ContactPreviewProps> = {}) {
  return render(<ContactPreview {...defaultProps} {...props} />);
}

describe("ContactPreview", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("contact info display", () => {
    it("displays contact name", () => {
      renderContactPreview();
      expect(screen.getByTestId("contact-preview-name")).toHaveTextContent(
        "John Smith"
      );
    });

    it("displays large avatar with initial", () => {
      renderContactPreview();
      const avatar = screen.getByTestId("contact-preview-avatar");
      expect(avatar).toHaveTextContent("J");
      expect(avatar).toHaveClass("w-16", "h-16");
    });

    it("displays all emails joined by pipe", () => {
      renderContactPreview();
      expect(screen.getByTestId("contact-preview-emails")).toHaveTextContent(
        "john@email.com | john.smith@work.com"
      );
    });

    it("displays all phones joined by pipe", () => {
      renderContactPreview();
      expect(screen.getByTestId("contact-preview-phones")).toHaveTextContent(
        "+1-555-1234 | +1-555-5678"
      );
    });

    it("displays single email when allEmails is empty", () => {
      const contactWithSingleEmail: ExtendedContact = {
        ...mockImportedContact,
        allEmails: [],
        email: "single@email.com",
      };
      renderContactPreview({ contact: contactWithSingleEmail });
      expect(screen.getByTestId("contact-preview-emails")).toHaveTextContent(
        "single@email.com"
      );
    });

    it("displays single phone when allPhones is empty", () => {
      const contactWithSinglePhone: ExtendedContact = {
        ...mockImportedContact,
        allPhones: [],
        phone: "+1-111-1111",
      };
      renderContactPreview({ contact: contactWithSinglePhone });
      expect(screen.getByTestId("contact-preview-phones")).toHaveTextContent(
        "+1-111-1111"
      );
    });

    it("displays company if present", () => {
      renderContactPreview();
      expect(screen.getByTestId("contact-preview-company")).toHaveTextContent(
        "ABC Realty"
      );
    });

    it("does not display company if not present", () => {
      const contactWithoutCompany: ExtendedContact = {
        ...mockImportedContact,
        company: undefined,
      };
      renderContactPreview({ contact: contactWithoutCompany });
      expect(
        screen.queryByTestId("contact-preview-company")
      ).not.toBeInTheDocument();
    });

    it("displays title if present", () => {
      renderContactPreview();
      expect(screen.getByTestId("contact-preview-title")).toHaveTextContent(
        "Sales Manager"
      );
    });

    it("does not display title if not present", () => {
      const contactWithoutTitle: ExtendedContact = {
        ...mockImportedContact,
        title: undefined,
      };
      renderContactPreview({ contact: contactWithoutTitle });
      expect(
        screen.queryByTestId("contact-preview-title")
      ).not.toBeInTheDocument();
    });

    it("displays source pill showing origin", () => {
      renderContactPreview();
      expect(screen.getByTestId("source-pill-contacts_app")).toBeInTheDocument();
    });

    it("displays import status pill", () => {
      renderContactPreview();
      expect(screen.getByTestId("status-pill-imported")).toBeInTheDocument();
    });

    it("displays not-imported status pill for external contacts", () => {
      renderContactPreview({
        contact: mockExternalContact,
        isExternal: true,
      });
      expect(screen.getByTestId("status-pill-not-imported")).toBeInTheDocument();
    });

    it("falls back to name when display_name is not present", () => {
      const contactWithoutDisplayName: ExtendedContact = {
        ...mockImportedContact,
        display_name: undefined,
        name: "Fallback Name",
      };
      renderContactPreview({ contact: contactWithoutDisplayName });
      expect(screen.getByTestId("contact-preview-name")).toHaveTextContent(
        "Fallback Name"
      );
    });

    it("shows Unknown Contact when no name available", () => {
      const contactWithoutName: ExtendedContact = {
        ...mockImportedContact,
        display_name: undefined,
        name: "",
      };
      renderContactPreview({ contact: contactWithoutName });
      expect(screen.getByTestId("contact-preview-name")).toHaveTextContent(
        "Unknown Contact"
      );
    });
  });

  describe("imported contact", () => {
    it("shows transaction list", () => {
      renderContactPreview();
      expect(
        screen.getByTestId("contact-preview-transactions")
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("contact-preview-transaction-txn-1")
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("contact-preview-transaction-txn-2")
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("contact-preview-transaction-txn-3")
      ).toBeInTheDocument();
    });

    it("displays transaction address and role", () => {
      renderContactPreview();
      const txn1 = screen.getByTestId("contact-preview-transaction-txn-1");
      expect(txn1).toHaveTextContent("123 Main St");
      expect(txn1).toHaveTextContent("Buyer");
    });

    it("hides transactions section when list is empty", () => {
      renderContactPreview({ transactions: [] });
      expect(
        screen.queryByTestId("contact-preview-transactions")
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText("No transactions yet")
      ).not.toBeInTheDocument();
    });

    it("shows loading spinner when loading transactions", () => {
      renderContactPreview({ isLoadingTransactions: true });
      expect(screen.getByTestId("contact-preview-loading")).toBeInTheDocument();
    });

    it("displays 'Edit Contact' button", () => {
      renderContactPreview();
      expect(screen.getByTestId("contact-preview-edit")).toBeInTheDocument();
      expect(screen.getByTestId("contact-preview-edit")).toHaveTextContent(
        "Edit Contact"
      );
    });

    it("calls onEdit when button clicked", () => {
      const onEdit = jest.fn();
      renderContactPreview({ onEdit });
      fireEvent.click(screen.getByTestId("contact-preview-edit"));
      expect(onEdit).toHaveBeenCalledTimes(1);
    });

    it("does not show import button", () => {
      renderContactPreview();
      expect(
        screen.queryByTestId("contact-preview-import")
      ).not.toBeInTheDocument();
    });
  });

  describe("external contact", () => {
    const externalProps: Partial<ContactPreviewProps> = {
      contact: mockExternalContact,
      isExternal: true,
      onImport: jest.fn(),
    };

    it("does not show transaction list for external contacts", () => {
      renderContactPreview(externalProps);
      expect(
        screen.queryByTestId("contact-preview-transactions")
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("contact-preview-external-message")
      ).not.toBeInTheDocument();
    });

    it("displays 'Import' button", () => {
      renderContactPreview(externalProps);
      expect(screen.getByTestId("contact-preview-import")).toBeInTheDocument();
      expect(screen.getByTestId("contact-preview-import")).toHaveTextContent(
        "Import"
      );
    });

    it("calls onImport when button clicked", () => {
      const onImport = jest.fn();
      renderContactPreview({ ...externalProps, onImport });
      fireEvent.click(screen.getByTestId("contact-preview-import"));
      expect(onImport).toHaveBeenCalledTimes(1);
    });

    it("does not show edit button", () => {
      renderContactPreview(externalProps);
      expect(
        screen.queryByTestId("contact-preview-edit")
      ).not.toBeInTheDocument();
    });
  });

  describe("dismissal", () => {
    it("calls onClose when close button clicked", () => {
      const onClose = jest.fn();
      renderContactPreview({ onClose });
      fireEvent.click(screen.getByTestId("contact-preview-close"));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("calls onClose when backdrop clicked", () => {
      const onClose = jest.fn();
      renderContactPreview({ onClose });
      fireEvent.click(screen.getByTestId("contact-preview-backdrop"));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("does not close when modal content clicked", () => {
      const onClose = jest.fn();
      renderContactPreview({ onClose });
      fireEvent.click(screen.getByTestId("contact-preview-modal"));
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe("accessibility", () => {
    it("close button has aria-label", () => {
      renderContactPreview();
      const closeButton = screen.getByTestId("contact-preview-close");
      expect(closeButton).toHaveAttribute("aria-label", "Close preview");
    });
  });

  // BACKLOG-1898 T5: clickable transaction rows
  describe("clickable transactions", () => {
    it("fires onTransactionClick with the transaction id when a row is clicked", () => {
      const onTransactionClick = jest.fn();
      renderContactPreview({ onTransactionClick });
      fireEvent.click(
        screen.getByTestId("contact-preview-transaction-txn-2")
      );
      expect(onTransactionClick).toHaveBeenCalledTimes(1);
      expect(onTransactionClick).toHaveBeenCalledWith("txn-2");
    });

    it("preserves the role label on clickable rows (formatRoleLabel)", () => {
      const onTransactionClick = jest.fn();
      renderContactPreview({ onTransactionClick });
      const row = screen.getByTestId("contact-preview-transaction-txn-1");
      expect(row).toHaveTextContent("123 Main St");
      expect(row).toHaveTextContent("Buyer");
    });

    it("renders rows as disabled (non-interactive) when onTransactionClick is omitted", () => {
      renderContactPreview();
      const row = screen.getByTestId("contact-preview-transaction-txn-1");
      expect(row).toBeDisabled();
    });
  });

  // BACKLOG-1898 T5: "pane" vs "modal" render variants
  describe("render variants", () => {
    it("modal variant (default) renders inside the ResponsiveModal shell", () => {
      renderContactPreview();
      expect(
        screen.getByTestId("contact-preview-backdrop")
      ).toBeInTheDocument();
      expect(screen.getByTestId("contact-preview-modal")).toBeInTheDocument();
    });

    it("pane variant renders inline WITHOUT the ResponsiveModal shell", () => {
      renderContactPreview({ variant: "pane" });
      // No backdrop/modal shell in pane mode...
      expect(
        screen.queryByTestId("contact-preview-backdrop")
      ).not.toBeInTheDocument();
      // ...but the same body content is still rendered.
      expect(screen.getByTestId("contact-preview-modal")).toBeInTheDocument();
      expect(screen.getByTestId("contact-preview-name")).toHaveTextContent(
        "John Smith"
      );
    });

    it("pane variant still renders transaction rows and fires onTransactionClick", () => {
      const onTransactionClick = jest.fn();
      renderContactPreview({ variant: "pane", onTransactionClick });
      fireEvent.click(
        screen.getByTestId("contact-preview-transaction-txn-3")
      );
      expect(onTransactionClick).toHaveBeenCalledWith("txn-3");
    });
  });

  // BACKLOG-1934: Emails section (opt-in via the emails/onEmailClick props).
  // NOTE: the section's row container is `contact-preview-email-list` — distinct
  // from `contact-preview-emails`, which is the header line of the contact's own
  // email addresses (always present).
  describe("emails section", () => {
    it("renders an email row per email with its subject", () => {
      renderContactPreview({ emails: mockEmails });
      expect(
        screen.getByTestId("contact-preview-email-list")
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("contact-preview-email-email-1")
      ).toHaveTextContent("Closing docs");
      expect(
        screen.getByTestId("contact-preview-email-email-2")
      ).toHaveTextContent("Inspection report");
    });

    it("shows the email count in the section heading", () => {
      renderContactPreview({ emails: mockEmails });
      expect(screen.getByText("Emails (2)")).toBeInTheDocument();
    });

    it("shows a loading spinner while emails are loading", () => {
      renderContactPreview({ isLoadingEmails: true });
      expect(
        screen.getByTestId("contact-preview-emails-loading")
      ).toBeInTheDocument();
      // The rows should not render while loading.
      expect(
        screen.queryByTestId("contact-preview-email-list")
      ).not.toBeInTheDocument();
    });

    it("shows an empty state when emails is an empty array (opted-in, none found)", () => {
      renderContactPreview({ emails: [] });
      expect(
        screen.getByTestId("contact-preview-emails-empty")
      ).toHaveTextContent("No emails");
      expect(
        screen.queryByTestId("contact-preview-email-list")
      ).not.toBeInTheDocument();
    });

    it("fires onEmailClick with the email object when a row is clicked", () => {
      const onEmailClick = jest.fn();
      renderContactPreview({ emails: mockEmails, onEmailClick });
      fireEvent.click(screen.getByTestId("contact-preview-email-email-1"));
      expect(onEmailClick).toHaveBeenCalledTimes(1);
      expect(onEmailClick).toHaveBeenCalledWith(mockEmails[0]);
    });

    it("renders email rows as disabled when onEmailClick is omitted", () => {
      renderContactPreview({ emails: mockEmails });
      expect(
        screen.getByTestId("contact-preview-email-email-1")
      ).toBeDisabled();
    });

    it("falls back to the sender when an email has no subject", () => {
      renderContactPreview({
        emails: [makeEmail({ id: "email-3", subject: undefined, sender: "x@y.com" })],
      });
      expect(
        screen.getByTestId("contact-preview-email-email-3")
      ).toHaveTextContent("x@y.com");
    });

    // GATING (hard AC): the six ContactPreview consumers that pass no email
    // props must render identically — no Emails section at all.
    it("does NOT render the emails section when no email props are passed", () => {
      renderContactPreview();
      expect(
        screen.queryByTestId("contact-preview-email-list")
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("contact-preview-emails-empty")
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("contact-preview-emails-loading")
      ).not.toBeInTheDocument();
      // No "Emails" section heading either (header emails are joined addresses).
      expect(screen.queryByText(/^Emails/)).not.toBeInTheDocument();
    });

    it("does NOT render the emails section for external contacts even if emails are passed", () => {
      renderContactPreview({
        contact: mockExternalContact,
        isExternal: true,
        emails: mockEmails,
      });
      expect(
        screen.queryByTestId("contact-preview-email-list")
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("contact-preview-emails-empty")
      ).not.toBeInTheDocument();
    });

    it("still renders the emails section in pane variant", () => {
      renderContactPreview({ variant: "pane", emails: mockEmails });
      expect(
        screen.getByTestId("contact-preview-email-list")
      ).toBeInTheDocument();
    });
  });
});
