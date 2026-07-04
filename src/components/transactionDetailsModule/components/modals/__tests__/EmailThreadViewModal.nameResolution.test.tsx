/**
 * EmailThreadViewModal — contact name resolution (BACKLOG-1762)
 * Verifies chat-bubble sender names resolve from Contacts when the email header
 * carries no name, fall back to the bare address when no contact matches, and
 * that a genuine header name wins over the contact name.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { EmailThreadViewModal } from "../EmailThreadViewModal";
import type { Communication } from "../../../types";
import type { EmailThread } from "../../EmailThreadCard";

function createMockEmail(overrides: Partial<Communication> = {}): Communication {
  return {
    id: `email-${Math.random().toString(36).slice(2, 9)}`,
    user_id: "user-1",
    communication_type: "email",
    channel: "email",
    sender: "sender@example.com",
    recipients: "recipient@example.com",
    subject: "Test Subject",
    body_plain: "Hello there",
    sent_at: "2024-01-15T10:00:00Z",
    has_attachments: false,
    is_false_positive: false,
    created_at: "2024-01-15T10:00:00Z",
    ...overrides,
  } as Communication;
}

function createThread(email: Communication): EmailThread {
  return {
    id: "thread-1",
    subject: email.subject || "Test Subject",
    participants: [email.sender || ""],
    emailCount: 1,
    startDate: new Date(email.sent_at || 0),
    endDate: new Date(email.sent_at || 0),
    emails: [email],
  };
}

const nameMap: ReadonlyMap<string, string> = new Map([
  ["emily.patt@gmail.com", "Emily Patterson"],
]);

describe("EmailThreadViewModal contact name resolution (BACKLOG-1762)", () => {
  const onClose = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders the contact name in the bubble when the header has no name", () => {
    const email = createMockEmail({ sender: "emily.patt@gmail.com" });
    render(
      <EmailThreadViewModal
        thread={createThread(email)}
        onClose={onClose}
        userEmail="me@x.com"
        nameMap={nameMap}
      />
    );

    expect(screen.getByText("Emily Patterson")).toBeInTheDocument();
  });

  it("falls back to the bare address when no contact matches", () => {
    const email = createMockEmail({ sender: "nobody@nowhere.com" });
    render(
      <EmailThreadViewModal
        thread={createThread(email)}
        onClose={onClose}
        userEmail="me@x.com"
        nameMap={nameMap}
      />
    );

    expect(screen.getByText("nobody@nowhere.com")).toBeInTheDocument();
  });

  it("keeps a genuine header name over the contact name (header truth first)", () => {
    // Header says "Emmy" even though contacts say "Emily Patterson" -> header wins.
    const email = createMockEmail({ sender: "Emmy <emily.patt@gmail.com>" });
    render(
      <EmailThreadViewModal
        thread={createThread(email)}
        onClose={onClose}
        userEmail="me@x.com"
        nameMap={nameMap}
      />
    );

    expect(screen.getByText("Emmy")).toBeInTheDocument();
    expect(screen.queryByText("Emily Patterson")).not.toBeInTheDocument();
  });
});
