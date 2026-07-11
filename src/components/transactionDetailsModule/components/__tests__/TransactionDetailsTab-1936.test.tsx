/**
 * Tests for BACKLOG-1936 (Phase 2 · T4): the transaction "Key Contacts" detail
 * renders the SAME enriched ContactPreview pane as the Clients & Contacts side
 * panel — Transactions + Emails + Texts sections, click-to-open in-place viewers.
 *
 * Scope of these tests:
 * - Clicking a Key Contact opens the enriched ContactPreview with Transactions,
 *   Emails and Texts sections populated from the shared loaders (checkCanDelete +
 *   useContactComms). This is the unify goal.
 * - Clicking an email / text row opens the in-place viewer (via the shared
 *   useContactCommViewers hook).
 * - "See transaction" is NOT wired in the transaction-detail context
 *   (onSeeTransaction is omitted — see the T4 decision), so the viewers never
 *   render a "See transaction" button here.
 *
 * ContactPreview is rendered for REAL (not stubbed) so we exercise the actual
 * enriched sections. Only the heavy viewer modals are stubbed with lightweight
 * spies that surface the props T4 wires — this keeps the test deterministic while
 * still asserting the integration (row click → viewer open, no See-transaction).
 *
 * Mocks use the REAL Communication (= Message) and ContactMessageThread shapes
 * that T1 (BACKLOG-1933) returns, matching src/components/shared/ContactPreview.test.tsx.
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TransactionDetailsTab } from "../TransactionDetailsTab";
import type { Transaction } from "@/types";
import type { ContactAssignment } from "../../types";
import type { Communication, ContactMessageThread, Message } from "@/types";

// Stub the in-place viewer modals with lightweight spies. Each records whether an
// `onSeeTransaction` handler was passed (T4 must NOT pass one), and exposes an
// identifying line so we can assert the correct viewer opened.
jest.mock("../modals", () => ({
  EmailViewModal: ({
    email,
    onSeeTransaction,
    onClose,
  }: {
    email: { subject?: string };
    onSeeTransaction?: () => void;
    onClose: () => void;
  }) => (
    <div data-testid="stub-email-view-modal">
      <span data-testid="stub-email-subject">{email.subject}</span>
      {onSeeTransaction && (
        <button data-testid="stub-email-see-transaction" onClick={onSeeTransaction}>
          See transaction
        </button>
      )}
      <button data-testid="stub-email-close" onClick={onClose}>
        close
      </button>
    </div>
  ),
  ConversationViewModal: ({
    phoneNumber,
    onSeeTransaction,
    onClose,
  }: {
    phoneNumber: string;
    onSeeTransaction?: () => void;
    onClose: () => void;
  }) => (
    <div data-testid="stub-conversation-view-modal">
      <span data-testid="stub-thread-phone">{phoneNumber}</span>
      {onSeeTransaction && (
        <button data-testid="stub-thread-see-transaction" onClick={onSeeTransaction}>
          See transaction
        </button>
      )}
      <button data-testid="stub-thread-close" onClick={onClose}>
        close
      </button>
    </div>
  ),
}));

// The ContactFormModal (edit) pulls heavier deps and is not under test here.
jest.mock("../../../contact", () => ({
  ContactFormModal: () => null,
}));

// ---- Fixtures (REAL shapes T1 returns) ---------------------------------------

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

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    user_id: "user-1",
    channel: "imessage",
    direction: "inbound",
    body_text: "hi",
    sent_at: "2026-01-15T10:00:00.000Z",
    has_attachments: false,
    is_false_positive: false,
    created_at: "2026-01-15T10:00:00.000Z",
    ...overrides,
  } as Message;
}

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

const mockEmails: Communication[] = [
  makeEmail({ id: "email-1", subject: "Closing docs", transaction_id: "txn-1" }),
  makeEmail({ id: "email-2", subject: "Inspection report", transaction_id: undefined }),
];

const mockThreads: ContactMessageThread[] = [
  makeThread({ thread_id: "thread-1", phoneNumber: "+15551234567", transaction_id: "txn-1" }),
];

const mockTransaction = {
  id: "txn-1",
  transaction_type: "purchase",
  user_id: "user-1",
} as unknown as Transaction;

const assignment: ContactAssignment = {
  id: "assign-1",
  contact_id: "c1",
  contact_name: "Jane Buyer",
  contact_email: "jane@example.com",
  contact_phone: "+15551234567",
  role: "buyer",
};

type ContactsApi = typeof window.api.contacts;

function renderTab() {
  return render(
    <TransactionDetailsTab
      transaction={mockTransaction}
      contactAssignments={[assignment]}
      loading={false}
      userId="user-1"
    />,
  );
}

// Open the Key Contact preview and wait for the enriched pane to appear.
async function openPreview() {
  fireEvent.click(screen.getByTestId(`contact-summary-card-${assignment.contact_id}`));
  await screen.findByTestId("contact-preview-modal");
}

describe("TransactionDetailsTab — unified Key Contacts pane (BACKLOG-1936)", () => {
  beforeEach(() => {
    const contacts = window.api.contacts as jest.Mocked<ContactsApi>;
    // Transactions section (checkCanDelete returns the real string[] roles shape).
    contacts.checkCanDelete.mockResolvedValue({
      success: true,
      transactions: [
        {
          id: "txn-1",
          property_address: "123 Main St",
          roles: ["buyer"],
        },
      ],
    } as Awaited<ReturnType<ContactsApi["checkCanDelete"]>>);
    contacts.getEditData.mockResolvedValue({
      success: true,
      emails: [],
      phones: [],
    } as Awaited<ReturnType<ContactsApi["getEditData"]>>);
    // Emails + Texts sections (contact-scoped comms via useContactComms).
    contacts.getEmailsForContact.mockResolvedValue({
      success: true,
      emails: mockEmails,
    } as Awaited<ReturnType<ContactsApi["getEmailsForContact"]>>);
    contacts.getMessagesForContact.mockResolvedValue({
      success: true,
      messages: mockThreads,
    } as Awaited<ReturnType<ContactsApi["getMessagesForContact"]>>);
  });

  it("renders the enriched ContactPreview (Transactions + Emails + Texts) for a Key Contact", async () => {
    renderTab();
    await openPreview();

    // Transactions section (loaded via checkCanDelete).
    expect(
      await screen.findByTestId("contact-preview-transaction-txn-1"),
    ).toBeInTheDocument();

    // Emails section (loaded via useContactComms).
    expect(
      await screen.findByTestId("contact-preview-email-email-1"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("contact-preview-email-email-2")).toBeInTheDocument();

    // Texts section (loaded via useContactComms).
    expect(
      await screen.findByTestId("contact-preview-text-thread-1"),
    ).toBeInTheDocument();
  });

  it("opens the in-place email viewer when an email row is clicked", async () => {
    renderTab();
    await openPreview();

    fireEvent.click(await screen.findByTestId("contact-preview-email-email-1"));

    const modal = await screen.findByTestId("stub-email-view-modal");
    expect(modal).toBeInTheDocument();
    expect(screen.getByTestId("stub-email-subject")).toHaveTextContent("Closing docs");
    // T4 decision: NO "See transaction" button in the transaction-detail context.
    expect(
      screen.queryByTestId("stub-email-see-transaction"),
    ).not.toBeInTheDocument();
  });

  it("opens the in-place text viewer when a text row is clicked", async () => {
    renderTab();
    await openPreview();

    fireEvent.click(await screen.findByTestId("contact-preview-text-thread-1"));

    const modal = await screen.findByTestId("stub-conversation-view-modal");
    expect(modal).toBeInTheDocument();
    expect(screen.getByTestId("stub-thread-phone")).toHaveTextContent("+15551234567");
    // T4 decision: NO "See transaction" button here either.
    expect(
      screen.queryByTestId("stub-thread-see-transaction"),
    ).not.toBeInTheDocument();
  });

  it("closing the in-place viewer returns to the contact card", async () => {
    renderTab();
    await openPreview();

    fireEvent.click(await screen.findByTestId("contact-preview-email-email-1"));
    fireEvent.click(await screen.findByTestId("stub-email-close"));

    await waitFor(() =>
      expect(
        screen.queryByTestId("stub-email-view-modal"),
      ).not.toBeInTheDocument(),
    );
    // The card is still open behind the (now-closed) viewer.
    expect(screen.getByTestId("contact-preview-modal")).toBeInTheDocument();
  });
});
