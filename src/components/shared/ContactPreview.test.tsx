import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  ContactPreview,
  type ContactPreviewProps,
  type ContactTransaction,
} from "./ContactPreview";
import type { ExtendedContact } from "../../types/components";
import type { Communication, ContactMessageThread, Message } from "@/types";

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
    direction: "inbound",
    body_html: "<p>hi</p>",
    body_text: "hi there, see attached closing docs for review",
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

// 4 emails - exercises the "See all" / "Show less" toggle (BACKLOG-1944),
// which only appears once a section has more than DEFAULT_VISIBLE_ROWS (3).
const mockManyEmails: Communication[] = [
  makeEmail({ id: "email-1", subject: "Closing docs" }),
  makeEmail({ id: "email-2", subject: "Inspection report" }),
  makeEmail({ id: "email-3", subject: "Title commitment" }),
  makeEmail({ id: "email-4", subject: "Final walkthrough" }),
];

/**
 * Build a mock text Message using the REAL Message shape T1's thread groups
 * carry (id, direction, timestamps). Kept minimal to what the row renderer reads
 * (message count + newest timestamp) plus fields the type requires.
 */
function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    user_id: "user-1",
    channel: "imessage",
    direction: "inbound",
    body_text: "hi, see you at closing tomorrow",
    sent_at: "2026-01-15T10:00:00.000Z",
    has_attachments: false,
    is_false_positive: false,
    created_at: "2026-01-15T10:00:00.000Z",
    ...overrides,
  } as Message;
}

/**
 * Build a mock text thread group using the REAL ContactMessageThread shape T1
 * returns: { thread_id, phoneNumber (required), messages, transaction_id? }.
 */
function makeThread(
  overrides: Partial<ContactMessageThread> = {},
): ContactMessageThread {
  return {
    thread_id: "thread-1",
    phoneNumber: "+15551234567",
    messages: [makeMessage()],
    transaction_id: "txn-1",
    ...overrides,
  };
}

const mockThreads: ContactMessageThread[] = [
  makeThread({
    thread_id: "thread-1",
    phoneNumber: "+15551234567",
    transaction_id: "txn-1",
    messages: [
      makeMessage({ id: "m1", sent_at: "2026-01-15T10:00:00.000Z" }),
      makeMessage({ id: "m2", sent_at: "2026-01-16T09:00:00.000Z" }),
    ],
  }),
  makeThread({
    thread_id: "thread-2",
    phoneNumber: "+15559876543",
    transaction_id: undefined,
    messages: [makeMessage({ id: "m3", sent_at: "2026-01-10T08:00:00.000Z" })],
  }),
];

