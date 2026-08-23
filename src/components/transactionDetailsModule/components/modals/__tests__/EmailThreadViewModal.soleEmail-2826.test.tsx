/**
 * BACKLOG-2826 — the conversation view has to read well at ONE email.
 *
 * Founder, 2026-08-23: "a lone email should open in conversation view." That
 * makes this modal the only viewer a card's View button opens, so the
 * single-email case stopped being a degenerate thread and became the reading
 * view. Two things follow, and both are pinned here:
 *
 *   - the bubble shows the WHOLE body. A 300-char preview is a reasonable turn
 *     of a back-and-forth; it is not a way to read the email you just opened.
 *   - the bubble starts EXPANDED, so From/To and the "Open Full Email →" escape
 *     hatch to the plain reader do not need a tap to discover.
 *
 * Both are scoped to N=1: a real conversation keeps its previews and its
 * "Tap for details" hints, which the second test in each pair asserts.
 */
import React from "react";
import { render, screen, within, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { EmailThreadViewModal } from "../EmailThreadViewModal";
import type { EmailThread } from "../../EmailThreadCard";
import type { Communication } from "../../../types";

/** > 300 chars, so the bubble's preview cap is observable. */
const LONG_BODY =
  "Hi Daniel,\n\nAttaching the signed addendum for the inspection contingency ahead of Friday. " +
  "The seller has agreed to the repair credit at $4,200, which covers the roof flashing and the water heater strap. " +
  "Escrow has the wire instructions and will confirm receipt on Monday morning. " +
  "Please countersign page 3 and initial the two changes on page 5 so we can close on the 14th as planned.";
const BODY_TAIL = "close on the 14th as planned.";

function makeEmail(id: string, sentAt: string, body: string): Communication {
  return {
    id,
    user_id: "u",
    created_at: sentAt,
    has_attachments: false,
    is_false_positive: false,
    subject: "Inspection addendum",
    sender: "Paul Rivera <paul@example.com>",
    recipients: "me@example.com",
    sent_at: sentAt,
    body_text: body,
  } as unknown as Communication;
}

function makeThread(emails: Communication[]): EmailThread {
  return {
    id: "t-2826",
    subject: "Inspection addendum",
    participants: ["paul@example.com"],
    emailCount: emails.length,
    startDate: new Date(emails[0].sent_at as string),
    endDate: new Date(emails[emails.length - 1].sent_at as string),
    emails,
  };
}

const soleThread = makeThread([makeEmail("e-1", "2024-01-01T10:00:00Z", LONG_BODY)]);
const realConversation = makeThread([
  makeEmail("e-1", "2024-01-01T10:00:00Z", LONG_BODY),
  makeEmail("e-2", "2024-01-02T10:00:00Z", "Thanks Paul — reviewing now."),
]);

function renderModal(thread: EmailThread) {
  render(
    <EmailThreadViewModal
      thread={thread}
      onClose={() => undefined}
      onViewEmail={() => undefined}
      userEmail="me@example.com"
    />,
  );
  return screen.getByTestId("email-thread-view-modal");
}

describe("a conversation of one", () => {
  it("renders the body IN FULL, not the 300-char bubble preview", () => {
    const modal = renderModal(soleThread);
    expect(modal).toHaveTextContent(BODY_TAIL);
    expect(modal.textContent).not.toContain("planned....");
  });

  it("still truncates each bubble in a REAL conversation", () => {
    const modal = renderModal(realConversation);
    expect(modal).not.toHaveTextContent(BODY_TAIL);
    expect(modal.textContent).toContain("...");
  });

  it("starts expanded — From/To and the reader escape hatch need no tap", () => {
    const modal = renderModal(soleThread);
    expect(within(modal).getByText(/paul@example\.com/)).toBeInTheDocument();
    expect(within(modal).getByText("Open Full Email →")).toBeInTheDocument();
    expect(within(modal).queryByText("Tap for details")).not.toBeInTheDocument();
  });

  it("leaves a real conversation collapsed, as it always was", () => {
    const modal = renderModal(realConversation);
    expect(within(modal).getAllByText("Tap for details")).toHaveLength(2);
    expect(within(modal).queryByText("Open Full Email →")).not.toBeInTheDocument();
  });

  it("counts honestly: '1 email', never '1 emails' and never '1 email in conversation'", () => {
    const modal = renderModal(soleThread);
    expect(modal.textContent).not.toContain("1 emails");
    expect(modal.textContent).not.toContain("in conversation");
    expect(within(modal).getAllByText("1 email").length).toBeGreaterThan(0);
  });

  it("a real conversation still says 'N emails in conversation'", () => {
    const modal = renderModal(realConversation);
    expect(within(modal).getByText("2 emails in conversation")).toBeInTheDocument();
  });
});

/**
 * Requirement 3 of the founder's follow-up: the lone-email path must not lose
 * anything the plain reader carried. Attachments are the one affordance that
 * could regress silently — EmailViewModal fetches them through
 * transactions.getEmailAttachments and lists them behind a toggle, and this
 * modal must do the same for the email it now owns.
 */
describe("a conversation of one — attachments", () => {
  const withAttachment = makeThread([
    {
      ...makeEmail("e-att", "2024-01-01T10:00:00Z", "See attached."),
      has_attachments: true,
    } as Communication,
  ]);

  beforeEach(() => {
    (window as unknown as { api: unknown }).api = {
      transactions: {
        getEmailAttachments: jest.fn().mockResolvedValue({
          success: true,
          data: [
            {
              id: "att-1",
              filename: "addendum-signed.pdf",
              mime_type: "application/pdf",
              file_size_bytes: 24576,
              storage_path: "/tmp/addendum-signed.pdf",
            },
          ],
        }),
      },
    };
  });

  it("fetches and lists the attachment, and can open its preview", async () => {
    const modal = renderModal(withAttachment);

    await waitFor(() => {
      expect(window.api.transactions.getEmailAttachments).toHaveBeenCalledWith("e-att");
    });

    const toggle = await within(modal).findByTestId("attachment-toggle-e-att");
    expect(toggle).toHaveTextContent("1 attachment");

    fireEvent.click(toggle);
    const item = await screen.findByTestId("thread-attachment-att-1");
    expect(item).toHaveTextContent("addendum-signed.pdf");
  });
});