// 4 threads - exercises the "See all" / "Show less" toggle (BACKLOG-1944).
const mockManyThreads: ContactMessageThread[] = [
  makeThread({ thread_id: "thread-1", phoneNumber: "+15551234567" }),
  makeThread({ thread_id: "thread-2", phoneNumber: "+15559876543" }),
  makeThread({ thread_id: "thread-3", phoneNumber: "+15555551212" }),
  makeThread({ thread_id: "thread-4", phoneNumber: "+15554443333" }),
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

// 4 transactions - exercises the "See all" / "Show less" toggle (BACKLOG-1944).
const mockManyTransactions: ContactTransaction[] = [
  ...mockTransactions,
  { id: "txn-4", property_address: "321 Pine Ct", role: "Buyer Agent" },
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
      // BACKLOG-1944: avatar is now sized via inline style (52px, matches the
      // artifact's .card-head .avatar), not fixed Tailwind w-16/h-16 classes.
      expect(avatar).toHaveStyle({ width: "52px", height: "52px" });
    });

    // BACKLOG-1944: emails are now stacked one-per-line (field-grid), not
    // joined by " | " — matches the artifact's .field-grid value block.
    it("displays all emails stacked one per line", () => {
      renderContactPreview();
      const emailsField = screen.getByTestId("contact-preview-emails");
      expect(emailsField).toHaveTextContent("john@email.com");
      expect(emailsField).toHaveTextContent("john.smith@work.com");
      expect(emailsField.textContent).not.toContain(" | ");
    });

    it("displays all phones stacked one per line", () => {
      renderContactPreview();
      const phonesField = screen.getByTestId("contact-preview-phones");
      expect(phonesField).toHaveTextContent("+1-555-1234");
      expect(phonesField).toHaveTextContent("+1-555-5678");
      expect(phonesField.textContent).not.toContain(" | ");
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

    // BACKLOG-1944: "Added <date>" in the card-head meta-line, imported contacts only.
    it("shows an 'Added <date>' label for imported contacts with a valid created_at", () => {
      renderContactPreview({
        contact: { ...mockImportedContact, created_at: "2026-03-04T00:00:00.000Z" },
      });
      expect(screen.getByText(/^· Added /)).toBeInTheDocument();
    });

    it("does not show an 'Added' label for external contacts (created_at isn't a meaningful add-date)", () => {
      renderContactPreview({
        contact: { ...mockExternalContact, created_at: "2026-03-04T00:00:00.000Z" },
        isExternal: true,
      });
      expect(screen.queryByText(/^· Added /)).not.toBeInTheDocument();
    });

    it("does not show an 'Added' label (never 'Invalid Date') when created_at is malformed", () => {
      renderContactPreview({
        contact: { ...mockImportedContact, created_at: "not-a-date" },
      });
      expect(screen.queryByText(/^· Added /)).not.toBeInTheDocument();
      expect(screen.queryByText(/Invalid Date/)).not.toBeInTheDocument();
    });

    // BACKLOG-1944: field-grid uses uppercase mono-ish labels (EMAILS/PHONE/
    // COMPANY/TITLE) rather than the old unlabeled centered stack.
    it("renders uppercase field-grid labels for Emails/Phone/Company/Title", () => {
      renderContactPreview();
      expect(screen.getByText("Emails")).toHaveClass("uppercase");
      expect(screen.getByText("Phone")).toHaveClass("uppercase");
      expect(screen.getByText("Company")).toHaveClass("uppercase");
      expect(screen.getByText("Title")).toHaveClass("uppercase");
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

    // BACKLOG-1944: "See all" / "Show less" (in the section header) — only 3
    // rows shown by default.
    it("shows only the first 3 transactions and a 'See all' link when there are more", () => {
      renderContactPreview({ transactions: mockManyTransactions });
      expect(
        screen.getByTestId("contact-preview-transaction-txn-1")
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("contact-preview-transaction-txn-3")
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId("contact-preview-transaction-txn-4")
      ).not.toBeInTheDocument();
      expect(
        screen.getByTestId("contact-preview-transactions-show-all")
      ).toHaveTextContent("See all");
      // The section-head count-badge always shows the TOTAL, not the
      // truncated count (title and count are separate elements now).
      expect(screen.getByText("Transactions")).toBeInTheDocument();
      const section = screen.getByText("Transactions").closest("div");
      expect(section).toHaveTextContent("4");
    });

    it("expands to show all transactions on 'See all' click, then collapses on 'Show less'", () => {
      renderContactPreview({ transactions: mockManyTransactions });
      fireEvent.click(screen.getByTestId("contact-preview-transactions-show-all"));
      expect(
        screen.getByTestId("contact-preview-transaction-txn-4")
      ).toBeInTheDocument();
      const toggle = screen.getByTestId("contact-preview-transactions-show-all");
      expect(toggle).toHaveTextContent("Show less");

      fireEvent.click(toggle);
      expect(
        screen.queryByTestId("contact-preview-transaction-txn-4")
      ).not.toBeInTheDocument();
      expect(
        screen.getByTestId("contact-preview-transactions-show-all")
      ).toHaveTextContent("See all");
    });

    it("does not show the 'See all' link when there are 3 or fewer transactions", () => {
      renderContactPreview();
      expect(
        screen.queryByTestId("contact-preview-transactions-show-all")
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

    // SR polish (BACKLOG-1944): guard the Edit button on its own handler too
    // (symmetry with the Import guard) — no dead no-op button for any
    // consumer that omits onEdit for an imported contact.
    it("does not render the Edit button when onEdit is omitted", () => {
      renderContactPreview({ onEdit: undefined });
      expect(
        screen.queryByTestId("contact-preview-edit")
      ).not.toBeInTheDocument();
    });

    // BACKLOG-1944 refinement: the primary action (Edit) moved from the
    // footer to the card-head, top-right, across from the name.
    it("renders the Edit button inside the card head (next to the name), not the footer", () => {
      renderContactPreview();
      const editButton = screen.getByTestId("contact-preview-edit");
      const name = screen.getByTestId("contact-preview-name");
      // The card-head row (avatar + name/pills + action button) is the
      // nearest ancestor shared by both the name and the action button —
      // i.e. the button now lives in the header row, not a separate bottom
      // "footer" bar under the comms sections.
      const cardHeadRow = editButton.closest(".justify-between");
      expect(cardHeadRow).toContainElement(name);
    });

    it("shows the Remove button as a secondary action in the footer, separate from Edit", () => {
      const onRemove = jest.fn();
      renderContactPreview({ onRemove });
      const removeButton = screen.getByTestId("contact-preview-remove");
      expect(removeButton).toHaveTextContent("Remove");
      fireEvent.click(removeButton);
      expect(onRemove).toHaveBeenCalledTimes(1);
    });

    it("does not render a footer at all when onRemove is not provided", () => {
      renderContactPreview({ onRemove: undefined });
      expect(
        screen.queryByTestId("contact-preview-remove")
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

    // BACKLOG-1944 refinement: Import moved to the card-head, top-right.
    it("renders the Import button inside the card head (next to the name)", () => {
      renderContactPreview(externalProps);
      const importButton = screen.getByTestId("contact-preview-import");
      const name = screen.getByTestId("contact-preview-name");
      const cardHeadRow = importButton.closest(".justify-between");
      expect(cardHeadRow).toContainElement(name);
    });

    // External contacts never get onRemove (see Contacts.tsx wiring) and
    // Import is header-only now, so the footer bar should be fully absent.
    it("does not render a footer bar for external contacts", () => {
      renderContactPreview(externalProps);
      expect(
        screen.queryByTestId("contact-preview-remove")
      ).not.toBeInTheDocument();
    });

    // SR polish (BACKLOG-1944): ContactSelectModal and EditContactsModal
    // compute isExternal but never pass onImport — the header must not
    // render a dead no-op Import button in that case (guard on the handler,
    // not just isExternal).
    it("does not render the Import button when isExternal is true but onImport is omitted", () => {
      renderContactPreview({
        contact: mockExternalContact,
        isExternal: true,
        onImport: undefined,
      });
      expect(
        screen.queryByTestId("contact-preview-import")
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

    it("shows the email count as a count-badge next to the section title", () => {
      renderContactPreview({ emails: mockEmails });
      // BACKLOG-1944: title and count are now separate elements (title +
      // sibling count-badge pill), not a single "Emails (2)" string. Scope to
      // the <h3> section title — the field-grid also has an "Emails" label
      // (the contact's own addresses), which is a distinct, always-present
      // element.
      expect(screen.getByRole("heading", { name: "Emails", level: 3 })).toBeInTheDocument();
      expect(screen.getByText("2")).toBeInTheDocument();
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

    // BACKLOG-1944: row enrichment - snippet + sent/received tag.
    it("shows a one-line body snippet from body_text", () => {
      renderContactPreview({
        emails: [makeEmail({ id: "email-1", body_text: "hi there, see attached" })],
      });
      expect(
        screen.getByTestId("contact-preview-email-email-1")
      ).toHaveTextContent("hi there, see attached");
    });

    it("falls back to body_plain when body_text is missing", () => {
      renderContactPreview({
        emails: [
          makeEmail({
            id: "email-1",
            body_text: undefined,
            body_plain: "legacy plain text body",
          }),
        ],
      });
      expect(
        screen.getByTestId("contact-preview-email-email-1")
      ).toHaveTextContent("legacy plain text body");
    });

    it("renders no snippet text (never the literal 'undefined') when no body is available", () => {
      renderContactPreview({
        emails: [
          makeEmail({ id: "email-1", body_text: undefined, body_plain: undefined }),
        ],
      });
      const row = screen.getByTestId("contact-preview-email-email-1");
      expect(row.textContent).not.toContain("undefined");
    });

    it("shows a 'Received' tag for inbound emails and 'Sent' for outbound", () => {
      renderContactPreview({
        emails: [
          makeEmail({ id: "email-1", direction: "inbound" }),
          makeEmail({ id: "email-2", direction: "outbound" }),
        ],
      });
      expect(
        screen.getByTestId("contact-preview-email-email-1")
      ).toHaveTextContent("Received");
      expect(
        screen.getByTestId("contact-preview-email-email-2")
      ).toHaveTextContent("Sent");
    });

    // SR polish (BACKLOG-1944): the comm-icon color reflects a REAL direction
    // — violet is reserved for a confirmed "inbound" email. An undirected
    // message (direction undefined) shows no SENT/RECEIVED tag and must NOT
    // be colored violet as if it were confidently inbound; it gets the
    // neutral/gray treatment (same bg as outbound).
    it("colors the comm-icon violet only for a real inbound direction, not for undefined", () => {
      renderContactPreview({
        emails: [
          makeEmail({ id: "email-1", direction: "inbound" }),
          makeEmail({ id: "email-2", direction: "outbound" }),
          makeEmail({ id: "email-3", direction: undefined }),
        ],
      });
      const inboundIcon = screen
        .getByTestId("contact-preview-email-email-1")
        .querySelector(".bg-violet-600, .bg-gray-400, .bg-teal-600");
      const outboundIcon = screen
        .getByTestId("contact-preview-email-email-2")
        .querySelector(".bg-violet-600, .bg-gray-400, .bg-teal-600");
      const neutralIcon = screen
        .getByTestId("contact-preview-email-email-3")
        .querySelector(".bg-violet-600, .bg-gray-400, .bg-teal-600");

      expect(inboundIcon).toHaveClass("bg-violet-600");
      expect(outboundIcon).toHaveClass("bg-gray-400");
      expect(neutralIcon).toHaveClass("bg-gray-400");
      expect(neutralIcon).not.toHaveClass("bg-violet-600");
    });

    it("shows only the first 3 emails and a 'See all' link when there are more", () => {
      renderContactPreview({ emails: mockManyEmails });
      expect(
        screen.getByTestId("contact-preview-email-email-1")
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("contact-preview-email-email-3")
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId("contact-preview-email-email-4")
      ).not.toBeInTheDocument();
      expect(
        screen.getByTestId("contact-preview-emails-show-all")
      ).toHaveTextContent("See all");
      // Count-badge is always the TOTAL, not the truncated count.
      expect(screen.getByRole("heading", { name: "Emails", level: 3 })).toBeInTheDocument();
      expect(screen.getByText("4")).toBeInTheDocument();
    });

    it("expands to show all emails on 'See all' click, then collapses on 'Show less'", () => {
      renderContactPreview({ emails: mockManyEmails });
      fireEvent.click(screen.getByTestId("contact-preview-emails-show-all"));
      expect(
        screen.getByTestId("contact-preview-email-email-4")
      ).toBeInTheDocument();
      const toggle = screen.getByTestId("contact-preview-emails-show-all");
      expect(toggle).toHaveTextContent("Show less");

      fireEvent.click(toggle);
      expect(
        screen.queryByTestId("contact-preview-email-email-4")
      ).not.toBeInTheDocument();
    });

    it("does not show the 'See all' link when there are 3 or fewer emails", () => {
      renderContactPreview({ emails: mockEmails });
      expect(
        screen.queryByTestId("contact-preview-emails-show-all")
      ).not.toBeInTheDocument();
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
      // No "Emails" SECTION heading. NOTE (BACKLOG-1944): the field-grid
      // legitimately renders its own "Emails" label for the contact's own
      // addresses (mockImportedContact has allEmails) — that's a different,
      // always-present element, distinct from the opt-in comms section. So we
      // can't assert "no text matching /^Emails/" anymore; assert there's no
      // section-head count-badge sibling for it instead (the opt-in section's
      // title is always paired with a count-badge in the same flex row).
      const emailsLabels = screen.getAllByText("Emails");
      // Exactly one "Emails" text node should exist: the field-grid label.
      expect(emailsLabels).toHaveLength(1);
      expect(emailsLabels[0]).toHaveClass("font-mono", "uppercase");
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

  // BACKLOG-1935: Texts section (opt-in via the messages/onMessageClick props).
  // The thread group is T1's REAL shape (thread_id, phoneNumber, messages,
  // transaction_id?) — passed straight through, no client-side grouping.
  describe("texts section", () => {
    it("renders a thread row per group (grouped) with its phone number", () => {
      renderContactPreview({ messages: mockThreads });
      expect(
        screen.getByTestId("contact-preview-text-list")
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("contact-preview-text-thread-1")
      ).toHaveTextContent("+15551234567");
      expect(
        screen.getByTestId("contact-preview-text-thread-2")
      ).toHaveTextContent("+15559876543");
    });

    it("shows a per-thread message count", () => {
      renderContactPreview({ messages: mockThreads });
      // thread-1 has 2 messages, thread-2 has 1 (singular).
      expect(
        screen.getByTestId("contact-preview-text-thread-1")
      ).toHaveTextContent("2 messages");
      expect(
        screen.getByTestId("contact-preview-text-thread-2")
      ).toHaveTextContent("1 message");
    });

    it("shows the thread count as a count-badge next to the section title", () => {
      renderContactPreview({ messages: mockThreads });
      // BACKLOG-1944: title and count are separate elements now.
      expect(screen.getByText("Texts")).toBeInTheDocument();
      expect(screen.getByText("2")).toBeInTheDocument();
    });

    it("shows a loading spinner while messages are loading", () => {
      renderContactPreview({ isLoadingMessages: true });
      expect(
        screen.getByTestId("contact-preview-texts-loading")
      ).toBeInTheDocument();
      // Rows should not render while loading.
      expect(
        screen.queryByTestId("contact-preview-text-list")
      ).not.toBeInTheDocument();
    });

    it("shows an empty state when messages is an empty array (opted-in, none found)", () => {
      renderContactPreview({ messages: [] });
      expect(
        screen.getByTestId("contact-preview-texts-empty")
      ).toHaveTextContent("No texts");
      expect(
        screen.queryByTestId("contact-preview-text-list")
      ).not.toBeInTheDocument();
    });

    it("fires onMessageClick with the thread group when a row is clicked", () => {
      const onMessageClick = jest.fn();
      renderContactPreview({ messages: mockThreads, onMessageClick });
      fireEvent.click(screen.getByTestId("contact-preview-text-thread-1"));
      expect(onMessageClick).toHaveBeenCalledTimes(1);
      // The WHOLE thread group is passed (so the caller has messages + phoneNumber
      // for ConversationViewModal and transaction_id for "See transaction").
      expect(onMessageClick).toHaveBeenCalledWith(mockThreads[0]);
    });

    it("renders thread rows as disabled when onMessageClick is omitted", () => {
      renderContactPreview({ messages: mockThreads });
      expect(
        screen.getByTestId("contact-preview-text-thread-1")
      ).toBeDisabled();
    });

    // BACKLOG-1944: row enrichment - snippet + sent/received tag from the
    // newest message in the thread, plus the message count kept subtle.
    it("shows a one-line snippet from the newest message's body_text", () => {
      renderContactPreview({
        messages: [
          makeThread({
            thread_id: "thread-1",
            messages: [
              makeMessage({ id: "m1", sent_at: "2026-01-10T08:00:00.000Z", body_text: "old message" }),
              makeMessage({ id: "m2", sent_at: "2026-01-16T09:00:00.000Z", body_text: "newest message text" }),
            ],
          }),
        ],
      });
      expect(
        screen.getByTestId("contact-preview-text-thread-1")
      ).toHaveTextContent("newest message text");
    });

    it("shows a 'Received'/'Sent' tag derived from the newest message's direction", () => {
      renderContactPreview({
        messages: [
          makeThread({
            thread_id: "thread-1",
            messages: [makeMessage({ id: "m1", direction: "outbound" })],
          }),
        ],
      });
      expect(
        screen.getByTestId("contact-preview-text-thread-1")
      ).toHaveTextContent("Sent");
    });

    it("renders no snippet text (never the literal 'undefined') when no body is available", () => {
      renderContactPreview({
        messages: [
          makeThread({
            thread_id: "thread-1",
            messages: [makeMessage({ id: "m1", body_text: undefined, body_plain: undefined })],
          }),
        ],
      });
      const row = screen.getByTestId("contact-preview-text-thread-1");
      expect(row.textContent).not.toContain("undefined");
    });

    it("shows only the first 3 threads and a 'See all' link when there are more", () => {
      renderContactPreview({ messages: mockManyThreads });
      expect(
        screen.getByTestId("contact-preview-text-thread-1")
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("contact-preview-text-thread-3")
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId("contact-preview-text-thread-4")
      ).not.toBeInTheDocument();
      expect(
        screen.getByTestId("contact-preview-texts-show-all")
      ).toHaveTextContent("See all");
      // Count-badge is always the TOTAL, not the truncated count.
      expect(screen.getByText("Texts")).toBeInTheDocument();
      expect(screen.getByText("4")).toBeInTheDocument();
    });

    it("expands to show all threads on 'See all' click, then collapses on 'Show less'", () => {
      renderContactPreview({ messages: mockManyThreads });
      fireEvent.click(screen.getByTestId("contact-preview-texts-show-all"));
      expect(
        screen.getByTestId("contact-preview-text-thread-4")
      ).toBeInTheDocument();
      const toggle = screen.getByTestId("contact-preview-texts-show-all");
      expect(toggle).toHaveTextContent("Show less");

      fireEvent.click(toggle);
      expect(
        screen.queryByTestId("contact-preview-text-thread-4")
      ).not.toBeInTheDocument();
    });

    it("does not show the 'See all' link when there are 3 or fewer threads", () => {
      renderContactPreview({ messages: mockThreads });
      expect(
        screen.queryByTestId("contact-preview-texts-show-all")
      ).not.toBeInTheDocument();
    });

    // GATING (hard AC): the six ContactPreview consumers that pass no text props
    // must render identically — no Texts section at all.
    it("does NOT render the texts section when no message props are passed", () => {
      renderContactPreview();
      expect(
        screen.queryByTestId("contact-preview-text-list")
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("contact-preview-texts-empty")
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("contact-preview-texts-loading")
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/^Texts/)).not.toBeInTheDocument();
    });

    it("does NOT render the texts section for external contacts even if messages are passed", () => {
      renderContactPreview({
        contact: mockExternalContact,
        isExternal: true,
        messages: mockThreads,
      });
      expect(
        screen.queryByTestId("contact-preview-text-list")
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("contact-preview-texts-empty")
      ).not.toBeInTheDocument();
    });

    it("still renders the texts section in pane variant", () => {
      renderContactPreview({ variant: "pane", messages: mockThreads });
      expect(
        screen.getByTestId("contact-preview-text-list")
      ).toBeInTheDocument();
    });

    it("renders the texts section independently of the emails section (gating is per-prop)", () => {
      // Passing only messages (no email props) shows Texts but not Emails.
      renderContactPreview({ messages: mockThreads });
      expect(
        screen.getByTestId("contact-preview-text-list")
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId("contact-preview-email-list")
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("contact-preview-emails-empty")
      ).not.toBeInTheDocument();
    });
  });
});
